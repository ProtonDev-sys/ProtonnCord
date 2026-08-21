/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    createHash,
    createPublicKey,
    timingSafeEqual,
    verify as verifySignature,
} from "node:crypto";

import {
    decodeBase64Url,
    encodeBase64Url,
    type SecurityKeyAlgorithm,
    type SecurityKeyProof,
    securityKeyProofBinding,
    securityKeyProofChallenge,
    type SecurityKeyPublicProfile,
    securityKeyRootFingerprint,
    SECURITY_KEY_RP_ID,
    validateSecurityKeyProfile,
} from "./protocol";

const USER_PRESENT_FLAG = 0x01;
const USER_VERIFIED_FLAG = 0x04;
const MAX_PROOF_AGE_MS = 10 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface WebAuthnRegistrationResult {
    algorithm: number;
    authenticatorAttachment: string | null;
    authenticatorData: string;
    clientDataJson: string;
    credentialId: string;
    publicKeySpki: string;
    transports: string[];
}

export interface WebAuthnAssertionResult {
    authenticatorAttachment: string | null;
    authenticatorData: string;
    clientDataJson: string;
    credentialId: string;
    signature: string;
}

export interface VerifiedAuthenticatorData {
    origin: string;
    signCount: number;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function sha256(value: Uint8Array | string): Uint8Array {
    return new Uint8Array(createHash("sha256").update(value).digest());
}

function parseClientData(
    encoded: string,
    expectedChallenge: string,
    expectedType: "webauthn.create" | "webauthn.get",
): { bytes: Uint8Array; origin: string; } {
    const bytes = decodeBase64Url(encoded);
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        throw new Error("Security-key client data is malformed");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Security-key client data is malformed");
    const data = value as Record<string, unknown>;
    if (data.type !== expectedType || data.challenge !== expectedChallenge || data.crossOrigin === true ||
        typeof data.origin !== "string")
        throw new Error("Security-key client data does not match this operation");

    let origin: URL;
    try {
        origin = new URL(data.origin);
    } catch {
        throw new Error("Security-key origin is invalid");
    }
    if (origin.protocol !== "http:" || origin.hostname !== SECURITY_KEY_RP_ID || origin.username || origin.password ||
        !/^\d{1,5}$/u.test(origin.port) || Number(origin.port) < 1 || Number(origin.port) > 65_535 ||
        origin.pathname !== "/" || origin.search || origin.hash)
        throw new Error("Security-key assertion came from an unexpected origin");
    return { bytes, origin: origin.origin };
}

function parseAuthenticatorData(encoded: string): { bytes: Uint8Array; signCount: number; } {
    const bytes = decodeBase64Url(encoded);
    if (bytes.byteLength < 37 || bytes.byteLength > 1_024)
        throw new Error("Security-key authenticator data is invalid");
    const expectedRpIdHash = sha256(SECURITY_KEY_RP_ID);
    if (!equalBytes(bytes.subarray(0, 32), expectedRpIdHash))
        throw new Error("Security-key assertion is scoped to another relying party");
    const flags = bytes[32];
    if ((flags & USER_PRESENT_FLAG) === 0)
        throw new Error("Security-key user presence was not verified");
    if ((flags & USER_VERIFIED_FLAG) === 0)
        throw new Error("Security-key PIN or biometric verification is required");
    return {
        bytes,
        signCount: new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0),
    };
}

