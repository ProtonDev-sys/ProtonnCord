/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DATA_DIR } from "@main/utils/constants";
import {
    BrowserWindow,
    type IpcMainInvokeEvent,
    safeStorage,
    session,
} from "electron";

import { keyAnnouncementFromContent, verifyKeyAnnouncement } from "../secureMessaging.desktop/crypto";
import { isSnowflake } from "../secureMessaging.desktop/protocol";
import {
    decodeBase64Url,
    encodeBase64Url,
    formatSecurityKeyFingerprint,
    parseSecurityKeyProfile,
    parseSecurityKeyProof,
    SECURITY_KEY_RP_ID,
    type SecurityKeyAlgorithm,
    securityKeyImportChallenge,
    type SecurityKeyProof,
    securityKeyProofChallenge,
    type SecurityKeyPublicProfile,
    securityKeyRootFingerprint,
    type SecurityKeyTransport,
    serializeSecurityKeyProfile,
    serializeSecurityKeyProof,
} from "./protocol";
import {
    securityKeyProofDigest,
    verifySecurityKeyProfile,
    verifySecurityKeyProof,
    verifyWebAuthnAssertion,
    verifyWebAuthnRegistration,
    type WebAuthnAssertionResult,
    type WebAuthnRegistrationResult,
} from "./verification";

export type SecurityKeyUnavailableReason =
    | "secure_storage_unavailable"
    | "unsafe_linux_backend"
    | "webauthn_unavailable";

export type SecurityKeyFailure =
    | { status: "invalid_input"; error: string; }
    | { status: "unavailable"; reason: SecurityKeyUnavailableReason; }
    | {
        status: "failed";
        error: "capacity_exceeded" | "ceremony_cancelled" | "credential_mismatch" |
        "invalid_assertion" | "storage_error";
    };

export interface SecurityKeyProfileSummary {
    algorithm: SecurityKeyAlgorithm;
    createdAt: number;
    exportText: string;
    formattedRootFingerprint: string;
    rootFingerprint: string;
    transports: SecurityKeyTransport[];
}

export type SecurityKeyStateResult = {
    status: "ready";
    activeProfile: SecurityKeyProfileSummary | null;
    availableProfiles: SecurityKeyProfileSummary[];
} | SecurityKeyFailure;

export type SecurityKeySetupResult = {
    status: "configured";
    profile: SecurityKeyProfileSummary;
} | SecurityKeyFailure;

export type SecurityKeyProofResult = {
    status: "created";
    content: string;
    profile: SecurityKeyProfileSummary;
} | SecurityKeyFailure;

export interface SecurityKeyRootSummary {
    algorithm: SecurityKeyAlgorithm;
    formattedRootFingerprint: string;
    linkedUserIds: string[];
    rootFingerprint: string;
}

export type SecurityKeyProofReviewResult =
    | {
        status: "trusted";
        announcement: string;
        root: SecurityKeyRootSummary;
    }
    | {
        status: "key_changed" | "linked" | "trust_required";
        announcement: string;
        previousRootFingerprint: string | null;
        reviewToken: string;
        root: SecurityKeyRootSummary;
    }
    | { status: "invalid_proof" | "replay_detected"; }
    | SecurityKeyFailure;

export type SecurityKeyProofTrustResult =
    | { status: "trusted"; root: SecurityKeyRootSummary; }
    | { status: "key_changed" | "review_expired"; }
    | SecurityKeyFailure;

interface StoredProfile extends SecurityKeyPublicProfile {
    signCount: number;
}

interface TrustedRootRecord {
    algorithm: SecurityKeyAlgorithm;
    firstTrustedAt: number;
    lastSignCount: number;
    publicKeySpki: string;
    rootFingerprint: string;
    userIds: string[];
}

interface ProofReplayRecord {
    digest: string;
    discordMessageId: string;
    seenAt: number;
}

interface SecurityKeyAccountRecord {
    peerRoots: Record<string, string>;
    profileFingerprint: string | null;
    proofReplay: ProofReplayRecord[];
    trustedRoots: Record<string, TrustedRootRecord>;
}

interface SecurityKeyVault {
    accounts: Record<string, SecurityKeyAccountRecord>;
    profiles: Record<string, StoredProfile>;
    version: 1;
}

interface PendingProofReview {
    expiresAt: number;
    localUserId: string;
    peerUserId: string;
    root: TrustedRootRecord;
}

const VAULT_VERSION = 1 as const;
const STORE_DIR = join(DATA_DIR, "secure-messaging");
const STORE_PATH = join(STORE_DIR, "security-keys.bin");
const LOCK_PATH = join(STORE_DIR, "security-keys.lock");
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_ACCOUNTS = 16;
const MAX_LOCAL_PROFILES = 16;
const MAX_TRUSTED_ROOTS = 2_000;
const MAX_REPLAY_RECORDS = 4_096;
const MAX_PENDING_REVIEWS = 100;
const REVIEW_LIFETIME_MS = 10 * 60 * 1_000;
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1_000;
const ALLOWED_RENDERER_ORIGINS = new Set([
    "https://canary.discord.com",
    "https://discord.com",
    "https://ptb.discord.com",
]);
const pendingReviews = new Map<string, PendingProofReview>();
let operationQueue: Promise<void> = Promise.resolve();

