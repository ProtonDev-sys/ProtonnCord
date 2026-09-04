/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from "typescript";

type Fetch = (this: unknown, options: unknown, ...args: unknown[]) => unknown;

const source = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8");
const parsed = createSourceFile("index.tsx", source, ScriptTarget.Latest, true);
const declarations = new Set(["originalFetchMessages", "guardedFetchMessages", "suppressedChatLoads"]);
const functions = new Set([
    "cancelSuppressedChatLoads", "resumeSuppressedChatLoads", "deferChatLoad", "installChatLoadGuard", "uninstallChatLoadGuard",
]);
const runtimeSource = parsed.statements.filter(statement =>
    isFunctionDeclaration(statement) ? statement.name && functions.has(statement.name.text)
        : isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declarations.has(declaration.name.getText(parsed)))
).map(statement => statement.getText(parsed)).join("\n");

function harness(fetch: Fetch = () => "loaded") {
    let userId = "100000000000000001";
    let gated = true;
    const actions = { fetchMessages: fetch };
    const { outputText } = transpileModule(runtimeSource, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext },
    });
    const controls = runInNewContext(`${outputText}\n({
        installChatLoadGuard,
        uninstallChatLoadGuard,
        resumeSuppressedChatLoads,
        deferChatLoad,
    })`, {
        DOMException,
        MessageActions: actions,
        ChannelStore: { getChannel: (id: string) => ({ id }) },
        UserStore: { getCurrentUser: () => ({ id: userId }) },
        chatGateChannel: (target: { channelId: string; }) => ({ id: target.channelId }),
        chatGateReason: () => gated ? "checking" : null,
    }) as {
        installChatLoadGuard(): void;
        uninstallChatLoadGuard(): void;
        resumeSuppressedChatLoads(): void;
        deferChatLoad(options: unknown, fetch: () => unknown): Promise<unknown> | null;
    };
    controls.installChatLoadGuard();
    return {
        actions,
        controls,
        unlock: () => { gated = false; controls.resumeSuppressedChatLoads(); },
        switchAccount: () => { userId = "100000000000000002"; },
        isGated: () => gated,
    };
}

test("a gated history fetch stays pending and preserves the complete original invocation", async () => {
    const calls: Array<{ receiver: unknown; args: unknown[]; }> = [];
    const page = { messages: ["synthetic history"] };
    const h = harness(function (...args) {
        calls.push({ receiver: this, args });
        return page;
    });
    const options = { channelId: "200000000000000001", before: "300000000000000001", limit: 50, after: null, around: null, jump: { messageId: "300000000000000001" } };
    const receiver = { name: "original receiver" };
    const extra = { name: "original extra argument" };
    let settled = false;
    const pending = Promise.resolve(h.actions.fetchMessages.call(receiver, options, extra)).finally(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false, "a suppressed fetch must not report success before loading its page");
    assert.equal(calls.length, 0);
    h.controls.resumeSuppressedChatLoads();
    assert.equal(calls.length, 0, "checking access must continue blocking the request");
    h.unlock();
    assert.equal(await pending, page);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].receiver, receiver);
    assert.equal(calls[0].args[0], options);
    assert.equal(calls[0].args[1], extra);
    h.unlock();
    assert.equal(calls.length, 1, "a resumed fetch cannot run twice");
});

for (const asynchronous of [false, true]) {
    test(`distinct pending pages preserve ${asynchronous ? "asynchronous" : "synchronous"} failures and results`, async () => {
        const failure = new Error("synthetic fetch failure");
        const h = harness(options => {
            if ((options as { before?: string; }).before) {
                if (asynchronous) return Promise.reject(failure);
                throw failure;
            }
            return "around page";
        });
        const before = Promise.resolve(h.actions.fetchMessages({ channelId: "200000000000000001", before: "300000000000000001" }));
        const around = Promise.resolve(h.actions.fetchMessages({ channelId: "200000000000000001", around: "300000000000000002" }));
        const rejected = assert.rejects(before, error => error === failure);
        h.unlock();
        await rejected;
        assert.equal(await around, "around page");
    });
}

for (const reason of ["account change", "stop"] as const) {
    test(`${reason} cancels pending history without replaying it`, async () => {
        let calls = 0;
        const original: Fetch = () => ++calls;
        const h = harness(original);
        const pending = Promise.resolve(h.actions.fetchMessages({ channelId: "200000000000000001", before: "300000000000000001" }));
        const rejected = assert.rejects(pending, { name: "AbortError" });
        if (reason === "account change") h.switchAccount();
        else h.controls.uninstallChatLoadGuard();
        h.unlock();
        await rejected;
        assert.equal(calls, 0);
        if (reason === "stop") assert.equal(h.actions.fetchMessages, original);
    });
}

test("an open gate returns the original fetch result directly", () => {
    const page = { messages: [] };
    const h = harness(() => page);
    h.unlock();
    assert.equal(h.actions.fetchMessages({ channelId: "200000000000000001", limit: 50 }), page);
});

test("the MessageManager patch resumes the same routine with its full arguments and receiver", async () => {
    const patch = source.match(/find: '"MessageManager"',[\s\S]{0,250}?match: \/(.+?)\/,[\s\S]{0,100}?replace: "([^"]+)"/u);
    assert.ok(patch);
    const matcher = new RegExp(patch[1].replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"));
    const fixture = 'let logger=new Logger("MessageManager");function M(e){let{isPreload,channelId,forceFetch}=e;return load.call(this,e,arguments[1])}return M;';
    const patched = fixture.replace(matcher, patch[2]);
    assert.notEqual(patched, fixture);
    let calls = 0;
    const h = harness(() => { throw new Error("MessageManager must resume its own routine"); });
    const options = { channelId: "200000000000000001", before: "300000000000000001", limit: 50, forceFetch: true };
    const receiver = { name: "manager receiver" };
    const extra = { name: "manager argument" };
    const manager = new Function("Logger", "$self", "load", patched)(class {}, {
        shouldSuppressChatLoad: h.isGated,
        deferChatLoad: h.controls.deferChatLoad,
    }, function (this: unknown, received: unknown, receivedExtra: unknown) {
        assert.equal(this, receiver);
        assert.equal(received, options);
        assert.equal(receivedExtra, extra);
        calls++;
        return "manager page";
    }) as Fetch;
    const pending = manager.call(receiver, options, extra);
    assert.equal(calls, 0);
    h.unlock();
    assert.equal(await pending, "manager page");
    assert.equal(calls, 1);
});
