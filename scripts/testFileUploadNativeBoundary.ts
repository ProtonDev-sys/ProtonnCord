/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { IpcMainInvokeEvent } from "electron";
import { build, type Plugin } from "esbuild";

import type { CustomEndpointApprovalRequest } from "../src/equicordplugins/fileUpload/types";

type NativeModule = typeof import("../src/equicordplugins/fileUpload/native");

interface RecordedRequest {
    body: Buffer;
    headers: IncomingMessage["headers"];
    method: string;
    url: string;
}

interface HarnessRuntime {
    dataDir: string;
    dialogCalls: Array<Record<string, unknown>>;
    dialogResponses: number[];
    enabled: boolean;
}

interface HarnessGlobal {
    __fileUploadNativeHarness: HarnessRuntime;
}

const harnessGlobal = globalThis as typeof globalThis & HarnessGlobal;
const runtimeStubs: Plugin = {
    name: "file-upload-native-runtime-stubs",
    setup(bundle) {
        bundle.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "file-upload-test" }));
        bundle.onResolve({ filter: /^@main\/settings$/ }, () => ({ path: "settings", namespace: "file-upload-test" }));
        bundle.onResolve({ filter: /^@main\/utils\/constants$/ }, () => ({ path: "constants", namespace: "file-upload-test" }));
        bundle.onLoad({ filter: /^electron$/, namespace: "file-upload-test" }, () => ({
            contents: `
                export const dialog = {
                    showMessageBox: async options => {
                        const runtime = globalThis.__fileUploadNativeHarness;
                        runtime.dialogCalls.push(options);
                        return { response: runtime.dialogResponses.shift() ?? 0 };
                    }
                };
            `,
            loader: "js"
        }));
        bundle.onLoad({ filter: /^settings$/, namespace: "file-upload-test" }, () => ({
            contents: `
                export const RendererSettings = {
                    get store() {
                        return {
                            plugins: {
                                FileUpload: { enabled: globalThis.__fileUploadNativeHarness.enabled }
                            }
                        };
                    }
                };
            `,
            loader: "js"
        }));
        bundle.onLoad({ filter: /^constants$/, namespace: "file-upload-test" }, () => ({
            contents: "export const DATA_DIR = globalThis.__fileUploadNativeHarness.dataDir;",
            loader: "js"
        }));
    }
};

let loadSequence = 0;

function discordEvent(url: string, topLevel = true): IpcMainInvokeEvent {
    const mainFrame = { url };
    const senderFrame = topLevel ? mainFrame : { url };
    return { sender: { mainFrame }, senderFrame } as unknown as IpcMainInvokeEvent;
}

async function loadNative(bundlePath: string): Promise<NativeModule> {
    const url = pathToFileURL(bundlePath);
    url.searchParams.set("instance", String(++loadSequence));
    return await import(url.href) as NativeModule;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += chunk.byteLength;
        assert.ok(total <= 1024 * 1024, "the test server must not buffer an unexpectedly large request");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

function respondToRequest(request: RecordedRequest, response: ServerResponse): void {
    if (request.url === "/s3/bucket/redirect-object") {
        response.writeHead(307, { Location: "/redirect-target" });
        response.end();
        return;
    }
    if (request.url === "/s3/bucket/fail-object") {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("NATIVE_ERROR_SENTINEL_DO_NOT_LEAK");
        return;
    }
    if (request.method === "POST" && /^\/ocs\/v[12]\.php\/apps\/files_sharing\/api\/v1\/shares\?format=json$/u.test(request.url)) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ocs: { data: { token: "safe-share-token" } } }));
        return;
    }
    if (request.url === "/secret") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("LOOPBACK_SSRF_SENTINEL");
        return;
    }
    response.writeHead(request.method === "PUT" ? 201 : 200, { "Content-Type": "text/plain" });
    response.end("ok");
}

