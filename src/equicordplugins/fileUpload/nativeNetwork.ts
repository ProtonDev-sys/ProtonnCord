/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { RendererSettings } from "@main/settings";
import type { IpcMainInvokeEvent } from "electron";

const TRUSTED_RENDERER_ORIGINS = new Set([
    "https://canary.discord.com",
    "https://discord.com",
    "https://ptb.discord.com"
]);
const FIXED_UPLOAD_HOSTS = new Set([
    "0x0.st",
    "api.e-z.host",
    "catbox.moe",
    "filebin.net",
    "litterbox.catbox.moe",
    "nest.rip",
    "pixelvault.co",
    "pixeldrain.com",
    "temp.sh",
    "tmpfiles.org",
    "upload.gofile.io",
    "w.buzzheavier.com"
]);
const DISCORD_MEDIA_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const DISCORD_MEDIA_PATH_PREFIXES = [
    "/app-assets/",
    "/attachments/",
    "/avatars/",
    "/channel-icons/",
    "/embed/",
    "/emojis/",
    "/ephemeral-attachments/",
    "/external/",
    "/guild-events/",
    "/icons/",
    "/role-icons/",
    "/stickers/"
] as const;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const MAX_FILE_UPLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_REMOTE_MEDIA_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_NATIVE_ERROR_BYTES = 64 * 1024;
export const MAX_NATIVE_URL_LENGTH = 4_096;
export const MAX_NATIVE_FILENAME_LENGTH = 255;
export const MAX_NATIVE_SECRET_LENGTH = 8_192;
export const NATIVE_UPLOAD_TIMEOUT_MS = 5 * 60_000;
export const NATIVE_FETCH_TIMEOUT_MS = 60_000;

export type NetworkClass = "private" | "public";

export interface BoundedFetchResponse {
    readonly headers: Headers;
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    json(): Promise<unknown>;
    text(): Promise<string>;
}

export interface PinnedRequestOptions {
    approvedAddresses?: readonly string[];
    body?: ArrayBuffer | Uint8Array | string;
    deadline: number;
    headers?: Record<string, string>;
    maxResponseBytes: number;
    method: "GET" | "POST" | "PUT";
    networkClass: NetworkClass;
}

export interface PinnedResponse {
    body: Uint8Array;
    headers: Headers;
    status: number;
    statusText: string;
}

interface OperationWaiter {
    resolve(release: () => void): void;
    timer: ReturnType<typeof setTimeout>;
}

class BoundedNetworkLimiter {
    private active = 0;
    private readonly waiters: OperationWaiter[] = [];

    constructor(private readonly maximumActive: number, private readonly maximumQueued: number) { }

    private release = () => {
        this.active--;
        const waiter = this.waiters.shift();
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.active++;
        waiter.resolve(this.release);
    };

    acquire(deadline: number): Promise<() => void> {
        if (this.active < this.maximumActive) {
            this.active++;
            return Promise.resolve(this.release);
        }
        if (this.waiters.length >= this.maximumQueued)
            return Promise.reject(new Error("Too many FileUpload network operations are queued"));

        const remaining = Math.floor(deadline - Date.now());
        if (remaining <= 0) return Promise.reject(new Error("FileUpload network operation timed out while queued"));
        return new Promise((resolve, reject) => {
            const waiter: OperationWaiter = {
                resolve,
                timer: setTimeout(() => {
                    const index = this.waiters.indexOf(waiter);
                    if (index !== -1) this.waiters.splice(index, 1);
                    reject(new Error("FileUpload network operation timed out while queued"));
                }, remaining)
            };
            this.waiters.push(waiter);
        });
    }

