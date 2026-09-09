/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nodePath from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as protocol from "../src/equicordplugins/secureMessaging.desktop/protocol";

function load(file: string, helpers = "", mocks: Record<string, any> = {}, globals: Record<string, any> = {}) {
    const source = readFileSync(`src/equicordplugins/secureMessaging.desktop/${file}`, "utf8") + helpers;
    const output = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: false } }).outputText;
    const exports: any = {};
    runInNewContext(output, {
        exports, Buffer, process: { platform: "win32", env: {} }, AbortController, AbortSignal, URL,
        TextEncoder, TextDecoder, Uint8Array, structuredClone, setTimeout, clearTimeout,
        require: (id: string) => mocks[id] ?? ({
            crypto: nodeCrypto, "node:crypto": nodeCrypto, path: nodePath, "node:path": nodePath,
            "./protocol": protocol, "@main/utils/constants": { DATA_DIR: "C:/fixture/secure-state" }
        } as Record<string, any>)[id] ?? {},
        ...globals
    });
    return exports;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const event = { senderFrame: { url: "https://discord.com/channels/@me" } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function nativeFixture(extra: Record<string, any> = {}, globals: Record<string, any> = {}) {
    class SecurityKeyVaultError extends Error { constructor(public code: string) { super(code); } }
    return load("native.ts", `
        export const runTestOperation = runSerialized;
        export const attachmentCacheSize = () => authenticatedAttachmentCache.size;
        export function useFixtureDecryption(value) { decryptIncoming = async () => value; }
    `, {
        "electron": { safeStorage: { isEncryptionAvailable: () => true } },
        "fs/promises": {
            stat: async () => { const error = new Error("missing") as any; error.code = "ENOENT"; throw error; },
            mkdir: async () => {}, chmod: async () => {}, readdir: async () => []
        },
        net: { createServer: () => ({ unref() {}, once() {}, removeListener() {}, on() {}, listen(_options: any, callback: any) { callback(); }, close(callback: any) { callback(); } }) },
        "./securityKeyVault": { SecurityKeyVaultError, clearSecurityKeyVaultSession() {}, parseSecurityKeyVaultEnvelope: () => null },
        ...extra
    }, globals);
}

test("SecureMessaging discards a native operation completed after session lock", async () => {
    const native = nativeFixture();
    const started = deferred<void>();
    const complete = deferred<void>();
    const pending = native.runTestOperation(async () => { started.resolve(); await complete.promise; return { status: "fixture_complete" }; });
    await started.promise;
    const locking = native.lockSecurityKeyVault(event);
    complete.resolve();
    const result = await pending;
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "security_key_locked");
    assert.equal((await locking).status, "not_configured");
});

test("SecureMessaging clears late attachment results without repopulating its cache", async () => {
    const waiting = deferred<Response>();
    const started = deferred<void>();
    const ciphertext = new Uint8Array(32).fill(3);
    const plaintext = new Uint8Array([1, 2, 3]);
    const digest = nodeCrypto.createHash("sha256").update(ciphertext).digest("base64url");
    const channelId = "200000000000000001";
    const attachmentId = "300000000000000001";
    const native = nativeFixture({
        "./attachments": {
            MAX_ATTACHMENT_COUNT: 10, MAX_ATTACHMENT_CIPHERTEXT_BYTES: 1024, MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES: 1024,
            attachmentBundleRootFromDigests: async () => "root",
            isPreviewableAttachmentMimeType: () => true,
            decryptAttachmentBytes: async () => ({ data: plaintext, metadata: { name: "fixture.png", size: 3, spoiler: false, mimeType: "image/png" } })
        }
    }, { fetch: () => { started.resolve(); return waiting.promise; } });
    native.useFixtureDecryption({ status: "decrypted", plaintext: "fixture", detachedTextIndex: null, attachmentBundle: {
        id: "fixture", count: 1, key: Buffer.alloc(32, 1).toString("base64url"), root: "root",
        manifest: [{ digest, preview: true, spoiler: false, size: 3, name: "fixture.png" }]
    } });
    const url = `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/fixture.pcaf`;
    const pending = native.decryptIncomingAttachments(event, "100000000000000001", {
        channelId, content: "fixture", discordAuthorId: "100000000000000002", discordEditedTimestamp: null,
        discordMessageId: "400000000000000001", discordNonce: null,
        attachments: [{ id: attachmentId, size: 32, url, proxyUrl: url }]
    }, "previews");
    await started.promise;
    await native.lockSecurityKeyVault(event);
    waiting.resolve(new Response(ciphertext));
    const result = await pending;
    assert.equal(result.status, "unavailable");
    assert.equal(native.attachmentCacheSize(), 0);
    assert.deepEqual([...plaintext], [0, 0, 0]);
});

