/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as policy from "../src/equicordplugins/discordMcp.desktop/policy";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function loadRenderer(native: object, common: object = {}) {
    const output = transpileModule(readFileSync("src/equicordplugins/discordMcp.desktop/index.ts", "utf8")
        + "\nexport { generateAttachmentWaveform, waveformCache, executeTool, handleBridgeRequest, bridgeLoop, inFlightRequests };", {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: false }
    }).outputText;
    const modules = {
        "./policy": policy,
        "@utils/types": { default: (value: unknown) => value },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack/common": common,
        "@vencord/discord-types/enums": { MessageFlags: { IS_VOICE_MESSAGE: 8192 } },
        "@plugins/voiceMessages/waveform": { generateWaveform: () => "waveform" },
        "../voiceMessageTranscriber.desktop/utils": { decodeAudio: async () => [] }
    };
    return runInNewContext(`${output}\nexports;`, {
        exports: {}, VencordNative: { pluginHelpers: { DiscordMCP: native } },
        Blob, Uint8Array, setTimeout, clearTimeout, AbortController, crypto,
        require: (name: string) => modules[name] ?? {}
    });
}

async function nativeFixture(t: { after(fn: () => Promise<void>): void; }, overrides: object = {}) {
    const root = await fsp.mkdtemp(path.join(tmpdir(), "discord-mcp-regression-"));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const watchers = new Set<fs.FSWatcher>();
    const load = () => {
        const output = transpileModule(readFileSync("src/equicordplugins/discordMcp.desktop/native.ts", "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: false }
        }).outputText;
        const modules = { "@main/utils/constants": { DATA_DIR: root }, "./policy": policy, crypto, fs: { ...fs, watch(...args: any[]) {
            const watcher = (fs.watch as any)(...args) as fs.FSWatcher;
            watchers.add(watcher);
            watcher.on("close", () => watchers.delete(watcher));
            return watcher;
        } }, "fs/promises": { ...fsp, ...overrides }, path };
        return runInNewContext(`${output}\nexports;`, {
            exports: {}, Buffer, AbortController, setTimeout, clearTimeout,
            require: (name: string) => modules[name] ?? {}
        });
    };
    const native = load();
    const session = crypto.randomUUID();
    await native.initializeBridge({}, session);
    const directory = path.join(root, "discord-mcp");
    const config = JSON.parse(await fsp.readFile(path.join(directory, "config.json"), "utf8"));
    return {
        native, session, directory, load, watchers,
        async request(id: string) {
            await fsp.writeFile(path.join(directory, "requests", `${id}.json`), JSON.stringify({ id, secret: config.secret, tool: "list_subscriptions", createdAt: Date.now() }));
        },
        async response(id: string) { return JSON.parse(await fsp.readFile(path.join(directory, "responses", `${id}.json`), "utf8")); }
    };
}

test("Discord MCP stop wakes native polling and an old session cannot claim or cancel its replacement", async t => {
    const f = await nativeFixture(t);
    const pending = f.native.takeRequests({}, 30_000, f.session);
    f.native.cancelRequests({}, f.session);
    assert.equal((await pending).length, 0);
    const next = crypto.randomUUID();
    await f.native.initializeBridge({}, next);
    await f.request("replacement-request");
    f.native.cancelRequests({}, f.session);
    assert.equal((await f.native.takeRequests({}, 0, f.session)).length, 0);
    const requests = await f.native.takeRequests({}, 0, next);
    assert.equal(requests[0].id, "replacement-request");
    const files = await fsp.readdir(path.join(f.directory, "requests"));
    assert.equal(files.filter(name => name.endsWith(".processing")).length, 1, "claimed work remains durable until its response commits");
    await f.native.writeResponse({}, { id: requests[0].id, ok: true, result: "done" });
    assert.equal((await fsp.readdir(path.join(f.directory, "requests"))).length, 0);
});

async function until(predicate: () => boolean) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("fixture did not reach the expected state");
}

test("Discord MCP native stop closes an active empty directory watcher promptly", async t => {
    const f = await nativeFixture(t);
    const pending = f.native.takeRequests({}, 30_000, f.session);
    await until(() => f.watchers.size === 1);
    f.native.cancelRequests({}, f.session);
    assert.equal((await pending).length, 0);
    await until(() => f.watchers.size === 0);
});

