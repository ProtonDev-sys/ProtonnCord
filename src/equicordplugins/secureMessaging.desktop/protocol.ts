/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const KEY_ANNOUNCEMENT_PREFIX = "PCEK1:";
export const LEGACY_ENCRYPTED_MESSAGE_PREFIX = "PCEM1:";
export const PREVIOUS_ENCRYPTED_MESSAGE_PREFIX = "PCEM2:";
export const ENCRYPTED_MESSAGE_PREFIX = "PCEM3:";
export const PROTOCOL_VERSION = 1 as const;
export const PREVIOUS_ENCRYPTED_MESSAGE_VERSION = 2 as const;
export const ENCRYPTED_MESSAGE_VERSION = 3 as const;
export const MAX_DISCORD_MESSAGE_LENGTH = 2_000;
export const MAX_SELECTED_RECIPIENTS = 24;

const SNOWFLAKE = /^\d{17,20}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_48 = /^[A-Za-z0-9_-]{64}$/;
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const BASE64URL_16 = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

export interface PrivateIdentity {
    createdAt: number;
    hpkePrivateKey: string;
    hpkePublicKey: string;
    signingPrivateKey: string;
    signingPublicKey: string;
}

export interface PublicIdentity {
    fingerprint: string;
    hpkePublicKey: string;
    signingPublicKey: string;
    userId: string;
}

export interface UnsignedKeyAnnouncement {
    v: typeof PROTOCOL_VERSION;
    t: "k";
    u: string;
    d: number;
    s: string;
    e: string;
}

export interface KeyAnnouncement extends UnsignedKeyAnnouncement {
    z: string;
}

export interface WrappedContentKey {
    u: string;
    e: string;
    x: string;
}

export interface UnsignedEncryptedEnvelope {
    v: typeof PROTOCOL_VERSION | typeof PREVIOUS_ENCRYPTED_MESSAGE_VERSION | typeof ENCRYPTED_MESSAGE_VERSION;
    t: "m";
    i: string;
    c: string;
    s: string;
    d: number;
    q: number;
    k: string;
    r: WrappedContentKey[];
    /** Discord user IDs intentionally exposed as authenticated mention metadata in PCEM3. */
    m?: string[];
    n: string;
    x: string;
}

export interface EncryptedEnvelope extends UnsignedEncryptedEnvelope {
    z: string;
}

export interface EncryptedEnvelopeContext {
    channelId: string;
    discordAuthorId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isTimestamp(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1_700_000_000_000 && (value as number) <= 9_999_999_999_999;
}

export function isProtocolTimestamp(value: unknown): value is number {
    return isTimestamp(value);
}

export function isEnvelopeId(value: unknown): value is string {
    return typeof value === "string" && (UUID.test(value) || (BASE64URL_16.test(value) && isCanonicalBase64Url(value, 16)));
}

export function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && SNOWFLAKE.test(value);
}

export function requireSnowflake(value: unknown, field: string): string {
    if (!isSnowflake(value)) throw new Error(`${field} must be a Discord snowflake`);
    return value;
}

export function encodeBase64Url(value: ArrayBufferLike | ArrayBufferView): string {
    const bytes = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8_192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string, expectedBytes?: number): Uint8Array {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value");
    if (expectedBytes !== undefined && value.length !== Math.ceil(expectedBytes * 8 / 6))
        throw new Error(`Expected ${expectedBytes} decoded bytes`);
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    let binary: string;
    try {
        binary = atob(padded);
    } catch {
        throw new Error("Invalid base64url value");
    }
    const result = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (expectedBytes !== undefined && result.byteLength !== expectedBytes)
        throw new Error(`Expected ${expectedBytes} decoded bytes`);
    if (encodeBase64Url(result) !== value) throw new Error("Non-canonical base64url value");
    return result;
}

function isCanonicalBase64Url(value: unknown, expectedBytes: number): value is string {
    if (typeof value !== "string") return false;
    try {
        decodeBase64Url(value, expectedBytes);
        return true;
    } catch {
        return false;
    }
}