test("OneKey Windows helper removes its script and empty temporary directory", async () => {
    const removed: string[] = [];
    const temporaryDirectory = "C:/fixture/onekey";
    const fixture = load("oneKeyWindowsVault.ts", "", {
        "node:os": { tmpdir: () => "C:/fixture" },
        "node:fs/promises": {
            mkdtemp: async () => temporaryDirectory, writeFile: async () => {},
            unlink: async (file: string) => { removed.push(file); }, rmdir: async (directory: string) => { removed.push(directory); }
        },
        "node:child_process": { execFile: (_file: string, _args: string[], _options: any, callback: any) => {
            queueMicrotask(() => callback(null, Buffer.from([1]), Buffer.alloc(0)));
            return { stdin: { on() {}, end() {} } };
        } }
    });
    const result = await fixture.runOneKeyWindowsVaultCipher(Buffer.alloc(32, 1).toString("base64url"));
    assert.equal(result.ok, false);
    assert.equal(result.error, "unavailable");
    assert.deepEqual(removed, [join(temporaryDirectory, "onekey-winusb.ps1"), temporaryDirectory]);
});

test("Security-key ceremony cancels its deadline timer after completing", async () => {
    let deadlineSignal: AbortSignal | undefined;
    let pageUrl = "";
    class BrowserWindow {
        static fromWebContents() { return null; }
        webContents = { isDestroyed: () => false, getURL: () => pageUrl, setWindowOpenHandler() {}, on() {}, executeJavaScript: async () => ({ completed: true }) };
        loadURL = async (url: string) => { pageUrl = url; };
        isDestroyed() { return false; } show() {} once() {} destroy() {}
    }
    const fixture = load("securityKeyVault.ts", "\nexport { runCeremony };", {
        "node:http": { createServer: () => ({ once() {}, listen(_port: number, _host: string, callback: any) { callback(); }, address: () => ({ port: 1234 }), close(callback: any) { callback(); } }) },
        "node:timers/promises": { setTimeout: (_ms: number, _value: any, options: any) => { deadlineSignal = options.signal; return new Promise(() => {}); } },
        electron: { BrowserWindow, session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, off() {}, clearStorageData: async () => {} }) } }
    });
    const result = await fixture.runCeremony(event, "Fixture", "fixture");
    assert.equal(result.completed, true);
    assert.equal(deadlineSignal?.aborted, true);
    await tick();
});

function rendererFunctions(names: string[], globals: Record<string, any>) {
    const source = readFileSync("src/equicordplugins/secureMessaging.desktop/index.tsx", "utf8");
    const parsed = createSourceFile("index.tsx", source, ScriptTarget.ES2022, true);
    const declarations = parsed.statements.filter(statement => isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ""));
    assert.equal(declarations.length, names.length);
    const code = declarations.map(declaration => declaration.getText(parsed)).join("\n") + `\nexports.fixture = { ${names.join(",")} };`;
    const exports: any = {};
    runInNewContext(transpileModule(code, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, { exports, ...globals });
    return exports.fixture;
}

test("SecureMessaging visibility subscriber catches changes between render and effect", () => {
    let effect!: () => () => void;
    const states: string[] = [];
    const listeners = new Set();
    const fixture = rendererFunctions(["useScreenCaptureProtectionStatus"], {
        useState: () => ["pending", (status: string) => states.push(status)],
        useEffect: (callback: typeof effect) => { effect = callback; },
        screenCaptureProtectionStatus: "ready", screenCaptureProtectionListeners: listeners
    });
    assert.equal(fixture.useScreenCaptureProtectionStatus(), "pending");
    const cleanup = effect();
    assert.deepEqual(states, ["ready"]);
    assert.equal(listeners.size, 1);
    cleanup();
    assert.equal(listeners.size, 0);
});

test("SecureMessaging obsolete announcement review keeps its replacement pending", async () => {
    const pending = deferred<any>();
    const reviews = new Set();
    let generation = 1;
    let finishes = 0;
    const globals: any = {
        UserStore: { getCurrentUser: () => ({ id: "local" }) }, ChannelStore: { getChannel: () => null },
        isKeyAnnouncement: () => true, announcementReviewCacheKey: () => "attempt",
        backgroundAnnouncementReviews: reviews, announcementReviewOrder: () => 0,
        keyReviewGate: { begin() {}, finish() { finishes++; } },
        reviewAnnouncementCached: () => { generation++; return pending.promise; }
    };
    Object.defineProperty(globals, "announcementReviewGeneration", { enumerable: true, get: () => generation });
    // Preserve the live generation getter in the VM context.
    const source = readFileSync("src/equicordplugins/secureMessaging.desktop/index.tsx", "utf8");
    const parsed = createSourceFile("index.tsx", source, ScriptTarget.ES2022, true);
    const declaration = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === "reviewKeyAnnouncementInBackground")!;
    runInNewContext(transpileModule(declaration.getText(parsed) + "\nreviewKeyAnnouncementInBackground({author:{id:'peer'},content:'fixture',channel_id:'channel'});", {
        compilerOptions: { target: ScriptTarget.ES2022 }
    }).outputText, globals);
    pending.resolve({ status: "fixture" });
    await tick();
    assert.equal(reviews.has("attempt"), true);
    assert.equal(finishes, 0);
});

test("SecureMessaging key announcement rejects a stale account before native work", async () => {
    let operations = 0;
    const fixture = rendererFunctions(["sendKeyAnnouncement"], {
        UserStore: { getCurrentUser: () => ({ id: "new-account" }) },
        Native: { createAnnouncement: async () => { operations++; } }
    });
    await fixture.sendKeyAnnouncement("channel", "old-account");
    assert.equal(operations, 0);
});