class SecurityKeyOperationError extends Error {
    constructor(readonly code: "capacity_exceeded" | "ceremony_cancelled" | "credential_mismatch" |
        "invalid_assertion" | "storage_error" | SecurityKeyUnavailableReason) {
        super(code);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const canonical = [...expected].sort();
    return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function isTimestamp(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1_700_000_000_000 &&
        (value as number) <= 9_999_999_999_999;
}

function isAlgorithm(value: unknown): value is SecurityKeyAlgorithm {
    return value === -8 || value === -7 || value === -257;
}

function isTransport(value: unknown): value is SecurityKeyTransport {
    return value === "ble" || value === "hybrid" || value === "internal" || value === "nfc" ||
        value === "smart-card" || value === "usb";
}

function isRootFingerprint(value: unknown): value is string {
    if (typeof value !== "string" || value.length !== 43) return false;
    try {
        return decodeBase64Url(value, 32).byteLength === 32;
    } catch {
        return false;
    }
}

function isBoundedBase64Url(value: unknown, minimumBytes: number, maximumBytes: number): value is string {
    if (typeof value !== "string") return false;
    try {
        const bytes = decodeBase64Url(value);
        return bytes.byteLength >= minimumBytes && bytes.byteLength <= maximumBytes;
    } catch {
        return false;
    }
}

function parseStoredProfile(value: unknown, fingerprint: string): StoredProfile | null {
    if (!isRecord(value) || !hasExactKeys(value, [
        "algorithm", "createdAt", "credentialId", "publicKeySpki", "rootFingerprint", "signCount", "transports",
    ]) || !isAlgorithm(value.algorithm) || !isTimestamp(value.createdAt) ||
        !isBoundedBase64Url(value.credentialId, 16, 1_024) || !isBoundedBase64Url(value.publicKeySpki, 32, 1_024) ||
        value.rootFingerprint !== fingerprint || !isRootFingerprint(value.rootFingerprint) ||
        !Number.isSafeInteger(value.signCount) || (value.signCount as number) < 0 || (value.signCount as number) > 0xffff_ffff ||
        !Array.isArray(value.transports) || value.transports.some(transport => !isTransport(transport))) return null;
    const transports = [...new Set(value.transports as SecurityKeyTransport[])].sort((left, right) => left.localeCompare(right));
    if (transports.length !== (value.transports as unknown[]).length ||
        transports.some((transport, index) => transport !== (value.transports as unknown[])[index])) return null;
    return {
        algorithm: value.algorithm,
        createdAt: value.createdAt,
        credentialId: value.credentialId,
        publicKeySpki: value.publicKeySpki,
        rootFingerprint: value.rootFingerprint,
        signCount: value.signCount as number,
        transports,
    };
}

function parseTrustedRoot(value: unknown, fingerprint: string): TrustedRootRecord | null {
    if (!isRecord(value) || !hasExactKeys(value, [
        "algorithm", "firstTrustedAt", "lastSignCount", "publicKeySpki", "rootFingerprint", "userIds",
    ]) || !isAlgorithm(value.algorithm) || !isTimestamp(value.firstTrustedAt) ||
        !Number.isSafeInteger(value.lastSignCount) || (value.lastSignCount as number) < 0 ||
        (value.lastSignCount as number) > 0xffff_ffff || !isBoundedBase64Url(value.publicKeySpki, 32, 1_024) ||
        value.rootFingerprint !== fingerprint || !isRootFingerprint(value.rootFingerprint) ||
        !Array.isArray(value.userIds) || value.userIds.length < 1 || value.userIds.length > MAX_ACCOUNTS ||
        value.userIds.some(userId => !isSnowflake(userId))) return null;
    const userIds = [...new Set(value.userIds as string[])].sort((left, right) => left.localeCompare(right));
    if (userIds.length !== (value.userIds as unknown[]).length ||
        userIds.some((userId, index) => userId !== (value.userIds as unknown[])[index])) return null;
    return {
        algorithm: value.algorithm,
        firstTrustedAt: value.firstTrustedAt,
        lastSignCount: value.lastSignCount as number,
        publicKeySpki: value.publicKeySpki,
        rootFingerprint: value.rootFingerprint,
        userIds,
    };
}

function parseAccount(value: unknown): SecurityKeyAccountRecord | null {
    if (!isRecord(value) || !hasExactKeys(value, ["peerRoots", "profileFingerprint", "proofReplay", "trustedRoots"]) ||
        (value.profileFingerprint !== null && !isRootFingerprint(value.profileFingerprint)) ||
        !isRecord(value.peerRoots) || Object.keys(value.peerRoots).length > MAX_TRUSTED_ROOTS ||
        Object.entries(value.peerRoots).some(([userId, fingerprint]) => !isSnowflake(userId) || !isRootFingerprint(fingerprint)) ||
        !isRecord(value.trustedRoots) || Object.keys(value.trustedRoots).length > MAX_TRUSTED_ROOTS ||
        !Array.isArray(value.proofReplay) || value.proofReplay.length > MAX_REPLAY_RECORDS) return null;
    const trustedRoots: Record<string, TrustedRootRecord> = {};
    for (const [fingerprint, record] of Object.entries(value.trustedRoots)) {
        const parsed = parseTrustedRoot(record, fingerprint);
        if (!parsed) return null;
        trustedRoots[fingerprint] = parsed;
    }
    const proofReplay: ProofReplayRecord[] = [];
    for (const replay of value.proofReplay) {
        if (!isRecord(replay) || !hasExactKeys(replay, ["digest", "discordMessageId", "seenAt"]) ||
            !isBoundedBase64Url(replay.digest, 32, 32) || !isSnowflake(replay.discordMessageId) || !isTimestamp(replay.seenAt)) return null;
        proofReplay.push({
            digest: replay.digest,
            discordMessageId: replay.discordMessageId,
            seenAt: replay.seenAt,
        });
    }
    return {
        peerRoots: value.peerRoots as Record<string, string>,
        profileFingerprint: value.profileFingerprint as string | null,
        proofReplay,
        trustedRoots,
    };
}

function parseVault(value: unknown): SecurityKeyVault | null {
    if (!isRecord(value) || !hasExactKeys(value, ["accounts", "profiles", "version"]) || value.version !== VAULT_VERSION ||
        !isRecord(value.accounts) || Object.keys(value.accounts).length > MAX_ACCOUNTS ||
        !isRecord(value.profiles) || Object.keys(value.profiles).length > MAX_LOCAL_PROFILES) return null;
    const profiles: Record<string, StoredProfile> = {};
    for (const [fingerprint, profile] of Object.entries(value.profiles)) {
        const parsed = parseStoredProfile(profile, fingerprint);
        if (!parsed) return null;
        profiles[fingerprint] = parsed;
    }
    const accounts: Record<string, SecurityKeyAccountRecord> = {};
    for (const [userId, account] of Object.entries(value.accounts)) {
        if (!isSnowflake(userId)) return null;
        const parsed = parseAccount(account);
        if (!parsed || (parsed.profileFingerprint !== null && !profiles[parsed.profileFingerprint])) return null;
        accounts[userId] = parsed;
    }
    return { accounts, profiles, version: VAULT_VERSION };
}

function emptyVault(): SecurityKeyVault {
    return { accounts: {}, profiles: {}, version: VAULT_VERSION };
}

function emptyAccount(): SecurityKeyAccountRecord {
    return { peerRoots: {}, profileFingerprint: null, proofReplay: [], trustedRoots: {} };
}

function validateStorageAvailability(): void {
    if (!safeStorage.isEncryptionAvailable())
        throw new SecurityKeyOperationError("secure_storage_unavailable");
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
        throw new SecurityKeyOperationError("unsafe_linux_backend");
}

function hasErrorCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

async function ensureStoreDirectory(): Promise<void> {
    await mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
    await chmod(STORE_DIR, 0o700).catch(() => undefined);
}

async function acquireStoreLock(): Promise<() => Promise<void>> {
    await ensureStoreDirectory();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
        try {
            const handle = await open(LOCK_PATH, "wx", 0o600);
            await handle.writeFile(`${process.pid}:${randomUUID()}\n`);
            await handle.sync();
            return async () => {
                await handle.close().catch(() => undefined);
                await rm(LOCK_PATH, { force: true }).catch(() => undefined);
            };
        } catch (error) {
            if (!hasErrorCode(error, "EEXIST")) throw new SecurityKeyOperationError("storage_error");
            try {
                const lockStat = await stat(LOCK_PATH);
                if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
                    await rm(LOCK_PATH, { force: true });
                    continue;
                }
            } catch (lockError) {
                if (hasErrorCode(lockError, "ENOENT")) continue;
            }
            if (Date.now() >= deadline) throw new SecurityKeyOperationError("storage_error");
            await delay(50);
        }
    }
}