test("Discord MCP response write failures never replace a completed result with a false tool failure", async () => {
    const attempts: any[] = [];
    const f = loadRenderer({ writeResponse: async (response: object) => { attempts.push(response); throw new Error("write unavailable"); } });
    await assert.rejects(f.handleBridgeRequest({ id: "response-request", tool: "list_subscriptions" }), /write unavailable/);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].ok, true);
});

for (const blocked of [false, true]) {
    test(`Discord MCP stop cancels every unstarted ${blocked ? "capacity-blocked" : "late claimed"} request`, async () => {
        const batch = deferred<any[]>();
        const completed = deferred<void>();
        const responses: any[] = [];
        const f = loadRenderer({
            initializeBridge: async () => {}, cancelRequests: async () => {},
            takeRequests: () => batch.promise,
            writeResponse: async (response: object) => {
                responses.push(response);
                if (responses.length === 2) completed.resolve();
            }
        });
        if (blocked) for (let i = 0; i < 128; i++) f.inFlightRequests.add(new Promise(() => {}));
        await f.default.start();
        const requests = ["first-request", "second-request"].map(id => ({ id, tool: "list_subscriptions" }));
        if (blocked) {
            batch.resolve(requests);
            await new Promise(resolve => setImmediate(resolve));
        }
        f.default.stop();
        if (!blocked) batch.resolve(requests);
        await completed.promise;
        assert.deepEqual(responses.map(({ id, ok }) => [id, ok]), requests.map(({ id }) => [id, false]));
        assert.ok(responses.every(response => /stopped before executing/.test(response.error)));
    });
}

test("Discord MCP retries only a completed response after a write failure and never reexecutes its claim", async t => {
    let fail = true;
    const f = await nativeFixture(t, { rename: async (from: string, to: string) => {
        if (fail && to.includes(`${path.sep}responses${path.sep}`)) throw new Error("response write unavailable");
        await fsp.rename(from, to);
    } });
    await f.request("finished-request");
    await f.native.takeRequests({}, 0, f.session);
    await assert.rejects(f.native.writeResponse({}, { id: "finished-request", ok: true, result: { id: "confirmed" } }), /unavailable/);
    fail = false;
    assert.equal((await f.native.takeRequests({}, 0, f.session)).length, 0, "completed work cannot reappear in the request queue");
    assert.equal((await f.response("finished-request")).result.id, "confirmed");
    const restarted = f.load();
    await restarted.initializeBridge({}, crypto.randomUUID());
    assert.equal((await f.response("finished-request")).ok, true);
});

test("Discord MCP restart gives abandoned claims an explicit unknown outcome without replay", async t => {
    const f = await nativeFixture(t);
    await f.request("abandoned-request");
    await f.native.takeRequests({}, 0, f.session);
    const restarted = f.load();
    const session = crypto.randomUUID();
    await restarted.initializeBridge({}, session);
    assert.match((await f.response("abandoned-request")).error, /outcome is unknown/);
    assert.equal((await restarted.takeRequests({}, 0, session)).length, 0);
});

test("Discord MCP retries interrupted-claim recovery on a later writable poll without replay", async t => {
    let fail = false;
    let committedResponses = 0;
    const f = await nativeFixture(t, { rename: async (from: string, to: string) => {
        const response = to.includes(`${path.sep}responses${path.sep}`);
        if (fail && response) throw new Error("recovery response unavailable");
        await fsp.rename(from, to);
        if (response) committedResponses++;
    } });
    await f.request("recovery-request");
    await f.native.takeRequests({}, 0, f.session);
    fail = true;
    const restarted = f.load();
    const session = crypto.randomUUID();
    await restarted.initializeBridge({}, session);
    await assert.rejects(f.response("recovery-request"), { code: "ENOENT" });
    assert.equal((await fsp.readdir(path.join(f.directory, "requests"))).filter(name => name.endsWith(".processing")).length, 1);
    fail = false;
    assert.equal((await restarted.takeRequests({}, 0, session)).length, 0);
    const response = await f.response("recovery-request");
    assert.equal(response.ok, false);
    assert.match(response.error, /outcome is unknown/);
    assert.equal((await fsp.readdir(path.join(f.directory, "requests"))).length, 0);
    assert.equal((await restarted.takeRequests({}, 0, session)).length, 0);
    assert.equal(committedResponses, 1, "recovery must commit exactly one terminal response and never replay the tool");
});

