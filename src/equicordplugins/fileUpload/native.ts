/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";

import { IpcMainInvokeEvent } from "electron";

import {
    approveEndpoint,
    assertS3Destination,
    assertWebdavShareDestination,
    assertWebdavUploadDestination,
    getApprovalProfile
} from "./nativeApprovals";
import {
    acquireUploadAdmission,
    assertTrustedFileUploadEvent,
    boundedPinnedRequest,
    fetchPublicMedia,
    fixedFetch,
    MAX_NATIVE_ERROR_BYTES,
    MAX_NATIVE_URL_LENGTH,
    NATIVE_UPLOAD_TIMEOUT_MS,
    safeNativeError,
    validateHeaderRecord,
    validateNativeSecret,
    validateUploadFilename
} from "./nativeNetwork";
import { CustomEndpointApprovalRequest, NativeEndpointApprovalResult, NativeUploadResult, NestUploadResponse } from "./types";

const S3_HEADERS = new Set([
    "authorization",
    "content-type",
    "x-amz-content-sha256",
    "x-amz-date",
    "x-amz-security-token"
]);
const WEBDAV_UPLOAD_HEADERS = new Set(["authorization", "content-type"]);
const WEBDAV_SHARE_HEADERS = new Set(["authorization", "content-type", "ocs-apirequest"]);
const WEB_DAV_RECEIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const webdavUploadReceipts = new Map<string, { approvalId: string; expiresAt: number; path: string; }>();

async function admitFileInput(
    event: IpcMainInvokeEvent,
    fileBuffer: unknown,
    filename: unknown
): Promise<[ArrayBuffer, string, () => void]> {
    const admission = await acquireUploadAdmission(event, fileBuffer);
    try {
        return [admission.fileBuffer, validateUploadFilename(filename), admission.release];
    } catch (error) {
        admission.release();
        throw error;
    }
}

function failedHttpUpload(status: number): NativeUploadResult {
    return { success: false, error: `Upload failed with HTTP ${status}` };
}

function validateReturnedUrl(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > MAX_NATIVE_URL_LENGTH
        || /[\u0000-\u001f\u007f]/u.test(value))
        throw new Error("Upload service returned an invalid URL");
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Upload service returned an invalid URL");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
        throw new Error("Upload service returned an unsafe URL");
    return url.href;
}