async function loadVault(): Promise<SecurityKeyVault> {
    await ensureStoreDirectory();
    let ciphertext: Buffer;
    try {
        ciphertext = await readFile(STORE_PATH);
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return emptyVault();
        throw new SecurityKeyOperationError("storage_error");
    }
    if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_STORE_BYTES)
        throw new SecurityKeyOperationError("storage_error");
    let plaintext: string;
    try {
        plaintext = safeStorage.decryptString(ciphertext);
    } catch {
        throw new SecurityKeyOperationError("storage_error");
    }
    if (Buffer.byteLength(plaintext, "utf8") > MAX_STORE_BYTES)
        throw new SecurityKeyOperationError("storage_error");
    try {
        const parsed = parseVault(JSON.parse(plaintext));
        if (!parsed) throw new Error("invalid");
        for (const profile of Object.values(parsed.profiles)) await verifySecurityKeyProfile(profile);
        for (const account of Object.values(parsed.accounts)) {
            for (const root of Object.values(account.trustedRoots)) {
                const fingerprint = await securityKeyRootFingerprint(root.algorithm, root.publicKeySpki);
                if (fingerprint !== root.rootFingerprint) throw new Error("invalid trusted root");
            }
        }
        return parsed;
    } catch {
        throw new SecurityKeyOperationError("storage_error");
    }
}