const channelId = "123456789012345678";
const messageId = "234567890123456789";
const sent = { id: messageId, channel_id: channelId, content: "fixture text", author: { id: "345678901234567890" } };
function messageCommon(post: () => Promise<unknown>) {
    return {
        ChannelStore: { getChannel: () => ({ id: channelId }) },
        Constants: { Endpoints: { MESSAGES: () => "fixture-messages" } },
        SnowflakeUtils: { fromTimestamp: () => "fixture-nonce" },
        RestAPI: { post }
    };
}

test("Discord MCP confirms a sent message despite ledger failure and recovers tracking without reposting", async t => {
    let fail = true;
    const f = await nativeFixture(t, { rename: async (from: string, to: string) => {
        if (fail && to.endsWith("sent-messages.json")) throw new Error("ledger unavailable");
        await fsp.rename(from, to);
    } });
    let posts = 0;
    const responses: any[] = [];
    const renderer = loadRenderer({
        recordSentMessage: (channel: string, message: string) => f.native.recordSentMessage({}, channel, message),
        writeResponse: async (response: any) => responses.push(response)
    }, messageCommon(async () => { posts++; return { body: sent }; }));
    await renderer.handleBridgeRequest({ id: "send-request", tool: "send_message", arguments: { channel_id: channelId, content: sent.content } });
    assert.equal(responses[0].ok, true, "bookkeeping cannot report an already sent message as failed");
    assert.equal(responses[0].result.id, messageId);
    assert.equal(responses[0].result.content, sent.content);
    assert.match(responses[0].result.trackingWarning, /sent successfully/);
    assert.equal(await f.native.isSentMessage({}, channelId, messageId), true, "failed persistence retains authorization in memory");
    assert.equal(await f.native.isSentMessage({}, channelId, "999999999999999999"), false);

    const beforeRecovery = f.load();
    await beforeRecovery.initializeBridge({}, crypto.randomUUID());
    assert.equal(await beforeRecovery.isSentMessage({}, channelId, messageId), false, "a process restart before persistence must fail closed as the warning says");
    fail = false;
    await f.native.takeRequests({}, 0, f.session);
    const afterRecovery = f.load();
    await afterRecovery.initializeBridge({}, crypto.randomUUID());
    assert.equal(await afterRecovery.isSentMessage({}, channelId, messageId), true, "ledger-only recovery survives process restart");
    assert.equal(await afterRecovery.isSentMessage({}, channelId, "999999999999999999"), false);
    assert.equal(posts, 1, "tracking recovery never sends the message again");
});

test("Discord MCP REST rejection remains a failed send without recording deletion authorization", async () => {
    let records = 0;
    const responses: any[] = [];
    const renderer = loadRenderer({
        recordSentMessage: async () => { records++; },
        writeResponse: async (response: any) => responses.push(response)
    }, messageCommon(async () => { throw new Error("REST rejected"); }));
    await renderer.handleBridgeRequest({ id: "failed-send", tool: "send_message", arguments: { channel_id: channelId, content: sent.content } });
    assert.equal(responses[0].ok, false);
    assert.match(responses[0].error, /REST rejected/);
    assert.equal(records, 0);
});

test("Discord MCP stop cannot replace an already-started send's confirmed result with cancellation", async () => {
    const post = deferred<object>();
    const responses: any[] = [];
    let records = 0;
    const renderer = loadRenderer({
        recordSentMessage: async () => { records++; },
        writeResponse: async (response: any) => responses.push(response)
    }, messageCommon(() => post.promise));
    const request = renderer.handleBridgeRequest({ id: "started-send", tool: "send_message", arguments: { channel_id: channelId, content: sent.content } });
    renderer.default.stop();
    post.resolve({ body: sent });
    await request;
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].result.id, messageId);
    assert.equal(responses[0].result.trackingWarning, undefined);
    assert.equal(records, 1);
});

