/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build, type Plugin } from "esbuild";
import type { IpcMainInvokeEvent } from "electron";

import {
    assertAttachmentContent,
    BoundedOperationLimiter,
    fetchDiscordAttachment,
    isTrustedDiscordRendererEvent,
    parseAllowedAttachmentExtensions,
    validateDiscordAttachmentUrl
} from "../src/equicordplugins/messageLoggerEnhanced/native/attachmentDownload";
import { getImageCachePath } from "../src/equicordplugins/messageLoggerEnhanced/native/cacheFile";

type NativeModule = typeof import("../src/equicordplugins/messageLoggerEnhanced/native");

const ATTACHMENT_ID = "300000000000000001";
const CHANNEL_ID = "200000000000000001";
const VALID_CDN_URL = `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png?ex=abcdef&is=123&hm=456`;
const VALID_MEDIA_URL = `https://media.discordapp.net/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png?width=640&format=webp`;
const VALID_EPHEMERAL_URL = `https://cdn.discordapp.com/ephemeral-attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png?ex=abcdef`;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DISCORD_EVENT = discordEvent(`https://discord.com/channels/@me/${CHANNEL_ID}`);
const HARNESS_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const HARNESS_CACHE_BYTES = 1024;

function discordEvent(url: string): IpcMainInvokeEvent {
    return { senderFrame: { url } as IpcMainInvokeEvent["senderFrame"] } as IpcMainInvokeEvent;
}

for (const url of [VALID_CDN_URL, VALID_MEDIA_URL, VALID_EPHEMERAL_URL]) {
    assert.equal(validateDiscordAttachmentUrl(url, ATTACHMENT_ID).href, new URL(url).href);
}

for (const url of [
    `http://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `file:///attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `data:text/plain,secret`,
    `https://user@cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `https://cdn.discordapp.com:444/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `https://cdn.discordapp.com.evil.test/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `https://cdn.discordapp.com./attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `https://127.0.0.1/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `https://[::1]/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `https://169.254.169.254/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `https://cdn.discordapp.com/avatars/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`,
    `https://cdn.discordapp.com/attachments/not-a-channel/${ATTACHMENT_ID}/image.png`,
    `https://cdn.discordapp.com/attachments/18446744073709551616/${ATTACHMENT_ID}/image.png`,
    `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/300000000000000002/image.png`,
    `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/`,
    `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/folder/image.png`,
    `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/..`,
    `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/%2e%2e`,
    `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image%2fsecret.png`,
    `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image%5csecret.png`,
    `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image%00.png`,
    `${VALID_CDN_URL}#fragment`,
    `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/${"a".repeat(513)}`,
    `${VALID_CDN_URL}${"x".repeat(4_096)}`
]) {
    assert.throws(() => validateDiscordAttachmentUrl(url, ATTACHMENT_ID), /attachment|Discord|untrusted|invalid/i,
        `${url.slice(0, 120)} must be rejected`);
}

for (const event of [
    DISCORD_EVENT,
    discordEvent(`https://ptb.discord.com/channels/@me/${CHANNEL_ID}`),
    discordEvent(`https://canary.discord.com/channels/@me/${CHANNEL_ID}`)
]) {
    assert.equal(isTrustedDiscordRendererEvent(event), true);
}
for (const event of [
    discordEvent("data:text/html,evil"),
    discordEvent("file:///C:/tmp/evil.html"),
    discordEvent("https://evil.example/channels/@me"),
    discordEvent("https://discord.com.evil.example/channels/@me"),
    discordEvent("https://user@discord.com/channels/@me"),
    discordEvent("https://discord.com:444/channels/@me"),
    {} as IpcMainInvokeEvent
]) {
    assert.equal(isTrustedDiscordRendererEvent(event), false);
}

assert.deepEqual(parseAllowedAttachmentExtensions("png, JPG, png, .webp"), ["png", "jpg", "webp"]);
assert.deepEqual(parseAllowedAttachmentExtensions("png,".repeat(100)), [],
    "oversized persisted extension settings must fail closed before splitting");
assert.deepEqual(parseAllowedAttachmentExtensions("exe,svg,html"), []);

