/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const ORBOLAY_PROTOCOL_VERSION = 1;
export const ORBOLAY_HANDSHAKE_TIMEOUT_MS = 10_000;
export const ORBOLAY_COMMAND_WINDOW_MS = 5_000;
export const ORBOLAY_MAX_COMMANDS_PER_WINDOW = 8;

const DOMAIN = "ProtonnCord/OrbolayBridge/v1";
const MAX_MESSAGE_BYTES = 16 * 1024;
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const encoder = new TextEncoder();

type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue; };

export type OrbolayControlCommand =
    | { cmd: "TOGGLE_MUTE"; }
    | { cmd: "TOGGLE_DEAF"; }
    | { cmd: "DISCONNECT"; }
    | { cmd: "STOP_STREAM"; }
    | {
        cmd: "NAVIGATE";
        guildId: string;
        channelId: string;
        messageId: string;
    };

export type OrbolayProtocolAction =
    | { type: "send"; data: string; }
    | { type: "authenticated"; }
    | { type: "command"; command: OrbolayControlCommand; }
    | { type: "close"; reason: string; };

interface ProtocolOptions {
    now?: () => number;
    randomBytes?: (length: number) => Uint8Array;
}

interface SessionMaterial {
    clientToServerKey: CryptoKey;
    serverToClientKey: CryptoKey;
    sessionId: string;
}

function encodeBase64Url(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
    if (!BASE64URL_256.test(value)) return null;
    try {
        const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
        const binary = atob(base64);
        if (binary.length !== 32) return null;
        const decoded = Uint8Array.from(binary, character => character.charCodeAt(0));
        return encodeBase64Url(decoded) === value ? decoded : null;
    } catch {
        return null;
    }
}

function secureRandomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
    if (depth > 16) return false;
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
    if (!isRecord(value)) return false;
    return Object.entries(value).every(([key, item]) => key !== "__proto__" && isJsonValue(item, depth + 1));
}

function canonicalJson(value: JsonValue): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy.buffer;
}

async function importHmacKey(value: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "raw",
        copyToArrayBuffer(value),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
    );
}

async function sign(key: CryptoKey, value: string): Promise<string> {
    return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function verify(key: CryptoKey, proof: unknown, value: string): Promise<boolean> {
    if (typeof proof !== "string") return false;
    const decoded = decodeBase64Url(proof);
    if (!decoded) return false;
    return crypto.subtle.verify("HMAC", key, copyToArrayBuffer(decoded), encoder.encode(value));
}

function handshakeInput(role: string, clientNonce: string, serverNonce: string): string {
    return `${DOMAIN}\n${role}\n${clientNonce}\n${serverNonce}`;
}

function acceptanceInput(clientNonce: string, serverNonce: string, sessionId: string): string {
    return `${DOMAIN}\nserver-acceptance\n${clientNonce}\n${serverNonce}\n${sessionId}`;
}

function envelopeInput(
    direction: "client-to-server" | "server-to-client",
    sessionId: string,
    sequence: number,
    payload: JsonValue
): string {
    return `${DOMAIN}\nenvelope\n${direction}\n${sessionId}\n${sequence}\n${canonicalJson(payload)}`;
}

async function importSharedSecret(sharedSecret: string): Promise<CryptoKey> {
    const bytes = decodeBase64Url(sharedSecret);
    if (!bytes) throw new Error("Orbolay requires a 256-bit base64url shared secret");
    return importHmacKey(bytes);
}

async function deriveSession(
    sharedSecret: string,
    clientNonce: string,
    serverNonce: string
): Promise<SessionMaterial> {
    const sharedKey = await importSharedSecret(sharedSecret);
    const deriveKey = async (direction: "client-to-server" | "server-to-client") => {
        const keyBytes = new Uint8Array(await crypto.subtle.sign(
            "HMAC",
            sharedKey,
            encoder.encode(handshakeInput(`${direction}-key`, clientNonce, serverNonce))
        ));
        return importHmacKey(keyBytes);
    };
    const [clientToServerKey, serverToClientKey, sessionId] = await Promise.all([
        deriveKey("client-to-server"),
        deriveKey("server-to-client"),
        sign(sharedKey, handshakeInput("session-id", clientNonce, serverNonce)),
    ]);
    return { clientToServerKey, serverToClientKey, sessionId };
}

function parseControlCommand(value: unknown): OrbolayControlCommand | null {
    if (!isRecord(value) || typeof value.cmd !== "string") return null;
    switch (value.cmd) {
        case "TOGGLE_MUTE":
        case "TOGGLE_DEAF":
        case "DISCONNECT":
        case "STOP_STREAM":
            return hasExactKeys(value, ["cmd"]) ? { cmd: value.cmd } : null;
        case "NAVIGATE":
            if (!hasExactKeys(value, ["cmd", "guildId", "channelId", "messageId"])) return null;
            if (typeof value.guildId !== "string" || !SNOWFLAKE.test(value.guildId)
                || typeof value.channelId !== "string" || !SNOWFLAKE.test(value.channelId)
                || typeof value.messageId !== "string" || !SNOWFLAKE.test(value.messageId)) return null;
            return {
                cmd: "NAVIGATE",
                guildId: value.guildId,
                channelId: value.channelId,
                messageId: value.messageId,
            };
        default:
            return null;
    }
}

export function isValidOrbolaySharedSecret(value: unknown): value is string {
    return typeof value === "string" && decodeBase64Url(value) !== null;
}

export function generateOrbolaySharedSecret(): string {
    return encodeBase64Url(secureRandomBytes(32));
}

export async function createOrbolayServerChallenge(
    sharedSecret: string,
    clientNonce: string,
    serverNonce = encodeBase64Url(secureRandomBytes(32))
): Promise<string> {
    if (!decodeBase64Url(clientNonce) || !decodeBase64Url(serverNonce) || clientNonce === serverNonce)
        throw new Error("Invalid Orbolay handshake nonce");
    const key = await importSharedSecret(sharedSecret);
    return JSON.stringify({
        type: "AUTH_CHALLENGE",
        version: ORBOLAY_PROTOCOL_VERSION,
        clientNonce,
        serverNonce,
        proof: await sign(key, handshakeInput("server-challenge", clientNonce, serverNonce)),
    });
}

export async function createOrbolayServerAcceptance(
    sharedSecret: string,
    clientNonce: string,
    serverNonce: string
): Promise<string> {
    const session = await deriveSession(sharedSecret, clientNonce, serverNonce);
    return JSON.stringify({
        type: "AUTH_OK",
        version: ORBOLAY_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        proof: await sign(
            session.serverToClientKey,
            acceptanceInput(clientNonce, serverNonce, session.sessionId)
        ),
    });
}

export async function createOrbolayCompanionCommand(
    sharedSecret: string,
    clientNonce: string,
    serverNonce: string,
    sequence: number,
    command: OrbolayControlCommand
): Promise<string> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid Orbolay sequence");
    const session = await deriveSession(sharedSecret, clientNonce, serverNonce);
    return JSON.stringify({
        type: "ENVELOPE",
        version: ORBOLAY_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        sequence,
        payload: command,
        mac: await sign(
            session.serverToClientKey,
            envelopeInput("server-to-client", session.sessionId, sequence, command)
        ),
    });
}

