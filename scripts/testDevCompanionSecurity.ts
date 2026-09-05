/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build, type Plugin } from "esbuild";

import {
    COMPANION_AUTH_PROTOCOL,
    createCompanionAuthenticator,
    createCompanionAuthProof,
    isValidAuthSecret,
} from "../src/plugins/devCompanion.dev/auth";
import { parseIncomingMessage } from "../src/plugins/devCompanion.dev/types/recieve";

type DevCompanionModule = typeof import("../src/plugins/devCompanion.dev/initWs");

interface HarnessRuntime {
    authSecret: string;
    logs: unknown[][];
    reloads: number;
    toasts: Array<Record<string, unknown>>;
}

interface HarnessGlobal {
    __devCompanionHarness: HarnessRuntime;
}

type FakeEventType = "close" | "error" | "message" | "open";

class FakeWebSocket {
    static readonly CLOSED = 3;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly instances: FakeWebSocket[] = [];

    readonly closeCalls: Array<{ code?: number; reason?: string; }> = [];
    readonly listeners = new Map<FakeEventType, Array<(event: unknown) => void>>();
    readonly sent: string[] = [];
    readyState = FakeWebSocket.CONNECTING;

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type: FakeEventType, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    close(code?: number, reason?: string): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.closeCalls.push({ code, reason });
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
    }

    emitOpen(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open", {});
    }

    emitMessage(data: unknown): void {
        this.emit("message", { data });
    }

    send(data: string): void {
        assert.equal(this.readyState, FakeWebSocket.OPEN, "closed companion sockets must not send data");
        this.sent.push(data);
    }

    private emit(type: FakeEventType, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
}

const harnessGlobal = globalThis as typeof globalThis & HarnessGlobal;
const SECRET = "0123456789abcdef".repeat(4);
const OTHER_SECRET = "fedcba9876543210".repeat(4);
const CLIENT_NONCE_A = "11".repeat(32);
const CLIENT_NONCE_B = "22".repeat(32);
const SERVER_NONCE = "33".repeat(32);
const EXECUTION_SENTINEL = "__devCompanionRemoteCodeExecuted";
const LOG_SENTINEL = "__devCompanionSecretLogSentinel";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> {
    assert.ok(isRecord(value));
    return value;
}

function getString(value: unknown): string {
    if (typeof value !== "string") assert.fail("Expected a string value");
    return value;
}

function parseSent(socket: FakeWebSocket): Array<Record<string, unknown>> {
    return socket.sent.map(message => getRecord(JSON.parse(message)));
}