async function saveVault(vault: SecurityKeyVault): Promise<void> {
    let ciphertext: Buffer;
    try {
        ciphertext = safeStorage.encryptString(JSON.stringify(vault));
    } catch {
        throw new SecurityKeyOperationError("storage_error");
    }
    if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_STORE_BYTES)
        throw new SecurityKeyOperationError("capacity_exceeded");
    await ensureStoreDirectory();
    const temporary = join(STORE_DIR, `security-keys.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, ciphertext, { flag: "wx", flush: true, mode: 0o600 });
        await rename(temporary, STORE_PATH);
        await chmod(STORE_PATH, 0o600).catch(() => undefined);
    } catch {
        throw new SecurityKeyOperationError("storage_error");
    } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

function mapFailure(error: unknown): SecurityKeyFailure {
    if (error instanceof SecurityKeyOperationError) {
        if (error.code === "secure_storage_unavailable" || error.code === "unsafe_linux_backend" ||
            error.code === "webauthn_unavailable") return { status: "unavailable", reason: error.code };
        return { status: "failed", error: error.code };
    }
    return { status: "failed", error: "invalid_assertion" };
}

async function runSerialized<T>(operation: () => Promise<T>): Promise<T | SecurityKeyFailure> {
    const execute = async (): Promise<T | SecurityKeyFailure> => {
        let release: (() => Promise<void>) | null = null;
        try {
            validateStorageAvailability();
            release = await acquireStoreLock();
            return await operation();
        } catch (error) {
            return mapFailure(error);
        } finally {
            await release?.();
        }
    };
    const result = operationQueue.then(execute, execute);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
}

function validateIpcCaller(event: IpcMainInvokeEvent): SecurityKeyFailure | null {
    try {
        const url = event.senderFrame?.url;
        if (typeof url === "string" && ALLOWED_RENDERER_ORIGINS.has(new URL(url).origin)) return null;
    } catch {
        return { status: "invalid_input", error: "Security keys can only be used by the Discord renderer" };
    }
    return { status: "invalid_input", error: "Security keys can only be used by the Discord renderer" };
}

function validateLocalUserId(value: unknown): string | null {
    return isSnowflake(value) ? value : null;
}

function profileSummary(profile: StoredProfile): SecurityKeyProfileSummary {
    const publicProfile: SecurityKeyPublicProfile = {
        algorithm: profile.algorithm,
        createdAt: profile.createdAt,
        credentialId: profile.credentialId,
        publicKeySpki: profile.publicKeySpki,
        rootFingerprint: profile.rootFingerprint,
        transports: profile.transports,
    };
    return {
        algorithm: profile.algorithm,
        createdAt: profile.createdAt,
        exportText: serializeSecurityKeyProfile(publicProfile),
        formattedRootFingerprint: formatSecurityKeyFingerprint(profile.rootFingerprint),
        rootFingerprint: profile.rootFingerprint,
        transports: profile.transports,
    };
}

function rootSummary(root: TrustedRootRecord): SecurityKeyRootSummary {
    return {
        algorithm: root.algorithm,
        formattedRootFingerprint: formatSecurityKeyFingerprint(root.rootFingerprint),
        linkedUserIds: root.userIds,
        rootFingerprint: root.rootFingerprint,
    };
}

function accountFor(vault: SecurityKeyVault, localUserId: string): SecurityKeyAccountRecord {
    const existing = vault.accounts[localUserId];
    if (existing) return existing;
    if (Object.keys(vault.accounts).length >= MAX_ACCOUNTS)
        throw new SecurityKeyOperationError("capacity_exceeded");
    return vault.accounts[localUserId] = emptyAccount();
}

function randomChallenge(): string {
    return encodeBase64Url(randomBytes(32));
}

function randomNonce(): string {
    return encodeBase64Url(randomBytes(16));
}

function ceremonyPage(title: string, detail: string): string {
    const safeTitle = title.replace(/[<>&"']/gu, "");
    const safeDetail = detail.replace(/[<>&"']/gu, "");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safeTitle}</title><style>html{color-scheme:dark;font-family:system-ui;background:#151720;color:#f2f3f5}body{margin:0;padding:28px;display:flex;min-height:220px;box-sizing:border-box;align-items:center}main{max-width:520px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#c8c9d0}strong{color:#fff}</style></head><body><main><h1>${safeTitle}</h1><p>${safeDetail}</p><p><strong>Touch the roaming security key and complete its PIN or biometric check.</strong></p><p>Close this window to cancel.</p></main></body></html>`;
}

