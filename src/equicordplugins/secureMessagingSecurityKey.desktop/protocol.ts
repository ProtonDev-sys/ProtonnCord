/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const SECURITY_KEY_PROFILE_PREFIX = "PCSKP1:";
export const SECURITY_KEY_PROOF_PREFIX = "PCSK1:";
export const SECURITY_KEY_PROTOCOL_VERSION = 1 as const;
export const SECURITY_KEY_RP_ID = "localhost";
export const MAX_SECURITY_KEY_WIRE_LENGTH = 2_000;
export const MAX_SECURITY_KEY_PROFILE_LENGTH = 8_192;

export type SecurityKeyAlgorithm = -8 | -7 | -257;
export type SecurityKeyTransport = "ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

const ALGORITHMS = new Set<number>([-8, -7, -257]);
const TRANSPORTS = new Set<string>(["ble", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const SNOWFLAKE = /^\d{17,20}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const BASE64URL_16 = /^[A-Za-z0-9_-]{22}$/u;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const ROOT_FINGERPRINT_PREFIX = new TextEncoder().encode("ProtonnCord/SecureMessaging/security-key-root/v1\0");
const PROOF_CHALLENGE_PREFIX = new TextEncoder().encode("ProtonnCord/SecureMessaging/security-key-proof/v1\0");
const IMPORT_CHALLENGE_PREFIX = new TextEncoder().encode("ProtonnCord/SecureMessaging/security-key-import/v1\0");

export interface SecurityKeyPublicProfile {
    algorithm: SecurityKeyAlgorithm;
    createdAt: number;
    credentialId: string;
    publicKeySpki: string;
    rootFingerprint: string;
    transports: SecurityKeyTransport[];
}

export interface SecurityKeyProof {
    algorithm: SecurityKeyAlgorithm;
    announcement: string;
    authenticatorData: string;
    clientDataJson: string;
    issuedAt: number;
    nonce: string;
    publicKeySpki: string;
    rootFingerprint: string;
    signature: string;
    userId: string;
}

export interface SecurityKeyProofBinding {
    announcement: string;
    issuedAt: number;
    nonce: string;
    rootFingerprint: string;
    userId: string;
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
    let offset = 0;
    for (const value of values) {
        result.set(value, offset);
        offset += value.byteLength;
    }
    return result;
}

function isProtocolTimestamp(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1_700_000_000_000 &&
        (value as number) <= 9_999_999_999_999;
}

function isCanonicalBase64Url(value: unknown, minimumBytes: number, maximumBytes: number): value is string {
    if (typeof value !== "string" || value.length < 1 || !BASE64URL.test(value)) return false;
    try {
        const bytes = decodeBase64Url(value);
        return bytes.byteLength >= minimumBytes && bytes.byteLength <= maximumBytes && encodeBase64Url(bytes) === value;
    } catch {
        return false;
    }
}

function isAlgorithm(value: unknown): value is SecurityKeyAlgorithm {
    return typeof value === "number" && ALGORITHMS.has(value);
}

function isTransport(value: unknown): value is SecurityKeyTransport {
    return typeof value === "string" && TRANSPORTS.has(value);
}

function parseAfterPrefix(content: string, prefix: string, maximumLength: number): unknown {
    if (typeof content !== "string" || content.length <= prefix.length || content.length > maximumLength || !content.startsWith(prefix))
        throw new Error("Unsupported security-key payload");
    try {
        return JSON.parse(content.slice(prefix.length));
    } catch {
        throw new Error("Malformed security-key JSON");
    }
}

export function encodeBase64Url(value: ArrayBufferLike | ArrayBufferView): string {
    const bytes = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8_192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string, expectedBytes?: number): Uint8Array {
    if (typeof value !== "string" || value.length < 1 || !BASE64URL.test(value))
        throw new Error("Invalid base64url value");
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

export function isSecurityKeyProof(content: unknown): content is string {
    return typeof content === "string" && content.startsWith(SECURITY_KEY_PROOF_PREFIX);
}

export function serializeSecurityKeyProfile(profile: SecurityKeyPublicProfile): string {
    validateSecurityKeyProfile(profile);
    return SECURITY_KEY_PROFILE_PREFIX + JSON.stringify([
        SECURITY_KEY_PROTOCOL_VERSION,
        "p",
        profile.createdAt,
        profile.credentialId,
        profile.algorithm,
        profile.publicKeySpki,
        profile.rootFingerprint,
        profile.transports,
    ]);
}

export function parseSecurityKeyProfile(content: string): SecurityKeyPublicProfile {
    const value = parseAfterPrefix(content, SECURITY_KEY_PROFILE_PREFIX, MAX_SECURITY_KEY_PROFILE_LENGTH);
    if (!Array.isArray(value) || value.length !== 8 || value[0] !== SECURITY_KEY_PROTOCOL_VERSION || value[1] !== "p")
        throw new Error("Malformed security-key profile");
    const profile: SecurityKeyPublicProfile = {
        createdAt: value[2],
        credentialId: value[3],
        algorithm: value[4],
        publicKeySpki: value[5],
        rootFingerprint: value[6],
        transports: value[7],
    };
    validateSecurityKeyProfile(profile);
    if (serializeSecurityKeyProfile(profile) !== content)
        throw new Error("Security-key profile is not canonically encoded");
    return profile;
}

export function validateSecurityKeyProfile(profile: SecurityKeyPublicProfile): void {
    if (!profile || !isProtocolTimestamp(profile.createdAt) ||
        !isCanonicalBase64Url(profile.credentialId, 16, 1_024) || !isAlgorithm(profile.algorithm) ||
        !isCanonicalBase64Url(profile.publicKeySpki, 32, 1_024) ||
        typeof profile.rootFingerprint !== "string" || !BASE64URL_32.test(profile.rootFingerprint) ||
        encodeBase64Url(decodeBase64Url(profile.rootFingerprint, 32)) !== profile.rootFingerprint ||
        !Array.isArray(profile.transports) || profile.transports.length > TRANSPORTS.size ||
        profile.transports.some(transport => !isTransport(transport)))
        throw new Error("Invalid security-key profile fields");
    const canonical = [...new Set(profile.transports)].sort((left, right) => left.localeCompare(right));
    if (canonical.length !== profile.transports.length ||
        canonical.some((transport, index) => transport !== profile.transports[index]))
        throw new Error("Security-key transports must be unique and sorted");
}

export function serializeSecurityKeyProof(proof: SecurityKeyProof): string {
    validateSecurityKeyProof(proof);
    const content = SECURITY_KEY_PROOF_PREFIX + JSON.stringify([
        SECURITY_KEY_PROTOCOL_VERSION,
        "s",
        proof.userId,
        proof.issuedAt,
        proof.nonce,
        proof.announcement,
        proof.algorithm,
        proof.publicKeySpki,
        proof.rootFingerprint,
        proof.clientDataJson,
        proof.authenticatorData,
        proof.signature,
    ]);
    if (content.length > MAX_SECURITY_KEY_WIRE_LENGTH)
        throw new Error("Security-key proof exceeds Discord's message limit");
    return content;
}

export function parseSecurityKeyProof(content: string): SecurityKeyProof {
    const value = parseAfterPrefix(content, SECURITY_KEY_PROOF_PREFIX, MAX_SECURITY_KEY_WIRE_LENGTH);
    if (!Array.isArray(value) || value.length !== 12 || value[0] !== SECURITY_KEY_PROTOCOL_VERSION || value[1] !== "s")
        throw new Error("Malformed security-key proof");
    const proof: SecurityKeyProof = {
        userId: value[2],
        issuedAt: value[3],
        nonce: value[4],
        announcement: value[5],
        algorithm: value[6],
        publicKeySpki: value[7],
        rootFingerprint: value[8],
        clientDataJson: value[9],
        authenticatorData: value[10],
        signature: value[11],
    };
    validateSecurityKeyProof(proof);
    if (serializeSecurityKeyProof(proof) !== content)
        throw new Error("Security-key proof is not canonically encoded");
    return proof;
}

export function validateSecurityKeyProof(proof: SecurityKeyProof): void {
    if (!proof || typeof proof.userId !== "string" || !SNOWFLAKE.test(proof.userId) ||
        !isProtocolTimestamp(proof.issuedAt) || typeof proof.nonce !== "string" || !BASE64URL_16.test(proof.nonce) ||
        encodeBase64Url(decodeBase64Url(proof.nonce, 16)) !== proof.nonce ||
        typeof proof.announcement !== "string" || proof.announcement.length < 1 || proof.announcement.length > 1_500 ||
        !isAlgorithm(proof.algorithm) || !isCanonicalBase64Url(proof.publicKeySpki, 32, 1_024) ||
        typeof proof.rootFingerprint !== "string" || !BASE64URL_32.test(proof.rootFingerprint) ||
        encodeBase64Url(decodeBase64Url(proof.rootFingerprint, 32)) !== proof.rootFingerprint ||
        !isCanonicalBase64Url(proof.clientDataJson, 32, 2_048) ||
        !isCanonicalBase64Url(proof.authenticatorData, 37, 1_024) ||
        !isCanonicalBase64Url(proof.signature, 32, 1_024))
        throw new Error("Invalid security-key proof fields");
}

export function securityKeyProofBinding(proof: Pick<SecurityKeyProof,
    "announcement" | "issuedAt" | "nonce" | "rootFingerprint" | "userId">): SecurityKeyProofBinding {
    return {
        announcement: proof.announcement,
        issuedAt: proof.issuedAt,
        nonce: proof.nonce,
        rootFingerprint: proof.rootFingerprint,
        userId: proof.userId,
    };
}

export async function securityKeyRootFingerprint(
    algorithm: SecurityKeyAlgorithm,
    publicKeySpki: string,
): Promise<string> {
    if (!isAlgorithm(algorithm) || !isCanonicalBase64Url(publicKeySpki, 32, 1_024))
        throw new Error("Invalid security-key public key");
    const digest = await crypto.subtle.digest("SHA-256", concatBytes(
        ROOT_FINGERPRINT_PREFIX,
        new TextEncoder().encode(`${SECURITY_KEY_RP_ID}\0${algorithm}\0`),
        decodeBase64Url(publicKeySpki),
    ));
    return encodeBase64Url(digest);
}

export async function securityKeyProofChallenge(binding: SecurityKeyProofBinding): Promise<string> {
    if (typeof binding.userId !== "string" || !SNOWFLAKE.test(binding.userId) ||
        !isProtocolTimestamp(binding.issuedAt) || !BASE64URL_16.test(binding.nonce) ||
        typeof binding.announcement !== "string" || binding.announcement.length < 1 || binding.announcement.length > 1_500 ||
        !BASE64URL_32.test(binding.rootFingerprint))
        throw new Error("Invalid security-key proof binding");
    const canonical = new TextEncoder().encode(JSON.stringify([
        SECURITY_KEY_PROTOCOL_VERSION,
        "b",
        binding.userId,
        binding.issuedAt,
        binding.nonce,
        binding.announcement,
        binding.rootFingerprint,
    ]));
    return encodeBase64Url(await crypto.subtle.digest("SHA-256", concatBytes(PROOF_CHALLENGE_PREFIX, canonical)));
}

export async function securityKeyImportChallenge(
    profile: SecurityKeyPublicProfile,
    localUserId: string,
    nonce: string,
    issuedAt: number,
): Promise<string> {
    validateSecurityKeyProfile(profile);
    if (!SNOWFLAKE.test(localUserId) || !BASE64URL_16.test(nonce) || !isProtocolTimestamp(issuedAt))
        throw new Error("Invalid security-key import binding");
    const canonical = new TextEncoder().encode(JSON.stringify([
        SECURITY_KEY_PROTOCOL_VERSION,
        "i",
        localUserId,
        issuedAt,
        nonce,
        serializeSecurityKeyProfile(profile),
    ]));
    return encodeBase64Url(await crypto.subtle.digest("SHA-256", concatBytes(IMPORT_CHALLENGE_PREFIX, canonical)));
}

export function formatSecurityKeyFingerprint(fingerprint: string): string {
    const bytes = decodeBase64Url(fingerprint, 32);
    const hexadecimal = [...bytes].map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
    return hexadecimal.match(/.{1,4}/gu)?.join(" ") ?? hexadecimal;
}
