/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";

export interface HttpChange {
    author: string;
    hash: string;
    message: string;
}

export interface PendingHttpUpdate {
    hash: string;
    url: string;
}

export interface HttpUpdateInspection {
    changes: HttpChange[];
    pending: PendingHttpUpdate | null;
}

export interface AtomicFileOperations {
    remove(path: string): void;
    rename(source: string, destination: string): void;
    write(path: string, data: Buffer): void;
}

export type HttpFetcher = (url: string, init: RequestInit) => Promise<Response>;
export type JsonRequest = (endpoint: string) => Promise<unknown>;

interface AsarFile {
    integrity: {
        algorithm: "SHA256";
        hash: string;
    };
    offset: number;
    size: number;
}

interface ReleaseState {
    hash: string;
    pending: PendingHttpUpdate | null;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/iu;

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function releaseHash(name: unknown): string {
    const hash = typeof name === "string" ? name.trim().split(/\s+/u).at(-1) : undefined;
    if (!hash || !COMMIT_PATTERN.test(hash))
        throw new Error("The latest Protonn Cord release does not identify its source commit");
    return hash;
}

function parseRelease(value: unknown, currentHash: string, asarFile: string): ReleaseState {
    const release = record(value);
    const hash = releaseHash(release?.name);
    if (hash.toLowerCase() === currentHash.toLowerCase()) return { hash, pending: null };

    if (!Array.isArray(release?.assets))
        throw new Error(`The latest Protonn Cord release is missing ${asarFile}`);

    const asset = release.assets
        .map(record)
        .find(candidate => candidate?.name === asarFile);
    const downloadUrl = asset?.browser_download_url;
    if (typeof downloadUrl !== "string")
        throw new Error(`The latest Protonn Cord release is missing ${asarFile}`);

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(downloadUrl);
    } catch {
        throw new Error(`The latest Protonn Cord release has an invalid ${asarFile} download URL`);
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "github.com")
        throw new Error(`The latest Protonn Cord release has an invalid ${asarFile} download URL`);

    return { hash, pending: { hash, url: parsedUrl.href } };
}

function parseChanges(value: unknown): HttpChange[] {
    const comparison = record(value);
    if (!Array.isArray(comparison?.commits))
        throw new Error("GitHub returned an invalid Protonn Cord changelog");

    return comparison.commits.map(value => {
        const commit = record(value);
        const hash = commit?.sha;
        const commitDetails = record(commit?.commit);
        const message = commitDetails?.message;
        if (typeof hash !== "string" || !COMMIT_PATTERN.test(hash) || typeof message !== "string")
            throw new Error("GitHub returned an invalid Protonn Cord changelog");

        const author = record(commit?.author)?.login ?? record(commitDetails?.author)?.name;
        return {
            author: typeof author === "string" ? author : "Unknown Author",
            hash,
            message: message.split("\n", 1)[0],
        };
    });
}

export async function inspectHttpUpdates(
    request: JsonRequest,
    currentHash: string,
    asarFile: string,
): Promise<HttpUpdateInspection> {
    const release = parseRelease(await request("/releases/latest"), currentHash, asarFile);
    if (!release.pending) return { changes: [], pending: null };

    const comparison = await request(`/compare/${currentHash}...${release.hash}`);
    return { changes: parseChanges(comparison), pending: release.pending };
}

export async function findHttpUpdate(
    request: JsonRequest,
    currentHash: string,
    asarFile: string,
): Promise<PendingHttpUpdate | null> {
    return parseRelease(await request("/releases/latest"), currentHash, asarFile).pending;
}

export async function requestBytes(
    fetcher: HttpFetcher,
    url: string,
    init: Omit<RequestInit, "signal">,
    timeoutMs: number,
    maximumBytes: number,
): Promise<Buffer> {
    const signal = AbortSignal.timeout(timeoutMs);
    let rejectTimeout: (reason: Error) => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
    });
    const onTimeout = () => rejectTimeout(new Error(`Request to ${url} timed out`));
    signal.addEventListener("abort", onTimeout, { once: true });

    try {
        const response = await Promise.race([fetcher(url, { ...init, signal }), timeout]);

        if (!response.ok)
            throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);

        const declaredLength = response.headers.get("Content-Length");
        if (declaredLength !== null) {
            const length = Number(declaredLength);
            if (!Number.isSafeInteger(length) || length < 0)
                throw new Error(`GET ${url} returned an invalid content length`);
            if (length > maximumBytes)
                throw new Error(`GET ${url} exceeded the ${maximumBytes} byte limit`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error(`GET ${url} returned an empty response body`);

        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
            const result = await Promise.race([reader.read(), timeout]);
            if (result.done) break;
            total += result.value.byteLength;
            if (total > maximumBytes) {
                await Promise.race([reader.cancel(), timeout]);
                throw new Error(`GET ${url} exceeded the ${maximumBytes} byte limit`);
            }
            chunks.push(Buffer.from(result.value));
        }
        return Buffer.concat(chunks, total);
    } finally {
        signal.removeEventListener("abort", onTimeout);
    }
}

