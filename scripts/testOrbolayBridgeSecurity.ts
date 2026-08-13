/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { build, type Plugin } from "esbuild";

import {
    createOrbolayCompanionCommand,
    createOrbolayServerAcceptance,
    createOrbolayServerChallenge,
    generateOrbolaySharedSecret,
    isValidOrbolaySharedSecret,
    OrbolayAuthenticatedProtocol,
    ORBOLAY_COMMAND_WINDOW_MS,
    ORBOLAY_HANDSHAKE_TIMEOUT_MS,
    ORBOLAY_MAX_COMMANDS_PER_WINDOW,
    type OrbolayProtocolAction,
} from "../src/equicordplugins/orbolayBridge/protocol";

const USER_ID = "111111111111111111";
const GUILD_ID = "222222222222222222";
const CHANNEL_ID = "333333333333333333";
const MESSAGE_ID = "444444444444444444";
const PRIVATE_NOTIFICATION = "ORBolay-private-notification-must-not-leak-before-auth";

interface HarnessRuntime {
    currentUserReads: number;
    dispatches: unknown[];
    settings: {
        port: unknown;
        sharedSecret: unknown;
    };
    toasts: unknown[];
}

interface HarnessGlobal {
    __orbolayBridgeHarness: HarnessRuntime;
}

interface OrbolayPlugin {
    flux: {
        RPC_NOTIFICATION_CREATE(dispatch: unknown): void;
        SPEAKING(dispatch: unknown): void;
        STREAMER_MODE(dispatch: unknown): void;
        VOICE_STATE_UPDATES(dispatch: unknown): Promise<void>;
    };
    settings: {
        def: {
            sharedSecret: {
                cloudSync?: boolean;
            };
        };
    };
    start(): void;
    stop(): void;
}

interface CloseRecord {
    code: number | undefined;
    reason: string | undefined;
}

const harnessGlobal = globalThis as typeof globalThis & HarnessGlobal;

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly sockets: FakeWebSocket[] = [];

    readonly closes: CloseRecord[] = [];
    readonly sent: string[] = [];
    readonly url: string;
    readyState = FakeWebSocket.CONNECTING;

    onclose: ((event: CloseEvent) => unknown) | null = null;
    onerror: ((event: Event) => unknown) | null = null;
    onmessage: ((event: MessageEvent) => unknown) | null = null;
    onopen: ((event: Event) => unknown) | null = null;

    constructor(url: string | URL) {
        this.url = String(url);
        FakeWebSocket.sockets.push(this);
    }

    close(code?: number, reason?: string): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.closes.push({ code, reason });
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new Event("close") as CloseEvent);
    }

    open(): void {
        assert.equal(this.readyState, FakeWebSocket.CONNECTING);
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
    }

    receive(data: unknown): void {
        assert.equal(this.readyState, FakeWebSocket.OPEN);
        this.onmessage?.({ data } as MessageEvent);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        assert.equal(this.readyState, FakeWebSocket.OPEN);
        assert.equal(typeof data, "string", "the bridge must only emit bounded protocol strings");
        if (typeof data === "string") this.sent.push(data);
    }
}