const validMedia: Array<[string, string, Uint8Array]> = [
    ["png", "image/png", PNG],
    ["jpg", "image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])],
    ["jpeg", "image/jpeg; charset=binary", Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])],
    ["gif", "image/gif", Buffer.from("GIF89a")],
    ["webp", "image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])],
    ["mp4", "video/mp4", Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from("ftyp"), Buffer.alloc(4)])],
    ["webm", "video/webm", Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])],
    ["mp3", "audio/mpeg", Buffer.concat([Buffer.from("ID3"), Buffer.alloc(7)])],
    ["ogg", "audio/ogg", Buffer.concat([Buffer.from("OggS"), Buffer.from([0])])],
    ["wav", "audio/wav", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])]
];
for (const [extension, contentType, content] of validMedia) {
    assert.doesNotThrow(() => assertAttachmentContent(extension, content, contentType), `${extension} must remain supported`);
}
for (const [extension, contentType, content] of [
    ["png", "text/html", Buffer.from("<html>secret</html>")],
    ["png", "image/png", Buffer.from("<svg onload=alert(1)>")],
    ["png", "", PNG],
    ["png", "image/jpeg", PNG],
    ["wav", "audio/wav", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])],
    ["exe", "application/octet-stream", Buffer.from("MZ")]
] as Array<[string, string, Uint8Array]>) {
    assert.throws(() => assertAttachmentContent(extension, content, contentType), /attachment|unsupported|Content-Type|signature/i);
}

function pngResponse(body: BodyInit | null = PNG, init: ResponseInit = {}): Response {
    return new Response(body, {
        status: init.status,
        statusText: init.statusText,
        headers: {
            "content-length": String(PNG.byteLength),
            "content-type": "image/png",
            ...Object.fromEntries(new Headers(init.headers))
        }
    });
}