function createWebdavUploadReceipt(approvalId: string, baseUrl: string, destination: URL): string {
    const basePath = new URL(baseUrl).pathname.replace(/\/+$/u, "") || "/";
    const encodedRelativePath = destination.pathname.slice(basePath === "/" ? 1 : basePath.length).replace(/^\//u, "");
    let relativePath: string;
    try {
        relativePath = encodedRelativePath.split("/").map(decodeURIComponent).join("/");
    } catch {
        throw new Error("Invalid WebDAV upload path");
    }
    if (!relativePath || /[\r\n\0]/u.test(relativePath)) throw new Error("Invalid WebDAV upload path");

    const now = Date.now();
    for (const [id, receipt] of webdavUploadReceipts) {
        if (receipt.expiresAt <= now) webdavUploadReceipts.delete(id);
    }
    while (webdavUploadReceipts.size >= 128) webdavUploadReceipts.delete(webdavUploadReceipts.keys().next().value!);
    const id = randomUUID();
    webdavUploadReceipts.set(id, { approvalId, expiresAt: now + 10 * 60_000, path: `/${relativePath}` });
    return id;
}

export async function approveCustomEndpoint(
    event: IpcMainInvokeEvent,
    request: CustomEndpointApprovalRequest
): Promise<NativeEndpointApprovalResult> {
    try {
        return await approveEndpoint(event, request);
    } catch (error) {
        return { success: false, error: safeNativeError(error, "Endpoint approval failed") };
    }
}

export async function uploadToNest(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    authToken: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        authToken = validateNativeSecret(authToken)!;
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, "https://nest.rip/api/files/upload", {
            method: "POST",
            headers: {
                "Authorization": authToken
            },
            body: formData
        });

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        const data = await response.json() as NestUploadResponse;

        if (data.fileURL) {
            return { success: true, url: validateReturnedUrl(data.fileURL) };
        }

        return { success: false, error: "No URL returned from upload" };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "Nest upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToEzHost(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    key: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        key = validateNativeSecret(key)!;
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, "https://api.e-z.host/files", {
            method: "POST",
            headers: {
                key
            },
            body: formData
        });

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        const data = await response.json() as { success: boolean; error?: string; imageUrl?: string; rawUrl?: string; };

        if (!data || !data.success) {
            return { success: false, error: "Upload service reported failure" };
        }

        if (data.imageUrl || data.rawUrl) {
            return { success: true, url: validateReturnedUrl(data.imageUrl || data.rawUrl) };
        }

        return { success: false, error: "No URL returned from upload" };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "E-Z Host upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadTo0x0(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, "https://0x0.st", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        const text = (await response.text()).trim();
        if (!text) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: validateReturnedUrl(text) };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "0x0.st upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToS3(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    uploadUrl: string,
    headers: Record<string, string>,
    approvalId: string,
    approval: CustomEndpointApprovalRequest
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        const admission = await acquireUploadAdmission(event, fileBuffer);
        fileBuffer = admission.fileBuffer;
        releaseUpload = admission.release;
        if (approval?.kind !== "s3") throw new Error("Invalid S3 approval request");
        const profile = await getApprovalProfile(approvalId, approval);
        const destination = assertS3Destination(profile, uploadUrl);
        const safeHeaders = validateHeaderRecord(headers, S3_HEADERS);
        const response = await boundedPinnedRequest(destination, {
            body: fileBuffer,
            deadline: Date.now() + NATIVE_UPLOAD_TIMEOUT_MS,
            headers: safeHeaders,
            maxResponseBytes: 0,
            method: "PUT",
            networkClass: profile.networkClass,
            approvedAddresses: profile.approvedAddresses
        });

        if (response.status < 200 || response.status >= 300) return failedHttpUpload(response.status);

        return { success: true, url: destination.href };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "S3 upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToCatbox(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    userhash?: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        userhash = validateNativeSecret(userhash, true);
        const formData = new FormData();
        formData.append("reqtype", "fileupload");
        if (userhash) {
            formData.append("userhash", userhash);
        }
        formData.append("fileToUpload", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, "https://catbox.moe/user/api.php", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        const text = (await response.text()).trim();
        if (!text) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: validateReturnedUrl(text) };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "Catbox upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToLitterbox(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    expiry: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        if (!["1h", "12h", "24h", "72h"].includes(expiry)) throw new Error("Invalid Litterbox expiry");
        const formData = new FormData();
        formData.append("reqtype", "fileupload");
        formData.append("time", expiry);
        formData.append("fileToUpload", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, "https://litterbox.catbox.moe/resources/internals/api.php", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        const text = (await response.text()).trim();
        if (!text) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: validateReturnedUrl(text) };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "Litterbox upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToGofile(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    token?: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        token = validateNativeSecret(token, true);
        const formData = new FormData();
        if (token?.trim()) {
            formData.append("token", token.trim());
        }
        formData.append("file", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, "https://upload.gofile.io/uploadfile", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        const data = await response.json() as {
            status?: string;
            error?: string;
            data?: { downloadPage?: string; code?: string; };
        };

        if (data.status !== "ok") {
            return { success: false, error: "Upload service reported failure" };
        }

        const url = data.data?.downloadPage || (data.data?.code ? `https://gofile.io/d/${data.data.code}` : "");
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: validateReturnedUrl(url) };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "GoFile upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToTmpfiles(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, "https://tmpfiles.org/api/v1/upload", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        const data = await response.json() as { status?: string; data?: { url?: string; }; };
        const rawUrl = data.data?.url || "";
        if (!rawUrl || data.status !== "success") {
            return { success: false, error: "No URL returned from upload" };
        }

        const url = rawUrl.includes("tmpfiles.org/") && !rawUrl.includes("/dl/")
            ? rawUrl.replace(/tmpfiles\.org\/(\d+)/, "tmpfiles.org/dl/$1")
            : rawUrl;

        return { success: true, url: validateReturnedUrl(url) };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "tmpfiles.org upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToBuzzheavier(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        const response = await fixedFetch(event, `https://w.buzzheavier.com/${encodeURIComponent(filename)}`, {
            method: "PUT",
            body: new Blob([fileBuffer])
        });

        const text = await response.text();
        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        try {
            const data = JSON.parse(text) as { code?: number; data?: { id?: string; }; };
            if (data.code === 201 && data.data?.id) {
                return { success: true, url: validateReturnedUrl(`https://buzzheavier.com/${data.data.id}`) };
            }
        } catch {
        }

        const url = text.trim();
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: validateReturnedUrl(url) };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "Buzzheavier upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToTempSh(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, "https://temp.sh/upload", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        const url = (await response.text()).trim();
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: validateReturnedUrl(url) };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "temp.sh upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToFilebin(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        const binId = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
        const uploadUrl = `https://filebin.net/${binId}/${encodeURIComponent(filename)}`;

        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, uploadUrl, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        return { success: true, url: `https://filebin.net/${binId}/${encodeURIComponent(filename)}` };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "Filebin upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToPixelVault(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    uploadKey: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        uploadKey = validateNativeSecret(uploadKey)!;
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);

        const response = await fixedFetch(event, "https://pixelvault.co/", {
            method: "POST",
            headers: {
                Authorization: uploadKey
            },
            body: formData
        });

        const text = await response.text();
        let data: { resource?: string; url?: string; } | null = null;

        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        const url = data?.resource || data?.url || text.trim();
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: validateReturnedUrl(url) };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "PixelVault upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToPixelDrain(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    apiKey?: string
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        [fileBuffer, filename, releaseUpload] = await admitFileInput(event, fileBuffer, filename);
        apiKey = validateNativeSecret(apiKey, true);
        const headers: Record<string, string> = {};
        if (apiKey?.trim()) {
            headers.Authorization = `Basic ${Buffer.from(`:${apiKey.trim()}`).toString("base64")}`;
        }

        const response = await fixedFetch(event, `https://pixeldrain.com/api/file/${encodeURIComponent(filename)}`, {
            method: "PUT",
            headers,
            body: new Blob([fileBuffer])
        });

        const text = await response.text();
        let data: { id?: string; message?: string; } | null = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }

        if (!response.ok) {
            return failedHttpUpload(response.status);
        }

        if (!data?.id) {
            return { success: false, error: "No URL returned from upload" };
        }

        return { success: true, url: validateReturnedUrl(`https://pixeldrain.com/u/${data.id}`) };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "PixelDrain upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function uploadToWebdav(
    event: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    uploadUrl: string,
    headers: Record<string, string>,
    approvalId: string,
    approval: CustomEndpointApprovalRequest
): Promise<NativeUploadResult> {
    let releaseUpload: (() => void) | undefined;
    try {
        const admission = await acquireUploadAdmission(event, fileBuffer);
        fileBuffer = admission.fileBuffer;
        releaseUpload = admission.release;
        if (approval?.kind !== "webdav") throw new Error("Invalid WebDAV approval request");
        const profile = await getApprovalProfile(approvalId, approval);
        const destination = assertWebdavUploadDestination(profile, uploadUrl);
        const safeHeaders = validateHeaderRecord(headers, WEBDAV_UPLOAD_HEADERS);
        const response = await boundedPinnedRequest(destination, {
            body: fileBuffer,
            deadline: Date.now() + NATIVE_UPLOAD_TIMEOUT_MS,
            headers: safeHeaders,
            maxResponseBytes: 0,
            method: "PUT",
            networkClass: profile.networkClass,
            approvedAddresses: profile.approvedAddresses
        });

        if (response.status < 200 || response.status >= 300) return failedHttpUpload(response.status);

        return {
            receipt: createWebdavUploadReceipt(approvalId, profile.baseUrl, destination),
            success: true,
            url: destination.href
        };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "WebDAV upload failed") };
    } finally {
        releaseUpload?.();
    }
}