async function startTestServer(): Promise<{
    close(): Promise<void>;
    origin: string;
    requests: RecordedRequest[];
}> {
    const requests: RecordedRequest[] = [];
    const server = createServer((incoming, response) => {
        void (async () => {
            const request: RecordedRequest = {
                body: await readBody(incoming),
                headers: incoming.headers,
                method: incoming.method ?? "",
                url: incoming.url ?? ""
            };
            requests.push(request);
            respondToRequest(request, response);
        })().catch(error => {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return {
        close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
        origin: `http://127.0.0.1:${address.port}`,
        requests
    };
}

function requestCount(requests: RecordedRequest[], predicate?: (request: RecordedRequest) => boolean): number {
    return predicate ? requests.filter(predicate).length : requests.length;
}

async function testEventBoundary(native: NativeModule): Promise<void> {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (_input, init) => {
        fetchCalls++;
        assert.equal(init?.redirect, "error", "fixed providers must disable automatic redirects");
        return new Response("https://0x0.st/result\n");
    }) as typeof fetch;
    try {
        for (const origin of ["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"]) {
            const result = await native.uploadTo0x0(discordEvent(`${origin}/channels/@me/1`), new ArrayBuffer(1), "file.txt");
            assert.equal(result.success, true, `${origin} top-level renderer must remain supported`);
        }
        assert.equal(fetchCalls, 3);

        const invalidEvents = [
            discordEvent("https://evil.example/channels/@me/1"),
            discordEvent("https://discord.com.evil.example/channels/@me/1"),
            discordEvent("https://user@discord.com/channels/@me/1"),
            discordEvent("https://discord.com:444/channels/@me/1"),
            discordEvent("data:text/html,evil"),
            discordEvent("https://discord.com/channels/@me/1", false),
            {} as IpcMainInvokeEvent
        ];
        for (const event of invalidEvents) {
            const result = await native.uploadTo0x0(event, new ArrayBuffer(1), "file.txt");
            assert.equal(result.success, false);
        }
        assert.equal(fetchCalls, 3, "untrusted renderers must be rejected before a fixed-provider request");

        harnessGlobal.__fileUploadNativeHarness.enabled = false;
        const disabledUpload = await native.uploadTo0x0(discordEvent("https://discord.com/channels/@me/1"), new ArrayBuffer(1), "file.txt");
        assert.equal(disabledUpload.success, false);
        const dialogsBefore = harnessGlobal.__fileUploadNativeHarness.dialogCalls.length;
        const disabledApproval = await native.approveCustomEndpoint(discordEvent("https://discord.com/channels/@me/1"), {
            baseUrl: "http://127.0.0.1:1/s3",
            bucket: "bucket",
            forcePathStyle: true,
            kind: "s3"
        });
        assert.equal(disabledApproval.success, false);
        assert.equal(harnessGlobal.__fileUploadNativeHarness.dialogCalls.length, dialogsBefore,
            "disabled FileUpload handlers must not open approval dialogs");
        assert.equal(fetchCalls, 3, "disabled FileUpload handlers must not retain network authority");
    } finally {
        harnessGlobal.__fileUploadNativeHarness.enabled = true;
        globalThis.fetch = originalFetch;
    }
}

async function testFetchBoundary(native: NativeModule, origin: string, requests: RecordedRequest[]): Promise<void> {
    const before = requests.length;
    for (const url of [
        `${origin}/secret`,
        "https://127.0.0.1/secret",
        "https://[::1]/secret",
        "https://169.254.169.254/latest/meta-data",
        "https://example.com/public-image.png",
        "https://httpbin.org/image/png",
        "https://cdn.discordapp.com/api/v10/users/@me.png",
        "file:///C:/Windows/System32/drivers/etc/hosts",
        "data:text/plain,secret"
    ]) {
        const result = await native.fetchFile(discordEvent("https://discord.com/channels/@me/1"), url);
        assert.equal(result.success, false, `${url} must not be readable through the main process`);
        assert.equal(result.data, undefined);
    }
    assert.equal(requests.length, before, "loopback read SSRF must be rejected before the local server receives a request");
}

async function approve(
    native: NativeModule,
    request: CustomEndpointApprovalRequest,
    response = 1
): Promise<string> {
    harnessGlobal.__fileUploadNativeHarness.dialogResponses.push(response);
    const result = await native.approveCustomEndpoint(discordEvent("https://discord.com/channels/@me/1"), request);
    assert.equal(result.success, response === 1);
    if (response !== 1) {
        assert.equal(result.approvalId, undefined);
        return "";
    }
    assert.match(result.approvalId ?? "", /^[0-9a-f-]{36}$/u);
    return result.approvalId!;
}

async function testS3Boundary(
    native: NativeModule,
    origin: string,
    requests: RecordedRequest[]
): Promise<{ approvalId: string; request: CustomEndpointApprovalRequest & { kind: "s3"; }; }> {
    const event = discordEvent("https://discord.com/channels/@me/1");
    const approvalRequest = {
        baseUrl: `${origin}/s3`,
        bucket: "bucket",
        forcePathStyle: true,
        kind: "s3"
    } as const;
    const approvalId = await approve(native, approvalRequest);
    const dialog = harnessGlobal.__fileUploadNativeHarness.dialogCalls.at(-1)!;
    assert.equal(dialog.defaultId, 0);
    assert.equal(dialog.cancelId, 0);
    assert.match(String(dialog.detail), /local\/private network/iu);
    assert.match(String(dialog.detail), /127\.0\.0\.1/u);

    const body = Buffer.from("approved s3 upload");
    const headers = {
        Authorization: "AWS4-HMAC-SHA256 Credential=test",
        "Content-Type": "text/plain",
        "x-amz-content-sha256": "abc123",
        "x-amz-date": "20260812T120000Z"
    };
    const uploadUrl = `${origin}/s3/bucket/object.txt`;
    const result = await native.uploadToS3(event, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        uploadUrl, headers, approvalId, approvalRequest);
    assert.deepEqual(result, { success: true, url: uploadUrl });
    const received = requests.at(-1)!;
    assert.equal(received.method, "PUT");
    assert.equal(received.url, "/s3/bucket/object.txt");
    assert.deepEqual(received.body, body);
    assert.equal(received.headers.authorization, headers.Authorization);
    assert.equal(received.headers["x-amz-date"], headers["x-amz-date"]);

    for (const unsafeUrl of [
        `${origin}/s3/bucket`,
        `${origin}/s3/other/object.txt`,
        `${origin}/s3/bucket/object%2Fsecret.txt`,
        `${origin}/s3/bucket/object%252fsecret.txt`,
        `${origin}/s3/bucket//secret.txt`
    ]) {
        const before = requests.length;
        const blocked = await native.uploadToS3(event, new ArrayBuffer(1), unsafeUrl, headers, approvalId, approvalRequest);
        assert.equal(blocked.success, false, `${unsafeUrl} must escape neither the approved path nor URL decoding rules`);
        assert.equal(requests.length, before);
    }

    const beforeWrongScope = requests.length;
    const wrongScope = await native.uploadToS3(event, new ArrayBuffer(1), uploadUrl, headers, approvalId, {
        ...approvalRequest,
        bucket: "different-bucket"
    });
    assert.equal(wrongScope.success, false);
    assert.equal(requests.length, beforeWrongScope);

    const beforeBadHeaders = requests.length;
    const badHeaders = await native.uploadToS3(event, new ArrayBuffer(1), uploadUrl, {
        ...headers,
        "X-Not-Approved": "secret"
    }, approvalId, approvalRequest);
    assert.equal(badHeaders.success, false);
    assert.equal(requests.length, beforeBadHeaders);

    const redirect = await native.uploadToS3(event, new ArrayBuffer(1), `${origin}/s3/bucket/redirect-object`,
        headers, approvalId, approvalRequest);
    assert.deepEqual(redirect, { success: false, error: "Upload failed with HTTP 307" });
    assert.equal(requestCount(requests, request => request.url === "/s3/bucket/redirect-object"), 1);
    assert.equal(requestCount(requests, request => request.url === "/redirect-target"), 0,
        "custom uploads must not follow redirects");

    const redacted = await native.uploadToS3(event, new ArrayBuffer(1), `${origin}/s3/bucket/fail-object`,
        headers, approvalId, approvalRequest);
    assert.deepEqual(redacted, { success: false, error: "Upload failed with HTTP 500" });
    assert.doesNotMatch(JSON.stringify(redacted), /NATIVE_ERROR_SENTINEL_DO_NOT_LEAK/u);

    return { approvalId, request: approvalRequest };
}

async function testPersistedApproval(
    bundlePath: string,
    expectedApprovalId: string,
    request: CustomEndpointApprovalRequest
): Promise<NativeModule> {
    const reloaded = await loadNative(bundlePath);
    const dialogCount = harnessGlobal.__fileUploadNativeHarness.dialogCalls.length;
    const result = await reloaded.approveCustomEndpoint(discordEvent("https://discord.com/channels/@me/1"), request);
    assert.deepEqual(result, { approvalId: expectedApprovalId, success: true });
    assert.equal(harnessGlobal.__fileUploadNativeHarness.dialogCalls.length, dialogCount,
        "an unchanged pinned endpoint approval must survive a native module reload without another prompt");
    return reloaded;
}

async function testWebdavBoundary(native: NativeModule, origin: string, requests: RecordedRequest[]): Promise<void> {
    const event = discordEvent("https://discord.com/channels/@me/1");
    const approvalRequest = { baseUrl: `${origin}/dav/user`, kind: "webdav" } as const;
    const approvalId = await approve(native, approvalRequest);
    const headers = { Authorization: "Basic dGVzdDp0ZXN0", "Content-Type": "text/plain" };

    const encodedBefore = requests.length;
    const encoded = await native.uploadToWebdav(event, new ArrayBuffer(1),
        `${origin}/dav/user/folder%2Fescape.txt`, headers, approvalId, approvalRequest);
    assert.equal(encoded.success, false);
    assert.equal(requests.length, encodedBefore);

    const uploadBody = Buffer.from("approved webdav upload");
    const uploadUrl = `${origin}/dav/user/folder/file.txt`;
    const upload = await native.uploadToWebdav(event,
        uploadBody.buffer.slice(uploadBody.byteOffset, uploadBody.byteOffset + uploadBody.byteLength),
        uploadUrl, headers, approvalId, approvalRequest);
    assert.equal(upload.success, true);
    assert.equal(upload.url, uploadUrl);
    assert.match(upload.receipt ?? "", /^[0-9a-f-]{36}$/u);
    const receivedUpload = requests.at(-1)!;
    assert.equal(receivedUpload.method, "PUT");
    assert.equal(receivedUpload.url, "/dav/user/folder/file.txt");
    assert.deepEqual(receivedUpload.body, uploadBody);

    const shareUrl = `${origin}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`;
    const shareHeaders = {
        Authorization: "Basic dGVzdDp0ZXN0",
        "Content-Type": "application/x-www-form-urlencoded",
        "OCS-APIRequest": "true"
    };
    const wrongBody = new URLSearchParams({ path: "/other.txt", permissions: "1", shareType: "3" }).toString();
    const beforeWrongPath = requests.length;
    const wrongPath = await native.createWebdavShare(event, shareUrl, shareHeaders, wrongBody,
        approvalId, approvalRequest, upload.receipt!);
    assert.equal(wrongPath.success, false);
    assert.equal(requests.length, beforeWrongPath, "a receipt must not authorize sharing a different path");

    const body = new URLSearchParams({ path: "/folder/file.txt", permissions: "1", shareType: "3" }).toString();
    const share = await native.createWebdavShare(event, shareUrl, shareHeaders, body,
        approvalId, approvalRequest, upload.receipt!);
    assert.deepEqual(share, { success: true, url: "safe-share-token" });
    const receivedShare = requests.at(-1)!;
    assert.equal(receivedShare.method, "POST");
    assert.equal(receivedShare.url, "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(receivedShare.body.toString())), {
        path: "/folder/file.txt",
        permissions: "1",
        shareType: "3"
    });

    const beforeReuse = requests.length;
    const reused = await native.createWebdavShare(event, shareUrl, shareHeaders, body,
        approvalId, approvalRequest, upload.receipt!);
    assert.equal(reused.success, false);
    assert.equal(requests.length, beforeReuse, "a WebDAV upload receipt must be single use");
}

async function testFixedResponseCap(native: NativeModule): Promise<void> {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.enqueue(Uint8Array.of(1));
        },
        cancel() {
            cancelled = true;
        }
    }))) as typeof fetch;
    try {
        const result = await native.uploadTo0x0(discordEvent("https://discord.com/channels/@me/1"), new ArrayBuffer(1), "file.txt");
        assert.equal(result.success, false);
        assert.match(result.error ?? "", /response exceeded its safe size/iu);
        assert.equal(cancelled, true, "an oversized fixed-provider response body must be cancelled");
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testUploadAdmission(native: NativeModule): Promise<void> {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const gate = new Promise<void>(resolve => releaseFirst = resolve);
    const started = new Promise<void>(resolve => firstStarted = resolve);
    globalThis.fetch = (async () => {
        fetchCalls++;
        firstStarted();
        await gate;
        return new Response("https://0x0.st/result\n");
    }) as typeof fetch;
    try {
        const event = discordEvent("https://discord.com/channels/@me/1");
        const first = native.uploadTo0x0(event, new ArrayBuffer(1), "first.txt");
        await started;
        const second = await native.uploadTo0x0(event, new ArrayBuffer(1), "second.txt");
        assert.equal(second.success, false);
        assert.match(second.error ?? "", /too many/iu);
        assert.equal(fetchCalls, 1, "a rejected concurrent upload must not construct another network request");
        releaseFirst();
        assert.equal((await first).success, true);
    } finally {
        releaseFirst?.();
        globalThis.fetch = originalFetch;
    }
}

async function main(): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), "protonncord-file-upload-native-"));
    const bundlePath = path.join(root, "file-upload-native.mjs");
    const server = await startTestServer();
    harnessGlobal.__fileUploadNativeHarness = {
        dataDir: path.join(root, "data"),
        dialogCalls: [],
        dialogResponses: [],
        enabled: true
    };
    try {
        await build({
            absWorkingDir: path.resolve("."),
            bundle: true,
            entryPoints: ["src/equicordplugins/fileUpload/native.ts"],
            format: "esm",
            outfile: bundlePath,
            platform: "node",
            plugins: [runtimeStubs],
            target: "node22"
        });
        let native = await loadNative(bundlePath);
        assert.deepEqual(Object.keys(native).sort(), [
            "approveCustomEndpoint",
            "createWebdavShare",
            "fetchFile",
            "uploadTo0x0",
            "uploadToBuzzheavier",
            "uploadToCatbox",
            "uploadToEzHost",
            "uploadToFilebin",
            "uploadToGofile",
            "uploadToLitterbox",
            "uploadToNest",
            "uploadToPixelDrain",
            "uploadToPixelVault",
            "uploadToS3",
            "uploadToTempSh",
            "uploadToTmpfiles",
            "uploadToWebdav"
        ], "only intentional handlers may enter the auto-registered FileUpload native export surface");

        await testEventBoundary(native);
        await testFetchBoundary(native, server.origin, server.requests);
        const s3 = await testS3Boundary(native, server.origin, server.requests);
        native = await testPersistedApproval(bundlePath, s3.approvalId, s3.request);
        await testWebdavBoundary(native, server.origin, server.requests);
        await testFixedResponseCap(native);
        await testUploadAdmission(native);
        console.log("file upload native boundary checks passed");
    } finally {
        await server.close();
        await rm(root, { force: true, recursive: true });
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