export class OrbolayAuthenticatedProtocol {
    private state: "idle" | "challenge" | "acceptance" | "authenticated" | "closed" = "idle";
    private clientNonce = "";
    private serverNonce = "";
    private session: SessionMaterial | null = null;
    private handshakeDeadline = 0;
    private inboundSequence = 0;
    private outboundSequence = 0;
    private commandTimestamps: number[] = [];

    private readonly now: () => number;
    private readonly randomBytes: (length: number) => Uint8Array;

    constructor(private readonly sharedSecret: string, options: ProtocolOptions = {}) {
        if (!isValidOrbolaySharedSecret(sharedSecret))
            throw new Error("Orbolay requires a 256-bit base64url shared secret");
        this.now = options.now ?? Date.now;
        this.randomBytes = options.randomBytes ?? secureRandomBytes;
    }

    get authenticated(): boolean {
        return this.state === "authenticated";
    }

    start(): string {
        if (this.state !== "idle") throw new Error("Orbolay authentication has already started");
        const nonce = this.randomBytes(32);
        if (nonce.byteLength !== 32) throw new Error("Orbolay nonce generation failed");
        this.clientNonce = encodeBase64Url(nonce);
        this.handshakeDeadline = this.now() + ORBOLAY_HANDSHAKE_TIMEOUT_MS;
        this.state = "challenge";
        return JSON.stringify({
            type: "AUTH_HELLO",
            version: ORBOLAY_PROTOCOL_VERSION,
            clientNonce: this.clientNonce,
        });
    }

    invalidate(): void {
        this.state = "closed";
        this.clientNonce = "";
        this.serverNonce = "";
        this.session = null;
        this.commandTimestamps = [];
    }

    async encode(payload: JsonValue): Promise<string | null> {
        const { session } = this;
        if (!this.authenticated || !session) return null;
        if (!isJsonValue(payload)) throw new Error("Invalid Orbolay outbound payload");

        const sequence = this.outboundSequence + 1;
        const mac = await sign(
            session.clientToServerKey,
            envelopeInput("client-to-server", session.sessionId, sequence, payload)
        );
        if (!this.authenticated || this.session !== session) return null;
        const encoded = JSON.stringify({
            type: "ENVELOPE",
            version: ORBOLAY_PROTOCOL_VERSION,
            sessionId: session.sessionId,
            sequence,
            payload,
            mac,
        });
        if (encoder.encode(encoded).byteLength > MAX_MESSAGE_BYTES)
            throw new Error("Orbolay outbound payload is too large");
        this.outboundSequence = sequence;
        return encoded;
    }