async function startCeremonyServer(title: string, detail: string): Promise<{ origin: string; server: Server; url: string; }> {
    const token = randomUUID();
    const path = `/${token}`;
    const html = ceremonyPage(title, detail);
    const server = createServer((request, response) => {
        const host = String(request.headers.host ?? "").split(":", 1)[0].toLowerCase();
        if (request.method !== "GET" || request.url !== path || (host !== "localhost" && host !== "127.0.0.1")) {
            response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
            response.end("Not found");
            return;
        }
        response.writeHead(200, {
            "Cache-Control": "no-store, max-age=0",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "Content-Type": "text/html; charset=utf-8",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        });
        response.end(html);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "localhost", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new SecurityKeyOperationError("webauthn_unavailable");
    }
    const origin = `http://${SECURITY_KEY_RP_ID}:${address.port}`;
    return { origin, server, url: origin + path };
}

function closeServer(server: Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

async function runWebAuthnCeremony<T>(
    event: IpcMainInvokeEvent,
    title: string,
    detail: string,
    script: string,
): Promise<T> {
    const { origin, server, url } = await startCeremonyServer(title, detail);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const isolatedSession = session.fromPartition(`pc-security-key-${randomUUID()}`, { cache: false });
    const window = new BrowserWindow({
        width: 600,
        height: 340,
        resizable: false,
        minimizable: false,
        maximizable: false,
        show: false,
        title,
        ...(parent && !parent.isDestroyed() ? { parent, modal: true } : {}),
        webPreferences: {
            contextIsolation: true,
            devTools: false,
            nodeIntegration: false,
            sandbox: true,
            session: isolatedSession,
            webSecurity: true,
        },
    });
    isolatedSession.setPermissionRequestHandler((contents, permission, callback) => {
        const permitted = contents === window.webContents && String(permission).startsWith("publickey-credentials");
        callback(permitted);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const preventUnexpectedNavigation = (navigationEvent: Electron.Event, target: string) => {
        if (target !== url) navigationEvent.preventDefault();
    };
    window.webContents.on("will-navigate", preventUnexpectedNavigation);
    window.webContents.on("will-redirect", preventUnexpectedNavigation);

    try {
        await window.loadURL(url);
        await closeServer(server);
        if (window.isDestroyed()) throw new SecurityKeyOperationError("ceremony_cancelled");
        window.show();
        const closed = new Promise<never>((_resolve, reject) => {
            window.once("closed", () => reject(new SecurityKeyOperationError("ceremony_cancelled")));
        });
        const timeout = delay(CEREMONY_TIMEOUT_MS).then(() => {
            throw new SecurityKeyOperationError("ceremony_cancelled");
        });
        const value = await Promise.race([
            window.webContents.executeJavaScript(script, true),
            closed,
            timeout,
        ]) as T | { __error?: unknown; };
        if (isRecord(value) && typeof value.__error === "string")
            throw new SecurityKeyOperationError(value.__error === "NotAllowedError" || value.__error === "AbortError"
                ? "ceremony_cancelled"
                : "invalid_assertion");
        return value as T;
    } catch (error) {
        if (error instanceof SecurityKeyOperationError) throw error;
        throw new SecurityKeyOperationError("webauthn_unavailable");
    } finally {
        await closeServer(server).catch(() => undefined);
        if (!window.isDestroyed()) window.destroy();
        await isolatedSession.clearStorageData().catch(() => undefined);
    }
}

function registrationScript(challenge: string, localUserId: string): string {
    return `(() => { const b64 = value => { const bytes = new Uint8Array(value); let binary = ""; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,""); }; const from = value => Uint8Array.from(atob(value.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(value.length/4)*4,"=")), c => c.charCodeAt(0)); return navigator.credentials.create({ publicKey: { challenge: from(${JSON.stringify(challenge)}), rp: { id: ${JSON.stringify(SECURITY_KEY_RP_ID)}, name: "ProtonnCord Secure Messaging" }, user: { id: crypto.getRandomValues(new Uint8Array(32)), name: ${JSON.stringify(`ProtonnCord-${localUserId}`)}, displayName: "ProtonnCord hardware identity" }, pubKeyCredParams: [{type:"public-key",alg:-7},{type:"public-key",alg:-8},{type:"public-key",alg:-257}], authenticatorSelection: { authenticatorAttachment:"cross-platform", residentKey:"preferred", userVerification:"required" }, attestation:"none", timeout:${CEREMONY_TIMEOUT_MS} } }).then(credential => { if (!(credential instanceof PublicKeyCredential)) throw new Error("InvalidCredential"); const response = credential.response; const publicKey = response.getPublicKey?.(); const algorithm = response.getPublicKeyAlgorithm?.(); const authenticatorData = response.getAuthenticatorData?.(); if (!publicKey || typeof algorithm !== "number" || !authenticatorData) throw new Error("UnsupportedAuthenticator"); return { credentialId:b64(credential.rawId), authenticatorAttachment:credential.authenticatorAttachment, clientDataJson:b64(response.clientDataJSON), authenticatorData:b64(authenticatorData), publicKeySpki:b64(publicKey), algorithm, transports:response.getTransports?.() ?? [] }; }).catch(error => ({__error:error?.name ?? "SecurityError"})); })()`;
}

function assertionScript(challenge: string, profile: SecurityKeyPublicProfile): string {
    return `(() => { const b64 = value => { const bytes = new Uint8Array(value); let binary = ""; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,""); }; const from = value => Uint8Array.from(atob(value.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(value.length/4)*4,"=")), c => c.charCodeAt(0)); return navigator.credentials.get({ publicKey: { challenge:from(${JSON.stringify(challenge)}), rpId:${JSON.stringify(SECURITY_KEY_RP_ID)}, allowCredentials:[{type:"public-key",id:from(${JSON.stringify(profile.credentialId)}),transports:${JSON.stringify(profile.transports)}}], userVerification:"required", timeout:${CEREMONY_TIMEOUT_MS} } }).then(credential => { if (!(credential instanceof PublicKeyCredential)) throw new Error("InvalidCredential"); const response = credential.response; return { credentialId:b64(credential.rawId), authenticatorAttachment:credential.authenticatorAttachment, clientDataJson:b64(response.clientDataJSON), authenticatorData:b64(response.authenticatorData), signature:b64(response.signature) }; }).catch(error => ({__error:error?.name ?? "SecurityError"})); })()`;
}

function checkSignCounter(previous: number, next: number): number {
    if (previous > 0 && next > 0 && next <= previous)
        throw new SecurityKeyOperationError("credential_mismatch");
    return Math.max(previous, next);
}

async function assertProfilePossession(
    event: IpcMainInvokeEvent,
    profile: StoredProfile,
    challenge: string,
    detail: string,
): Promise<void> {
    const assertion = await runWebAuthnCeremony<WebAuthnAssertionResult>(
        event,
        "Verify ProtonnCord security key",
        detail,
        assertionScript(challenge, profile),
    );
    const verified = await verifyWebAuthnAssertion(profile, assertion, challenge).catch(() => {
        throw new SecurityKeyOperationError("invalid_assertion");
    });
    profile.signCount = checkSignCounter(profile.signCount, verified.signCount);
}

function expirePendingReviews(): void {
    const now = Date.now();
    for (const [token, review] of pendingReviews) {
        if (review.expiresAt <= now) pendingReviews.delete(token);
    }
}

function makePendingReviewCapacity(): void {
    while (pendingReviews.size >= MAX_PENDING_REVIEWS) {
        const oldest = pendingReviews.keys().next().value;
        if (typeof oldest !== "string") break;
        pendingReviews.delete(oldest);
    }
}

function discordSnowflakeTimestamp(discordMessageId: string): number {
    return Number((BigInt(discordMessageId) >> 22n) + 1_420_070_400_000n);
}

function discordPublicationTimestamp(discordMessageId: string, editedTimestamp: string | null): number | null {
    const createdAt = discordSnowflakeTimestamp(discordMessageId);
    if (editedTimestamp === null) return createdAt;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(editedTimestamp)) return null;
    const editedAt = Date.parse(editedTimestamp);
    return Number.isFinite(editedAt) && editedAt >= createdAt ? editedAt : null;
}

function reviewState(
    account: SecurityKeyAccountRecord,
    peerUserId: string,
    root: TrustedRootRecord,
    announcement: string,
    reviewToken: string,
): SecurityKeyProofReviewResult {
    const previousRootFingerprint = account.peerRoots[peerUserId] ?? null;
    const known = account.trustedRoots[root.rootFingerprint];
    const summary = rootSummary(known ?? root);
    if (previousRootFingerprint === root.rootFingerprint && known)
        return { status: "trusted", announcement, root: summary };
    if (previousRootFingerprint !== null && previousRootFingerprint !== root.rootFingerprint)
        return { status: "key_changed", announcement, previousRootFingerprint, reviewToken, root: summary };
    if (known)
        return { status: "linked", announcement, previousRootFingerprint, reviewToken, root: summary };
    return { status: "trust_required", announcement, previousRootFingerprint, reviewToken, root: summary };
}

export async function getSecurityKeyState(
    event: IpcMainInvokeEvent,
    localUserId: string,
): Promise<SecurityKeyStateResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user) return { status: "invalid_input", error: "localUserId must be a Discord snowflake" };
    return runSerialized(async (): Promise<SecurityKeyStateResult> => {
        const vault = await loadVault();
        const account = vault.accounts[user];
        const active = account?.profileFingerprint ? vault.profiles[account.profileFingerprint] : null;
        return {
            status: "ready",
            activeProfile: active ? profileSummary(active) : null,
            availableProfiles: Object.values(vault.profiles)
                .filter(profile => profile.rootFingerprint !== active?.rootFingerprint)
                .map(profileSummary)
                .sort((left, right) => left.createdAt - right.createdAt),
        };
    }) as Promise<SecurityKeyStateResult>;
}

export async function setupSecurityKey(
    event: IpcMainInvokeEvent,
    localUserId: string,
): Promise<SecurityKeySetupResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user) return { status: "invalid_input", error: "localUserId must be a Discord snowflake" };
    const challenge = randomChallenge();
    let registration: WebAuthnRegistrationResult;
    try {
        registration = await runWebAuthnCeremony<WebAuthnRegistrationResult>(
            event,
            "Set up ProtonnCord hardware identity",
            "This creates a ProtonnCord-only credential on a roaming FIDO2 security key. It does not replace or export your message-encryption keys.",
            registrationScript(challenge, user),
        );
    } catch (error) {
        return mapFailure(error);
    }
    let verified: Awaited<ReturnType<typeof verifyWebAuthnRegistration>>;
    try {
        verified = await verifyWebAuthnRegistration(registration, challenge);
    } catch {
        return { status: "failed", error: "invalid_assertion" };
    }
    return runSerialized(async (): Promise<SecurityKeySetupResult> => {
        const vault = await loadVault();
        const account = accountFor(vault, user);
        const profile: StoredProfile = { ...verified.profile, signCount: verified.signCount };
        const existing = vault.profiles[profile.rootFingerprint];
        if (existing && (existing.credentialId !== profile.credentialId ||
            existing.publicKeySpki !== profile.publicKeySpki || existing.algorithm !== profile.algorithm))
            throw new SecurityKeyOperationError("credential_mismatch");
        if (!existing && Object.keys(vault.profiles).length >= MAX_LOCAL_PROFILES)
            throw new SecurityKeyOperationError("capacity_exceeded");
        vault.profiles[profile.rootFingerprint] = existing ?? profile;
        account.profileFingerprint = profile.rootFingerprint;
        await saveVault(vault);
        return { status: "configured", profile: profileSummary(vault.profiles[profile.rootFingerprint]) };
    }) as Promise<SecurityKeySetupResult>;
}