function isCanonicalVariableBase64Url(value: unknown, minimumBytes: number, maximumCharacters: number): value is string {
    if (typeof value !== "string" || value.length > maximumCharacters || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
    try {
        return decodeBase64Url(value).byteLength >= minimumBytes;
    } catch {
        return false;
    }
}

function parseJsonAfterPrefix(content: string, prefix: string): unknown {
    if (typeof content !== "string" || content.length > MAX_DISCORD_MESSAGE_LENGTH || !content.startsWith(prefix))
        throw new Error("Unsupported secure-message payload");
    try {
        return JSON.parse(content.slice(prefix.length));
    } catch {
        throw new Error("Malformed secure-message JSON");
    }
}

export function isKeyAnnouncement(content: unknown): content is string {
    return typeof content === "string" && content.startsWith(KEY_ANNOUNCEMENT_PREFIX);
}

export function isEncryptedMessage(content: unknown): content is string {
    return typeof content === "string" &&
        (content.startsWith(ENCRYPTED_MESSAGE_PREFIX) || content.startsWith(PREVIOUS_ENCRYPTED_MESSAGE_PREFIX) ||
            content.startsWith(LEGACY_ENCRYPTED_MESSAGE_PREFIX));
}

/** Extract canonical Discord user-mention IDs from visible plaintext. */
export function extractMentionedUserIds(content: string): string[] {
    if (typeof content !== "string") throw new Error("Mention source must be text");
    const userIds = new Set<string>();
    for (const match of content.matchAll(/<@!?(\d{17,20})>/gu)) userIds.add(match[1]);
    return [...userIds].sort((left, right) => left.localeCompare(right));
}

export function parseKeyAnnouncement(content: string): KeyAnnouncement {
    const value = parseJsonAfterPrefix(content, KEY_ANNOUNCEMENT_PREFIX);
    if (!isRecord(value) || !hasExactKeys(value, ["v", "t", "u", "d", "s", "e", "z"]))
        throw new Error("Malformed key announcement");
    if (value.v !== PROTOCOL_VERSION || value.t !== "k" || !isSnowflake(value.u) || !isTimestamp(value.d) ||
        typeof value.s !== "string" || !BASE64URL_32.test(value.s) || !isCanonicalBase64Url(value.s, 32) ||
        typeof value.e !== "string" || !BASE64URL_32.test(value.e) || !isCanonicalBase64Url(value.e, 32) ||
        typeof value.z !== "string" || !BASE64URL_64.test(value.z) || !isCanonicalBase64Url(value.z, 64))
        throw new Error("Invalid key announcement fields");
    const announcement = value as unknown as KeyAnnouncement;
    if (JSON.stringify(announcement) !== content.slice(KEY_ANNOUNCEMENT_PREFIX.length))
        throw new Error("Key announcement is not canonically encoded");
    return announcement;
}

function validateEnvelopeFields(value: Record<string, unknown>): EncryptedEnvelope {
    if (!isRecord(value)) throw new Error("Malformed encrypted envelope");
    const current = value.v === ENCRYPTED_MESSAGE_VERSION;
    if (!hasExactKeys(value, current
        ? ["v", "t", "i", "c", "s", "d", "q", "k", "r", "m", "n", "x", "z"]
        : ["v", "t", "i", "c", "s", "d", "q", "k", "r", "n", "x", "z"]))
        throw new Error("Malformed encrypted envelope");
    const validId = value.v === PROTOCOL_VERSION
        ? typeof value.i === "string" && UUID.test(value.i)
        : (value.v === PREVIOUS_ENCRYPTED_MESSAGE_VERSION || value.v === ENCRYPTED_MESSAGE_VERSION) &&
            typeof value.i === "string" && BASE64URL_16.test(value.i) && isCanonicalBase64Url(value.i, 16);
    if (!validId || value.t !== "m" ||
        !isSnowflake(value.c) || !isSnowflake(value.s) || !isTimestamp(value.d) ||
        !Number.isSafeInteger(value.q) || (value.q as number) < 1 ||
        typeof value.k !== "string" || !BASE64URL_32.test(value.k) || !isCanonicalBase64Url(value.k, 32) ||
        !isCanonicalBase64Url(value.n, 12) || !isCanonicalVariableBase64Url(value.x, 17, MAX_DISCORD_MESSAGE_LENGTH) ||
        typeof value.z !== "string" || !BASE64URL_64.test(value.z) || !isCanonicalBase64Url(value.z, 64) || !Array.isArray(value.r) ||
        value.r.length < 1 || value.r.length > MAX_SELECTED_RECIPIENTS + 1)
        throw new Error("Invalid encrypted envelope fields");

    const recipients = value.r as unknown[];
    let previousUserId = "";
    for (const recipient of recipients) {
        if (!isRecord(recipient) || !hasExactKeys(recipient, ["u", "e", "x"]) || !isSnowflake(recipient.u) ||
            typeof recipient.e !== "string" || !BASE64URL_32.test(recipient.e) || !isCanonicalBase64Url(recipient.e, 32) ||
            typeof recipient.x !== "string" || !BASE64URL_48.test(recipient.x) || !isCanonicalBase64Url(recipient.x, 48) ||
            recipient.u <= previousUserId)
            throw new Error("Invalid or unsorted encrypted recipient entry");
        previousUserId = recipient.u;
    }

    if (current) {
        if (!Array.isArray(value.m) || value.m.length > MAX_SELECTED_RECIPIENTS)
            throw new Error("Invalid encrypted mentioned users");
        const recipientIds = new Set(recipients.map(recipient => (recipient as Record<string, unknown>).u));
        let previousMentionId = "";
        for (const userId of value.m) {
            if (!isSnowflake(userId) || userId <= previousMentionId || !recipientIds.has(userId))
                throw new Error("Invalid or unsorted encrypted mentioned user");
            previousMentionId = userId;
        }
    }
    return value as unknown as EncryptedEnvelope;
}

function compactEnvelopeWire(value: EncryptedEnvelope): unknown[] {
    const prefix = [
        value.i,
        value.d,
        value.q,
        value.k,
        value.r.map(recipient => [recipient.u, recipient.e, recipient.x]),
    ];
    return value.v === ENCRYPTED_MESSAGE_VERSION
        ? [...prefix, (value.m ?? []).map(userId => `<@${userId}>`), value.n, value.x, value.z]
        : [...prefix, value.n, value.x, value.z];
}

export function parseEncryptedEnvelope(content: string, context?: EncryptedEnvelopeContext): EncryptedEnvelope {
    if (typeof content !== "string" || content.length > MAX_DISCORD_MESSAGE_LENGTH)
        throw new Error("Unsupported secure-message payload");
    if (content.startsWith(LEGACY_ENCRYPTED_MESSAGE_PREFIX)) {
        const value = parseJsonAfterPrefix(content, LEGACY_ENCRYPTED_MESSAGE_PREFIX);
        if (!isRecord(value)) throw new Error("Malformed encrypted envelope");
        const envelope = validateEnvelopeFields(value);
        if (envelope.v !== PROTOCOL_VERSION || JSON.stringify(envelope) !== content.slice(LEGACY_ENCRYPTED_MESSAGE_PREFIX.length))
            throw new Error("Encrypted envelope is not canonically encoded");
        return envelope;
    }
    const current = content.startsWith(ENCRYPTED_MESSAGE_PREFIX);
    const previous = content.startsWith(PREVIOUS_ENCRYPTED_MESSAGE_PREFIX);
    if (!current && !previous) throw new Error("Unsupported secure-message payload");
    if (!context || !isSnowflake(context.channelId) || !isSnowflake(context.discordAuthorId))
        throw new Error("Compact encrypted envelope requires valid Discord context");
    const prefix = current ? ENCRYPTED_MESSAGE_PREFIX : PREVIOUS_ENCRYPTED_MESSAGE_PREFIX;
    const version = current ? ENCRYPTED_MESSAGE_VERSION : PREVIOUS_ENCRYPTED_MESSAGE_VERSION;
    const value = parseJsonAfterPrefix(content, prefix);
    if (!Array.isArray(value) || value.length !== (current ? 9 : 8) || !Array.isArray(value[4]) ||
        (current && !Array.isArray(value[5])))
        throw new Error("Malformed encrypted envelope");
    const recipients = value[4].map(recipient => {
        if (!Array.isArray(recipient) || recipient.length !== 3) throw new Error("Invalid encrypted recipient entry");
        return { u: recipient[0], e: recipient[1], x: recipient[2] };
    });
    const mentionedUserIds = current
        ? value[5].map(mention => {
            if (typeof mention !== "string") throw new Error("Invalid encrypted mentioned user");
            const match = /^<@(\d{17,20})>$/u.exec(mention);
            if (!match) throw new Error("Invalid encrypted mentioned user");
            return match[1];
        })
        : undefined;
    const envelope = validateEnvelopeFields({
        v: version,
        t: "m",
        i: value[0],
        c: context.channelId,
        s: context.discordAuthorId,
        d: value[1],
        q: value[2],
        k: value[3],
        r: recipients,
        ...(current ? { m: mentionedUserIds } : {}),
        n: value[current ? 6 : 5],
        x: value[current ? 7 : 6],
        z: value[current ? 8 : 7],
    });
    if (JSON.stringify(compactEnvelopeWire(envelope)) !== content.slice(prefix.length))
        throw new Error("Encrypted envelope is not canonically encoded");
    return envelope;
}

export function canonicalKeyAnnouncement(value: UnsignedKeyAnnouncement): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
        v: value.v,
        t: value.t,
        u: value.u,
        d: value.d,
        s: value.s,
        e: value.e,
    }));
}