    async receive(raw: unknown): Promise<readonly OrbolayProtocolAction[]> {
        if (this.state === "closed") return [];
        if (typeof raw !== "string" || encoder.encode(raw).byteLength > MAX_MESSAGE_BYTES)
            return this.fail("Orbolay rejected an invalid message");

        let message: unknown;
        try {
            message = JSON.parse(raw);
        } catch {
            return this.fail("Orbolay rejected malformed JSON");
        }

        if ((this.state === "challenge" || this.state === "acceptance") && this.now() >= this.handshakeDeadline)
            return this.fail("Orbolay authentication timed out");

        if (this.state === "challenge") return this.receiveChallenge(message);
        if (this.state === "acceptance") return this.receiveAcceptance(message);
        if (this.state === "authenticated") return this.receiveEnvelope(message);
        return this.fail("Orbolay authentication was not started");
    }

    private fail(reason: string): readonly OrbolayProtocolAction[] {
        this.invalidate();
        return [{ type: "close", reason }];
    }

    private async receiveChallenge(message: unknown): Promise<readonly OrbolayProtocolAction[]> {
        if (!isRecord(message)
            || !hasExactKeys(message, ["type", "version", "clientNonce", "serverNonce", "proof"])
            || message.type !== "AUTH_CHALLENGE"
            || message.version !== ORBOLAY_PROTOCOL_VERSION
            || message.clientNonce !== this.clientNonce
            || typeof message.serverNonce !== "string"
            || !decodeBase64Url(message.serverNonce)
            || message.serverNonce === this.clientNonce) return this.fail("Orbolay authentication failed");

        const { clientNonce } = this;
        const { serverNonce } = message;
        const key = await importSharedSecret(this.sharedSecret);
        if (this.state !== "challenge" || this.clientNonce !== clientNonce) return [];
        const verified = await verify(
            key,
            message.proof,
            handshakeInput("server-challenge", clientNonce, serverNonce)
        );
        if (this.state !== "challenge" || this.clientNonce !== clientNonce) return [];
        if (!verified) return this.fail("Orbolay authentication failed");

        const session = await deriveSession(this.sharedSecret, clientNonce, serverNonce);
        if (this.state !== "challenge" || this.clientNonce !== clientNonce) return [];
        const proof = await sign(key, handshakeInput("client-response", clientNonce, serverNonce));
        if (this.state !== "challenge" || this.clientNonce !== clientNonce) return [];

        this.serverNonce = serverNonce;
        this.session = session;
        this.state = "acceptance";
        return [{
            type: "send",
            data: JSON.stringify({
                type: "AUTH_RESPONSE",
                version: ORBOLAY_PROTOCOL_VERSION,
                clientNonce,
                serverNonce,
                proof,
            }),
        }];
    }

    private async receiveAcceptance(message: unknown): Promise<readonly OrbolayProtocolAction[]> {
        if (!this.session
            || !isRecord(message)
            || !hasExactKeys(message, ["type", "version", "sessionId", "proof"])
            || message.type !== "AUTH_OK"
            || message.version !== ORBOLAY_PROTOCOL_VERSION
            || message.sessionId !== this.session.sessionId) return this.fail("Orbolay authentication failed");

        const { session } = this;
        const verified = await verify(
            session.serverToClientKey,
            message.proof,
            acceptanceInput(this.clientNonce, this.serverNonce, session.sessionId)
        );
        if (this.state !== "acceptance" || this.session !== session) return [];
        if (!verified) return this.fail("Orbolay authentication failed");

        this.state = "authenticated";
        return [{ type: "authenticated" }];
    }

    private async receiveEnvelope(message: unknown): Promise<readonly OrbolayProtocolAction[]> {
        if (!this.session
            || !isRecord(message)
            || !hasExactKeys(message, ["type", "version", "sessionId", "sequence", "payload", "mac"])
            || message.type !== "ENVELOPE"
            || message.version !== ORBOLAY_PROTOCOL_VERSION
            || message.sessionId !== this.session.sessionId
            || typeof message.sequence !== "number"
            || !Number.isSafeInteger(message.sequence)
            || message.sequence !== this.inboundSequence + 1) return this.fail("Orbolay rejected an invalid envelope");

        const command = parseControlCommand(message.payload);
        if (!command) return this.fail("Orbolay rejected an invalid command");
        const { session } = this;
        const verified = await verify(
            session.serverToClientKey,
            message.mac,
            envelopeInput("server-to-client", session.sessionId, message.sequence, command)
        );
        if (this.state !== "authenticated" || this.session !== session) return [];
        if (!verified) return this.fail("Orbolay rejected an invalid command");

        this.inboundSequence = message.sequence;
        const now = this.now();
        this.commandTimestamps = this.commandTimestamps.filter(
            timestamp => now - timestamp < ORBOLAY_COMMAND_WINDOW_MS
        );
        if (this.commandTimestamps.length >= ORBOLAY_MAX_COMMANDS_PER_WINDOW)
            return this.fail("Orbolay command rate limit exceeded");
        this.commandTimestamps.push(now);
        return [{ type: "command", command }];
    }
}