const runtimeStubs: Plugin = {
    name: "orbolay-bridge-hermetic-runtime",
    setup(bundle) {
        const stub = (filter: RegExp, modulePath: string) =>
            bundle.onResolve({ filter }, () => ({ namespace: "orbolay-test", path: modulePath }));
        stub(/^@api\/Settings$/, "settings");
        stub(/^@utils\/constants$/, "constants");
        stub(/^@utils\/Logger$/, "logger");
        stub(/^@utils\/misc$/, "misc");
        stub(/^@utils\/types$/, "types");
        stub(/^@webpack\/common$/, "webpack-common");

        bundle.onLoad({ filter: /^settings$/, namespace: "orbolay-test" }, () => ({
            contents: `
                export function definePluginSettings(def) {
                    const result = { def };
                    Object.defineProperty(result, "store", {
                        get: () => globalThis.__orbolayBridgeHarness.settings
                    });
                    return result;
                }
            `,
            loader: "js",
        }));
        bundle.onLoad({ filter: /^constants$/, namespace: "orbolay-test" }, () => ({
            contents: "export const EquicordDevs = { SpikeHD: { name: 'SpikeHD' } };",
            loader: "js",
        }));
        bundle.onLoad({ filter: /^logger$/, namespace: "orbolay-test" }, () => ({
            contents: `
                export class Logger {
                    info() {}
                    warn() {}
                }
            `,
            loader: "js",
        }));
        bundle.onLoad({ filter: /^misc$/, namespace: "orbolay-test" }, () => ({
            contents: "export const sleep = async () => undefined;",
            loader: "js",
        }));
        bundle.onLoad({ filter: /^types$/, namespace: "orbolay-test" }, () => ({
            contents: `
                export const OptionType = { NUMBER: 1, STRING: 2 };
                export default function definePlugin(plugin) { return plugin; }
            `,
            loader: "js",
        }));
        bundle.onLoad({ filter: /^webpack-common$/, namespace: "orbolay-test" }, () => ({
            contents: `
                const runtime = () => globalThis.__orbolayBridgeHarness;
                export const ChannelStore = {
                    getChannel: () => ({ guild_id: "${GUILD_ID}" })
                };
                export const FluxDispatcher = {
                    dispatch: value => runtime().dispatches.push(value)
                };
                export const GuildMemberStore = {
                    getNick: () => "private nickname"
                };
                export const StreamerModeStore = { enabled: true };
                export const Toasts = {
                    Type: { FAILURE: 0, MESSAGE: 1, SUCCESS: 2 },
                    genId: () => "toast-id",
                    show: value => runtime().toasts.push(value)
                };
                export const UserStore = {
                    getCurrentUser() {
                        runtime().currentUserReads++;
                        return { id: "${USER_ID}", globalName: "private user", username: "private-user" };
                    },
                    getUser: () => ({ avatar: "private-avatar", globalName: "private user", username: "private-user" })
                };
                export const VoiceStateStore = {
                    getVoiceStateForUser: () => null,
                    getVoiceStatesForChannel: () => ({})
                };
            `,
            loader: "js",
        }));
    },
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRecord(raw: string): Record<string, unknown> {
    const value: unknown = JSON.parse(raw);
    assert.ok(isRecord(value));
    return value;
}

function requireString(value: unknown): string {
    if (typeof value !== "string") throw new Error("Expected a protocol string field");
    return value;
}

function isOrbolayPlugin(value: unknown): value is OrbolayPlugin {
    if (!isRecord(value) || typeof value.start !== "function" || typeof value.stop !== "function") return false;
    const { flux } = value;
    const { settings } = value;
    return isRecord(flux)
        && typeof flux.RPC_NOTIFICATION_CREATE === "function"
        && typeof flux.SPEAKING === "function"
        && typeof flux.STREAMER_MODE === "function"
        && typeof flux.VOICE_STATE_UPDATES === "function"
        && isRecord(settings)
        && isRecord(settings.def)
        && isRecord(settings.def.sharedSecret);
}

function expectClose(actions: readonly OrbolayProtocolAction[], label: string): void {
    assert.equal(actions.length, 1, `${label} must produce exactly one terminal action`);
    const [action] = actions;
    assert.equal(action?.type, "close", `${label} must fail closed`);
}

function expectSend(actions: readonly OrbolayProtocolAction[], label: string): string {
    assert.equal(actions.length, 1, `${label} must produce exactly one response`);
    const [action] = actions;
    assert.equal(action?.type, "send", `${label} must produce a protocol response`);
    if (!action || action.type !== "send") throw new Error(`${label} did not produce a send action`);
    return action.data;
}

function startProtocol(
    secret: string,
    byte = 7,
    now?: () => number
): { clientNonce: string; protocol: OrbolayAuthenticatedProtocol; } {
    const protocol = new OrbolayAuthenticatedProtocol(secret, {
        now,
        randomBytes: length => new Uint8Array(length).fill(byte),
    });
    const helloRaw = protocol.start();
    const hello = parseRecord(helloRaw);
    assert.deepEqual(Object.keys(hello).sort(), ["clientNonce", "type", "version"]);
    assert.equal(hello.type, "AUTH_HELLO");
    assert.equal(hello.version, 1);
    assert.doesNotMatch(helloRaw, new RegExp(secret, "u"), "the shared secret must never cross the socket");
    return { clientNonce: requireString(hello.clientNonce), protocol };
}

async function authenticateProtocol(
    secret = generateOrbolaySharedSecret(),
    byte = 7,
    now?: () => number
): Promise<{
    clientNonce: string;
    protocol: OrbolayAuthenticatedProtocol;
    secret: string;
    serverNonce: string;
}> {
    const { clientNonce, protocol } = startProtocol(secret, byte, now);
    let serverNonce = generateOrbolaySharedSecret();
    while (serverNonce === clientNonce) serverNonce = generateOrbolaySharedSecret();
    const responseRaw = expectSend(
        await protocol.receive(await createOrbolayServerChallenge(secret, clientNonce, serverNonce)),
        "valid server challenge"
    );
    const response = parseRecord(responseRaw);
    assert.deepEqual(Object.keys(response).sort(), ["clientNonce", "proof", "serverNonce", "type", "version"]);
    assert.equal(response.type, "AUTH_RESPONSE");
    assert.equal(response.clientNonce, clientNonce);
    assert.equal(response.serverNonce, serverNonce);
    assert.equal(protocol.authenticated, false, "the server must prove session-key possession before data flows");

    const actions = await protocol.receive(
        await createOrbolayServerAcceptance(secret, clientNonce, serverNonce)
    );
    assert.deepEqual(actions, [{ type: "authenticated" }]);
    assert.equal(protocol.authenticated, true);
    return { clientNonce, protocol, secret, serverNonce };
}

async function testSecretAndHandshakeBoundary(): Promise<void> {
    const secret = generateOrbolaySharedSecret();
    const secondSecret = generateOrbolaySharedSecret();
    const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastCharacterIndex = base64UrlAlphabet.indexOf(secret.at(-1) ?? "");
    assert.equal(lastCharacterIndex % 4, 0);
    const nonCanonicalSecret = `${secret.slice(0, -1)}${base64UrlAlphabet[lastCharacterIndex + 1]}`;
    assert.equal(isValidOrbolaySharedSecret(secret), true);
    assert.equal(isValidOrbolaySharedSecret(secondSecret), true);
    assert.equal(secret.length, 43);
    assert.notEqual(secret, secondSecret, "independent installations must not reuse a fixed credential");
    for (const invalid of [
        "",
        "A".repeat(42),
        "A".repeat(44),
        `${"A".repeat(42)}=`,
        "!".repeat(43),
        nonCanonicalSecret,
        null,
        123,
    ]) {
        assert.equal(isValidOrbolaySharedSecret(invalid), false);
    }

    const { clientNonce, protocol } = startProtocol(secret);
    assert.equal(await protocol.encode({ cmd: "REGISTER_CONFIG", userId: USER_ID }), null,
        "identity data must not be encodable before authentication");

    const serverNonce = secondSecret === clientNonce ? generateOrbolaySharedSecret() : secondSecret;
    const responseRaw = expectSend(
        await protocol.receive(await createOrbolayServerChallenge(secret, clientNonce, serverNonce)),
        "authenticated challenge"
    );
    assert.equal(protocol.authenticated, false);
    assert.equal(await protocol.encode({ cmd: "MESSAGE_NOTIFICATION", body: PRIVATE_NOTIFICATION }), null,
        "notification data must remain blocked during mutual authentication");
    assert.doesNotMatch(responseRaw, new RegExp(secret, "u"));

    assert.deepEqual(
        await protocol.receive(await createOrbolayServerAcceptance(secret, clientNonce, serverNonce)),
        [{ type: "authenticated" }]
    );
    const firstEnvelope = parseRecord(requireString(await protocol.encode({ cmd: "REGISTER_CONFIG", userId: USER_ID })));
    const secondEnvelope = parseRecord(requireString(await protocol.encode({ cmd: "STREAMER_MODE", enabled: true })));
    assert.equal(firstEnvelope.type, "ENVELOPE");
    assert.equal(firstEnvelope.sequence, 1);
    assert.equal(secondEnvelope.sequence, 2);
    assert.notEqual(firstEnvelope.mac, secondEnvelope.mac);
    assert.throws(() => protocol.start(), /already started/u);
}

async function testHostileHandshakeInputs(): Promise<void> {
    const secret = generateOrbolaySharedSecret();

    {
        const { protocol } = startProtocol(secret);
        expectClose(await protocol.receive(JSON.stringify({ cmd: "DISCONNECT" })), "plaintext pre-auth command");
        assert.equal(protocol.authenticated, false);
        assert.equal(await protocol.encode({ cmd: "REGISTER_CONFIG", userId: USER_ID }), null);
    }

    {
        const { protocol } = startProtocol(secret);
        expectClose(await protocol.receive("{"), "malformed JSON");
    }

    {
        const { protocol } = startProtocol(secret);
        expectClose(await protocol.receive(new Uint8Array([1, 2, 3])), "binary frame");
    }

    {
        const { protocol } = startProtocol(secret);
        expectClose(await protocol.receive(JSON.stringify({ padding: "x".repeat(17 * 1024) })), "oversized frame");
    }

    {
        const { clientNonce, protocol } = startProtocol(secret);
        const wrongSecret = generateOrbolaySharedSecret();
        expectClose(
            await protocol.receive(await createOrbolayServerChallenge(wrongSecret, clientNonce)),
            "challenge signed by the wrong peer"
        );
    }

    {
        const { clientNonce, protocol } = startProtocol(secret);
        const challenge = parseRecord(await createOrbolayServerChallenge(secret, clientNonce));
        challenge.extra = true;
        expectClose(await protocol.receive(JSON.stringify(challenge)), "challenge with an undeclared field");
    }

    {
        const { protocol } = startProtocol(secret);
        const unrelatedNonce = generateOrbolaySharedSecret();
        expectClose(
            await protocol.receive(await createOrbolayServerChallenge(secret, unrelatedNonce)),
            "challenge replayed against another client nonce"
        );
    }

    {
        let now = 10_000;
        const { clientNonce, protocol } = startProtocol(secret, 7, () => now);
        now += ORBOLAY_HANDSHAKE_TIMEOUT_MS;
        expectClose(
            await protocol.receive(await createOrbolayServerChallenge(secret, clientNonce)),
            "challenge at the expired deadline"
        );
    }

    {
        const { clientNonce, protocol } = startProtocol(secret);
        const challenge = await createOrbolayServerChallenge(secret, clientNonce);
        expectSend(await protocol.receive(challenge), "first challenge");
        expectClose(await protocol.receive(challenge), "replayed challenge");
    }

    {
        const { clientNonce, protocol } = startProtocol(secret);
        const serverNonce = generateOrbolaySharedSecret();
        expectSend(
            await protocol.receive(await createOrbolayServerChallenge(secret, clientNonce, serverNonce)),
            "challenge before malformed acceptance"
        );
        const acceptance = parseRecord(await createOrbolayServerAcceptance(secret, clientNonce, serverNonce));
        acceptance.extra = true;
        expectClose(await protocol.receive(JSON.stringify(acceptance)), "acceptance with an undeclared field");
    }

    {
        const first = startProtocol(secret, 3);
        const firstServerNonce = generateOrbolaySharedSecret();
        expectSend(
            await first.protocol.receive(await createOrbolayServerChallenge(
                secret, first.clientNonce, firstServerNonce
            )),
            "first-session challenge"
        );
        const firstAcceptance = await createOrbolayServerAcceptance(
            secret, first.clientNonce, firstServerNonce
        );
        const second = startProtocol(secret, 4);
        const secondServerNonce = generateOrbolaySharedSecret();
        expectSend(
            await second.protocol.receive(await createOrbolayServerChallenge(
                secret, second.clientNonce, secondServerNonce
            )),
            "reconnected-session challenge"
        );
        expectClose(await second.protocol.receive(firstAcceptance), "acceptance replay after reconnect");
    }

    {
        const protocol = new OrbolayAuthenticatedProtocol(secret, {
            randomBytes: () => new Uint8Array(31),
        });
        assert.throws(() => protocol.start(), /nonce generation failed/u);
    }
}

async function testCommandAuthenticationSchemasAndReplay(): Promise<void> {
    {
        const { protocol } = await authenticateProtocol();
        const reflected = await protocol.encode({ cmd: "DISCONNECT" });
        assert.ok(reflected);
        expectClose(await protocol.receive(reflected), "reflected client-to-server envelope");
    }

    {
        const { clientNonce, protocol, secret, serverNonce } = await authenticateProtocol();
        const command = await createOrbolayCompanionCommand(
            secret,
            clientNonce,
            serverNonce,
            1,
            { cmd: "NAVIGATE", guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }
        );
        assert.deepEqual(await protocol.receive(command), [{
            type: "command",
            command: { cmd: "NAVIGATE", guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID },
        }]);
        expectClose(await protocol.receive(command), "replayed command sequence");
    }

    {
        const { clientNonce, protocol, secret, serverNonce } = await authenticateProtocol();
        const forged = parseRecord(await createOrbolayCompanionCommand(
            secret, clientNonce, serverNonce, 1, { cmd: "DISCONNECT" }
        ));
        forged.mac = "A".repeat(43);
        expectClose(await protocol.receive(JSON.stringify(forged)), "forged command MAC");
    }

    {
        const { clientNonce, protocol, secret, serverNonce } = await authenticateProtocol();
        expectClose(await protocol.receive(await createOrbolayCompanionCommand(
            secret, clientNonce, serverNonce, 2, { cmd: "DISCONNECT" }
        )), "out-of-order command sequence");
    }

    for (const mutate of [
        (envelope: Record<string, unknown>) => { envelope.extra = true; },
        (envelope: Record<string, unknown>) => { envelope.sequence = 1.5; },
        (envelope: Record<string, unknown>) => { envelope.sessionId = generateOrbolaySharedSecret(); },
        (envelope: Record<string, unknown>) => {
            envelope.payload = { cmd: "DISCONNECT", extra: true };
        },
        (envelope: Record<string, unknown>) => {
            envelope.payload = { cmd: "NAVIGATE", guildId: GUILD_ID, channelId: "../escape", messageId: MESSAGE_ID };
        },
        (envelope: Record<string, unknown>) => { envelope.payload = { cmd: "UNKNOWN" }; },
    ]) {
        const { clientNonce, protocol, secret, serverNonce } = await authenticateProtocol();
        const envelope = parseRecord(await createOrbolayCompanionCommand(
            secret, clientNonce, serverNonce, 1, { cmd: "DISCONNECT" }
        ));
        mutate(envelope);
        expectClose(await protocol.receive(JSON.stringify(envelope)), "non-canonical command envelope");
    }

    {
        const secret = generateOrbolaySharedSecret();
        const first = await authenticateProtocol(secret, 3);
        const second = await authenticateProtocol(secret, 4);
        const firstSessionCommand = await createOrbolayCompanionCommand(
            secret,
            first.clientNonce,
            first.serverNonce,
            1,
            { cmd: "TOGGLE_MUTE" }
        );
        expectClose(await second.protocol.receive(firstSessionCommand), "cross-session command replay");
    }
}

async function testCommandRateLimit(): Promise<void> {
    let now = 50_000;
    const session = await authenticateProtocol(generateOrbolaySharedSecret(), 7, () => now);
    for (let sequence = 1; sequence <= ORBOLAY_MAX_COMMANDS_PER_WINDOW; sequence++) {
        assert.deepEqual(await session.protocol.receive(await createOrbolayCompanionCommand(
            session.secret,
            session.clientNonce,
            session.serverNonce,
            sequence,
            { cmd: "TOGGLE_DEAF" }
        )), [{ type: "command", command: { cmd: "TOGGLE_DEAF" } }]);
    }
    expectClose(await session.protocol.receive(await createOrbolayCompanionCommand(
        session.secret,
        session.clientNonce,
        session.serverNonce,
        ORBOLAY_MAX_COMMANDS_PER_WINDOW + 1,
        { cmd: "TOGGLE_DEAF" }
    )), "command burst over the limit");

    now = 75_000;
    const resetSession = await authenticateProtocol(generateOrbolaySharedSecret(), 8, () => now);
    for (let sequence = 1; sequence <= ORBOLAY_MAX_COMMANDS_PER_WINDOW; sequence++) {
        const actions = await resetSession.protocol.receive(await createOrbolayCompanionCommand(
            resetSession.secret,
            resetSession.clientNonce,
            resetSession.serverNonce,
            sequence,
            { cmd: "DISCONNECT" }
        ));
        assert.equal(actions[0]?.type, "command");
    }
    now += ORBOLAY_COMMAND_WINDOW_MS;
    assert.equal((await resetSession.protocol.receive(await createOrbolayCompanionCommand(
        resetSession.secret,
        resetSession.clientNonce,
        resetSession.serverNonce,
        ORBOLAY_MAX_COMMANDS_PER_WINDOW + 1,
        { cmd: "DISCONNECT" }
    )))[0]?.type, "command", "a completed window must release capacity");
}

function resetHarness(sharedSecret: unknown, port: unknown = 6888): HarnessRuntime {
    const runtime: HarnessRuntime = {
        currentUserReads: 0,
        dispatches: [],
        settings: { port, sharedSecret },
        toasts: [],
    };
    harnessGlobal.__orbolayBridgeHarness = runtime;
    FakeWebSocket.sockets.length = 0;
    return runtime;
}

async function loadPlugin(): Promise<OrbolayPlugin> {
    const result = await build({
        bundle: true,
        entryPoints: ["src/equicordplugins/orbolayBridge/index.tsx"],
        format: "esm",
        platform: "browser",
        plugins: [runtimeStubs],
        target: "es2022",
        write: false,
    });
    assert.equal(result.outputFiles.length, 1);
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`;
    const loaded: unknown = await import(moduleUrl);
    assert.ok(isRecord(loaded));
    const plugin = loaded.default;
    assert.ok(isOrbolayPlugin(plugin));
    return plugin;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`Timed out waiting for ${label}`);
}

function emitSensitiveEvents(plugin: OrbolayPlugin): Promise<void> {
    plugin.flux.SPEAKING({ userId: USER_ID, speakingFlags: 1 });
    plugin.flux.RPC_NOTIFICATION_CREATE({
        body: PRIVATE_NOTIFICATION,
        icon: "private-icon",
        message: { channel_id: CHANNEL_ID, guild_id: GUILD_ID, id: MESSAGE_ID },
        title: "private-title",
    });
    plugin.flux.STREAMER_MODE({ value: true });
    return plugin.flux.VOICE_STATE_UPDATES({
        voiceStates: [{
            channelId: CHANNEL_ID,
            deaf: false,
            guildId: GUILD_ID,
            mute: false,
            oldChannelId: null,
            selfDeaf: false,
            selfMute: false,
            selfStream: true,
            userId: USER_ID,
        }],
    });
}

async function testHermeticLoopbackBoundary(): Promise<void> {
    const websocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket, writable: true });
    try {
        resetHarness("");
        const plugin = await loadPlugin();
        assert.equal(plugin.settings.def.sharedSecret.cloudSync, false,
            "the per-install pairing secret must be explicitly excluded from cloud sync");

        plugin.start();
        assert.equal(FakeWebSocket.sockets.length, 0, "an unpaired bridge must not open a socket");
        assert.equal(isValidOrbolaySharedSecret(harnessGlobal.__orbolayBridgeHarness.settings.sharedSecret), true,
            "first enablement must create a high-entropy pairing secret");
        plugin.stop();

        resetHarness("not-a-secret");
        plugin.start();
        assert.equal(FakeWebSocket.sockets.length, 0, "an invalid credential must disable the bridge");
        plugin.stop();

        const secret = generateOrbolaySharedSecret();
        resetHarness(secret, "6888@attacker.example");
        plugin.start();
        assert.equal(FakeWebSocket.sockets.length, 0, "tampered port settings must not escape loopback");
        plugin.stop();

        const preAuthRuntime = resetHarness(secret);
        plugin.start();
        assert.equal(FakeWebSocket.sockets.length, 1);
        const [preAuthSocket] = FakeWebSocket.sockets;
        assert.ok(preAuthSocket);
        assert.equal(preAuthSocket.url, "ws://127.0.0.1:6888");
        assert.equal(preAuthSocket.sent.length, 0, "no state may flow before transport establishment");
        preAuthSocket.open();
        assert.equal(preAuthSocket.sent.length, 1);
        assert.equal(parseRecord(preAuthSocket.sent[0]).type, "AUTH_HELLO");
        await emitSensitiveEvents(plugin);
        assert.equal(preAuthRuntime.currentUserReads, 0, "pre-auth events must not even read identity state");
        assert.equal(preAuthRuntime.dispatches.length, 0);
        assert.equal(preAuthSocket.sent.length, 1, "identity, notification, voice, and stream state must stay silent");
        assert.doesNotMatch(preAuthSocket.sent[0], new RegExp(`${USER_ID}|${PRIVATE_NOTIFICATION}`, "u"));
        preAuthSocket.receive(JSON.stringify({ cmd: "DISCONNECT" }));
        await waitUntil(() => preAuthSocket.closes.length === 1, "legacy peer rejection");
        assert.equal(preAuthSocket.closes[0]?.code, 1008);
        assert.equal(preAuthRuntime.dispatches.length, 0, "plaintext controls must never reach Discord");
        plugin.stop();

        const forgedRuntime = resetHarness(secret);
        plugin.start();
        const [forgedSocket] = FakeWebSocket.sockets;
        assert.ok(forgedSocket);
        forgedSocket.open();
        const forgedHello = parseRecord(forgedSocket.sent[0]);
        forgedSocket.receive(await createOrbolayServerChallenge(
            generateOrbolaySharedSecret(),
            requireString(forgedHello.clientNonce)
        ));
        await waitUntil(() => forgedSocket.closes.length === 1, "forged companion rejection");
        assert.equal(forgedSocket.sent.length, 1);
        assert.equal(forgedRuntime.currentUserReads, 0);
        assert.equal(forgedRuntime.dispatches.length, 0);
        plugin.stop();

        const authenticatedRuntime = resetHarness(secret);
        plugin.start();
        const [authenticatedSocket] = FakeWebSocket.sockets;
        assert.ok(authenticatedSocket);
        authenticatedSocket.open();
        const hello = parseRecord(authenticatedSocket.sent[0]);
        const clientNonce = requireString(hello.clientNonce);
        let serverNonce = generateOrbolaySharedSecret();
        while (serverNonce === clientNonce) serverNonce = generateOrbolaySharedSecret();
        authenticatedSocket.receive(await createOrbolayServerChallenge(secret, clientNonce, serverNonce));
        await waitUntil(() => authenticatedSocket.sent.length === 2, "client challenge response");
        assert.equal(parseRecord(authenticatedSocket.sent[1]).type, "AUTH_RESPONSE");
        await emitSensitiveEvents(plugin);
        assert.equal(authenticatedSocket.sent.length, 2,
            "a proved server challenge alone must not unlock outbound state");
        assert.equal(authenticatedRuntime.currentUserReads, 0);
        assert.equal(authenticatedRuntime.dispatches.length, 0);
        for (const raw of authenticatedSocket.sent) {
            assert.doesNotMatch(raw, new RegExp(`${USER_ID}|${PRIVATE_NOTIFICATION}|${secret}`, "u"));
        }

        authenticatedSocket.receive(await createOrbolayServerAcceptance(secret, clientNonce, serverNonce));
        await waitUntil(() => authenticatedSocket.sent.length >= 4, "post-auth initial state");
        assert.ok(authenticatedRuntime.currentUserReads > 0);
        for (const raw of authenticatedSocket.sent.slice(2)) {
            assert.equal(parseRecord(raw).type, "ENVELOPE", "post-auth data must remain authenticated");
            assert.doesNotMatch(raw, new RegExp(secret, "u"), "the shared secret must never be transmitted");
        }

        const disconnect = await createOrbolayCompanionCommand(
            secret,
            clientNonce,
            serverNonce,
            1,
            { cmd: "DISCONNECT" }
        );
        authenticatedSocket.receive(disconnect);
        await waitUntil(() => authenticatedRuntime.dispatches.length === 1, "authenticated control dispatch");
        assert.deepEqual(authenticatedRuntime.dispatches, [{ type: "VOICE_CHANNEL_SELECT", channelId: null }]);
        authenticatedSocket.receive(disconnect);
        await waitUntil(() => authenticatedSocket.closes.length === 1, "loopback replay rejection");
        assert.equal(authenticatedRuntime.dispatches.length, 1, "replayed controls must never dispatch twice");
        plugin.stop();
    } finally {
        if (websocketDescriptor) Object.defineProperty(globalThis, "WebSocket", websocketDescriptor);
        else Reflect.deleteProperty(globalThis, "WebSocket");
    }
}

async function main(): Promise<void> {
    await testSecretAndHandshakeBoundary();
    await testHostileHandshakeInputs();
    await testCommandAuthenticationSchemasAndReplay();
    await testCommandRateLimit();
    await testHermeticLoopbackBoundary();
    console.log("Orbolay authenticated loopback security checks passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