async function linkProfile(
    event: IpcMainInvokeEvent,
    localUserId: string,
    publicProfile: SecurityKeyPublicProfile,
): Promise<SecurityKeySetupResult> {
    try {
        await verifySecurityKeyProfile(publicProfile);
    } catch {
        return { status: "invalid_input", error: "The exported security-key profile is invalid" };
    }
    const issuedAt = Date.now();
    const nonce = randomNonce();
    const challenge = await securityKeyImportChallenge(publicProfile, localUserId, nonce, issuedAt);
    const temporary: StoredProfile = { ...publicProfile, signCount: 0 };
    try {
        await assertProfilePossession(
            event,
            temporary,
            challenge,
            "Insert the security key represented by this exported public profile to link the current Discord account.",
        );
    } catch (error) {
        return mapFailure(error);
    }
    return runSerialized(async (): Promise<SecurityKeySetupResult> => {
        const vault = await loadVault();
        const account = accountFor(vault, localUserId);
        const existing = vault.profiles[temporary.rootFingerprint];
        if (existing && (existing.credentialId !== temporary.credentialId ||
            existing.publicKeySpki !== temporary.publicKeySpki || existing.algorithm !== temporary.algorithm))
            throw new SecurityKeyOperationError("credential_mismatch");
        if (!existing && Object.keys(vault.profiles).length >= MAX_LOCAL_PROFILES)
            throw new SecurityKeyOperationError("capacity_exceeded");
        if (existing) existing.signCount = checkSignCounter(existing.signCount, temporary.signCount);
        else vault.profiles[temporary.rootFingerprint] = temporary;
        account.profileFingerprint = temporary.rootFingerprint;
        await saveVault(vault);
        return { status: "configured", profile: profileSummary(vault.profiles[temporary.rootFingerprint]) };
    }) as Promise<SecurityKeySetupResult>;
}

export async function importSecurityKeyProfile(
    event: IpcMainInvokeEvent,
    localUserId: string,
    exportedProfile: string,
): Promise<SecurityKeySetupResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user) return { status: "invalid_input", error: "localUserId must be a Discord snowflake" };
    let profile: SecurityKeyPublicProfile;
    try {
        profile = parseSecurityKeyProfile(exportedProfile.trim());
    } catch {
        return { status: "invalid_input", error: "The exported security-key profile is malformed" };
    }
    return linkProfile(event, user, profile);
}