test("Discord MCP tracking retry persists later deletions instead of restoring their authorization", async t => {
    let fail = true;
    const f = await nativeFixture(t, { rename: async (from: string, to: string) => {
        if (fail && to.endsWith("sent-messages.json")) throw new Error("ledger unavailable");
        await fsp.rename(from, to);
    } });
    await assert.rejects(f.native.recordSentMessage({}, channelId, messageId), /ledger unavailable/);
    await assert.rejects(f.native.forgetSentMessage({}, channelId, messageId), /ledger unavailable/);
    fail = false;
    await f.native.initializeBridge({}, crypto.randomUUID());
    const restarted = f.load();
    await restarted.initializeBridge({}, crypto.randomUUID());
    assert.equal(await restarted.isSentMessage({}, channelId, messageId), false);
});

test("Discord MCP confirms deletion despite ledger failure and retries only tracking", async t => {
    let fail = false;
    const f = await nativeFixture(t, { rename: async (from: string, to: string) => {
        if (fail && to.endsWith("sent-messages.json")) throw new Error("ledger unavailable");
        await fsp.rename(from, to);
    } });
    await f.native.recordSentMessage({}, channelId, messageId);
    fail = true;
    let deletes = 0;
    const responses: any[] = [];
    const renderer = loadRenderer({
        isSentMessage: (channel: string, message: string) => f.native.isSentMessage({}, channel, message),
        forgetSentMessage: (channel: string, message: string) => f.native.forgetSentMessage({}, channel, message),
        writeResponse: async (response: any) => responses.push(response)
    }, {
        ChannelStore: { getChannel: () => ({ id: channelId }) },
        Constants: { Endpoints: { MESSAGES: () => "fixture-messages", MESSAGE: () => "fixture-message" } },
        UserStore: { getCurrentUser: () => sent.author },
        RestAPI: { get: async () => ({ body: [sent] }), del: async () => { deletes++; } }
    });
    await renderer.handleBridgeRequest({ id: "delete-request", tool: "delete_own_message", arguments: { channel_id: channelId, message_id: messageId } });
    assert.equal(responses[0].ok, true, "bookkeeping cannot report a confirmed deletion as failed");
    assert.equal(responses[0].result.deleted, true);
    assert.equal(responses[0].result.channelId, channelId);
    assert.equal(responses[0].result.messageId, messageId);
    assert.match(responses[0].result.trackingWarning, /deleted successfully/);
    assert.equal(await f.native.isSentMessage({}, channelId, messageId), false);
    fail = false;
    await f.native.takeRequests({}, 0, f.session);
    const restarted = f.load();
    await restarted.initializeBridge({}, crypto.randomUUID());
    assert.equal(await restarted.isSentMessage({}, channelId, messageId), false);
    assert.equal(deletes, 1, "tracking recovery cannot repeat the Discord deletion");
});

for (const resolved of [false, true]) {
    test(`Discord MCP evicted waveform failures preserve ${resolved ? "completed" : "pending"} replacements`, async () => {
        const requests: ReturnType<typeof deferred<any>>[] = [];
        const f = loadRenderer({ fetchDiscordAttachment() {
            const request = deferred<any>();
            requests.push(request);
            return request.promise;
        } });
        const attachment = { url: "fixture-original" };
        const old = f.generateAttachmentWaveform(attachment);
        const failed = assert.rejects(old, /old failure/);
        for (let i = 0; i < 25; i++) f.generateAttachmentWaveform({ url: `fixture-${i}` });
        const replacement = f.generateAttachmentWaveform(attachment);
        if (resolved) {
            requests.at(-1)!.resolve({ data: new Uint8Array(), contentType: "audio/ogg" });
            assert.equal(await replacement, "waveform");
        }
        requests[0].reject(new Error("old failure"));
        await failed;
        assert.equal(f.generateAttachmentWaveform({ url: "fixture-original" }), replacement);
        assert.equal(requests.length, 27);
        if (!resolved) requests.at(-1)!.resolve({ data: new Uint8Array(), contentType: "audio/ogg" });
        await replacement;
    });
}