    async run<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
        const release = await this.acquire(deadline);
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

const networkLimiter = new BoundedNetworkLimiter(2, 16);
const mediaLimiter = new BoundedNetworkLimiter(1, 2);
const uploadAdmissionLimiter = new BoundedNetworkLimiter(1, 0);

function normalizedHostname(url: URL): string {
    return url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname;
}

function parseIpv4(address: string): number[] | null {
    if (isIP(address) !== 4) return null;
    const bytes = address.split(".").map(Number);
    return bytes.length === 4 && bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        ? bytes
        : null;
}

function parseIpv6(address: string): number[] | null {
    const zoneIndex = address.indexOf("%");
    if (zoneIndex !== -1) address = address.slice(0, zoneIndex);
    if (isIP(address) !== 6) return null;

    let embeddedIpv4: number[] = [];
    const lastColon = address.lastIndexOf(":");
    if (address.slice(lastColon + 1).includes(".")) {
        const ipv4 = parseIpv4(address.slice(lastColon + 1));
        if (!ipv4) return null;
        embeddedIpv4 = [(ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]];
        address = `${address.slice(0, lastColon)}:${embeddedIpv4.map(value => value.toString(16)).join(":")}`;
    }

    const halves = address.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":").map(part => Number.parseInt(part, 16)) : [];
    const right = halves[1] ? halves[1].split(":").map(part => Number.parseInt(part, 16)) : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0 || halves.length === 1 && missing !== 0) return null;
    const words = [...left, ...Array(missing).fill(0), ...right];
    return words.length === 8 && words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffff)
        ? words
        : null;
}

function classifyIpv4(address: string): NetworkClass | "forbidden" {
    const bytes = parseIpv4(address);
    if (!bytes) return "forbidden";
    const [a, b, c] = bytes;
    if (a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127
        || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168)
        return "private";
    if (a === 0 || a === 169 && b === 254 || a >= 224
        || a === 192 && b === 0 && (c === 0 || c === 2)
        || a === 192 && b === 88 && c === 99 || a === 198 && (b === 18 || b === 19)
        || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113)
        return "forbidden";
    return "public";
}

export function classifyIp(address: string): NetworkClass | "forbidden" {
    if (isIP(address) === 4) return classifyIpv4(address);
    const words = parseIpv6(address);
    if (!words) return "forbidden";

    if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) return "private";
    if ((words[0] & 0xfe00) === 0xfc00) return "private";
    if ((words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) return "forbidden";
    if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0
        && words[4] === 0 && (words[5] === 0 || words[5] === 0xffff)) {
        const ipv4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
        return classifyIpv4(ipv4);
    }
    if ((words[0] & 0xe000) !== 0x2000 || words[0] === 0x2002
        || words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8)
        || (words[0] & 0xfff0) === 0x3ff0)
        return "forbidden";
    return "public";
}

function canonicalIpAddress(address: string): string {
    const ipv4 = parseIpv4(address);
    if (ipv4) return ipv4.join(".");
    const ipv6 = parseIpv6(address);
    if (!ipv6) throw new Error("Invalid FileUpload endpoint address");
    return ipv6.map(word => word.toString(16).padStart(4, "0")).join(":");
}

function remainingMilliseconds(deadline: number): number {
    const remaining = Math.floor(deadline - Date.now());
    if (remaining <= 0) throw new Error("FileUpload network operation timed out");
    return remaining;
}

async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("FileUpload network operation timed out")), remainingMilliseconds(deadline));
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function resolveAddresses(hostname: string, deadline: number): Promise<string[]> {
    if (isIP(hostname)) return [canonicalIpAddress(hostname)];
    const results = await withDeadline(Promise.allSettled([resolve4(hostname), resolve6(hostname)]), deadline);
    const addresses = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
    if (!addresses.length) throw new Error("FileUpload endpoint did not resolve");
    const unique = [...new Set(addresses.map(canonicalIpAddress))].sort();
    if (unique.length > 16) throw new Error("FileUpload endpoint resolved to too many addresses");
    return unique;
}

async function resolvePinnedAddress(
    url: URL,
    expectedClass: NetworkClass,
    deadline: number,
    approvedAddresses?: readonly string[]
): Promise<string> {
    const addresses = await resolveAddresses(normalizedHostname(url), deadline);
    const classes = new Set(addresses.map(classifyIp));
    if (classes.has("forbidden") || classes.size !== 1)
        throw new Error("FileUpload endpoint resolved to an unsafe or mixed network range");
    const networkClass = classes.values().next().value as NetworkClass;
    if (networkClass !== expectedClass)
        throw new Error("FileUpload endpoint changed its approved network range");
    if (approvedAddresses) {
        const approved = [...new Set(approvedAddresses.map(canonicalIpAddress))].sort();
        if (approved.length !== addresses.length || approved.some((address, index) => address !== addresses[index]))
            throw new Error("FileUpload endpoint changed its approved address set");
    }
    return addresses[0];
}