export function envelopeHeader(value: Pick<UnsignedEncryptedEnvelope, "v" | "t" | "i" | "c" | "s" | "d" | "q" | "k" | "r" | "m">): Uint8Array {
    if (value.v === ENCRYPTED_MESSAGE_VERSION) return new TextEncoder().encode(JSON.stringify([
        ENCRYPTED_MESSAGE_PREFIX,
        value.i,
        value.c,
        value.s,
        value.d,
        value.q,
        value.k,
        value.r.map(recipient => recipient.u),
        value.m ?? [],
    ]));
    if (value.v === PREVIOUS_ENCRYPTED_MESSAGE_VERSION) return new TextEncoder().encode(JSON.stringify([
        PREVIOUS_ENCRYPTED_MESSAGE_PREFIX,
        value.i,
        value.c,
        value.s,
        value.d,
        value.q,
        value.k,
        value.r.map(recipient => recipient.u),
    ]));
    return new TextEncoder().encode(JSON.stringify({
        v: value.v,
        t: value.t,
        i: value.i,
        c: value.c,
        s: value.s,
        d: value.d,
        q: value.q,
        k: value.k,
        r: value.r.map(recipient => recipient.u),
    }));
}

export function canonicalEncryptedEnvelope(value: UnsignedEncryptedEnvelope): Uint8Array {
    if (value.v === ENCRYPTED_MESSAGE_VERSION) return new TextEncoder().encode(JSON.stringify([
        ENCRYPTED_MESSAGE_PREFIX,
        value.i,
        value.c,
        value.s,
        value.d,
        value.q,
        value.k,
        value.r.map(recipient => [recipient.u, recipient.e, recipient.x]),
        value.m ?? [],
        value.n,
        value.x,
    ]));
    if (value.v === PREVIOUS_ENCRYPTED_MESSAGE_VERSION) return new TextEncoder().encode(JSON.stringify([
        PREVIOUS_ENCRYPTED_MESSAGE_PREFIX,
        value.i,
        value.c,
        value.s,
        value.d,
        value.q,
        value.k,
        value.r.map(recipient => [recipient.u, recipient.e, recipient.x]),
        value.n,
        value.x,
    ]));
    return new TextEncoder().encode(JSON.stringify({
        v: value.v,
        t: value.t,
        i: value.i,
        c: value.c,
        s: value.s,
        d: value.d,
        q: value.q,
        k: value.k,
        r: value.r.map(recipient => ({ u: recipient.u, e: recipient.e, x: recipient.x })),
        n: value.n,
        x: value.x,
    }));
}

export function serializeKeyAnnouncement(value: KeyAnnouncement): string {
    const serialized = `${KEY_ANNOUNCEMENT_PREFIX}${JSON.stringify(value)}`;
    if (serialized.length > MAX_DISCORD_MESSAGE_LENGTH) throw new Error("Key announcement exceeds Discord's message limit");
    return serialized;
}

export function serializeEncryptedEnvelope(value: EncryptedEnvelope): string {
    const serialized = value.v === ENCRYPTED_MESSAGE_VERSION
        ? `${ENCRYPTED_MESSAGE_PREFIX}${JSON.stringify(compactEnvelopeWire(value))}`
        : value.v === PREVIOUS_ENCRYPTED_MESSAGE_VERSION
            ? `${PREVIOUS_ENCRYPTED_MESSAGE_PREFIX}${JSON.stringify(compactEnvelopeWire(value))}`
            : `${LEGACY_ENCRYPTED_MESSAGE_PREFIX}${JSON.stringify(value)}`;
    if (serialized.length > MAX_DISCORD_MESSAGE_LENGTH)
        throw new Error("Encrypted message exceeds Discord's 2,000 character limit; shorten the text or select fewer recipients");
    return serialized;
}