async function testFetcher() {
    const fetchCalls: Array<{ init?: RequestInit; url: string; }> = [];
    const safeRedirect = await fetchDiscordAttachment(
        validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID),
        ATTACHMENT_ID,
        "png",
        {
            fetchImpl: async (input, init) => {
                fetchCalls.push({ init, url: input.toString() });
                return fetchCalls.length === 1
                    ? new Response(null, { status: 302, headers: { location: VALID_MEDIA_URL } })
                    : pngResponse();
            }
        }
    );
    assert.deepEqual(safeRedirect, { content: PNG, extension: "png" });
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls.every(call => call.init?.redirect === "manual"), "every redirect hop must disable automatic redirects");
    assert.ok(fetchCalls.every(call => call.init?.signal instanceof AbortSignal), "every redirect hop must share a bounded deadline");

    const transformedWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
    assert.deepEqual(await fetchDiscordAttachment(
        validateDiscordAttachmentUrl(VALID_MEDIA_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
            maxBytes: transformedWebp.byteLength,
            fetchImpl: async () => new Response(transformedWebp, {
                headers: { "content-length": String(transformedWebp.byteLength), "content-type": "image/webp" }
            })
        }
    ), { content: Uint8Array.from(transformedWebp), extension: "webp" },
    "a Discord media proxy transformation must be stored under its validated actual media type");

    for (const label of ["oversized headers", "redirect", "non-success", "unexpected response URL"] as const) {
        let wasCancelled = false;
        function markCancelled() {
            wasCancelled = true;
        }
        function responseFactory() {
            const body = new ReadableStream({ cancel: markCancelled });
            if (label === "oversized headers") return new Response(body, {
                headers: { "content-length": "9", "content-type": "image/png" }
            });
            if (label === "redirect") return new Response(body, {
                status: 302,
                headers: { location: VALID_MEDIA_URL }
            });
            if (label === "non-success") return new Response(body, { status: 503 });
            const response = new Response(body, { headers: { "content-type": "image/png" } });
            Object.defineProperty(response, "url", { value: "http://127.0.0.1/secret" });
            return response;
        }
        await assert.rejects(fetchDiscordAttachment(
            validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
                maxBytes: PNG.byteLength,
                fetchImpl: async () => responseFactory()
            }
        ));
        assert.equal(wasCancelled, true, `${label} responses must be cancelled before the limiter releases`);
    }

    let unsafeRedirectCalls = 0;
    await assert.rejects(fetchDiscordAttachment(
        validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID),
        ATTACHMENT_ID,
        "png",
        {
            fetchImpl: async () => {
                unsafeRedirectCalls++;
                return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:65535/secret" } });
            }
        }
    ), /attachment|untrusted|Discord/i);
    assert.equal(unsafeRedirectCalls, 1, "an unsafe redirect must be rejected before a second network request");

    let redirectLoopCalls = 0;
    await assert.rejects(fetchDiscordAttachment(
        validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
            fetchImpl: async () => {
                redirectLoopCalls++;
                return new Response(null, { status: 307, headers: { location: VALID_CDN_URL } });
            }
        }
    ), /redirected too many times/u);
    assert.equal(redirectLoopCalls, 4);

    let bodyRead = false;
    let oversizedCancelled = false;
    const oversizedResponse = new Response(new ReadableStream({
        pull(controller) {
            controller.enqueue(PNG);
            controller.close();
        },
        cancel() {
            oversizedCancelled = true;
        }
    }), {
        headers: { "content-length": String(PNG.byteLength + 1), "content-type": "image/png" }
    });
    const getOversizedReader = oversizedResponse.body!.getReader.bind(oversizedResponse.body);
    (oversizedResponse.body as any).getReader = (...args: unknown[]) => {
        bodyRead = true;
        return getOversizedReader(...args as []);
    };
    await assert.rejects(fetchDiscordAttachment(
        validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
            maxBytes: PNG.byteLength,
            fetchImpl: async () => oversizedResponse
        }
    ), /configured size limit/u);
    assert.equal(bodyRead, false, "oversized Content-Length must fail before reading the body");
    assert.equal(oversizedCancelled, true,
        "oversized Content-Length must cancel the response body before returning");

    let cancelled = false;
    let overLimitChunk = 0;
    await assert.rejects(fetchDiscordAttachment(
        validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
            maxBytes: PNG.byteLength,
            fetchImpl: async () => new Response(new ReadableStream({
                pull(controller) {
                    controller.enqueue(overLimitChunk++ === 0 ? PNG : Uint8Array.of(0));
                },
                cancel() {
                    cancelled = true;
                }
            }), { headers: { "content-type": "image/png" } })
        }
    ), /size limit/u);
    assert.equal(cancelled, true, "a chunked response that crosses the cap must be cancelled");

    assert.deepEqual(await fetchDiscordAttachment(
        validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
            maxBytes: PNG.byteLength,
            fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/png" } })
        }
    ), { content: PNG, extension: "png" }, "a chunked response exactly at the boundary must succeed");

    for (const response of [
        new Response(null, { status: 200, headers: { "content-type": "image/png" } }),
        new Response(PNG, { headers: { "content-encoding": "gzip", "content-type": "image/png" } }),
        new Response(PNG, { headers: { "content-length": "8x", "content-type": "image/png" } }),
        new Response(PNG.subarray(0, 7), { headers: { "content-length": "8", "content-type": "image/png" } }),
        new Response(Buffer.from("<html>secret</html>"), { headers: { "content-type": "text/html" } })
    ]) {
        await assert.rejects(fetchDiscordAttachment(
            validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
                maxBytes: 64,
                fetchImpl: async () => response
            }
        ));
    }

    const forgedResponse = pngResponse();
    Object.defineProperty(forgedResponse, "url", { value: "http://127.0.0.1/secret" });
    await assert.rejects(fetchDiscordAttachment(
        validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
            fetchImpl: async () => forgedResponse
        }
    ), /unexpected redirect/u);

    const timeoutStarted = Date.now();
    const connectionKeepAlive = setInterval(() => undefined, 100);
    try {
        await assert.rejects(fetchDiscordAttachment(
            validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
                deadline: Date.now() + 30,
                fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
                })
            }
        ), /timed? ?out|abort/i);
    } finally {
        clearInterval(connectionKeepAlive);
    }
    assert.ok(Date.now() - timeoutStarted < 5_000, "a stalled connection must honor the overall deadline");

    const stalledBodyStarted = Date.now();
    const bodyKeepAlive = setInterval(() => undefined, 100);
    try {
        await assert.rejects(fetchDiscordAttachment(
            validateDiscordAttachmentUrl(VALID_CDN_URL, ATTACHMENT_ID), ATTACHMENT_ID, "png", {
                deadline: Date.now() + 30,
                fetchImpl: async (_input, init) => new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(PNG.subarray(0, 4));
                        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
                    }
                }), { headers: { "content-type": "image/png" } })
            }
        ), /timed? ?out|abort/i);
    } finally {
        clearInterval(bodyKeepAlive);
    }
    assert.ok(Date.now() - stalledBodyStarted < 5_000, "a stalled body must honor the same overall deadline");
}

async function testLimiter() {
    const limiter = new BoundedOperationLimiter(1, 1);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => releaseFirst = resolve);
    const first = limiter.run(Date.now() + 1_000, async () => {
        await firstGate;
        return 1;
    });
    const second = limiter.run(Date.now() + 1_000, async () => 2);
    await assert.rejects(limiter.run(Date.now() + 1_000, async () => 3), /too many/iu,
        "the limiter must bound queued privileged operations");
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
}

