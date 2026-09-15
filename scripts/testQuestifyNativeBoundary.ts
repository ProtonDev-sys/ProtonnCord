/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import type { IpcMainInvokeEvent } from "electron";
import { build, type Plugin } from "esbuild";

type NativeModule = typeof import("../src/equicordplugins/questify/native");

interface HarnessRuntime {
    pluginEnabled: boolean;
}

interface HarnessGlobal {
    __questifyNativeHarness: HarnessRuntime;
}

interface FetchCall {
    init: RequestInit | undefined;
    url: string;
}

const APP_ID = "123456789012345678";
const QUEST_ID = "234567890123456789";
const AUTH_CODE = "synthetic_oauth-code.123~";
const ACTIVITY_TOKEN = "synthetic.activity-token_123~";
const QUEST_TARGET = 42;
const PROXY_TICKET = "synthetic ticket&scope=one";
const ACTIVITY_REFERRER = `https://${APP_ID}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=synthetic+ticket%26scope%3Done`;

const harnessGlobal = globalThis as typeof globalThis & HarnessGlobal;
harnessGlobal.__questifyNativeHarness = { pluginEnabled: true };

const runtimeStubs: Plugin = {
    name: "questify-native-runtime-stubs",
    setup(bundle) {
        bundle.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "questify-test" }));
        bundle.onResolve({ filter: /^@main\/settings$/ }, () => ({ path: "settings", namespace: "questify-test" }));
        bundle.onLoad({ filter: /^electron$/, namespace: "questify-test" }, () => ({
            contents: `
                export const BrowserWindow = {
                    fromWebContents: () => null
                };
            `,
            loader: "js"
        }));
        bundle.onLoad({ filter: /^settings$/, namespace: "questify-test" }, () => ({
            contents: `
                const store = {
                    get plugins() {
                        return {
                            Questify: { enabled: globalThis.__questifyNativeHarness.pluginEnabled }
                        };
                    }
                };
                export const RendererSettings = { store };
                export const Settings = { store };
            `,
            loader: "js"
        }));
    }
};

function discordEvent(url: string, topLevel = true, destroyed = false): IpcMainInvokeEvent {
    const mainFrame = { url };
    const senderFrame = topLevel ? mainFrame : { url };
    return {
        sender: {
            isDestroyed: () => destroyed,
            isDevToolsOpened: () => false,
            mainFrame,
            openDevTools: () => undefined,
        },
        senderFrame,
    } as unknown as IpcMainInvokeEvent;
}

function fetchUrl(input: string | URL | Request): string {
    return input instanceof Request ? input.url : String(input);
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
    return Object.fromEntries(new Headers(init?.headers).entries());
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
        status,
    });
}

