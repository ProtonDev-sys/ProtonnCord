/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import { dialog, type IpcMainInvokeEvent } from "electron";

import {
    assertTrustedFileUploadEvent,
    classifyIp,
    inspectEndpointNetwork,
    MAX_NATIVE_URL_LENGTH,
    type NetworkClass,
    parseNetworkUrl } from "./nativeNetwork";
import type { CustomEndpointApprovalRequest, NativeEndpointApprovalResult } from "./types";

const MAX_APPROVAL_FILE_BYTES = 128 * 1024;
const MAX_APPROVAL_RECORDS = 64;
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const S3_BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}[A-Za-z0-9]$|^[A-Za-z0-9]$/u;

interface ApprovalProfile {
    approvedAddresses?: string[];
    baseUrl: string;
    bucket?: string;
    createdAt: number;
    forcePathStyle?: boolean;
    id: string;
    kind: "s3" | "webdav";
    networkClass: NetworkClass;
}

let approvalCache: ApprovalProfile[] | null = null;
let approvalQueue: Promise<void> = Promise.resolve();
let pendingApprovalOperations = 0;

function runApprovalOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = approvalQueue.then(operation, operation);
    approvalQueue = result.then(() => undefined, () => undefined);
    return result;
}

function approvalFilePath(): string {
    return path.join(DATA_DIR, "FileUpload", "approved-endpoints.json");
}

function normalizeBaseUrl(input: unknown): URL {
    const url = parseNetworkUrl(input, { allowHttp: true, allowPort: true, allowQuery: false });
    if (/%(?:25)*(?:00|0a|0d|2e|2f|5c)/iu.test(url.pathname) || url.pathname.includes("\\") || url.pathname.includes("//"))
        throw new Error("Invalid endpoint base path");
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url;
}

function normalizeRequest(request: unknown): CustomEndpointApprovalRequest & { baseUrl: string; } {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid endpoint approval request");
    const value = request as Partial<CustomEndpointApprovalRequest>;
    if (value.kind !== "s3" && value.kind !== "webdav") throw new Error("Invalid endpoint approval kind");
    const keys = Object.keys(value).sort();
    const expectedKeys = value.kind === "s3"
        ? ["baseUrl", "bucket", "forcePathStyle", "kind"]
        : ["baseUrl", "kind"];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
        throw new Error("Invalid endpoint approval fields");
    const baseUrl = normalizeBaseUrl(value.baseUrl).href;
    if (value.kind === "s3") {
        if (typeof value.bucket !== "string" || !S3_BUCKET.test(value.bucket) || typeof value.forcePathStyle !== "boolean")
            throw new Error("Invalid S3 approval scope");
        const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/gu, "");
        if (!value.forcePathStyle && isIP(hostname)) throw new Error("Virtual-hosted S3 requires a DNS hostname");
        return { baseUrl, bucket: value.bucket, forcePathStyle: value.forcePathStyle, kind: "s3" };
    }
    return { baseUrl, kind: "webdav" };
}

function isProfile(value: unknown): value is ApprovalProfile {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const profile = value as Partial<ApprovalProfile>;
    if (profile.kind !== "s3" && profile.kind !== "webdav" || typeof profile.id !== "string" || !APPROVAL_ID.test(profile.id)
        || typeof profile.baseUrl !== "string" || profile.baseUrl.length > MAX_NATIVE_URL_LENGTH
        || (profile.networkClass !== "private" && profile.networkClass !== "public")
        || !Number.isSafeInteger(profile.createdAt) || (profile.createdAt ?? 0) < 0)
        return false;
    try {
        if (normalizeBaseUrl(profile.baseUrl).href !== profile.baseUrl) return false;
    } catch {
        return false;
    }
    const addressesAreValid = profile.approvedAddresses === undefined
        || Array.isArray(profile.approvedAddresses) && profile.approvedAddresses.length > 0
        && profile.approvedAddresses.length <= 16 && profile.approvedAddresses.every(address =>
            typeof address === "string" && classifyIp(address) === profile.networkClass);
    const needsAddressPin = profile.networkClass === "private" || new URL(profile.baseUrl).protocol === "http:";
    return addressesAreValid && (!needsAddressPin || profile.approvedAddresses !== undefined)
        && (profile.kind === "webdav" || typeof profile.bucket === "string" && S3_BUCKET.test(profile.bucket)
            && typeof profile.forcePathStyle === "boolean");
}