interface HarnessRuntime {
    chosenDirectory?: string;
    dataDir: string;
    dialogGate?: Promise<void>;
    dialogOpened?: () => void;
}

interface HarnessGlobal {
    __messageLoggerNativeHarness: HarnessRuntime;
}

const harnessGlobal = globalThis as typeof globalThis & HarnessGlobal;
const runtimeStubs: Plugin = {
    name: "message-logger-native-runtime-stubs",
    setup(bundle) {
        bundle.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "message-logger-test" }));
        bundle.onResolve({ filter: /^@main\/utils\/constants$/ }, () => ({ path: "constants", namespace: "message-logger-test" }));
        bundle.onLoad({ filter: /[\\/]messageLoggerEnhanced[\\/]utils[\\/]constants\.ts$/ }, () => ({
            contents: `
                export const SUPPORTED_ATTACHMENT_FILE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mp3", "ogg", "wav"];
                export const DEFAULT_ATTACHMENT_FILE_EXTENSIONS = SUPPORTED_ATTACHMENT_FILE_EXTENSIONS.join(",");
                export const DEFAULT_ATTACHMENT_SIZE_LIMIT_MEGABYTES = 1;
                export const MAX_ATTACHMENT_SIZE_LIMIT_MEGABYTES = 2;
                export const MAX_ATTACHMENT_CACHE_BYTES = ${HARNESS_CACHE_BYTES};
                export const MAX_ATTACHMENT_CACHE_ENTRIES = 100;
                export const LOGS_DATA_FILENAME = "message-logger-logs.json";
            `,
            loader: "js"
        }));
        bundle.onLoad({ filter: /^electron$/, namespace: "message-logger-test" }, () => ({
            contents: `
                const runtime = globalThis.__messageLoggerNativeHarness;
                export const dialog = {
                    showOpenDialog: async () => {
                        runtime.dialogOpened?.();
                        await runtime.dialogGate;
                        return { filePaths: runtime.chosenDirectory ? [runtime.chosenDirectory] : [] };
                    },
                    showSaveDialog: async () => ({ canceled: true })
                };
                export const shell = { showItemInFolder: () => undefined };
            `,
            loader: "js"
        }));
        bundle.onLoad({ filter: /^constants$/, namespace: "message-logger-test" }, () => ({
            contents: "export const DATA_DIR = globalThis.__messageLoggerNativeHarness.dataDir;",
            loader: "js"
        }));
    }
};

let loadSequence = 0;
async function loadNative(bundlePath: string, dataDir: string): Promise<NativeModule> {
    harnessGlobal.__messageLoggerNativeHarness = { dataDir };
    const url = pathToFileURL(bundlePath);
    url.searchParams.set("instance", String(++loadSequence));
    const native = await import(url.href) as NativeModule;
    return native;
}

function attachment(url = VALID_MEDIA_URL, oldUrl = VALID_CDN_URL) {
    return {
        fileExtension: ".png",
        filename: "image.png",
        id: ATTACHMENT_ID,
        oldUrl,
        proxy_url: url,
        size: PNG.byteLength,
        spoiler: false,
        url
    };
}

function attachmentForId(id: string) {
    const url = `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${id}/image.png`;
    return { ...attachment(url, url), id };
}