export async function createWebdavShare(
    event: IpcMainInvokeEvent,
    ocsUrl: string,
    headers: Record<string, string>,
    body: string,
    approvalId: string,
    approval: CustomEndpointApprovalRequest,
    uploadReceipt: string
): Promise<NativeUploadResult> {
    try {
        assertTrustedFileUploadEvent(event);
        if (approval?.kind !== "webdav" || typeof body !== "string" || Buffer.byteLength(body, "utf8") > 4_096)
            throw new Error("Invalid WebDAV share request");
        const parameters = new URLSearchParams(body);
        const requestedPath = parameters.get("path");
        if (parameters.size !== 3 || parameters.get("shareType") !== "3" || parameters.get("permissions") !== "1"
            || !requestedPath?.startsWith("/") || /[\r\n\0]/u.test(requestedPath))
            throw new Error("Invalid WebDAV share body");
        if (typeof uploadReceipt !== "string" || !WEB_DAV_RECEIPT.test(uploadReceipt))
            throw new Error("Invalid WebDAV upload receipt");
        const receipt = webdavUploadReceipts.get(uploadReceipt);
        if (!receipt || receipt.expiresAt <= Date.now() || receipt.approvalId !== approvalId || receipt.path !== requestedPath)
            throw new Error("WebDAV share is not bound to a recent upload");
        webdavUploadReceipts.delete(uploadReceipt);
        const profile = await getApprovalProfile(approvalId, approval);
        const destination = assertWebdavShareDestination(profile, ocsUrl);
        const safeHeaders = validateHeaderRecord(headers, WEBDAV_SHARE_HEADERS);
        let response;
        try {
            response = await boundedPinnedRequest(destination, {
                body,
                deadline: Date.now() + NATIVE_UPLOAD_TIMEOUT_MS,
                headers: safeHeaders,
                maxResponseBytes: MAX_NATIVE_ERROR_BYTES,
                method: "POST",
                networkClass: profile.networkClass,
                approvedAddresses: profile.approvedAddresses
            });
        } catch (error) {
            if (receipt.expiresAt > Date.now()) webdavUploadReceipts.set(uploadReceipt, receipt);
            throw error;
        }

        const text = new TextDecoder().decode(response.body);

        if (response.status < 200 || response.status >= 300)
            return { success: false, error: `Share creation failed with HTTP ${response.status}` };

        let data: { ocs?: { data?: { token?: string; }; }; };
        try {
            data = JSON.parse(text);
        } catch {
            return { success: false, error: "Invalid share response" };
        }

        const token = data?.ocs?.data?.token;
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,512}$/u.test(token)) {
            return { success: false, error: "No share token in server response" };
        }

        return { success: true, url: token };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "WebDAV share creation failed") };
    }
}

export async function fetchFile(
    event: IpcMainInvokeEvent,
    url: string
): Promise<{ success: boolean; data?: ArrayBuffer; contentType?: string; error?: string; }> {
    try {
        const result = await fetchPublicMedia(event, url);
        return { success: true, data: result.data, contentType: result.contentType };
    } catch (e) {
        return { success: false, error: safeNativeError(e, "Remote media fetch failed") };
    }
}