export async function requestJson(
    fetcher: HttpFetcher,
    url: string,
    init: Omit<RequestInit, "signal">,
    timeoutMs: number,
    maximumBytes: number,
): Promise<unknown> {
    const data = await requestBytes(fetcher, url, init, timeoutMs, maximumBytes);
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    } catch {
        throw new Error(`GET ${url} returned invalid JSON`);
    }
}

function parseAsarFiles(value: unknown, dataBytes: number, files = new Map<string, AsarFile>(), prefix = ""): Map<string, AsarFile> {
    const directory = record(value);
    if (!directory) throw new Error("The downloaded Protonn Cord archive has an invalid file index");

    for (const [name, rawEntry] of Object.entries(directory)) {
        const entry = record(rawEntry);
        if (!entry || !name || name === "." || name === ".." || name.includes("/") || name.includes("\\"))
            throw new Error("The downloaded Protonn Cord archive has an invalid file index");
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry.files !== undefined) {
            parseAsarFiles(entry.files, dataBytes, files, path);
            continue;
        }
        if (entry.unpacked === true)
            throw new Error("The downloaded Protonn Cord archive depends on missing unpacked files");

        const { offset: offsetText, size } = entry;
        const integrity = record(entry.integrity);
        const algorithm = integrity?.algorithm;
        const hash = integrity?.hash;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
            typeof offsetText !== "string" || !/^\d+$/u.test(offsetText) ||
            algorithm !== "SHA256" || typeof hash !== "string" || !SHA256_PATTERN.test(hash))
            throw new Error("The downloaded Protonn Cord archive has an invalid file index");

        const offset = Number(offsetText);
        if (!Number.isSafeInteger(offset) || offset + size > dataBytes)
            throw new Error("The downloaded Protonn Cord archive is truncated");
        files.set(path, { integrity: { algorithm, hash }, offset, size });
    }
    return files;
}

export function validateAsar(data: Buffer): void {
    if (data.byteLength < 16 || data.readUInt32LE(0) !== 4)
        throw new Error("The downloaded Protonn Cord archive has an invalid header");

    const headerSize = data.readUInt32LE(4);
    if (headerSize < 8 || headerSize % 4 !== 0 || headerSize > data.byteLength - 8 ||
        data.readUInt32LE(8) !== headerSize - 4)
        throw new Error("The downloaded Protonn Cord archive has an invalid header");

    const jsonBytes = data.readUInt32LE(12);
    if (jsonBytes === 0 || jsonBytes > headerSize - 8)
        throw new Error("The downloaded Protonn Cord archive has an invalid header");

    let header: unknown;
    try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(16, 16 + jsonBytes));
        header = JSON.parse(json);
    } catch {
        throw new Error("The downloaded Protonn Cord archive has an invalid header");
    }

    const root = record(header);
    const dataOffset = 8 + headerSize;
    const files = parseAsarFiles(root?.files, data.byteLength - dataOffset);
    const packageFile = files.get("package.json");
    if (!packageFile) throw new Error("The downloaded Protonn Cord archive is missing package.json");

    let previousEnd = 0;
    const orderedFiles = [...files.values()].sort((left, right) => left.offset - right.offset);
    for (const file of orderedFiles) {
        if (file.size > 0 && file.offset < previousEnd)
            throw new Error("The downloaded Protonn Cord archive has overlapping files");
        previousEnd = Math.max(previousEnd, file.offset + file.size);
        const contents = data.subarray(dataOffset + file.offset, dataOffset + file.offset + file.size);
        if (createHash("sha256").update(contents).digest("hex") !== file.integrity.hash.toLowerCase())
            throw new Error("The downloaded Protonn Cord archive failed its integrity check");
    }

    try {
        const contents = data.subarray(
            dataOffset + packageFile.offset,
            dataOffset + packageFile.offset + packageFile.size,
        );
        const packageJson = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)));
        if (!packageJson || typeof packageJson.main !== "string" || !files.has(packageJson.main))
            throw new Error();
    } catch {
        throw new Error("The downloaded Protonn Cord archive has an invalid package.json");
    }
}

export function replaceAsarAtomically(
    targetPath: string,
    temporaryPath: string,
    data: Buffer,
    files: AtomicFileOperations,
): void {
    validateAsar(data);
    try {
        files.write(temporaryPath, data);
        files.rename(temporaryPath, targetPath);
    } catch (error) {
        files.remove(temporaryPath);
        throw error;
    }
}

export async function applyPendingHttpUpdate(
    pending: PendingHttpUpdate | null,
    download: (url: string) => Promise<Buffer>,
    install: (data: Buffer) => void,
): Promise<PendingHttpUpdate | null> {
    if (!pending) return null;
    const data = await download(pending.url);
    install(data);
    return null;
}