async function testNativeHandler(root: string) {
    const bundlePath = path.join(root, "message-logger-native.mjs");
    await build({
        absWorkingDir: path.resolve("."),
        bundle: true,
        entryPoints: ["src/equicordplugins/messageLoggerEnhanced/native/index.ts"],
        format: "esm",
        outfile: bundlePath,
        platform: "node",
        plugins: [runtimeStubs],
        target: "node22"
    });
    const dataDir = path.join(root, "native-data");
    const loggerDataDir = path.join(dataDir, "MessageLoggerData");
    await mkdir(loggerDataDir, { recursive: true });
    await writeFile(path.join(loggerDataDir, "mlSettings.json"), Buffer.alloc(64 * 1024 + 1, 0x20));
    const native = await loadNative(bundlePath, dataDir);
    assert.deepEqual(Object.keys(native).sort(), [
        "chooseDir",
        "chooseFile",
        "closeNativeLogImport",
        "deleteFileNative",
        "downloadAttachment",
        "finishNativeLogExport",
        "getDefaultAttachmentFileExtensions",
        "getDefaultNativeDataDir",
        "getDefaultNativeImageDir",
        "getImageNative",
        "getSettingsNative",
        "init",
        "messageLoggerEnhancedUniqueIdThingyIdkMan",
        "readNativeLogChunk",
        "showItemInFolder",
        "startNativeLogExport",
        "startNativeLogImport",
        "updateAllowedExtensions",
        "updateAttachmentSizeLimit",
        "writeLogs",
        "writeNativeLogChunk"
    ], "only intentional handler functions may enter the auto-registered native export surface");
    for (const [name, handler] of Object.entries(native)) {
        assert.equal(typeof handler, "function", `native export ${name} must be an IPC handler function`);
    }
    assert.equal((await native.getSettingsNative(DISCORD_EVENT)).attachmentFileExtensions, "png,jpg,jpeg,gif,webp,mp4,webm,mp3,ogg,wav",
        "oversized persisted settings must be rejected and replaced with bounded defaults");
    await native.updateAttachmentSizeLimit(DISCORD_EVENT, 1);
    await native.updateAllowedExtensions(DISCORD_EVENT, "png,jpg");
    await native.init(DISCORD_EVENT);
    await assert.rejects((native.chooseDir as any)(DISCORD_EVENT, "__proto__"), /invalid directory setting/iu,
        "the native directory handler must reject runtime values outside its declared key union");

    const originalFetch = globalThis.fetch;
    try {
        let fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls++;
            return pngResponse();
        };
        const downloaded = await native.downloadAttachment(DISCORD_EVENT, attachment());
        assert.equal(downloaded.error, null);
        assert.ok(downloaded.path && existsSync(downloaded.path));
        assert.deepEqual(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), Buffer.from(PNG));
        assert.equal(fetchCalls, 1);

        await rm(downloaded.path!, { force: true });
        await native.init(DISCORD_EVENT);
        const transformedWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
        fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls++;
            return new Response(transformedWebp, {
                headers: { "content-length": String(transformedWebp.byteLength), "content-type": "image/webp" }
            });
        };
        const blockedTransformed = await native.downloadAttachment(DISCORD_EVENT, {
            ...attachment(),
            size: transformedWebp.byteLength
        });
        assert.match(blockedTransformed.error ?? "", /file type \.webp is blocked/iu,
            "a proxy-transformed media type must also satisfy the configured extension allowlist");
        assert.equal(fetchCalls, 2);
        assert.equal(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), null);

        await native.updateAllowedExtensions(DISCORD_EVENT, "png,jpg,webp");
        fetchCalls = 0;
        const transformed = await native.downloadAttachment(DISCORD_EVENT, {
            ...attachment(),
            size: transformedWebp.byteLength
        });
        assert.equal(transformed.error, null);
        assert.equal(path.extname(transformed.path!), ".webp");
        assert.deepEqual(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), Buffer.from(transformedWebp));
        await native.deleteFileNative(DISCORD_EVENT, ATTACHMENT_ID);
        await native.updateAllowedExtensions(DISCORD_EVENT, "png,jpg");

        globalThis.fetch = async () => {
            fetchCalls++;
            return pngResponse();
        };
        const restoredPng = await native.downloadAttachment(DISCORD_EVENT, attachment());
        assert.equal(restoredPng.error, null);
        assert.deepEqual(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), Buffer.from(PNG));

        await native.updateAllowedExtensions(DISCORD_EVENT, "png,".repeat(1_000_000));
        assert.equal((await native.getSettingsNative(DISCORD_EVENT)).attachmentFileExtensions, "none",
            "a huge renderer-controlled allowlist must fail closed without being persisted");
        await native.updateAllowedExtensions(DISCORD_EVENT, "png,png,JPG,.webp,png");
        assert.equal((await native.getSettingsNative(DISCORD_EVENT)).attachmentFileExtensions, "png,jpg,webp",
            "native extension settings must stay bounded, canonical, and deduplicated");
        await native.updateAllowedExtensions(DISCORD_EVENT, "png,jpg");

        const concurrentLogsDir = path.join(root, "concurrent-logs");
        await mkdir(concurrentLogsDir);
        let releaseDialog!: () => void;
        let dialogOpened!: () => void;
        harnessGlobal.__messageLoggerNativeHarness.chosenDirectory = concurrentLogsDir;
        harnessGlobal.__messageLoggerNativeHarness.dialogGate = new Promise<void>(resolve => releaseDialog = resolve);
        const sawDialog = new Promise<void>(resolve => dialogOpened = resolve);
        harnessGlobal.__messageLoggerNativeHarness.dialogOpened = dialogOpened;
        const chooseLogsDir = native.chooseDir(DISCORD_EVENT, "logsDir");
        await sawDialog;
        await Promise.all([
            native.updateAttachmentSizeLimit(DISCORD_EVENT, 2),
            native.updateAllowedExtensions(DISCORD_EVENT, "png,webp")
        ]);
        releaseDialog();
        assert.equal(await chooseLogsDir, concurrentLogsDir);
        harnessGlobal.__messageLoggerNativeHarness.dialogGate = undefined;
        harnessGlobal.__messageLoggerNativeHarness.dialogOpened = undefined;
        const concurrentlyUpdatedSettings = await native.getSettingsNative(DISCORD_EVENT);
        assert.equal(concurrentlyUpdatedSettings.attachmentSizeLimitInMegabytes, 2,
            "a directory dialog must not overwrite a concurrent attachment-size update");
        assert.equal(concurrentlyUpdatedSettings.attachmentFileExtensions, "png,webp",
            "atomic settings updates must preserve concurrently changed fields");
        await native.updateAttachmentSizeLimit(DISCORD_EVENT, 1);
        await native.updateAllowedExtensions(DISCORD_EVENT, "png,jpg");

        const cached = await native.downloadAttachment(DISCORD_EVENT, attachment());
        assert.equal(cached.path, restoredPng.path);
        assert.equal(fetchCalls, 2, "a validated cache hit must avoid another privileged request");

        assert.equal(await native.getImageNative(discordEvent("data:text/plain,evil"), ATTACHMENT_ID), null);
        const untrusted = await native.downloadAttachment(discordEvent("https://evil.example"), attachment());
        assert.match(untrusted.error ?? "", /untrusted/iu);
        assert.equal(fetchCalls, 2);

        const invalidId = await native.getImageNative(DISCORD_EVENT, "../secret");
        assert.equal(invalidId, null);

        await native.deleteFileNative(DISCORD_EVENT, ATTACHMENT_ID);
        assert.equal(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), null);

        const cacheDir = await native.getDefaultNativeImageDir();
        const stalePath = getImageCachePath(cacheDir, ATTACHMENT_ID, "png");
        await writeFile(stalePath, Buffer.from("truncated"));
        await native.init(DISCORD_EVENT);
        assert.equal(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), null,
            "reading malformed cached media must remove the contained stale file before recaching");
        fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls++;
            return pngResponse();
        };
        const replacedStaleCache = await native.downloadAttachment(DISCORD_EVENT, attachment());
        assert.equal(replacedStaleCache.error, null,
            "an invalid legacy cache entry must be removed so exclusive recaching can recover");
        assert.deepEqual(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), Buffer.from(PNG));
        assert.equal(fetchCalls, 1);
        await native.deleteFileNative(DISCORD_EVENT, ATTACHMENT_ID);

        for (const location of [
            "http://127.0.0.1:65535/secret",
            `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/300000000000000099/image.png`
        ]) {
            fetchCalls = 0;
            globalThis.fetch = async (_input, init) => {
                fetchCalls++;
                assert.equal(init?.redirect, "manual");
                assert.ok(init?.signal instanceof AbortSignal);
                return new Response(null, { status: 302, headers: { location } });
            };
            const redirected = await native.downloadAttachment(DISCORD_EVENT, attachment(VALID_CDN_URL, VALID_CDN_URL));
            assert.ok(redirected.error);
            assert.equal(fetchCalls, 1,
                "the real native handler must reject an unsafe redirect before a second privileged request");
            assert.equal(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), null);
        }

        fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls++;
            return new Response(null, { status: 503 });
        };
        const boundedFailure = await (native.downloadAttachment as any)(DISCORD_EVENT, attachment(), -Infinity, true);
        assert.ok(boundedFailure.error);
        assert.equal(fetchCalls, 2, "renderer-supplied retry state must not create an unbounded retry chain");

        fetchCalls = 0;
        const maliciousFallback = await native.downloadAttachment(DISCORD_EVENT,
            attachment(VALID_MEDIA_URL, "http://127.0.0.1:65535/secret"));
        assert.match(maliciousFallback.error ?? "", /Invalid Discord attachment URL/u);
        assert.equal(fetchCalls, 0, "all fallback candidates must validate before the first network request");

        fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls++;
            return fetchCalls === 1 ? new Response(null, { status: 404 }) : pngResponse();
        };
        const fallback = await native.downloadAttachment(DISCORD_EVENT, attachment());
        assert.equal(fallback.error, null, `a safe CDN fallback must preserve normal behavior: ${fallback.error}`);
        assert.equal(fetchCalls, 2);
        await native.deleteFileNative(DISCORD_EVENT, ATTACHMENT_ID);

        fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls++;
            return new Response(Buffer.from("<html>loopback secret</html>"), {
                headers: { "content-type": "text/html" }
            });
        };
        const misleading = await native.downloadAttachment(DISCORD_EVENT, attachment());
        assert.ok(misleading.error);
        assert.equal(fetchCalls, 2);
        assert.equal(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), null,
            "misleading active content must never enter the readable cache");

        const concurrentIds = Array.from({ length: 36 }, (_, index) =>
            (310_000_000_000_000_000n + BigInt(index)).toString());
        let activeFetches = 0;
        let maximumActiveFetches = 0;
        let releaseFetches!: () => void;
        let twoFetchesStarted!: () => void;
        const fetchGate = new Promise<void>(resolve => releaseFetches = resolve);
        const firstTwoStarted = new Promise<void>(resolve => twoFetchesStarted = resolve);
        fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls++;
            activeFetches++;
            maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
            if (fetchCalls === 2) twoFetchesStarted();
            await fetchGate;
            activeFetches--;
            return pngResponse();
        };
        const concurrentDownloads = concurrentIds.map(id => native.downloadAttachment(DISCORD_EVENT, attachmentForId(id)));
        let startWatchdog: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                firstTwoStarted,
                new Promise<never>((_resolve, reject) => {
                    startWatchdog = setTimeout(() => reject(new Error("Two native downloads did not start within 5 seconds")), 5_000);
                })
            ]);
        } catch (error) {
            releaseFetches();
            await Promise.allSettled(concurrentDownloads);
            throw error;
        } finally {
            clearTimeout(startWatchdog);
        }
        assert.equal(fetchCalls, 2, "only two privileged downloads may be active while the bounded queue is blocked");
        assert.equal(maximumActiveFetches, 2);
        releaseFetches();
        const concurrentResults = await Promise.all(concurrentDownloads);
        assert.equal(concurrentResults.filter(result => result.error === null).length, 34,
            "two active and thirty-two queued downloads must fit the production limiter");
        assert.equal(concurrentResults.filter(result => /too many/iu.test(result.error ?? "")).length, 2,
            "requests beyond the production queue must fail closed");
        assert.equal(fetchCalls, 34);
        assert.equal(maximumActiveFetches, 2);
        for (const id of concurrentIds) await native.deleteFileNative(DISCORD_EVENT, id);

        let loopbackRequests = 0;
        const server = createServer((_request, response) => {
            loopbackRequests++;
            response.writeHead(200, { "content-type": "image/png" });
            response.end(PNG);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        try {
            const address = server.address();
            assert.ok(address && typeof address === "object");
            globalThis.fetch = originalFetch;
            const loopbackUrl = `http://127.0.0.1:${address.port}/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/image.png`;
            const ssrf = await native.downloadAttachment(DISCORD_EVENT, attachment(loopbackUrl, loopbackUrl));
            assert.ok(ssrf.error);
            assert.equal(loopbackRequests, 0, "loopback SSRF must be rejected before the local server receives a request");
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }

        const imageCacheDir = await native.getDefaultNativeImageDir();
        await mkdir(imageCacheDir, { recursive: true });
        const oversizedPath = getImageCachePath(imageCacheDir, ATTACHMENT_ID, "png");
        const oversizedHandle = await open(oversizedPath, "wx");
        await oversizedHandle.truncate(HARNESS_MAX_ATTACHMENT_BYTES + 1);
        await oversizedHandle.close();
        await native.init(DISCORD_EVENT);
        assert.equal(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), null,
            "oversized legacy cache files must not be indexed or read into main-process memory");
        fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls++;
            return pngResponse();
        };
        const replacedOversizedCache = await native.downloadAttachment(DISCORD_EVENT, attachment());
        assert.equal(replacedOversizedCache.error, null,
            "an oversized stale file must be removed so exclusive recaching can recover");
        assert.equal(fetchCalls, 1);
        assert.deepEqual(await native.getImageNative(DISCORD_EVENT, ATTACHMENT_ID), Buffer.from(PNG));
        await native.deleteFileNative(DISCORD_EVENT, ATTACHMENT_ID);

        const zeroByteId = "397000000000000001";
        const zeroBytePath = getImageCachePath(imageCacheDir, zeroByteId, "png");
        await writeFile(zeroBytePath, Buffer.alloc(0));
        await native.init(DISCORD_EVENT);
        assert.equal(await native.getImageNative(DISCORD_EVENT, zeroByteId), null);
        const replacedZeroByteCache = await native.downloadAttachment(DISCORD_EVENT, attachmentForId(zeroByteId));
        assert.equal(replacedZeroByteCache.error, null,
            "a zero-byte stale file must be removed so exclusive recaching can recover");
        assert.deepEqual(await native.getImageNative(DISCORD_EVENT, zeroByteId), Buffer.from(PNG));
        await native.deleteFileNative(DISCORD_EVENT, zeroByteId);

        const quotaId = "399000000000000001";
        const quotaPath = getImageCachePath(imageCacheDir, quotaId, "png");
        const quotaHandle = await open(quotaPath, "wx");
        await quotaHandle.truncate(HARNESS_CACHE_BYTES);
        await quotaHandle.close();
        fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls++;
            return pngResponse();
        };
        const quotaFailure = await native.downloadAttachment(DISCORD_EVENT, attachment(VALID_CDN_URL, VALID_CDN_URL));
        assert.match(quotaFailure.error ?? "", /quota/iu,
            "the production handler must wire aggregate disk quota enforcement into cache writes");
        assert.equal(fetchCalls, 1);
        assert.equal(existsSync(getImageCachePath(imageCacheDir, ATTACHMENT_ID, "png")), false,
            "a native quota failure must not leave a partial attachment file");

        const racedId = "398000000000000001";
        const switchedCacheDir = path.join(root, "switched-cache");
        await mkdir(switchedCacheDir);
        let releaseRacedFetch!: () => void;
        let racedFetchStarted!: () => void;
        const racedFetchGate = new Promise<void>(resolve => releaseRacedFetch = resolve);
        const racedFetchStart = new Promise<void>(resolve => racedFetchStarted = resolve);
        globalThis.fetch = async () => {
            racedFetchStarted();
            await racedFetchGate;
            return pngResponse();
        };
        const racedDownload = native.downloadAttachment(DISCORD_EVENT, attachmentForId(racedId));
        await racedFetchStart;
        harnessGlobal.__messageLoggerNativeHarness.chosenDirectory = switchedCacheDir;
        assert.equal(await native.chooseDir(DISCORD_EVENT, "imageCacheDir"), switchedCacheDir);
        releaseRacedFetch();
        const racedResult = await racedDownload;
        assert.equal(racedResult.error, null);
        assert.equal(path.dirname(racedResult.path!), path.resolve(switchedCacheDir),
            "an in-flight download must commit only to the newly selected cache directory");
        assert.equal(existsSync(getImageCachePath(imageCacheDir, racedId, "png")), false,
            "a cache-directory switch must not let an in-flight download repopulate the old directory");
        assert.deepEqual(await native.getImageNative(DISCORD_EVENT, racedId), Buffer.from(PNG));
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function main() {
    await testFetcher();
    await testLimiter();
    const root = await mkdtemp(path.join(tmpdir(), "protonncord-message-downloads-"));
    try {
        await testNativeHandler(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }

    const nativeSource = readFileSync("src/equicordplugins/messageLoggerEnhanced/native/index.ts", "utf8");
    const cacheSource = readFileSync("src/equicordplugins/messageLoggerEnhanced/native/cacheFile.ts", "utf8");
    assert.doesNotMatch(nativeSource, /\.arrayBuffer\(\)/u,
        "the privileged native downloader must never buffer an unbounded response with arrayBuffer");
    assert.doesNotMatch(nativeSource, /downloadAttachment\([^)]*attempts|downloadAttachment\([^)]*useOldUrl/u,
        "renderer-controlled retry state must not reappear in the public native handler");
    assert.doesNotMatch(nativeSource, /export (?:const|class) (?:MAX_|ATTACHMENT_|Bounded)/u,
        "non-handler test utilities must not be exported from the auto-registered native entrypoint");
    assert.doesNotMatch(cacheSource, /\breadFile\b/u,
        "bounded cache reads must stat and stream from a file handle instead of allocating through readFile");
    assert.ok(cacheSource.indexOf("const initialStats = await lstat(imagePath)")
        < cacheSource.indexOf("const content = Buffer.allocUnsafe(openedStats.size)"),
    "cache size validation must remain before allocation");
    console.log("message logger native download boundary checks passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