export async function inspectEndpointNetwork(
    url: URL,
    deadline = Date.now() + 10_000
): Promise<{ addresses: string[]; networkClass: NetworkClass; }> {
    const addresses = await resolveAddresses(normalizedHostname(url), deadline);
    const classes = new Set(addresses.map(classifyIp));
    if (classes.has("forbidden") || classes.size !== 1)
        throw new Error("FileUpload endpoint resolved to an unsafe or mixed network range");
    return { addresses, networkClass: classes.values().next().value as NetworkClass };
}

function sameAddress(actual: string | undefined, expected: string): boolean {
    if (!actual) return false;
    if (isIP(expected) === 4 && actual.toLowerCase() === `::ffff:${expected}`) return true;
    try {
        return canonicalIpAddress(actual) === canonicalIpAddress(expected);
    } catch {
        return false;
    }
}

function bodyToUint8Array(body: PinnedRequestOptions["body"]): Uint8Array | undefined {
    if (body === undefined) return undefined;
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (body instanceof Uint8Array) return body;
    throw new TypeError("Invalid FileUpload request body");
}

async function readIncomingBody(
    response: import("node:http").IncomingMessage,
    maxBytes: number
): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("Invalid FileUpload response limit");
    if (maxBytes === 0) {
        response.destroy();
        return new Uint8Array(0);
    }
    const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
    if (encoding && encoding !== "identity") {
        response.destroy();
        throw new Error("Encoded FileUpload responses are not accepted");
    }
    const declared = response.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > maxBytes)) {
        response.destroy();
        throw new Error("FileUpload response exceeded its safe size");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of response) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
            response.destroy();
            throw new Error("FileUpload response exceeded its safe size");
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

async function pinnedRequest(url: URL, options: PinnedRequestOptions): Promise<PinnedResponse> {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid FileUpload endpoint scheme");
    const address = await resolvePinnedAddress(url, options.networkClass, options.deadline, options.approvedAddresses);
    const body = bodyToUint8Array(options.body);
    const headers = { ...options.headers };
    headers["Accept-Encoding"] = "identity";
    if (body) headers["Content-Length"] = String(body.byteLength);

    return await new Promise<PinnedResponse>((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("FileUpload network operation timed out")), remainingMilliseconds(options.deadline));
        const lookup = ((_hostname: string, lookupOptions: unknown, callback?: (...args: unknown[]) => void) => {
            const done = typeof lookupOptions === "function" ? lookupOptions : callback;
            if (!done) return;
            const family = isIP(address);
            if (typeof lookupOptions === "object" && lookupOptions !== null && "all" in lookupOptions
                && (lookupOptions as { all?: boolean; }).all)
                done(null, [{ address, family }]);
            else
                done(null, address, family);
        }) as never;
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
            agent: false,
            headers,
            lookup,
            method: options.method,
            signal: controller.signal
        }, response => {
            void (async () => {
                try {
                    const responseBody = REDIRECT_STATUSES.has(response.statusCode ?? 0)
                        ? (response.destroy(), new Uint8Array(0))
                        : await readIncomingBody(response, options.maxResponseBytes);
                    const responseHeaders = new Headers();
                    for (const [name, value] of Object.entries(response.headers)) {
                        if (Array.isArray(value)) value.forEach(item => responseHeaders.append(name, item));
                        else if (value !== undefined) responseHeaders.set(name, String(value));
                    }
                    resolve({
                        body: responseBody,
                        headers: responseHeaders,
                        status: response.statusCode ?? 0,
                        statusText: response.statusMessage ?? ""
                    });
                } catch (error) {
                    reject(error);
                } finally {
                    clearTimeout(timer);
                }
            })();
        });
        request.once("socket", socket => {
            socket.once("connect", () => {
                if (!sameAddress(socket.remoteAddress, address))
                    request.destroy(new Error("FileUpload connection did not use its pinned address"));
            });
        });
        request.once("error", error => {
            clearTimeout(timer);
            reject(error);
        });
        request.end(body ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : undefined);
    });
}

export async function boundedPinnedRequest(url: URL, options: PinnedRequestOptions): Promise<PinnedResponse> {
    return networkLimiter.run(options.deadline, () => pinnedRequest(url, options));
}