async function readApprovalFile(): Promise<ApprovalProfile[]> {
    const handle = await fs.open(approvalFilePath(), "r");
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size < 2 || stats.size > MAX_APPROVAL_FILE_BYTES)
            throw new Error("Invalid FileUpload approval store");
        const content = Buffer.allocUnsafe(stats.size);
        let offset = 0;
        while (offset < content.byteLength) {
            const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
            if (bytesRead < 1) throw new Error("Truncated FileUpload approval store");
            offset += bytesRead;
        }
        const parsed = JSON.parse(content.toString("utf8"));
        if (!Array.isArray(parsed)) throw new Error("Invalid FileUpload approval store");
        return parsed.filter(isProfile).slice(-MAX_APPROVAL_RECORDS);
    } finally {
        await handle.close();
    }
}

async function loadApprovals(): Promise<ApprovalProfile[]> {
    if (approvalCache) return approvalCache;
    try {
        approvalCache = await readApprovalFile();
    } catch {
        approvalCache = [];
    }
    return approvalCache;
}

async function saveApprovals(profiles: ApprovalProfile[]): Promise<void> {
    const target = approvalFilePath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const content = JSON.stringify(profiles.slice(-MAX_APPROVAL_RECORDS), null, 2);
    if (Buffer.byteLength(content) > MAX_APPROVAL_FILE_BYTES) throw new Error("FileUpload approval store exceeds its safe size");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await fs.rename(temporary, target);
    } finally {
        await fs.unlink(temporary).catch(() => undefined);
    }
}

function matchesRequest(profile: ApprovalProfile, request: CustomEndpointApprovalRequest & { baseUrl: string; }): boolean {
    return profile.kind === request.kind && profile.baseUrl === request.baseUrl
        && (request.kind === "webdav" || profile.bucket === request.bucket && profile.forcePathStyle === request.forcePathStyle);
}

export async function approveEndpoint(
    event: IpcMainInvokeEvent,
    requestValue: unknown
): Promise<NativeEndpointApprovalResult> {
    assertTrustedFileUploadEvent(event);
    const request = normalizeRequest(requestValue);
    if (pendingApprovalOperations >= 8) throw new Error("Too many FileUpload endpoint approvals are queued");
    pendingApprovalOperations++;
    try {
        return await runApprovalOperation(async () => {
            const profiles = await loadApprovals();
            const baseUrl = new URL(request.baseUrl);
            const effectiveUrl = new URL(baseUrl);
            if (request.kind === "s3" && !request.forcePathStyle)
                effectiveUrl.hostname = `${request.bucket}.${baseUrl.hostname}`;
            const existing = profiles.find(profile => matchesRequest(profile, request));
            let inspected: Awaited<ReturnType<typeof inspectEndpointNetwork>> | undefined;
            if (existing) {
                const addressPinned = existing.networkClass === "private" || baseUrl.protocol === "http:";
                if (!addressPinned) return { approvalId: existing.id, success: true };
                inspected = await inspectEndpointNetwork(effectiveUrl);
                if (inspected.networkClass === existing.networkClass
                    && sameAddressSet(inspected.addresses, existing.approvedAddresses ?? []))
                    return { approvalId: existing.id, success: true };
            }

            const { addresses, networkClass } = inspected ?? await inspectEndpointNetwork(effectiveUrl);
            const privateNetwork = networkClass === "private";
            const insecure = baseUrl.protocol !== "https:";
            const scope = request.kind === "s3"
                ? `S3 bucket: ${request.bucket}\nAddressing: ${request.forcePathStyle ? "path-style" : "virtual-host"}\nEffective host: ${effectiveUrl.host}\nBase path: ${baseUrl.pathname}`
                : `WebDAV base path: ${baseUrl.pathname}`;
            const warning = [
                insecure ? "This endpoint uses unencrypted HTTP." : "",
                privateNetwork ? `This endpoint can access your local/private network at: ${addresses.join(", ")}.` : "",
                existing ? "Its resolved address changed, so approval is required again." : ""
            ].filter(Boolean).join(" ");
            const { response } = await dialog.showMessageBox({
                buttons: ["Cancel", "Approve endpoint"],
                cancelId: 0,
                defaultId: 0,
                detail: `${baseUrl.origin}\n${scope}${warning ? `\n\n${warning}` : ""}\n\nApproval is stored only for this exact configuration.`,
                message: `Allow FileUpload to send files and credentials to this ${request.kind === "s3" ? "S3" : "WebDAV"} endpoint?`,
                noLink: true,
                title: "Approve FileUpload endpoint",
                type: "warning"
            });
            if (response !== 1) return { error: "FileUpload endpoint approval was cancelled", success: false };

            const profile: ApprovalProfile = {
                approvedAddresses: privateNetwork || insecure ? addresses : undefined,
                baseUrl: request.baseUrl,
                bucket: request.kind === "s3" ? request.bucket : undefined,
                createdAt: Date.now(),
                forcePathStyle: request.kind === "s3" ? request.forcePathStyle : undefined,
                id: randomUUID(),
                kind: request.kind,
                networkClass
            };
            const next = [...profiles.filter(candidate => !matchesRequest(candidate, request)), profile].slice(-MAX_APPROVAL_RECORDS);
            await saveApprovals(next);
            approvalCache = next;
            return { approvalId: profile.id, success: true };
        });
    } finally {
        pendingApprovalOperations--;
    }
}

