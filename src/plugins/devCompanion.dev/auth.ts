/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const COMPANION_AUTH_PROTOCOL = "protonn-dev-companion-v1";

const HEX_256_PATTERN = /^[0-9a-f]{64}$/u;
const textEncoder = new TextEncoder();

type AuthRole = "client" | "ready" | "server";

interface AuthChallenge {
    data: {
        clientNonce: string;
        proof: string;
        protocol: typeof COMPANION_AUTH_PROTOCOL;
        serverNonce: string;
    };
    type: "authChallenge";
}

interface AuthReady extends Omit<AuthChallenge, "type"> {
    type: "authReady";
}

interface AuthResponse extends Omit<AuthChallenge, "type"> {
    type: "authResponse";
}

export interface AuthHello {
    data: {
        clientNonce: string;
        protocol: typeof COMPANION_AUTH_PROTOCOL;
    };
    type: "authHello";
}

export type AuthAdvance =
    | { authenticated: false; response: AuthResponse; }
    | { authenticated: true; };

export interface CompanionAuthenticator {
    hello: AuthHello;
    receive(message: unknown): Promise<AuthAdvance>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function isAuthMessage(value: unknown, type: "authChallenge" | "authReady"): value is AuthChallenge | AuthReady {
    if (!isRecord(value) || !hasExactKeys(value, ["type", "data"]) || value.type !== type || !isRecord(value.data)) return false;
    const { data } = value;
    return hasExactKeys(data, ["protocol", "clientNonce", "serverNonce", "proof"])
        && data.protocol === COMPANION_AUTH_PROTOCOL
        && typeof data.clientNonce === "string"
        && HEX_256_PATTERN.test(data.clientNonce)
        && typeof data.serverNonce === "string"
        && HEX_256_PATTERN.test(data.serverNonce)
        && typeof data.proof === "string"
        && HEX_256_PATTERN.test(data.proof);
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(value.length / 2);
    for (let index = 0; index < result.length; index++)
        result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    return result;
}

function encodeHex(value: ArrayBuffer): string {
    return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");
}

function authTranscript(role: AuthRole, clientNonce: string, serverNonce: string): Uint8Array<ArrayBuffer> {
    return textEncoder.encode(`${COMPANION_AUTH_PROTOCOL}\0${role}\0${clientNonce}\0${serverNonce}`);
}

async function importAuthKey(secret: string): Promise<CryptoKey> {
    return await crypto.subtle.importKey(
        "raw",
        decodeHex(secret),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign", "verify"]
    );
}

async function signAuthProof(key: CryptoKey, role: AuthRole, clientNonce: string, serverNonce: string): Promise<string> {
    return encodeHex(await crypto.subtle.sign("HMAC", key, authTranscript(role, clientNonce, serverNonce)));
}

async function verifyAuthProof(key: CryptoKey, proof: string, role: AuthRole, clientNonce: string, serverNonce: string): Promise<boolean> {
    return await crypto.subtle.verify("HMAC", key, decodeHex(proof), authTranscript(role, clientNonce, serverNonce));
}

export function isValidAuthSecret(value: unknown): value is string {
    return typeof value === "string" && HEX_256_PATTERN.test(value);
}

export function createAuthNonce(): string {
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    return Array.from(nonce, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createCompanionAuthProof(
    secret: string,
    role: AuthRole,
    clientNonce: string,
    serverNonce: string
): Promise<string> {
    if (!isValidAuthSecret(secret) || !HEX_256_PATTERN.test(clientNonce) || !HEX_256_PATTERN.test(serverNonce))
        throw new Error("Invalid Dev Companion authentication input");
    return await signAuthProof(await importAuthKey(secret), role, clientNonce, serverNonce);
}

export async function createCompanionAuthenticator(secret: string, clientNonce = createAuthNonce()): Promise<CompanionAuthenticator> {
    if (!isValidAuthSecret(secret) || !HEX_256_PATTERN.test(clientNonce))
        throw new Error("Invalid Dev Companion authentication input");

    const key = await importAuthKey(secret);
    let phase: "challenge" | "verifyingChallenge" | "ready" | "verifyingReady" | "authenticated" | "failed" = "challenge";
    let serverNonce: string | undefined;

    return {
        hello: {
            type: "authHello",
            data: { clientNonce, protocol: COMPANION_AUTH_PROTOCOL }
        },
        async receive(message) {
            try {
                if (phase === "challenge") {
                    phase = "verifyingChallenge";
                    if (!isAuthMessage(message, "authChallenge") || message.data.clientNonce !== clientNonce)
                        throw new Error("Invalid Dev Companion authentication challenge");
                    const validChallenge = await verifyAuthProof(key, message.data.proof, "server", clientNonce, message.data.serverNonce);
                    if (phase !== "verifyingChallenge" || !validChallenge)
                        throw new Error("Invalid Dev Companion authentication challenge");

                    serverNonce = message.data.serverNonce;
                    const clientProof = await signAuthProof(key, "client", clientNonce, serverNonce);
                    if (phase !== "verifyingChallenge") throw new Error("Invalid Dev Companion authentication challenge");
                    const response: AuthResponse = {
                        type: "authResponse",
                        data: {
                            clientNonce,
                            proof: clientProof,
                            protocol: COMPANION_AUTH_PROTOCOL,
                            serverNonce
                        }
                    };
                    phase = "ready";
                    return { authenticated: false, response };
                }

                if (phase === "ready" && serverNonce) {
                    phase = "verifyingReady";
                    if (!isAuthMessage(message, "authReady")
                        || message.data.clientNonce !== clientNonce
                        || message.data.serverNonce !== serverNonce)
                        throw new Error("Invalid Dev Companion authentication confirmation");
                    const validReady = await verifyAuthProof(key, message.data.proof, "ready", clientNonce, serverNonce);
                    if (phase !== "verifyingReady" || !validReady) throw new Error("Invalid Dev Companion authentication confirmation");

                    phase = "authenticated";
                    return { authenticated: true };
                }

                throw new Error("Unexpected Dev Companion authentication message");
            } catch {
                phase = "failed";
                throw new Error("Dev Companion authentication failed");
            }
        }
    };
}