async function settle(): Promise<void> {
    for (let index = 0; index < 4; index++) await new Promise<void>(resolve => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, failureMessage: string): Promise<void> {
    const deadline = performance.now() + 5000;
    while (!condition()) {
        if (performance.now() >= deadline) assert.fail(failureMessage);
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
}

async function testAuthenticator(): Promise<void> {
    assert.equal(isValidAuthSecret(SECRET), true);
    for (const value of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64), null, 123])
        assert.equal(isValidAuthSecret(value), false, `${String(value)} must not be accepted as an authentication secret`);

    const authenticator = await createCompanionAuthenticator(SECRET, CLIENT_NONCE_A);
    assert.deepEqual(authenticator.hello, {
        type: "authHello",
        data: { clientNonce: CLIENT_NONCE_A, protocol: COMPANION_AUTH_PROTOCOL }
    });

    const serverProof = await createCompanionAuthProof(SECRET, "server", CLIENT_NONCE_A, SERVER_NONCE);
    const challenge = {
        type: "authChallenge",
        data: {
            clientNonce: CLIENT_NONCE_A,
            proof: serverProof,
            protocol: COMPANION_AUTH_PROTOCOL,
            serverNonce: SERVER_NONCE
        }
    };
    const response = await authenticator.receive(challenge);
    assert.equal(response.authenticated, false);
    if (response.authenticated) assert.fail("challenge response must precede authentication");
    assert.deepEqual(response.response, {
        type: "authResponse",
        data: {
            clientNonce: CLIENT_NONCE_A,
            proof: await createCompanionAuthProof(SECRET, "client", CLIENT_NONCE_A, SERVER_NONCE),
            protocol: COMPANION_AUTH_PROTOCOL,
            serverNonce: SERVER_NONCE
        }
    });

    const ready = {
        type: "authReady",
        data: {
            clientNonce: CLIENT_NONCE_A,
            proof: await createCompanionAuthProof(SECRET, "ready", CLIENT_NONCE_A, SERVER_NONCE),
            protocol: COMPANION_AUTH_PROTOCOL,
            serverNonce: SERVER_NONCE
        }
    };
    assert.deepEqual(await authenticator.receive(ready), { authenticated: true });
    await assert.rejects(authenticator.receive(challenge), /authentication failed/u,
        "an authenticated transcript must not accept replayed challenges");

    const replayTarget = await createCompanionAuthenticator(SECRET, CLIENT_NONCE_B);
    await assert.rejects(replayTarget.receive(challenge), /authentication failed/u,
        "a challenge captured from another connection must not authenticate a fresh nonce");

    const reflectionTarget = await createCompanionAuthenticator(SECRET, CLIENT_NONCE_A);
    const clientProof = await createCompanionAuthProof(SECRET, "client", CLIENT_NONCE_A, SERVER_NONCE);
    await assert.rejects(reflectionTarget.receive({
        ...challenge,
        data: { ...challenge.data, proof: clientProof }
    }), /authentication failed/u, "client and server proofs must be domain separated");

    const wrongSecretTarget = await createCompanionAuthenticator(SECRET, CLIENT_NONCE_A);
    await assert.rejects(wrongSecretTarget.receive({
        ...challenge,
        data: {
            ...challenge.data,
            proof: await createCompanionAuthProof(OTHER_SECRET, "server", CLIENT_NONCE_A, SERVER_NONCE)
        }
    }), /authentication failed/u);

    const extraFieldTarget = await createCompanionAuthenticator(SECRET, CLIENT_NONCE_A);
    await assert.rejects(extraFieldTarget.receive({
        ...challenge,
        unexpected: "field"
    }), /authentication failed/u, "authentication messages must use the exact protocol schema");

    const concurrentTarget = await createCompanionAuthenticator(SECRET, CLIENT_NONCE_A);
    const concurrent = await Promise.allSettled([concurrentTarget.receive(challenge), concurrentTarget.receive(challenge)]);
    assert.equal(concurrent.every(result => result.status === "rejected"), true,
        "concurrent duplicate challenges must permanently fail instead of racing authentication state");
}

function testCommandSchemas(): void {
    const validMessages: unknown[] = [
        { nonce: 1, type: "disable", data: { enabled: true, pluginName: "Example" } },
        { nonce: 2, type: "rawId", data: { id: 42 } },
        { nonce: 3, type: "diff", data: { extractType: "id", idOrSearch: 42 } },
        { nonce: 4, type: "reload", data: null },
        { nonce: 5, type: "extract", data: { extractType: "search", findType: "string", idOrSearch: "needle", usePatched: null } },
        {
            nonce: 6,
            type: "testPatch",
            data: {
                find: "needle",
                findType: "string",
                replacement: [{
                    match: { type: "string", value: "before" },
                    replace: { type: "regex", value: { flags: "u", pattern: "after" } }
                }]
            }
        },
        { nonce: 7, type: "testFind", data: { args: [{ type: "string", value: "prop" }], type: "findByProps" } },
        { nonce: 8, type: "allModules", data: null },
        { nonce: 9, type: "i18n", data: { hashedKey: "MESSAGE_KEY" } },
        { nonce: 10, type: "version", data: { server_version: [1, 2, 3] } },
    ];
    for (const message of validMessages)
        assert.notEqual(parseIncomingMessage(message), null, "each documented command family must retain a valid bounded schema");

    const invalidMessages: unknown[] = [
        { nonce: 1, type: "reload", data: null, extra: LOG_SENTINEL },
        { nonce: 1, type: "reload" },
        { nonce: -1, type: "reload", data: null },
        { nonce: 1, type: LOG_SENTINEL, data: null },
        { nonce: 1, type: "disable", data: { enabled: true, pluginName: "Example", extra: true } },
        { nonce: 1, type: "rawId", data: { id: 1.5 } },
        { nonce: 1, type: "diff", data: { extractType: "search", findType: "string", idOrSearch: "needle", extra: true } },
        { nonce: 1, type: "reload", data: {} },
        { nonce: 1, type: "extract", data: { extractType: "find", findArgs: [], findType: "findByProps" } },
        {
            nonce: 1,
            type: "testPatch",
            data: {
                find: "needle",
                findType: "string",
                replacement: [{
                    extra: true,
                    match: { type: "string", value: "before" },
                    replace: { type: "string", value: "after" }
                }]
            }
        },
        { nonce: 1, type: "testFind", data: { args: [{ type: "function", value: "malicious" }], type: "find" } },
        { nonce: 1, type: "allModules", data: {} },
        { nonce: 1, type: "i18n", data: { hashedKey: 123 } },
        { nonce: 1, type: "version", data: { server_version: [1, 2, 3, 4] } },
        { nonce: 1, type: "testFind", data: { args: [{ type: "string", value: "x".repeat(16 * 1024 + 1) }], type: "findByCode" } },
    ];
    for (const message of invalidMessages)
        assert.equal(parseIncomingMessage(message), null, "unknown, malformed, extra, and oversized command fields must be rejected");
}

