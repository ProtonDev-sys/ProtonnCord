/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createPublicKey,
    hkdfSync,
    randomBytes,
    randomUUID,
    type KeyObject,
    verify as verifySignature,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import {
    BrowserWindow,
    type IpcMainInvokeEvent,
    session,
} from "electron";

const PROFILE_PREFIX = "PCSKV1:";
const PROFILE_VERSION = 1 as const;
const ENVELOPE_VERSION = 2 as const;
const RP_ID = "localhost";
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_PROFILE_LENGTH = 8_192;
const MAX_ENCRYPTED_VAULT_BYTES = 24 * 1024 * 1024;
const USER_PRESENT_FLAG = 0x01;
const USER_VERIFIED_FLAG = 0x04;
const ROOT_PREFIX = Buffer.from("ProtonnCord/SecureMessaging/security-key-vault-root/v1\0", "utf8");
const VAULT_KEY_INFO = Buffer.from("ProtonnCord/SecureMessaging/security-key-vault-key/v1", "utf8");
const VAULT_AAD_PREFIX = "ProtonnCord/SecureMessaging/security-key-vault/v2";
const SNOWFLAKE = /^\d{17,20}$/u;

export type SecurityKeyAlgorithm = -8 | -7 | -257;
export type SecurityKeyTransport = "ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";
export type SecurityKeyVaultErrorCode =
    | "cancelled"
    | "corrupt"
    | "credential_mismatch"
    | "invalid_profile"
    | "locked"
    | "unsupported";

export class SecurityKeyVaultError extends Error {
    constructor(readonly code: SecurityKeyVaultErrorCode) {
        super(code);
    }
}

export interface SecurityKeyVaultProfile {
    algorithm: SecurityKeyAlgorithm;
    createdAt: number;
    credentialId: string;
    prfSalt: string;
    publicKeySpki: string;
    rootFingerprint: string;
    transports: SecurityKeyTransport[];
}

export interface SecurityKeyVaultProfileSummary {
    exportText: string;
    formattedRootFingerprint: string;
    rootFingerprint: string;
}

export interface SecurityKeyVaultEnvelope {
    ciphertext: string;
    mode: "security_key";
    nonce: string;
    rootFingerprint: string;
    tag: string;
    version: typeof ENVELOPE_VERSION;
    profile: SecurityKeyVaultProfile;
}

export type SecurityKeyVaultState =
    | { status: "not_configured"; }
    | { status: "locked" | "unlocked"; profile: SecurityKeyVaultProfileSummary; };

export interface PreparedSecurityKeyVault {
    key: Buffer;
    profile: SecurityKeyVaultProfile;
}

interface RegistrationResult {
    algorithm: number;
    authenticatorAttachment: string | null;
    authenticatorData: string;
    clientDataJson: string;
    credentialId: string;
    prfEnabled: boolean;
    prfFirst: string | null;
    publicKeySpki: string;
    transports: string[];
}

interface AssertionResult {
    authenticatorAttachment: string | null;
    authenticatorData: string;
    clientDataJson: string;
    credentialId: string;
    prfFirst: string;
    signature: string;
}