export async function linkKnownSecurityKey(
    event: IpcMainInvokeEvent,
    localUserId: string,
    rootFingerprint: string,
): Promise<SecurityKeySetupResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user || !isRootFingerprint(rootFingerprint))
        return { status: "invalid_input", error: "Invalid account or security-key fingerprint" };
    const loaded = await runSerialized(async () => {
        const profile = (await loadVault()).profiles[rootFingerprint];
        return profile ? { status: "profile" as const, profile } : { status: "missing" as const };
    });
    if ("status" in loaded && loaded.status !== "profile") {
        if (loaded.status === "missing") return { status: "invalid_input", error: "That local security-key profile no longer exists" };
        return loaded as SecurityKeyFailure;
    }
    return linkProfile(event, user, (loaded as { status: "profile"; profile: StoredProfile; }).profile);
}

export async function unlinkSecurityKey(
    event: IpcMainInvokeEvent,
    localUserId: string,
): Promise<{ status: "unlinked"; } | SecurityKeyFailure> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user) return { status: "invalid_input", error: "localUserId must be a Discord snowflake" };
    return runSerialized(async () => {
        const vault = await loadVault();
        const account = accountFor(vault, user);
        const previous = account.profileFingerprint;
        account.profileFingerprint = null;
        if (previous && !Object.values(vault.accounts).some(candidate => candidate.profileFingerprint === previous))
            delete vault.profiles[previous];
        await saveVault(vault);
        return { status: "unlinked" as const };
    }) as Promise<{ status: "unlinked"; } | SecurityKeyFailure>;
}

export async function createSecurityKeyProof(
    event: IpcMainInvokeEvent,
    localUserId: string,
    announcement: string,
): Promise<SecurityKeyProofResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user || typeof announcement !== "string" || announcement.length < 1 || announcement.length > 1_500)
        return { status: "invalid_input", error: "Invalid account or encryption-key announcement" };
    try {
        await verifyKeyAnnouncement(announcement, user);
        if (keyAnnouncementFromContent(announcement).u !== user) throw new Error("mismatch");
    } catch {
        return { status: "invalid_input", error: "The encryption-key announcement is invalid" };
    }
    const loaded = await runSerialized(async () => {
        const vault = await loadVault();
        const account = vault.accounts[user];
        const profile = account?.profileFingerprint ? vault.profiles[account.profileFingerprint] : null;
        return profile ? { status: "profile" as const, profile } : { status: "missing" as const };
    });
    if ("status" in loaded && loaded.status !== "profile") {
        if (loaded.status === "missing") return { status: "invalid_input", error: "Set up or link a security key first" };
        return loaded as SecurityKeyFailure;
    }
    const profile = structuredClone((loaded as { status: "profile"; profile: StoredProfile; }).profile);
    const proofBase = {
        userId: user,
        issuedAt: Date.now(),
        nonce: randomNonce(),
        announcement,
        rootFingerprint: profile.rootFingerprint,
    };
    const challenge = await securityKeyProofChallenge(proofBase);
    let assertion: WebAuthnAssertionResult;
    try {
        assertion = await runWebAuthnCeremony<WebAuthnAssertionResult>(
            event,
            "Sign ProtonnCord hardware identity proof",
            "This binds the current Discord account and its current message-encryption identity to your established hardware security key.",
            assertionScript(challenge, profile),
        );
        const verified = await verifyWebAuthnAssertion(profile, assertion, challenge);
        profile.signCount = checkSignCounter(profile.signCount, verified.signCount);
    } catch (error) {
        return mapFailure(error);
    }
    const proof: SecurityKeyProof = {
        ...proofBase,
        algorithm: profile.algorithm,
        publicKeySpki: profile.publicKeySpki,
        clientDataJson: assertion.clientDataJson,
        authenticatorData: assertion.authenticatorData,
        signature: assertion.signature,
    };
    let content: string;
    try {
        content = serializeSecurityKeyProof(proof);
    } catch {
        return { status: "failed", error: "capacity_exceeded" };
    }
    const saved = await runSerialized(async () => {
        const vault = await loadVault();
        const stored = vault.profiles[profile.rootFingerprint];
        const account = vault.accounts[user];
        if (!stored || account?.profileFingerprint !== profile.rootFingerprint ||
            stored.credentialId !== profile.credentialId)
            throw new SecurityKeyOperationError("credential_mismatch");
        stored.signCount = checkSignCounter(stored.signCount, profile.signCount);
        await saveVault(vault);
        return { status: "saved" as const };
    });
    if ("status" in saved && saved.status !== "saved") return saved as SecurityKeyFailure;
    return { status: "created", content, profile: profileSummary(profile) };
}