async function readFetchBody(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!chunk.value?.byteLength) continue;
            total += chunk.value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error("FileUpload response exceeded its safe size");
            }
            chunks.push(chunk.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

export async function fixedFetch(
    event: IpcMainInvokeEvent,
    input: string,
    init: RequestInit
): Promise<BoundedFetchResponse> {
    assertTrustedFileUploadEvent(event);
    const url = parseNetworkUrl(input, { allowHttp: false, allowPort: false, allowQuery: false });
    if (!FIXED_UPLOAD_HOSTS.has(url.hostname)) throw new Error("Unapproved fixed FileUpload host");
    const deadline = Date.now() + NATIVE_UPLOAD_TIMEOUT_MS;
    return networkLimiter.run(deadline, async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error("FileUpload request timed out")), remainingMilliseconds(deadline));
        try {
            const response = await fetch(url, {
                ...init,
                headers: { ...Object.fromEntries(new Headers(init.headers).entries()), "Accept-Encoding": "identity" },
                redirect: "error",
                signal: controller.signal
            });
            const bytes = await readFetchBody(response, response.ok ? MAX_NATIVE_RESPONSE_BYTES : MAX_NATIVE_ERROR_BYTES);
            const text = new TextDecoder().decode(bytes);
            return {
                headers: response.headers,
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
                json: async () => JSON.parse(text),
                text: async () => text
            };
        } finally {
            clearTimeout(timeout);
        }
    });
}

export function isTrustedFileUploadEvent(event: IpcMainInvokeEvent): boolean {
    if (RendererSettings.store.plugins?.FileUpload?.enabled !== true) return false;
    const frame = event?.senderFrame;
    if (!frame || !event?.sender || frame !== event.sender.mainFrame) return false;
    const rawUrl = frame.url;
    if (typeof rawUrl !== "string" || rawUrl.length < 1 || rawUrl.length > MAX_NATIVE_URL_LENGTH) return false;
    try {
        const url = new URL(rawUrl);
        return url.protocol === "https:" && !url.username && !url.password && !url.port
            && TRUSTED_RENDERER_ORIGINS.has(url.origin);
    } catch {
        return false;
    }
}

export function assertTrustedFileUploadEvent(event: IpcMainInvokeEvent): void {
    if (!isTrustedFileUploadEvent(event)) throw new Error("Untrusted FileUpload request");
}

export function validateUploadBuffer(event: IpcMainInvokeEvent, fileBuffer: unknown): ArrayBuffer {
    assertTrustedFileUploadEvent(event);
    if (!(fileBuffer instanceof ArrayBuffer) || fileBuffer.byteLength > MAX_FILE_UPLOAD_BYTES)
        throw new Error("Invalid or oversized FileUpload body");
    return fileBuffer;
}

export async function acquireUploadAdmission(
    event: IpcMainInvokeEvent,
    fileBuffer: unknown,
    deadline = Date.now() + NATIVE_UPLOAD_TIMEOUT_MS
): Promise<{ fileBuffer: ArrayBuffer; release(): void; }> {
    const validated = validateUploadBuffer(event, fileBuffer);
    const release = await uploadAdmissionLimiter.acquire(deadline);
    return { fileBuffer: validated, release };
}

export function validateUploadFilename(filename: unknown): string {
    if (typeof filename !== "string" || filename.length < 1 || filename.length > MAX_NATIVE_FILENAME_LENGTH
        || Buffer.byteLength(filename, "utf8") > MAX_NATIVE_FILENAME_LENGTH
        || /[\u0000-\u001f\u007f/\\]/u.test(filename))
        throw new Error("Invalid FileUpload filename");
    return filename;
}

export function validateNativeSecret(value: unknown, optional = false): string | undefined {
    if (optional && (value === undefined || value === "")) return undefined;
    if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > MAX_NATIVE_SECRET_LENGTH
        || /[\r\n\0]/u.test(value))
        throw new Error("Invalid FileUpload credential");
    return value;
}

export function parseNetworkUrl(
    input: unknown,
    options: { allowHttp: boolean; allowPort: boolean; allowQuery: boolean; }
): URL {
    if (typeof input !== "string" || input.length < 1 || Buffer.byteLength(input, "utf8") > MAX_NATIVE_URL_LENGTH)
        throw new Error("Invalid FileUpload URL");
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new Error("Invalid FileUpload URL");
    }
    if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:"))
        throw new Error("Invalid FileUpload URL scheme");
    if (url.username || url.password || url.hash || !options.allowPort && url.port || !options.allowQuery && url.search)
        throw new Error("Unsafe FileUpload URL authority");
    if (!url.hostname || url.hostname.endsWith(".")) throw new Error("Invalid FileUpload hostname");
    return url;
}