const runtimeStubs: Plugin = {
    name: "dev-companion-security-runtime",
    setup(bundle) {
        const stub = (filter: RegExp, modulePath: string) =>
            bundle.onResolve({ filter }, () => ({ namespace: "dev-companion-test", path: modulePath }));

        stub(/^\.$/, "plugin-index");
        stub(/^@api\/Notices$/, "notices");
        stub(/^@api\/PluginManager$/, "plugin-manager");
        stub(/^@api\/Settings$/, "settings");
        stub(/^@components\/ErrorBoundary$/, "error-boundary");
        stub(/^@debug\/loadLazyChunks$/, "lazy-chunks");
        stub(/^@debug\/reporterData$/, "reporter-data");
        stub(/^@utils\/discord$/, "discord");
        stub(/^@utils\/patches$/, "patches");
        stub(/^@webpack$/, "webpack");
        stub(/^@webpack\/common$/, "webpack-common");
        stub(/^\.\.\/\.\.\/Vencord$/, "vencord");

        bundle.onLoad({ filter: /.*/, namespace: "dev-companion-test" }, args => {
            const modules: Record<string, string> = {
                "plugin-index": `
                    export const CLIENT_VERSION = [0, 2, 0];
                    export const PORT = 8485;
                    export const logger = Object.fromEntries(["debug", "error", "info", "warn"].map(level => [level, (...args) => globalThis.__devCompanionHarness.logs.push([level, ...args])]));
                    export const settings = { store: {
                        get authSecret() { return globalThis.__devCompanionHarness.authSecret; },
                        notifyOnAutoConnect: false,
                        reloadAfterToggle: false,
                        usePatchedModule: true
                    } };
                `,
                notices: "export const popNotice = () => undefined; export const showNotice = () => undefined;",
                "plugin-manager": `
                    export const plugins = {};
                    export const startDependenciesRecursive = () => ({ failures: [], restartNeeded: false });
                    export const startPlugin = () => false;
                    export const stopPlugin = () => false;
                `,
                settings: "export const Settings = { plugins: {} };",
                "error-boundary": "export default { wrap: component => component };",
                "lazy-chunks": "export const loadLazyChunks = async () => undefined;",
                "reporter-data": "export const reporterData = {};",
                discord: "export const getIntlMessageFromHash = () => 'translated';",
                patches: "export const canonicalizeMatch = value => value;",
                webpack: `
                    export const wreq = { c: {}, m: { 101: () => undefined, 202: () => undefined } };
                    export const search = () => ({});
                    export const findAll = () => [];
                    export const stringMatches = () => false;
                    const noMatch = () => () => false;
                    export const filters = { byClassNames: noMatch, byProps: noMatch, byStoreName: noMatch, byCode: noMatch, componentByCode: noMatch };
                `,
                "webpack-common": `
                    export const React = { createElement: (type, props, ...children) => ({ children, props, type }) };
                    export const Toasts = {
                        Position: { BOTTOM: 0, TOP: 1 },
                        Type: { FAILURE: 0, MESSAGE: 1, SUCCESS: 2 },
                        genId: () => "toast",
                        show: toast => globalThis.__devCompanionHarness.toasts.push(toast)
                    };
                    export const useState = value => [value, () => undefined];
                `,
                vencord: "export const WebpackPatcher = { getFactoryPatchedBy: () => new Set(), getFactoryPatchedSource: () => undefined };"
            };
            return { contents: modules[args.path], loader: "js" };
        });
    }
};