export async function reviewSecurityKeyProof(
    event: IpcMainInvokeEvent,
    localUserId: string,
    discordAuthorId: string,
    content: string,
    discordMessageId: string,
    discordEditedTimestamp: string | null,
): Promise<SecurityKeyProofReviewResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user || !isSnowflake(discordAuthorId) || discordAuthorId === user || !isSnowflake(discordMessageId) ||
        (discordEditedTimestamp !== null && typeof discordEditedTimestamp !== "string"))
        return { status: "invalid_input", error: "Invalid security-key proof message details" };
    let proof: SecurityKeyProof;
    try {
        proof = parseSecurityKeyProof(content);
    } catch {
        return { status: "invalid_proof" };
    }
    const publishedAt = discordPublicationTimestamp(discordMessageId, discordEditedTimestamp);
    if (publishedAt === null) return { status: "invalid_proof" };
    let signCount: number;
    try {
        const verified = await verifySecurityKeyProof(proof, discordAuthorId, publishedAt);
        signCount = verified.signCount;
        const identity = await verifyKeyAnnouncement(proof.announcement, discordAuthorId);
        if (identity.userId !== discordAuthorId || keyAnnouncementFromContent(proof.announcement).u !== discordAuthorId)
            throw new Error("announcement mismatch");
    } catch {
        return { status: "invalid_proof" };
    }
    return runSerialized(async (): Promise<SecurityKeyProofReviewResult> => {
        const vault = await loadVault();
        const account = accountFor(vault, user);
        const digest = securityKeyProofDigest(content);
        const sameDigest = account.proofReplay.find(replay => replay.digest === digest);
        if (sameDigest && sameDigest.discordMessageId !== discordMessageId)
            return { status: "replay_detected" };
        if (account.proofReplay.some(replay => replay.discordMessageId === discordMessageId && replay.digest !== digest))
            return { status: "replay_detected" };
        if (!sameDigest) {
            account.proofReplay.push({ digest, discordMessageId, seenAt: Date.now() });
            if (account.proofReplay.length > MAX_REPLAY_RECORDS)
                account.proofReplay.splice(0, account.proofReplay.length - MAX_REPLAY_RECORDS);
        }

        const known = account.trustedRoots[proof.rootFingerprint];
        if (known && known.lastSignCount > 0 && signCount > 0 && signCount <= known.lastSignCount && !sameDigest)
            return { status: "replay_detected" };
        if (known) known.lastSignCount = Math.max(known.lastSignCount, signCount);
        const root: TrustedRootRecord = known ?? {
            algorithm: proof.algorithm,
            firstTrustedAt: Date.now(),
            lastSignCount: signCount,
            publicKeySpki: proof.publicKeySpki,
            rootFingerprint: proof.rootFingerprint,
            userIds: [],
        };
        if (known && (known.algorithm !== proof.algorithm || known.publicKeySpki !== proof.publicKeySpki))
            return { status: "invalid_proof" };
        expirePendingReviews();
        makePendingReviewCapacity();
        const reviewToken = randomUUID();
        pendingReviews.set(reviewToken, {
            expiresAt: Date.now() + REVIEW_LIFETIME_MS,
            localUserId: user,
            peerUserId: discordAuthorId,
            root: structuredClone(root),
        });
        await saveVault(vault);
        return reviewState(account, discordAuthorId, root, proof.announcement, reviewToken);
    }) as Promise<SecurityKeyProofReviewResult>;
}

export async function trustSecurityKeyProof(
    event: IpcMainInvokeEvent,
    localUserId: string,
    peerUserId: string,
    reviewToken: string,
    expectedRootFingerprint: string,
    replaceExisting: boolean,
): Promise<SecurityKeyProofTrustResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user || !isSnowflake(peerUserId) || peerUserId === user || typeof reviewToken !== "string" ||
        !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu.test(reviewToken) ||
        !isRootFingerprint(expectedRootFingerprint) || typeof replaceExisting !== "boolean")
        return { status: "invalid_input", error: "Invalid security-key trust request" };
    return runSerialized(async (): Promise<SecurityKeyProofTrustResult> => {
        expirePendingReviews();
        const review = pendingReviews.get(reviewToken);
        if (!review || review.localUserId !== user || review.peerUserId !== peerUserId ||
            review.root.rootFingerprint !== expectedRootFingerprint) return { status: "review_expired" };
        const vault = await loadVault();
        const account = accountFor(vault, user);
        const previous = account.peerRoots[peerUserId] ?? null;
        if (previous && previous !== expectedRootFingerprint && !replaceExisting)
            return { status: "key_changed" };
        if (!account.trustedRoots[expectedRootFingerprint] &&
            Object.keys(account.trustedRoots).length >= MAX_TRUSTED_ROOTS)
            throw new SecurityKeyOperationError("capacity_exceeded");
        const root = account.trustedRoots[expectedRootFingerprint] ?? review.root;
        root.firstTrustedAt = account.trustedRoots[expectedRootFingerprint]?.firstTrustedAt ?? Date.now();
        root.lastSignCount = Math.max(root.lastSignCount, review.root.lastSignCount);
        root.userIds = [...new Set([...root.userIds, peerUserId])].sort((left, right) => left.localeCompare(right));
        account.trustedRoots[expectedRootFingerprint] = root;
        account.peerRoots[peerUserId] = expectedRootFingerprint;
        pendingReviews.delete(reviewToken);
        await saveVault(vault);
        return { status: "trusted", root: rootSummary(root) };
    }) as Promise<SecurityKeyProofTrustResult>;
}

export async function forgetSecurityKeyPeer(
    event: IpcMainInvokeEvent,
    localUserId: string,
    peerUserId: string,
): Promise<{ status: "forgotten" | "not_found"; } | SecurityKeyFailure> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user || !isSnowflake(peerUserId) || peerUserId === user)
        return { status: "invalid_input", error: "Invalid security-key peer" };
    return runSerialized(async () => {
        const vault = await loadVault();
        const account = accountFor(vault, user);
        const fingerprint = account.peerRoots[peerUserId];
        if (!fingerprint) return { status: "not_found" as const };
        delete account.peerRoots[peerUserId];
        const root = account.trustedRoots[fingerprint];
        if (root) {
            root.userIds = root.userIds.filter(candidate => candidate !== peerUserId);
            if (root.userIds.length === 0) delete account.trustedRoots[fingerprint];
        }
        await saveVault(vault);
        return { status: "forgotten" as const };
    }) as Promise<{ status: "forgotten" | "not_found"; } | SecurityKeyFailure>;
}