function sameAddressSet(left: readonly string[], right: readonly string[]): boolean {
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.length === sortedRight.length && sortedLeft.every((address, index) => address === sortedRight[index]);
}

export async function getApprovalProfile(
    approvalId: unknown,
    expectedRequest: unknown
): Promise<ApprovalProfile> {
    if (typeof approvalId !== "string" || !APPROVAL_ID.test(approvalId)) throw new Error("Invalid FileUpload approval ID");
    const request = normalizeRequest(expectedRequest);
    return runApprovalOperation(async () => {
        const profile = (await loadApprovals()).find(candidate => candidate.id === approvalId);
        if (!profile || !matchesRequest(profile, request)) throw new Error("Unapproved FileUpload endpoint configuration");
        return { ...profile };
    });
}

function isStrictPathDescendant(pathname: string, prefix: string): boolean {
    if (/%(?:25)*(?:00|0a|0d|2e|2f|5c)/iu.test(pathname) || pathname.includes("\\") || pathname.includes("//")) return false;
    const normalizedPrefix = prefix.replace(/\/+$/u, "") || "/";
    return normalizedPrefix === "/" ? pathname !== "/" && pathname.startsWith("/") : pathname.startsWith(`${normalizedPrefix}/`);
}

export function assertS3Destination(profile: ApprovalProfile, destinationValue: unknown): URL {
    if (profile.kind !== "s3" || !profile.bucket) throw new Error("Invalid S3 approval profile");
    const destination = parseNetworkUrl(destinationValue, { allowHttp: true, allowPort: true, allowQuery: false });
    const base = new URL(profile.baseUrl);
    if (destination.protocol !== base.protocol || destination.port !== base.port)
        throw new Error("S3 destination escaped its approved endpoint");

    const expectedHostname = profile.forcePathStyle ? base.hostname : `${profile.bucket}.${base.hostname}`.toLowerCase();
    if (destination.hostname !== expectedHostname) throw new Error("S3 destination escaped its approved host");
    let expectedPrefix = base.pathname.replace(/\/+$/u, "") || "/";
    if (profile.forcePathStyle) expectedPrefix = `${expectedPrefix === "/" ? "" : expectedPrefix}/${encodeURIComponent(profile.bucket)}`;
    if (!isStrictPathDescendant(destination.pathname, expectedPrefix)) throw new Error("S3 destination escaped its approved path");
    return destination;
}

export function assertWebdavUploadDestination(profile: ApprovalProfile, destinationValue: unknown): URL {
    if (profile.kind !== "webdav") throw new Error("Invalid WebDAV approval profile");
    const destination = parseNetworkUrl(destinationValue, { allowHttp: true, allowPort: true, allowQuery: false });
    const base = new URL(profile.baseUrl);
    if (destination.origin !== base.origin || !isStrictPathDescendant(destination.pathname, base.pathname))
        throw new Error("WebDAV upload escaped its approved endpoint");
    return destination;
}

export function assertWebdavShareDestination(profile: ApprovalProfile, destinationValue: unknown): URL {
    if (profile.kind !== "webdav") throw new Error("Invalid WebDAV approval profile");
    const destination = parseNetworkUrl(destinationValue, { allowHttp: true, allowPort: true, allowQuery: true });
    const base = new URL(profile.baseUrl);
    if (destination.origin !== base.origin
        || !/^\/ocs\/v[12]\.php\/apps\/files_sharing\/api\/v1\/shares$/u.test(destination.pathname)
        || destination.search !== "?format=json")
        throw new Error("WebDAV share request escaped its approved endpoint");
    return destination;
}