async function loadInitWs(): Promise<DevCompanionModule> {
    const directory = await mkdtemp(path.join(tmpdir(), "dev-companion-security-"));
    const output = path.join(directory, "initWs.mjs");
    try {
        await build({
            bundle: true,
            define: { IS_COMPANION_TEST: "false" },
            entryPoints: ["src/plugins/devCompanion.dev/initWs.tsx"],
            format: "esm",
            outfile: output,
            platform: "node",
            plugins: [runtimeStubs],
            target: "node24",
        });
        return await import(`${pathToFileURL(output).href}?security=${Date.now()}`) as DevCompanionModule;
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}

async function beginConnection(module: DevCompanionModule): Promise<FakeWebSocket> {
    module.initWs();
    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket, "a configured Dev Companion client must create a loopback socket");
    assert.equal(socket.url, "ws://127.0.0.1:8485");
    socket.emitOpen();
    await waitFor(() => socket.sent.length > 0 || socket.closeCalls.length > 0,
        "the client did not begin authentication");
    assert.equal(parseSent(socket)[0]?.type, "authHello", "the nonce-only authentication hello must be the first message");
    return socket;
}

async function authenticateSocket(socket: FakeWebSocket): Promise<void> {
    const hello = parseSent(socket)[0];
    const helloData = getRecord(hello.data);
    const clientNonce = getString(helloData.clientNonce);
    const proof = await createCompanionAuthProof(SECRET, "server", clientNonce, SERVER_NONCE);
    socket.emitMessage(JSON.stringify({
        type: "authChallenge",
        data: { clientNonce, proof, protocol: COMPANION_AUTH_PROTOCOL, serverNonce: SERVER_NONCE }
    }));
    await waitFor(() => socket.sent.length >= 2 || socket.closeCalls.length > 0,
        "the client did not answer a valid server challenge");
    assert.deepEqual(parseSent(socket).map(message => message.type), ["authHello", "authResponse"],
        "the client must not disclose module data after only the server challenge");

    socket.emitMessage(JSON.stringify({
        type: "authReady",
        data: {
            clientNonce,
            proof: await createCompanionAuthProof(SECRET, "ready", clientNonce, SERVER_NONCE),
            protocol: COMPANION_AUTH_PROTOCOL,
            serverNonce: SERVER_NONCE
        }
    }));
    await waitFor(() => parseSent(socket).some(message => message.type === "moduleList") || socket.closeCalls.length > 0,
        "the client did not finish a valid authentication transcript");
    assert.deepEqual(parseSent(socket).map(message => message.type), ["authHello", "authResponse", "moduleList"]);
}