function assertPublicKeyAlgorithm(algorithm: SecurityKeyAlgorithm, publicKeySpki: string): ReturnType<typeof createPublicKey> {
    const key = createPublicKey({
        key: Buffer.from(decodeBase64Url(publicKeySpki)),
        format: "der",
        type: "spki",
    });
    const details = key.asymmetricKeyDetails;
    if (algorithm === -7 && (key.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1"))
        throw new Error("Security-key ES256 public key is invalid");
    if (algorithm === -8 && key.asymmetricKeyType !== "ed25519")
        throw new Error("Security-key Ed25519 public key is invalid");
    if (algorithm === -257 && (key.asymmetricKeyType !== "rsa" || (details?.modulusLength ?? 0) < 2_048))
        throw new Error("Security-key RSA public key is invalid");
    return key;
}

function verifyAssertionSignature(
    algorithm: SecurityKeyAlgorithm,
    publicKeySpki: string,
    authenticatorData: Uint8Array,
    clientDataJson: Uint8Array,
    encodedSignature: string,
): void {
    const publicKey = assertPublicKeyAlgorithm(algorithm, publicKeySpki);
    const signed = Buffer.concat([
        Buffer.from(authenticatorData),
        Buffer.from(sha256(clientDataJson)),
    ]);
    const signature = Buffer.from(decodeBase64Url(encodedSignature));
    const valid = algorithm === -8
        ? verifySignature(null, signed, publicKey, signature)
        : verifySignature("sha256", signed, publicKey, signature);
    if (!valid) throw new Error("Security-key assertion signature is invalid");
}

export async function verifySecurityKeyProfile(profile: SecurityKeyPublicProfile): Promise<void> {
    validateSecurityKeyProfile(profile);
    assertPublicKeyAlgorithm(profile.algorithm, profile.publicKeySpki);
    if (await securityKeyRootFingerprint(profile.algorithm, profile.publicKeySpki) !== profile.rootFingerprint)
        throw new Error("Security-key profile fingerprint is invalid");
}

export async function verifyWebAuthnRegistration(
    result: WebAuthnRegistrationResult,
    expectedChallenge: string,
): Promise<{ profile: SecurityKeyPublicProfile; signCount: number; }> {
    if (!result || result.authenticatorAttachment !== "cross-platform" ||
        (result.algorithm !== -8 && result.algorithm !== -7 && result.algorithm !== -257))
        throw new Error("A roaming security key with PIN or biometric verification is required");
    const clientData = parseClientData(result.clientDataJson, expectedChallenge, "webauthn.create");
    const authenticator = parseAuthenticatorData(result.authenticatorData);
    const algorithm = result.algorithm as SecurityKeyAlgorithm;
    const rootFingerprint = await securityKeyRootFingerprint(algorithm, result.publicKeySpki);
    const transports = [...new Set(result.transports.filter(value =>
        value === "ble" || value === "hybrid" || value === "internal" || value === "nfc" ||
        value === "smart-card" || value === "usb"))].sort((left, right) => left.localeCompare(right));
    const profile: SecurityKeyPublicProfile = {
        algorithm,
        createdAt: Date.now(),
        credentialId: result.credentialId,
        publicKeySpki: result.publicKeySpki,
        rootFingerprint,
        transports,
    };
    await verifySecurityKeyProfile(profile);
    if (!clientData.origin.startsWith("http://localhost:"))
        throw new Error("Security-key registration origin is invalid");
    return { profile, signCount: authenticator.signCount };
}

export async function verifyWebAuthnAssertion(
    profile: SecurityKeyPublicProfile,
    result: WebAuthnAssertionResult,
    expectedChallenge: string,
): Promise<VerifiedAuthenticatorData> {
    await verifySecurityKeyProfile(profile);
    if (result.authenticatorAttachment !== "cross-platform" || result.credentialId !== profile.credentialId)
        throw new Error("A different security key answered the request");
    const clientData = parseClientData(result.clientDataJson, expectedChallenge, "webauthn.get");
    const authenticator = parseAuthenticatorData(result.authenticatorData);
    verifyAssertionSignature(
        profile.algorithm,
        profile.publicKeySpki,
        authenticator.bytes,
        clientData.bytes,
        result.signature,
    );
    return { origin: clientData.origin, signCount: authenticator.signCount };
}

export async function verifySecurityKeyProof(
    proof: SecurityKeyProof,
    discordAuthorId: string,
    discordPublishedAt: number,
    now = Date.now(),
): Promise<VerifiedAuthenticatorData> {
    if (proof.userId !== discordAuthorId)
        throw new Error("Security-key proof does not match its Discord author");
    if (!Number.isSafeInteger(discordPublishedAt) || discordPublishedAt < 1_700_000_000_000 ||
        proof.issuedAt > now + MAX_CLOCK_SKEW_MS || proof.issuedAt < discordPublishedAt - MAX_PROOF_AGE_MS ||
        proof.issuedAt > discordPublishedAt + MAX_CLOCK_SKEW_MS)
        throw new Error("Security-key proof timestamp is outside the accepted window");
    const profile: SecurityKeyPublicProfile = {
        algorithm: proof.algorithm,
        createdAt: proof.issuedAt,
        credentialId: encodeBase64Url(new Uint8Array(16)),
        publicKeySpki: proof.publicKeySpki,
        rootFingerprint: proof.rootFingerprint,
        transports: [],
    };
    await verifySecurityKeyProfile(profile);
    const challenge = await securityKeyProofChallenge(securityKeyProofBinding(proof));
    const clientData = parseClientData(proof.clientDataJson, challenge, "webauthn.get");
    const authenticator = parseAuthenticatorData(proof.authenticatorData);
    verifyAssertionSignature(
        proof.algorithm,
        proof.publicKeySpki,
        authenticator.bytes,
        clientData.bytes,
        proof.signature,
    );
    return { origin: clientData.origin, signCount: authenticator.signCount };
}

export function securityKeyProofDigest(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("base64url");
}