async function loadNative(): Promise<NativeModule> {
    const result = await build({
        bundle: true,
        entryPoints: ["src/equicordplugins/questify/native.ts"],
        format: "esm",
        platform: "node",
        plugins: [runtimeStubs],
        target: "node22",
        write: false,
    });
    assert.equal(result.outputFiles.length, 1);
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`;
    return await import(moduleUrl) as NativeModule;
}

async function invokeComplete(
    native: NativeModule,
    event: IpcMainInvokeEvent = discordEvent("https://discord.com/channels/@me/1"),
    appId: unknown = APP_ID,
    authCode: unknown = AUTH_CODE,
    questTarget: unknown = QUEST_TARGET,
    questId: unknown = QUEST_ID,
    proxyTicket: unknown = PROXY_TICKET
): Promise<{ error: string | null; success: boolean; }> {
    return await (native.complete as (
        event: IpcMainInvokeEvent,
        appId: unknown,
        authCode: unknown,
        questTarget: unknown,
        questId: unknown,
        proxyTicket?: unknown
    ) => Promise<{ error: string | null; success: boolean; }>)(
        event,
        appId,
        authCode,
        questTarget,
        questId,
        proxyTicket
    );
}

async function testValidFlow(native: NativeModule): Promise<void> {
    const originalFetch = globalThis.fetch;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input, init) => {
        const url = fetchUrl(input);
        calls.push({ init, url });
        if (new URL(url).pathname === "/.proxy/acf/authorize") return jsonResponse({ token: ACTIVITY_TOKEN });
        return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
        const result = await invokeComplete(native);
        assert.deepEqual(result, { error: null, success: true });
        assert.equal(calls.length, 2, "a valid completion must perform one authorization and one progress request");

        const [authorization, progress] = calls;
        assert.equal(authorization.url, `https://${APP_ID}.discordsays.com/.proxy/acf/authorize`);
        assert.equal(progress.url, `https://${APP_ID}.discordsays.com/.proxy/acf/quest/progress`);
        for (const call of calls) {
            const url = new URL(call.url);
            assert.equal(url.protocol, "https:");
            assert.equal(url.hostname, `${APP_ID}.discordsays.com`);
            assert.equal(url.port, "");
            assert.equal(url.username, "");
            assert.equal(url.password, "");
            assert.equal(call.init?.method, "POST");
            assert.equal(call.init?.mode, "cors");
            assert.equal(call.init?.credentials, "omit");
            assert.equal(call.init?.redirect, "error", "Questify native requests must never follow redirects");
            assert.ok(call.init?.signal instanceof AbortSignal, "Questify native requests must have a timeout signal");
        }

        assert.equal(authorization.init?.body, JSON.stringify({ code: AUTH_CODE }));
        assert.equal(progress.init?.body, JSON.stringify({ progress: QUEST_TARGET }));
        const authorizationHeaders = headerRecord(authorization.init);
        const progressHeaders = headerRecord(progress.init);
        assert.deepEqual(authorizationHeaders, {
            "content-type": "application/json",
            referer: ACTIVITY_REFERRER,
            "x-discord-quest-id": QUEST_ID,
        });
        assert.deepEqual(progressHeaders, {
            "content-type": "application/json",
            referer: ACTIVITY_REFERRER,
            "x-auth-token": ACTIVITY_TOKEN,
            "x-discord-quest-id": QUEST_ID,
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testOptionalProxyTicket(native: NativeModule): Promise<void> {
    const originalFetch = globalThis.fetch;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input, init) => {
        calls.push({ init, url: fetchUrl(input) });
        return calls.length === 1 ? jsonResponse({ token: ACTIVITY_TOKEN }) : new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
        const result = await native.complete(
            discordEvent("https://discord.com/channels/@me/1"),
            APP_ID,
            AUTH_CODE,
            QUEST_TARGET,
            QUEST_ID
        );
        assert.deepEqual(result, { error: null, success: true });
        assert.equal(calls.length, 2);
        for (const call of calls) {
            assert.equal(headerRecord(call.init).referer, undefined,
                "an omitted proxy ticket must not produce a synthetic Referer header");
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testTrustedRendererOrigins(native: NativeModule): Promise<void> {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return fetchCalls % 2 === 1 ? jsonResponse({ token: ACTIVITY_TOKEN }) : new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
        for (const origin of ["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"]) {
            const result = await invokeComplete(native, discordEvent(`${origin}/channels/@me/1`));
            assert.deepEqual(result, { error: null, success: true }, `${origin} must remain supported`);
        }
        assert.equal(fetchCalls, 6);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testAcceptedSnowflakeBoundaries(native: NativeModule): Promise<void> {
    const originalFetch = globalThis.fetch;
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input, init) => {
        const url = fetchUrl(input);
        calls.push({ init, url });
        return new URL(url).pathname.endsWith("/authorize")
            ? jsonResponse({ token: ACTIVITY_TOKEN })
            : new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
        const boundaries = [
            ["12345678901234567", "23456789012345678"],
            ["12345678901234567890", "23456789012345678901"],
        ] as const;
        for (const [appId, questId] of boundaries) {
            const result = await invokeComplete(
                native,
                undefined,
                appId,
                AUTH_CODE,
                QUEST_TARGET,
                questId,
                PROXY_TICKET
            );
            assert.deepEqual(result, { error: null, success: true });
            const pair = calls.slice(-2);
            assert.equal(pair.length, 2);
            assert.equal(new URL(pair[0].url).hostname, `${appId}.discordsays.com`);
            assert.equal(new URL(pair[1].url).hostname, `${appId}.discordsays.com`);
            assert.equal(headerRecord(pair[0].init)["x-discord-quest-id"], questId);
            assert.equal(headerRecord(pair[1].init)["x-discord-quest-id"], questId);
        }
        assert.equal(calls.length, 4);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function expectNoFetch(
    native: NativeModule,
    label: string,
    args: Parameters<typeof invokeComplete>
): Promise<void> {
    await expectNoFetchAction(label, () => invokeComplete(...args));
}

async function expectNoFetchAction(
    label: string,
    action: () => Promise<{ error: string | null; success: boolean; }>
): Promise<void> {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls++;
        throw new Error(`unexpected fetch for ${label}`);
    }) as typeof fetch;
    try {
        const result = await action();
        assert.equal(result.success, false, `${label} must fail closed`);
        assert.equal(fetchCalls, 0, `${label} must be rejected before network access`);
        assert.ok(typeof result.error === "string" && result.error.length <= 1024,
            `${label} must return a bounded error`);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testSenderAndPluginBoundary(native: NativeModule): Promise<void> {
    const validArgs = [native] as Parameters<typeof invokeComplete>;
    harnessGlobal.__questifyNativeHarness.pluginEnabled = false;
    try {
        await expectNoFetch(native, "disabled Questify plugin", validArgs);
    } finally {
        harnessGlobal.__questifyNativeHarness.pluginEnabled = true;
    }

    const invalidEvents = [
        discordEvent("http://discord.com/channels/@me/1"),
        discordEvent("https://evil.example/channels/@me/1"),
        discordEvent("https://discord.com.evil.example/channels/@me/1"),
        discordEvent("https://user@discord.com/channels/@me/1"),
        discordEvent("https://discord.com:444/channels/@me/1"),
        discordEvent("data:text/html,evil"),
        discordEvent("https://discord.com/channels/@me/1", false),
        discordEvent("https://discord.com/channels/@me/1", true, true),
        {} as IpcMainInvokeEvent,
    ];
    const disposedFrame = discordEvent("https://discord.com/channels/@me/1");
    Object.defineProperty(disposedFrame.senderFrame, "url", {
        get() { throw new Error("Render frame was disposed"); }
    });
    invalidEvents.push(disposedFrame);

    for (const [index, event] of invalidEvents.entries()) {
        await expectNoFetch(native, `untrusted renderer ${index}`, [native, event]);
    }
}

async function testInputBoundary(native: NativeModule): Promise<void> {
    const event = discordEvent("https://discord.com/channels/@me/1");
    const rawComplete = native.complete as (
        event: IpcMainInvokeEvent,
        appId: unknown,
        authCode: unknown,
        questTarget: unknown,
        questId: unknown,
        proxyTicket?: unknown
    ) => Promise<{ error: string | null; success: boolean; }>;
    const missingRequiredFields = [
        () => rawComplete(event, undefined, AUTH_CODE, QUEST_TARGET, QUEST_ID, PROXY_TICKET),
        () => rawComplete(event, APP_ID, undefined, QUEST_TARGET, QUEST_ID, PROXY_TICKET),
        () => rawComplete(event, APP_ID, AUTH_CODE, undefined, QUEST_ID, PROXY_TICKET),
        () => rawComplete(event, APP_ID, AUTH_CODE, QUEST_TARGET, undefined, PROXY_TICKET),
    ];
    for (const [index, action] of missingRequiredFields.entries()) {
        await expectNoFetchAction(`missing required field ${index}`, action);
    }

    const invalidAppIds: unknown[] = [
        "",
        "1234567890123456",
        "123456789012345678901",
        "１２３４５６７８９０１２３４５６７８",
        " 123456789012345678",
        "123456789012345678 ",
        "12345678901234567\n",
        "attacker.example/",
        "attacker.example\\",
        "attacker.example#",
        "attacker.example?",
        "u@127.0.0.1/",
        "u@[::1]/",
        "123.discordsays.com@attacker.example/",
        "https://attacker.example/",
        null,
        123456789012345678n,
        {},
    ];
    for (const [index, value] of invalidAppIds.entries()) {
        await expectNoFetch(native, `invalid app ID ${index}`, [native, undefined, value]);
    }

    const invalidQuestIds: unknown[] = [
        "",
        "1234567890123456",
        "123456789012345678901",
        "12345678901234567\n",
        "not-a-snowflake",
        null,
        234567890123456789n,
    ];
    for (const [index, value] of invalidQuestIds.entries()) {
        await expectNoFetch(native, `invalid quest ID ${index}`, [native, undefined, undefined, undefined, undefined, value]);
    }

    const invalidAuthCodes: unknown[] = [
        "",
        "   ",
        "code\nheader",
        "code\0value",
        "x".repeat(16 * 1024),
        null,
        123,
    ];
    for (const [index, value] of invalidAuthCodes.entries()) {
        await expectNoFetch(native, `invalid authorization code ${index}`, [native, undefined, undefined, value]);
    }

    const invalidTargets: unknown[] = [NaN, Infinity, -Infinity, -1, 0.5, 86_401, Number.MAX_SAFE_INTEGER, "42", null];
    for (const [index, value] of invalidTargets.entries()) {
        await expectNoFetch(native, `invalid quest target ${index}`, [native, undefined, undefined, undefined, value]);
    }

    const invalidProxyTickets: unknown[] = [
        "",
        "   ",
        "ticket\nheader",
        "ticket\rheader",
        "ticket\0value",
        "x".repeat(16 * 1024),
        null,
        123,
    ];
    for (const [index, value] of invalidProxyTickets.entries()) {
        await expectNoFetch(native, `invalid proxy ticket ${index}`, [native, undefined, undefined, undefined, undefined, undefined, value]);
    }
}

async function testResponseTokenBoundary(native: NativeModule): Promise<void> {
    const invalidTokens: unknown[] = ["", "   ", "token\nheader", "token\0value", "x".repeat(16 * 1024), null, 123];
    const originalFetch = globalThis.fetch;
    try {
        for (const [index, token] of invalidTokens.entries()) {
            let fetchCalls = 0;
            globalThis.fetch = (async () => {
                fetchCalls++;
                return jsonResponse({ token });
            }) as typeof fetch;
            const result = await invokeComplete(native);
            assert.equal(result.success, false, `invalid response token ${index} must fail closed`);
            assert.equal(fetchCalls, 1, `invalid response token ${index} must not reach the progress endpoint`);
            assert.ok(typeof result.error === "string" && result.error.length <= 1024);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testBoundedAuthorizationResponse(native: NativeModule): Promise<void> {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    let fetchCalls = 0;
    let pulls = 0;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
            pull(controller) {
                if (++pulls > 64) {
                    controller.close();
                    return;
                }
                controller.enqueue(new Uint8Array(64 * 1024));
            }
        }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
        const result = await invokeComplete(native);
        assert.equal(result.success, false);
        assert.equal(fetchCalls, 1, "an oversized authorization response must not reach the progress endpoint");
        assert.equal(cancelled, true, "an oversized authorization response body must be cancelled");
        assert.ok(typeof result.error === "string" && result.error.length <= 1024,
            "oversized responses must produce a bounded error");
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testErrorRedaction(native: NativeModule): Promise<void> {
    const originalFetch = globalThis.fetch;
    const sentinel = "QUESTIFY_REMOTE_ERROR_SENTINEL_DO_NOT_LEAK";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return jsonResponse({ details: sentinel }, 502);
    }) as typeof fetch;
    try {
        const result = await invokeComplete(native);
        assert.equal(result.success, false);
        assert.equal(fetchCalls, 1);
        assert.doesNotMatch(result.error ?? "", new RegExp(sentinel, "u"),
            "remote response details must not be reflected across the native boundary");
        assert.ok(typeof result.error === "string" && result.error.length <= 1024);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function main(): Promise<void> {
    const native = await loadNative();
    await testValidFlow(native);
    await testOptionalProxyTicket(native);
    await testTrustedRendererOrigins(native);
    await testAcceptedSnowflakeBoundaries(native);
    await testSenderAndPluginBoundary(native);
    await testInputBoundary(native);
    await testResponseTokenBoundary(native);
    await testBoundedAuthorizationResponse(native);
    await testErrorRedaction(native);
    console.log("Questify native network boundary checks passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