async function testHostileServers(module: DevCompanionModule): Promise<void> {
    FakeWebSocket.instances.length = 0;
    harnessGlobal.__devCompanionHarness = { authSecret: "", logs: [], reloads: 0, toasts: [] };
    module.initWs();
    assert.equal(FakeWebSocket.instances.length, 0, "an empty or invalid secret must disable all network activity");

    harnessGlobal.__devCompanionHarness.authSecret = SECRET;
    const preAuthCommand = await beginConnection(module);
    assert.deepEqual(parseSent(preAuthCommand).map(message => message.type), ["authHello"],
        "module lists and reports must not be disclosed on socket open");
    preAuthCommand.emitMessage(JSON.stringify({
        nonce: 1,
        type: "testFind",
        data: { args: [{ type: "function", value: `() => globalThis.${EXECUTION_SENTINEL} = true` }], type: "find" }
    }));
    await settle();
    assert.deepEqual(preAuthCommand.closeCalls, [{ code: 1008, reason: "Authentication failed" }]);
    assert.deepEqual(parseSent(preAuthCommand).map(message => message.type), ["authHello"],
        "pre-authentication commands must receive no data or command response");

    const wrongProof = await beginConnection(module);
    const wrongHelloData = getRecord(parseSent(wrongProof)[0].data);
    const wrongClientNonce = getString(wrongHelloData.clientNonce);
    wrongProof.emitMessage(JSON.stringify({
        type: "authChallenge",
        data: {
            clientNonce: wrongClientNonce,
            proof: await createCompanionAuthProof(OTHER_SECRET, "server", wrongClientNonce, SERVER_NONCE),
            protocol: COMPANION_AUTH_PROTOCOL,
            serverNonce: SERVER_NONCE
        }
    }));
    await waitFor(() => wrongProof.closeCalls.length > 0, "an invalid proof did not close the connection");
    assert.equal(wrongProof.closeCalls[0]?.code, 1008, "a hostile server without the shared secret must be disconnected");

    const oversized = await beginConnection(module);
    oversized.emitMessage("x".repeat(module.MAX_COMPANION_MESSAGE_LENGTH + 1));
    assert.equal(oversized.closeCalls[0]?.code, 1008, "oversized pre-authentication input must fail before JSON parsing");

    const binary = await beginConnection(module);
    binary.emitMessage(new Uint8Array([1, 2, 3]));
    assert.equal(binary.closeCalls[0]?.code, 1008, "binary protocol input must fail closed");

    const authenticated = await beginConnection(module);
    await authenticateSocket(authenticated);
    authenticated.emitMessage(JSON.stringify({
        nonce: 7,
        type: "testPatch",
        data: {
            find: "safe",
            findType: "string",
            replacement: [{
                match: { type: "string", value: "safe" },
                replace: { type: "string", value: `globalThis.${EXECUTION_SENTINEL} = true` }
            }]
        }
    }));
    await waitFor(() => parseSent(authenticated).some(message => message.nonce === 7),
        "the disabled patch command did not return a bounded failure");
    const patchReply = parseSent(authenticated).find(message => message.nonce === 7);
    assert.equal(patchReply?.ok, false);
    assert.match(String(patchReply?.error), /disabled for security/u);
    authenticated.close(1000, "test complete");

    const functionNode = await beginConnection(module);
    await authenticateSocket(functionNode);
    const functionNodeResponseCount = functionNode.sent.length;
    functionNode.emitMessage(JSON.stringify({
        nonce: 8,
        type: "testFind",
        data: { args: [{ type: "function", value: `() => globalThis.${EXECUTION_SENTINEL} = true` }], type: "find" }
    }));
    await settle();
    assert.deepEqual(functionNode.closeCalls, [{ code: 1008, reason: "Invalid message" }]);
    assert.equal(functionNode.sent.length, functionNodeResponseCount,
        "a malformed nested command must be rejected before dispatch and receive no response");
    assert.equal(Reflect.has(globalThis, EXECUTION_SENTINEL), false, "authenticated messages must still be treated only as data");

    const extraField = await beginConnection(module);
    await authenticateSocket(extraField);
    const reloadsBeforeInvalidCommand = harnessGlobal.__devCompanionHarness.reloads;
    const extraFieldResponseCount = extraField.sent.length;
    extraField.emitMessage(JSON.stringify({
        nonce: 9,
        type: "reload",
        data: null,
        extra: LOG_SENTINEL
    }));
    await settle();
    assert.deepEqual(extraField.closeCalls, [{ code: 1008, reason: "Invalid message" }]);
    assert.equal(extraField.sent.length, extraFieldResponseCount,
        "an extra top-level field must fail the exact schema without a response");
    assert.equal(harnessGlobal.__devCompanionHarness.reloads, reloadsBeforeInvalidCommand,
        "a malformed reload command must be rejected before its side effect");

    const unknownCommand = await beginConnection(module);
    await authenticateSocket(unknownCommand);
    const unknownResponseCount = unknownCommand.sent.length;
    unknownCommand.emitMessage(JSON.stringify({ nonce: 10, type: LOG_SENTINEL, data: null }));
    await settle();
    assert.deepEqual(unknownCommand.closeCalls, [{ code: 1008, reason: "Invalid message" }]);
    assert.equal(unknownCommand.sent.length, unknownResponseCount,
        "unknown authenticated command types must be rejected without a response");
    assert.doesNotMatch(JSON.stringify(harnessGlobal.__devCompanionHarness.logs), new RegExp(LOG_SENTINEL, "u"),
        "server-controlled protocol data must not be reflected into logs");

    const rateLimited = await beginConnection(module);
    await authenticateSocket(rateLimited);
    const rateLimitResponseCount = rateLimited.sent.length;
    for (let nonce = 0; nonce < module.MAX_AUTHENTICATED_COMMANDS_PER_WINDOW; nonce++) {
        rateLimited.emitMessage(JSON.stringify({
            nonce,
            type: "version",
            data: { server_version: [1, 0, 0] }
        }));
    }
    assert.equal(rateLimited.sent.length, rateLimitResponseCount + module.MAX_AUTHENTICATED_COMMANDS_PER_WINDOW,
        "commands within the per-connection window must remain available");
    assert.equal(rateLimited.closeCalls.length, 0);

    rateLimited.emitMessage(JSON.stringify({
        nonce: module.MAX_AUTHENTICATED_COMMANDS_PER_WINDOW,
        type: "version",
        data: { server_version: [1, 0, 0] }
    }));
    assert.deepEqual(rateLimited.closeCalls, [{ code: 1008, reason: "Rate limit exceeded" }]);
    assert.equal(rateLimited.sent.length, rateLimitResponseCount + module.MAX_AUTHENTICATED_COMMANDS_PER_WINDOW,
        "the over-limit command must not reach dispatch or receive a response");
}