let activeKey: Buffer | null = null;
let activeProfile: SecurityKeyVaultProfile | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const canonical = [...expected].sort();
    return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function encodeBase64Url(value: ArrayBufferLike | ArrayBufferView): string {
    const bytes = ArrayBuffer.isView(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(value);
    return bytes.toString("base64url");
}

function decodeBase64Url(value: unknown, minimumBytes = 1, maximumBytes = Number.POSITIVE_INFINITY): Buffer {
    if (typeof value !== "string" || value.length < 1 || !/^[A-Za-z0-9_-]+$/u.test(value))
        throw new SecurityKeyVaultError("invalid_profile");
    let bytes: Buffer;
    try {
        bytes = Buffer.from(value, "base64url");
    } catch {
        throw new SecurityKeyVaultError("invalid_profile");
    }
    if (bytes.byteLength < minimumBytes || bytes.byteLength > maximumBytes || bytes.toString("base64url") !== value)
        throw new SecurityKeyVaultError("invalid_profile");
    return bytes;
}

function validTimestamp(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1_700_000_000_000 &&
        (value as number) <= 9_999_999_999_999;
}

function validAlgorithm(value: unknown): value is SecurityKeyAlgorithm {
    return value === -8 || value === -7 || value === -257;
}

function validTransport(value: unknown): value is SecurityKeyTransport {
    return value === "ble" || value === "hybrid" || value === "internal" || value === "nfc" ||
        value === "smart-card" || value === "usb";
}

function assertPublicKeyAlgorithm(algorithm: SecurityKeyAlgorithm, publicKeySpki: string): KeyObject {
    const key = createPublicKey({
        key: decodeBase64Url(publicKeySpki, 32, 1_024),
        format: "der",
        type: "spki",
    });
    const details = key.asymmetricKeyDetails;
    if (algorithm === -7 && (key.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1"))
        throw new SecurityKeyVaultError("invalid_profile");
    if (algorithm === -8 && key.asymmetricKeyType !== "ed25519")
        throw new SecurityKeyVaultError("invalid_profile");
    if (algorithm === -257 && (key.asymmetricKeyType !== "rsa" || (details?.modulusLength ?? 0) < 2_048))
        throw new SecurityKeyVaultError("invalid_profile");
    return key;
}

function rootFingerprint(algorithm: SecurityKeyAlgorithm, publicKeySpki: string): string {
    assertPublicKeyAlgorithm(algorithm, publicKeySpki);
    return createHash("sha256")
        .update(ROOT_PREFIX)
        .update(`${RP_ID}\0${algorithm}\0`, "utf8")
        .update(decodeBase64Url(publicKeySpki, 32, 1_024))
        .digest("base64url");
}

function validateProfile(profile: SecurityKeyVaultProfile): void {
    if (!profile || !validAlgorithm(profile.algorithm) || !validTimestamp(profile.createdAt) ||
        !Array.isArray(profile.transports) || profile.transports.length > 6 ||
        profile.transports.some(transport => !validTransport(transport)))
        throw new SecurityKeyVaultError("invalid_profile");
    decodeBase64Url(profile.credentialId, 16, 1_024);
    decodeBase64Url(profile.prfSalt, 32, 32);
    decodeBase64Url(profile.publicKeySpki, 32, 1_024);
    decodeBase64Url(profile.rootFingerprint, 32, 32);
    const transports = [...new Set(profile.transports)].sort((left, right) => left.localeCompare(right));
    if (transports.length !== profile.transports.length ||
        transports.some((transport, index) => transport !== profile.transports[index]) ||
        rootFingerprint(profile.algorithm, profile.publicKeySpki) !== profile.rootFingerprint)
        throw new SecurityKeyVaultError("invalid_profile");
}

export function serializeSecurityKeyVaultProfile(profile: SecurityKeyVaultProfile): string {
    validateProfile(profile);
    const value = PROFILE_PREFIX + JSON.stringify([
        PROFILE_VERSION,
        profile.createdAt,
        profile.credentialId,
        profile.algorithm,
        profile.publicKeySpki,
        profile.rootFingerprint,
        profile.transports,
        profile.prfSalt,
    ]);
    if (value.length > MAX_PROFILE_LENGTH) throw new SecurityKeyVaultError("invalid_profile");
    return value;
}

export function parseSecurityKeyVaultProfile(value: string): SecurityKeyVaultProfile {
    if (typeof value !== "string" || value.length <= PROFILE_PREFIX.length || value.length > MAX_PROFILE_LENGTH ||
        !value.startsWith(PROFILE_PREFIX)) throw new SecurityKeyVaultError("invalid_profile");
    let parsed: unknown;
    try {
        parsed = JSON.parse(value.slice(PROFILE_PREFIX.length));
    } catch {
        throw new SecurityKeyVaultError("invalid_profile");
    }
    if (!Array.isArray(parsed) || parsed.length !== 8 || parsed[0] !== PROFILE_VERSION)
        throw new SecurityKeyVaultError("invalid_profile");
    const profile: SecurityKeyVaultProfile = {
        createdAt: parsed[1],
        credentialId: parsed[2],
        algorithm: parsed[3],
        publicKeySpki: parsed[4],
        rootFingerprint: parsed[5],
        transports: parsed[6],
        prfSalt: parsed[7],
    };
    validateProfile(profile);
    if (serializeSecurityKeyVaultProfile(profile) !== value)
        throw new SecurityKeyVaultError("invalid_profile");
    return profile;
}

export function formatSecurityKeyVaultFingerprint(fingerprint: string): string {
    const bytes = decodeBase64Url(fingerprint, 32, 32);
    const hexadecimal = bytes.toString("hex").toUpperCase();
    return hexadecimal.match(/.{1,4}/gu)?.join(" ") ?? hexadecimal;
}

export function securityKeyVaultProfileSummary(profile: SecurityKeyVaultProfile): SecurityKeyVaultProfileSummary {
    validateProfile(profile);
    return {
        exportText: serializeSecurityKeyVaultProfile(profile),
        formattedRootFingerprint: formatSecurityKeyVaultFingerprint(profile.rootFingerprint),
        rootFingerprint: profile.rootFingerprint,
    };
}

export function parseSecurityKeyVaultEnvelope(value: unknown): SecurityKeyVaultEnvelope | null {
    if (!isRecord(value) || !hasExactKeys(value, [
        "ciphertext", "mode", "nonce", "profile", "rootFingerprint", "tag", "version",
    ]) || value.version !== ENVELOPE_VERSION || value.mode !== "security_key" ||
        !isRecord(value.profile)) return null;
    const profile = value.profile as unknown as SecurityKeyVaultProfile;
    try {
        validateProfile(profile);
        decodeBase64Url(value.nonce, 12, 12);
        decodeBase64Url(value.tag, 16, 16);
        decodeBase64Url(value.ciphertext, 1, MAX_ENCRYPTED_VAULT_BYTES);
        if (value.rootFingerprint !== profile.rootFingerprint) return null;
    } catch {
        return null;
    }
    return {
        ciphertext: value.ciphertext as string,
        mode: "security_key",
        nonce: value.nonce as string,
        profile,
        rootFingerprint: value.rootFingerprint as string,
        tag: value.tag as string,
        version: ENVELOPE_VERSION,
    };
}

export function securityKeyVaultStateForValue(value: unknown): SecurityKeyVaultState {
    const envelope = parseSecurityKeyVaultEnvelope(value);
    if (!envelope) return { status: "not_configured" };
    const unlocked = activeKey !== null && activeProfile?.rootFingerprint === envelope.rootFingerprint;
    return {
        status: unlocked ? "unlocked" : "locked",
        profile: securityKeyVaultProfileSummary(envelope.profile),
    };
}

function vaultAad(root: string): Buffer {
    return Buffer.from(JSON.stringify([VAULT_AAD_PREFIX, ENVELOPE_VERSION, root]), "utf8");
}

function deriveVaultKey(prfOutput: string, profile: SecurityKeyVaultProfile): Buffer {
    const output = decodeBase64Url(prfOutput, 32, 32);
    return Buffer.from(hkdfSync(
        "sha256",
        output,
        decodeBase64Url(profile.rootFingerprint, 32, 32),
        VAULT_KEY_INFO,
        32,
    ));
}

export function activatePreparedSecurityKeyVault(prepared: PreparedSecurityKeyVault): void {
    validateProfile(prepared.profile);
    if (!Buffer.isBuffer(prepared.key) || prepared.key.byteLength !== 32)
        throw new SecurityKeyVaultError("credential_mismatch");
    clearSecurityKeyVaultSession();
    activeKey = Buffer.from(prepared.key);
    activeProfile = structuredClone(prepared.profile);
}

export function clearSecurityKeyVaultSession(): void {
    activeKey?.fill(0);
    activeKey = null;
    activeProfile = null;
}

export function wrapSecurityKeyVaultValue(value: unknown): unknown {
    if (!activeKey || !activeProfile) return value;
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", activeKey, nonce);
    cipher.setAAD(vaultAad(activeProfile.rootFingerprint));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_ENCRYPTED_VAULT_BYTES)
        throw new SecurityKeyVaultError("corrupt");
    return {
        ciphertext: ciphertext.toString("base64url"),
        mode: "security_key",
        nonce: nonce.toString("base64url"),
        profile: structuredClone(activeProfile),
        rootFingerprint: activeProfile.rootFingerprint,
        tag: tag.toString("base64url"),
        version: ENVELOPE_VERSION,
    } satisfies SecurityKeyVaultEnvelope;
}

export function unwrapSecurityKeyVaultValue(value: unknown): unknown {
    const envelope = parseSecurityKeyVaultEnvelope(value);
    if (!envelope) return value;
    if (!activeKey || activeProfile?.rootFingerprint !== envelope.rootFingerprint)
        throw new SecurityKeyVaultError("locked");
    try {
        const decipher = createDecipheriv(
            "aes-256-gcm",
            activeKey,
            decodeBase64Url(envelope.nonce, 12, 12),
        );
        decipher.setAAD(vaultAad(envelope.rootFingerprint));
        decipher.setAuthTag(decodeBase64Url(envelope.tag, 16, 16));
        const plaintext = Buffer.concat([
            decipher.update(decodeBase64Url(envelope.ciphertext, 1, MAX_ENCRYPTED_VAULT_BYTES)),
            decipher.final(),
        ]);
        return JSON.parse(plaintext.toString("utf8"));
    } catch (error) {
        if (error instanceof SecurityKeyVaultError) throw error;
        throw new SecurityKeyVaultError("corrupt");
    }
}

function randomChallenge(): string {
    return randomBytes(32).toString("base64url");
}

function ceremonyPage(title: string): string {
    const safeTitle = title.replace(/[<>&"']/gu, "");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safeTitle}</title><style>html{color-scheme:dark;font-family:system-ui;background:#151720;color:#f2f3f5}body{margin:0;padding:28px;display:flex;min-height:220px;box-sizing:border-box;align-items:center}main{max-width:520px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#c8c9d0}</style></head><body><main><h1>${safeTitle}</h1><p>Insert the security key and complete its PIN or biometric check.</p><p>Close this window to cancel.</p></main></body></html>`;
}

async function startCeremonyServer(title: string): Promise<{ server: Server; url: string; }> {
    const token = randomUUID();
    const pathname = `/${token}`;
    const html = ceremonyPage(title);
    const server = createServer((request, response) => {
        const host = String(request.headers.host ?? "").split(":", 1)[0].toLowerCase();
        if (request.method !== "GET" || request.url !== pathname || (host !== "localhost" && host !== "127.0.0.1")) {
            response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain" });
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
        throw new SecurityKeyVaultError("unsupported");
    }
    return { server, url: `http://${RP_ID}:${address.port}${pathname}` };
}

function closeServer(server: Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

async function runCeremony<T>(event: IpcMainInvokeEvent, title: string, script: string): Promise<T> {
    const { server, url } = await startCeremonyServer(title);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const isolatedSession = session.fromPartition(`pc-secure-vault-${randomUUID()}`, { cache: false });
    const window = new BrowserWindow({
        width: 560,
        height: 300,
        maximizable: false,
        minimizable: false,
        resizable: false,
        show: false,
        title,
        ...(parent && !parent.isDestroyed() ? { modal: true, parent } : {}),
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
        callback(contents === window.webContents && String(permission).startsWith("publickey-credentials"));
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const stopNavigation = (navigationEvent: Electron.Event, target: string) => {
        if (target !== url) navigationEvent.preventDefault();
    };
    window.webContents.on("will-navigate", stopNavigation);
    window.webContents.on("will-redirect", stopNavigation);

    try {
        await window.loadURL(url);
        await closeServer(server);
        if (window.isDestroyed()) throw new SecurityKeyVaultError("cancelled");
        window.show();
        const closed = new Promise<never>((_resolve, reject) => {
            window.once("closed", () => reject(new SecurityKeyVaultError("cancelled")));
        });
        const timeout = delay(CEREMONY_TIMEOUT_MS).then(() => {
            throw new SecurityKeyVaultError("cancelled");
        });
        const result = await Promise.race([
            window.webContents.executeJavaScript(script, true),
            closed,
            timeout,
        ]) as T | { __error?: unknown; };
        if (isRecord(result) && typeof result.__error === "string") {
            if (result.__error === "NotAllowedError" || result.__error === "AbortError")
                throw new SecurityKeyVaultError("cancelled");
            if (result.__error === "PrfUnavailable" || result.__error === "UnsupportedAuthenticator")
                throw new SecurityKeyVaultError("unsupported");
            throw new SecurityKeyVaultError("credential_mismatch");
        }
        return result as T;
    } catch (error) {
        if (error instanceof SecurityKeyVaultError) throw error;
        throw new SecurityKeyVaultError("unsupported");
    } finally {
        await closeServer(server).catch(() => undefined);
        if (!window.isDestroyed()) window.destroy();
        await isolatedSession.clearStorageData().catch(() => undefined);
    }
}

function registrationScript(challenge: string, prfSalt: string, localUserId: string): string {
    return `(() => { const b64=value=>{const bytes=new Uint8Array(value);let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");};const from=value=>Uint8Array.from(atob(value.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(value.length/4)*4,"=")),c=>c.charCodeAt(0));return navigator.credentials.create({publicKey:{challenge:from(${JSON.stringify(challenge)}),rp:{id:${JSON.stringify(RP_ID)},name:"ProtonnCord Secure Messaging"},user:{id:crypto.getRandomValues(new Uint8Array(32)),name:${JSON.stringify(`ProtonnCord-${localUserId}`)},displayName:"ProtonnCord encrypted vault"},pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-8},{type:"public-key",alg:-257}],authenticatorSelection:{authenticatorAttachment:"cross-platform",residentKey:"preferred",userVerification:"required"},attestation:"none",extensions:{prf:{eval:{first:from(${JSON.stringify(prfSalt)})}}},timeout:${CEREMONY_TIMEOUT_MS}}}).then(credential=>{if(!(credential instanceof PublicKeyCredential))throw new Error("UnsupportedAuthenticator");const response=credential.response;const publicKey=response.getPublicKey?.();const algorithm=response.getPublicKeyAlgorithm?.();const authenticatorData=response.getAuthenticatorData?.();if(!publicKey||typeof algorithm!=="number"||!authenticatorData)throw new Error("UnsupportedAuthenticator");const prf=credential.getClientExtensionResults?.().prf;return{credentialId:b64(credential.rawId),authenticatorAttachment:credential.authenticatorAttachment,clientDataJson:b64(response.clientDataJSON),authenticatorData:b64(authenticatorData),publicKeySpki:b64(publicKey),algorithm,transports:response.getTransports?.()??[],prfEnabled:prf?.enabled===true,prfFirst:prf?.results?.first?b64(prf.results.first):null};}).catch(error=>({__error:error?.message==="UnsupportedAuthenticator"?"UnsupportedAuthenticator":error?.name??"SecurityError"}));})()`;
}

function assertionScript(challenge: string, profile: SecurityKeyVaultProfile): string {
    return `(() => { const b64=value=>{const bytes=new Uint8Array(value);let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");};const from=value=>Uint8Array.from(atob(value.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(value.length/4)*4,"=")),c=>c.charCodeAt(0));return navigator.credentials.get({publicKey:{challenge:from(${JSON.stringify(challenge)}),rpId:${JSON.stringify(RP_ID)},allowCredentials:[{type:"public-key",id:from(${JSON.stringify(profile.credentialId)}),transports:${JSON.stringify(profile.transports)}}],userVerification:"required",extensions:{prf:{eval:{first:from(${JSON.stringify(profile.prfSalt)})}}},timeout:${CEREMONY_TIMEOUT_MS}}}).then(credential=>{if(!(credential instanceof PublicKeyCredential))throw new Error("UnsupportedAuthenticator");const response=credential.response;const prf=credential.getClientExtensionResults?.().prf;const first=prf?.results?.first;if(!first)throw new Error("PrfUnavailable");return{credentialId:b64(credential.rawId),authenticatorAttachment:credential.authenticatorAttachment,clientDataJson:b64(response.clientDataJSON),authenticatorData:b64(response.authenticatorData),signature:b64(response.signature),prfFirst:b64(first)};}).catch(error=>({__error:error?.message==="PrfUnavailable"?"PrfUnavailable":error?.name??"SecurityError"}));})()`;
}

function parseClientData(encoded: string, expectedChallenge: string, expectedType: "webauthn.create" | "webauthn.get"): Buffer {
    const bytes = decodeBase64Url(encoded, 32, 2_048);
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new SecurityKeyVaultError("credential_mismatch");
    }
    if (!isRecord(value) || value.type !== expectedType || value.challenge !== expectedChallenge ||
        value.crossOrigin === true || typeof value.origin !== "string")
        throw new SecurityKeyVaultError("credential_mismatch");
    let origin: URL;
    try {
        origin = new URL(value.origin);
    } catch {
        throw new SecurityKeyVaultError("credential_mismatch");
    }
    if (origin.protocol !== "http:" || origin.hostname !== RP_ID || !origin.port || origin.pathname !== "/" ||
        origin.username || origin.password || origin.search || origin.hash)
        throw new SecurityKeyVaultError("credential_mismatch");
    return bytes;
}

function parseAuthenticatorData(encoded: string): Buffer {
    const bytes = decodeBase64Url(encoded, 37, 1_024);
    const expectedRpHash = createHash("sha256").update(RP_ID, "utf8").digest();
    if (!bytes.subarray(0, 32).equals(expectedRpHash) || (bytes[32] & USER_PRESENT_FLAG) === 0 ||
        (bytes[32] & USER_VERIFIED_FLAG) === 0)
        throw new SecurityKeyVaultError("credential_mismatch");
    return bytes;
}

function verifyRegistration(result: RegistrationResult, challenge: string): SecurityKeyVaultProfile {
    if (!result || result.authenticatorAttachment !== "cross-platform" || !validAlgorithm(result.algorithm))
        throw new SecurityKeyVaultError("unsupported");
    parseClientData(result.clientDataJson, challenge, "webauthn.create");
    parseAuthenticatorData(result.authenticatorData);
    const transports = [...new Set(result.transports.filter(validTransport))]
        .sort((left, right) => left.localeCompare(right));
    const profile: SecurityKeyVaultProfile = {
        algorithm: result.algorithm,
        createdAt: Date.now(),
        credentialId: result.credentialId,
        prfSalt: "",
        publicKeySpki: result.publicKeySpki,
        rootFingerprint: rootFingerprint(result.algorithm, result.publicKeySpki),
        transports,
    };
    decodeBase64Url(profile.credentialId, 16, 1_024);
    assertPublicKeyAlgorithm(profile.algorithm, profile.publicKeySpki);
    return profile;
}

function verifyAssertion(result: AssertionResult, profile: SecurityKeyVaultProfile, challenge: string): string {
    validateProfile(profile);
    if (!result || result.authenticatorAttachment !== "cross-platform" || result.credentialId !== profile.credentialId)
        throw new SecurityKeyVaultError("credential_mismatch");
    const clientData = parseClientData(result.clientDataJson, challenge, "webauthn.get");
    const authenticatorData = parseAuthenticatorData(result.authenticatorData);
    const signed = Buffer.concat([
        authenticatorData,
        createHash("sha256").update(clientData).digest(),
    ]);
    const key = assertPublicKeyAlgorithm(profile.algorithm, profile.publicKeySpki);
    const valid = profile.algorithm === -8
        ? verifySignature(null, signed, key, decodeBase64Url(result.signature, 32, 1_024))
        : verifySignature("sha256", signed, key, decodeBase64Url(result.signature, 32, 1_024));
    if (!valid) throw new SecurityKeyVaultError("credential_mismatch");
    decodeBase64Url(result.prfFirst, 32, 32);
    return result.prfFirst;
}

export async function prepareSecurityKeyVaultSetup(
    event: IpcMainInvokeEvent,
    localUserId: string,
): Promise<PreparedSecurityKeyVault> {
    if (!SNOWFLAKE.test(localUserId)) throw new SecurityKeyVaultError("invalid_profile");
    const challenge = randomChallenge();
    const prfSalt = randomBytes(32).toString("base64url");
    const registration = await runCeremony<RegistrationResult>(
        event,
        "Set up Secure Messaging security key",
        registrationScript(challenge, prfSalt, localUserId),
    );
    const profile = verifyRegistration(registration, challenge);
    profile.prfSalt = prfSalt;
    validateProfile(profile);
    let prfFirst = registration.prfFirst;
    if (!registration.prfEnabled || !prfFirst) {
        const assertionChallenge = randomChallenge();
        const assertion = await runCeremony<AssertionResult>(
            event,
            "Unlock Secure Messaging",
            assertionScript(assertionChallenge, profile),
        );
        prfFirst = verifyAssertion(assertion, profile, assertionChallenge);
    } else {
        decodeBase64Url(prfFirst, 32, 32);
    }
    return { key: deriveVaultKey(prfFirst, profile), profile };
}

export async function prepareSecurityKeyVaultUnlock(
    event: IpcMainInvokeEvent,
    profile: SecurityKeyVaultProfile,
): Promise<PreparedSecurityKeyVault> {
    validateProfile(profile);
    const challenge = randomChallenge();
    const assertion = await runCeremony<AssertionResult>(
        event,
        "Unlock Secure Messaging",
        assertionScript(challenge, profile),
    );
    const prfFirst = verifyAssertion(assertion, profile, challenge);
    return { key: deriveVaultKey(prfFirst, profile), profile: structuredClone(profile) };
}

export async function prepareSecurityKeyVaultImport(
    event: IpcMainInvokeEvent,
    exportedProfile: string,
): Promise<PreparedSecurityKeyVault> {
    return prepareSecurityKeyVaultUnlock(event, parseSecurityKeyVaultProfile(exportedProfile.trim()));
}