function parseDiscordMediaUrl(input: unknown, base?: URL): URL {
    let absolute = input;
    if (base && typeof input === "string") {
        try {
            absolute = new URL(input, base).href;
        } catch {
            throw new Error("Invalid Discord media URL");
        }
    }
    const url = parseNetworkUrl(absolute, { allowHttp: false, allowPort: false, allowQuery: true });
    if (!DISCORD_MEDIA_HOSTS.has(url.hostname)
        || !DISCORD_MEDIA_PATH_PREFIXES.some(prefix => url.pathname.startsWith(prefix))
        || /%(?:25)*(?:00|0a|0d|2e|2f|5c)/iu.test(url.pathname)
        || url.pathname.includes("\\") || url.pathname.includes("//"))
        throw new Error("Unapproved Discord media URL");
    return url;
}

export function validateHeaderRecord(
    headers: unknown,
    allowedNames: ReadonlySet<string>
): Record<string, string> {
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("Invalid FileUpload headers");
    const result: Record<string, string> = {};
    const seenNames = new Set<string>();
    const entries = Object.entries(headers);
    if (entries.length > 16) throw new Error("Too many FileUpload headers");
    let total = 0;
    for (const [rawName, rawValue] of entries) {
        const name = rawName.toLowerCase();
        if (seenNames.has(name) || !allowedNames.has(name) || typeof rawValue !== "string" || /[\r\n\0]/u.test(rawValue))
            throw new Error("Invalid FileUpload header");
        seenNames.add(name);
        total += Buffer.byteLength(rawName, "utf8") + Buffer.byteLength(rawValue, "utf8");
        if (Buffer.byteLength(rawValue, "utf8") > MAX_NATIVE_SECRET_LENGTH || total > 32_768)
            throw new Error("FileUpload headers exceed their safe size");
        result[rawName] = rawValue;
    }
    return result;
}

export async function fetchPublicMedia(event: IpcMainInvokeEvent, input: unknown): Promise<{
    contentType: string;
    data: ArrayBuffer;
}> {
    assertTrustedFileUploadEvent(event);
    const deadline = Date.now() + NATIVE_FETCH_TIMEOUT_MS;
    return mediaLimiter.run(deadline, () => networkLimiter.run(deadline, async () => {
        let current = parseDiscordMediaUrl(input);
        for (let redirects = 0; redirects <= 3; redirects++) {
            const response = await pinnedRequest(current, {
                deadline,
                headers: { Accept: "image/*,video/*", "Accept-Encoding": "identity" },
                maxResponseBytes: MAX_REMOTE_MEDIA_BYTES,
                method: "GET",
                networkClass: "public"
            });
            if (REDIRECT_STATUSES.has(response.status)) {
                const location = response.headers.get("location");
                if (!location || redirects === 3) throw new Error("Remote media redirected too many times");
                current = parseDiscordMediaUrl(location, current);
                continue;
            }
            if (response.status !== 200) throw new Error(`Remote media fetch failed with HTTP ${response.status}`);
            const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
            if (!contentType.startsWith("image/") && !contentType.startsWith("video/")
                && !(contentType === "application/octet-stream" && DISCORD_MEDIA_HOSTS.has(current.hostname)))
                throw new Error("Remote response is not an allowed media type");
            const copy = response.body;
            const data = copy.byteOffset === 0 && copy.buffer.byteLength === copy.byteLength
                ? copy.buffer as ArrayBuffer
                : copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
            return {
                contentType,
                data
            };
        }
        throw new Error("Remote media redirected too many times");
    }));
}

export function safeNativeError(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) return fallback;
    if (/^(?:Invalid|Unsafe|Untrusted|Unapproved|Too many|FileUpload|Remote media|Encoded)/u.test(error.message))
        return error.message.slice(0, 256);
    if (error.name === "AbortError" || /timed out/iu.test(error.message)) return "FileUpload request timed out";
    return fallback;
}