async function main(): Promise<void> {
    const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");

    await testAuthenticator();
    testCommandSchemas();

    const authSource = await readFile("src/plugins/devCompanion.dev/auth.ts", "utf8");
    const initSource = await readFile("src/plugins/devCompanion.dev/initWs.tsx", "utf8");
    const utilSource = await readFile("src/plugins/devCompanion.dev/util.tsx", "utf8");
    const receiveTypes = await readFile("src/plugins/devCompanion.dev/types/recieve.ts", "utf8");
    const indexSource = await readFile("src/plugins/devCompanion.dev/index.tsx", "utf8");
    const executableSource = `${authSource}\n${initSource}\n${utilSource}\n${receiveTypes}`;
    assert.doesNotMatch(executableSource, /\beval\b|\bFunction\s*\(/u,
        "Dev Companion must not compile or evaluate server-provided strings");
    assert.doesNotMatch(receiveTypes, /FunctionNode|type:\s*"function"/u,
        "the wire contract must not expose executable function nodes");
    assert.match(indexSource, /authSecret:[\s\S]{0,600}?default: ""/u,
        "authentication must remain opt-in and fail closed by default");
    assert.match(indexSource, /componentProps:\s*\{\s*type: "password"/u,
        "the shared authentication secret must not be displayed as ordinary text");

    harnessGlobal.__devCompanionHarness = { authSecret: SECRET, logs: [], reloads: 0, toasts: [] };
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket, writable: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis, writable: true });
    Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { reload: () => { harnessGlobal.__devCompanionHarness.reloads++; } },
        writable: true
    });

    try {
        await testHostileServers(await loadInitWs());
    } finally {
        for (const socket of FakeWebSocket.instances) socket.close(1000, "test cleanup");
        if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
        else Reflect.deleteProperty(globalThis, "WebSocket");
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else Reflect.deleteProperty(globalThis, "window");
        if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
        else Reflect.deleteProperty(globalThis, "location");
        Reflect.deleteProperty(globalThis, EXECUTION_SENTINEL);
    }

    console.log("Dev Companion authenticated channel security checks passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
