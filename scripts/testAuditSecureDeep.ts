import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { composeSecureForwardText, secureForwardEmbedText } from "../src/equicordplugins/secureMessaging.desktop/forwarding";

const folder = "../src/equicordplugins/secureMessaging.desktop/";
const source = (name: string) => readFileSync(new URL(folder + name, import.meta.url), "utf8");
function extracted(name: string, functionName: string, globals: Record<string, unknown>) {
    const parsed = createSourceFile(name, source(name), ScriptTarget.Latest, true);
    const declaration = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === functionName);
    assert.ok(declaration, functionName);
    const code = declaration.getText(parsed).replace(/^export\s+/u, "");
    return runInNewContext(transpileModule(code + ";" + functionName, {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
    }).outputText, globals);
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(complete => { resolve = complete; });
    return { promise, resolve };
}
function caches(native: Record<string, unknown>) {
    const modules = new Map<string, Record<string, any>>();
    let localUserId = "100000000000000001";
    function load(name: string): Record<string, any> {
        if (modules.has(name)) return modules.get(name)!;
        const exports = {};
        modules.set(name, exports);
        runInNewContext(transpileModule(source(name + ".ts"), {
            compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
        }).outputText, {
            exports, Date, Promise, Uint8Array, URL, Blob, AbortController, setTimeout, clearTimeout,
            VencordNative: { pluginHelpers: { SecureMessaging: native } },
            require(path: string) {
                if (path === "@utils/misc") return { sleep: async () => {} };
                if (path === "@api/MessageUpdater") return { updateMessage() {} };
                if (path === "@webpack/common") return { UserStore: { getCurrentUser: () => ({ id: localUserId }) }, Constants: {}, RestAPI: {} };
                if (path === "./attachments") return { isPreviewableAttachmentMimeType: () => false };
                if (path === "./layoutStability") return { preserveEncryptedMessageScroll: (callback: () => void) => callback() };
                if (path === "./protocol") return { isEncryptedMessage: () => true };
                assert.ok(path.startsWith("./"), path);
                return load(path.slice(2));
            },
        });
        return exports;
    }
    return { load, switchAccount() { localUserId = "100000000000000003"; } };
}
function message(index = 0) {
    return { id: String(200000000000000001n + BigInt(index)), channel_id: "300000000000000001", author: { id: "100000000000000002" },
        content: "PCEM3:offline-fixture", attachments: [], editedTimestamp: null, nonce: null };
}
const decrypted = () => ({ status: "decrypted", plaintext: "fixture", detachedTextIndex: null, attachmentBundle: null });

test("forwarded metadata and resolved labels cannot restore mention syntax", () => {
    const value = composeSecureForwardText({ authorLabel: "<@123456789012345678>", content: "<@223456789012345678>",
        mentionResolvers: { user: () => "<@323456789012345678>" }, embeds: [{ title: "<@&423456789012345678> @everyone", description: "<#523456789012345678>" }] });
    assert.doesNotMatch(value, /<@|<#|@everyone/u);
});

test("a changed message cannot publish cached plaintext under its previous key", async () => {
    const completion = deferred<ReturnType<typeof decrypted>>();
    const runtime = caches({ decryptIncoming: () => completion.promise });
    const cache = runtime.load("decryptCache");
    const fixture = message();
    const pending = cache.decryptCachedMessage("100000000000000001", fixture);
    await setImmediate();
    fixture.content = "PCEM3:changed";
    completion.resolve(decrypted());
    assert.equal((await pending).status, "failed");
    assert.equal(cache.getCachedDecryption("100000000000000001", fixture), null);
});

test("pending decryption admissions remain bounded while native work stalls", async () => {
    const completion = deferred<ReturnType<typeof decrypted>>();
    const runtime = caches({ decryptIncoming: () => completion.promise });
    const cache = runtime.load("decryptCache");
    const pending = Array.from({ length: 512 }, (_, index) => cache.decryptCachedMessage("100000000000000001", message(index)));
    assert.equal((await cache.decryptCachedMessage("100000000000000001", message(513))).status, "failed");
    cache.clearEncryptedMessageDecryptCache();
    completion.resolve(decrypted());
    await Promise.all(pending);
});

test("edited announcements cancel stale reviews and permit a fresh review", async () => {
    const completion = deferred<{ status: string }>();
    let calls = 0;
    const runtime = caches({ reviewAnnouncement: () => { calls++; return completion.promise; } });
    const cache = runtime.load("announcementReviewCache");
    const fixture = message();
    const pending = cache.reviewAnnouncementCached("100000000000000001", fixture);
    await setImmediate();
    fixture.content = "changed announcement";
    completion.resolve({ status: "review" });
    assert.equal((await pending).status, "failed");
    assert.equal((await cache.reviewAnnouncementCached("100000000000000001", fixture)).status, "review");
    assert.equal(calls, 2);
});

test("pending announcement admissions remain bounded", async () => {
    const completion = deferred<{ status: string }>();
    const runtime = caches({ reviewAnnouncement: () => completion.promise });
    const cache = runtime.load("announcementReviewCache");
    const pending = Array.from({ length: 256 }, (_, index) => cache.reviewAnnouncementCached("100000000000000001", message(index)));
    assert.equal((await cache.reviewAnnouncementCached("100000000000000001", message(257))).status, "failed");
    cache.clearAnnouncementReviewCache();
    completion.resolve({ status: "review" });
    await Promise.all(pending);
});

for (const invalidation of ["clear", "account", "edit"] as const) {
    test("attachment completion zeroes stale bytes after " + invalidation, async () => {
        const completion = deferred<any>();
        const runtime = caches({ decryptIncomingAttachments: () => completion.promise });
        const cache = runtime.load("attachmentCache");
        const fixture = message();
        const pending = cache.decryptIncomingAttachmentsCached("100000000000000001", fixture, "all");
        await setImmediate();
        if (invalidation === "clear") cache.clearEncryptedAttachmentCache();
        else if (invalidation === "account") runtime.switchAccount();
        else fixture.content = "PCEM3:changed";
        const bytes = new Uint8Array([1, 2, 3]);
        completion.resolve({ status: "decrypted", plaintext: "fixture", attachments: [{ data: bytes }] });
        assert.equal((await pending).status, "failed");
        assert.deepEqual([...bytes], [0, 0, 0]);
    });
}

function downloadHarness(status: string, changeEpoch = false) {
    const bytes = new Uint8Array([1, 2, 3]);
    let saves = 0;
    let rechecks = 0;
    const globals: Record<string, unknown> = {
        validateIpcCaller: () => null, validateLocalUserId: (value: string) => ({ ok: true, value }),
        validateDecryptAttachmentsInput: (value: unknown) => ({ ok: true, value }), isSnowflake: () => true,
        cachedAuthenticatedAttachment: () => ({ data: bytes, metadata: { name: "fixture.txt" }, downloadable: true }),
        securityKeySessionEpoch: 1, unavailableFailure: (reason: string) => ({ status: "unavailable", reason }),
        decryptIncoming: async () => { rechecks++; if (changeEpoch) globals.securityKeySessionEpoch = 2; return { status }; },
        saveAuthenticatedAttachment: async () => { saves++; return "fixture.txt"; },
    };
    const download = extracted("native.ts", "downloadIncomingAttachment", globals);
    return { bytes, download, saves: () => saves, rechecks: () => rechecks };
}
for (const status of ["untrusted_author", "replay_detected", "decrypted"]) {
    test("cached downloads recheck current envelope state: " + status, async () => {
        const harness = downloadHarness(status);
        const result = await harness.download({}, "100000000000000001", { attachments: [{ id: "200000000000000001" }], content: "fixture" }, "200000000000000001");
        assert.equal(result.status, status === "decrypted" ? "saved" : status);
        assert.equal(harness.saves(), status === "decrypted" ? 1 : 0);
        assert.equal(harness.rechecks(), 1);
        assert.deepEqual([...harness.bytes], [0, 0, 0]);
    });
}
test("cached downloads reject a lock during envelope revalidation", async () => {
    const harness = downloadHarness("decrypted", true);
    const result = await harness.download({}, "100000000000000001", { attachments: [{ id: "200000000000000001" }] }, "200000000000000001");
    assert.equal(result.status, "unavailable");
    assert.equal(harness.saves(), 0);
    assert.deepEqual([...harness.bytes], [0, 0, 0]);
});

test("disabling an existing conversation does not depend on renewed recipient trust", async () => {
    const conversation = { enabled: true, reviewRequired: "key_changed", selectedRecipients: [{ userId: "100000000000000002", fingerprint: "pinned" }], updatedAt: 0 };
    const context = { account: { conversations: { channel: conversation }, trustedPeers: {} }, vault: {} };
    let saves = 0;
    const configure = extracted("native.ts", "configureConversation", {
        Date, validateIpcCaller: () => null, validateLocalUserId: (value: string) => ({ ok: true, value }),
        validateConfigureInput: (value: unknown) => ({ ok: true, value }), runSerialized: (work: () => unknown) => work(),
        loadAccount: async () => context, saveVault: async () => { saves++; },
        conversationDetails: () => ({}), MAX_CONVERSATIONS: 512,
    });
    const result = await configure({}, "100000000000000001", { enabled: false, snapshot: { channelId: "channel" }, selectedRecipientIds: ["100000000000000002"] });
    assert.equal(result.status, "disabled");
    assert.equal(conversation.enabled, false);
    assert.equal(conversation.reviewRequired, null);
    assert.equal(conversation.selectedRecipients[0].fingerprint, "pinned");
    assert.equal(saves, 1);
});

test("attachment validation rejects duplicate IDs without changing size and URL checks", () => {
    const validate = extracted("native.ts", "validateDecryptAttachmentsInput", {
        isRecord: (value: unknown) => value !== null && typeof value === "object", hasExactKeys: () => true,
        validateDecryptInput: (value: unknown) => ({ ok: true, value }), isSnowflake: () => true,
        validateAttachmentUrl: () => true, MAX_ATTACHMENT_COUNT: 10, MAX_ATTACHMENT_CIPHERTEXT_BYTES: 100,
        MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES: 1000,
    });
    const attachment = { id: "200000000000000001", url: "fixture", proxyUrl: "fixture", size: 21 };
    assert.equal(validate({ attachments: [attachment, attachment] }).ok, false);
    assert.equal(validate({ attachments: [attachment, { ...attachment, id: "200000000000000002" }] }).ok, true);
});

test("stalled uploads expire, cancel the host upload and release listeners", async () => {
    let expire!: () => void;
    let cleared = 0;
    let cancellations = 0;
    const upload = Object.assign(new EventEmitter(), { status: "UPLOADING", upload: async () => {}, cancel: () => { cancellations++; } });
    const start = extracted("attachmentUploads.ts", "uploadEncryptedAttachment", {
        Promise, Error, setTimeout: (callback: () => void, duration: number) => { assert.equal(duration, 3600000); expire = callback; return 1; },
        clearTimeout: () => { cleared++; },
    });
    const pending = start(upload);
    await setImmediate();
    expire();
    await assert.rejects(pending, /timed out/u);
    assert.equal(cancellations, 1);
    assert.equal(cleared, 1);
    assert.equal(upload.listenerCount("complete"), 0);
    assert.equal(upload.listenerCount("error"), 0);
});

test("oversized uploads are rejected before metadata decoding", async () => {
    let probes = 0;
    const prepare = extracted("attachmentUploads.ts", "prepareEncryptedAttachments", {
        MAX_ATTACHMENT_COUNT: 10, MAX_ATTACHMENT_CIPHERTEXT_BYTES: 1000, MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES: 1000,
        assertUpload() {}, sourceForUpload: () => ({ file: { size: 90 }, filename: "fixture.png" }),
        metadataForUpload: () => { probes++; throw new Error("must not decode"); },
        EncryptedAttachmentUploadLimitError: Error,
    });
    await assert.rejects(prepare([{}], "", "channel", "user", [], null, 100));
    assert.equal(probes, 0);
});

test("security-key ceremony deadline also covers stalled page loading", async () => {
    const timeout = deferred<void>();
    let windowDestroyed = false;
    let storageCleared = false;
    let serverCloses = 0;
    class CeremonyError extends Error { constructor(public code: string) { super(code); } }
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, isDestroyed: () => false, getURL: () => "fixture" });
    class Window extends EventEmitter {
        static fromWebContents() { return null; }
        webContents = contents;
        loadURL() { return new Promise(() => {}); }
        isDestroyed() { return windowDestroyed; }
        destroy() { windowDestroyed = true; }
    }
    const isolated = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
        clearStorageData: async () => { storageCleared = true; } });
    const ceremony = extracted("securityKeyVault.ts", "runCeremony", {
        startCeremonyServer: async () => ({ server: {}, url: "fixture" }), BrowserWindow: Window,
        session: { fromPartition: () => isolated }, randomUUID: () => "offline", AbortController,
        delay: () => timeout.promise, CEREMONY_TIMEOUT_MS: 100, SecurityKeyVaultError: CeremonyError,
        closeServer: async () => { serverCloses++; },
    });
    const pending = ceremony({ sender: {} }, "Offline fixture", "fixture");
    await setImmediate();
    timeout.resolve();
    await assert.rejects(pending, /cancelled/u);
    assert.equal(windowDestroyed, true);
    assert.equal(storageCleared, true);
    assert.equal(serverCloses, 1);
});

for (const stage of ["parent", "partition", "window", "request", "check", "device", "navigation", "cleanup"]) {
    test(`ceremony setup failures release acquired resources: ${stage}`, async () => {
        let serverCloses = 0;
        let destroyed = false;
        let storageCleared = false;
        const cleared = new Set<string>();
        const fail = (point: string) => { if (stage === point) throw new Error("setup fixture"); };
        const isolated = Object.assign(new EventEmitter(), {
            setPermissionRequestHandler(value: unknown) {
                if (value !== null) fail("request");
                else { cleared.add("request"); if (stage === "cleanup") throw new Error("cleanup fixture"); }
            },
            setPermissionCheckHandler(value: unknown) {
                if (value !== null) { fail("check"); if (stage === "cleanup") throw new Error("setup fixture"); }
                else cleared.add("check");
            },
            setDevicePermissionHandler(value: unknown) { if (value !== null) fail("device"); else cleared.add("device"); },
            clearStorageData: async () => { storageCleared = true; },
        });
        const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler() { fail("navigation"); } });
        class Window extends EventEmitter {
            static fromWebContents() { fail("parent"); return null; }
            constructor() { super(); fail("window"); }
            webContents = contents;
            isDestroyed() { return destroyed; }
            destroy() { destroyed = true; }
        }
        class CeremonyError extends Error { constructor(public code: string) { super(code); } }
        const ceremony = extracted("securityKeyVault.ts", "runCeremony", {
            startCeremonyServer: async () => ({ server: {}, url: "fixture" }), BrowserWindow: Window,
            session: { fromPartition: () => { fail("partition"); return isolated; } }, randomUUID: () => "offline", AbortController,
            SecurityKeyVaultError: CeremonyError, closeServer: async () => { serverCloses++; },
        });
        await assert.rejects(ceremony({ sender: {} }, "Offline fixture", "fixture", true), /unsupported/u);
        assert.equal(serverCloses, 1);
        const acquiredSession = !["parent", "partition"].includes(stage);
        assert.equal(storageCleared, acquiredSession);
        assert.equal(destroyed, acquiredSession && stage !== "window");
        if (acquiredSession) assert.deepEqual([...cleared].sort(), ["check", "device", "request"]);
        assert.equal(isolated.listenerCount("select-usb-device"), 0);
    });
}

test("failed screenshot transitions remain fail closed and owners are only retained while pending", () => {
    const renderer = source("index.tsx");
    assert.match(renderer, /setScreenCaptureProtectionStatus\(applied \? enabled \? "screenshot" : "ready" : "failed"\)/u);
    assert.equal(renderer.match(/if \(screenCaptureProtectionStatus === "pending"\) pendingEncryptedRenderOwners.add\(owner\)/gu)?.length, 3);
});

test("encrypted forwarding excludes unauthenticated host embeds", () => {
    const runtime = readFileSync(new URL("../src/equicordplugins/secureMessagingForwarding.desktop/index.ts", import.meta.url), "utf8");
    assert.match(runtime, /encryptedSource \? \[\] : message.embeds/u);
    assert.match(runtime, /if \(encryptedSource && rawEmbedSelection && rawEmbedSelection.length > 0\)/u);
});

for (const status of ["untrusted_author", "replay_detected", "decrypted"]) {
    test("attachment transfers revalidate before publishing or caching: " + status, async () => {
        let checks = 0;
        let cached = 0;
        const bytes = new Uint8Array([1, 2, 3]);
        const ciphertext = new Uint8Array([4, 5]);
        const masterKey = new Uint8Array([6, 7]);
        const accepted = { status: "decrypted", plaintext: "fixture", detachedTextIndex: null,
            attachmentBundle: { id: "bundle", key: "key", count: 1, root: "root" } };
        const decrypt = extracted("native.ts", "decryptIncomingAttachments", {
            Date, securityKeySessionEpoch: 1, validateIpcCaller: () => null,
            validateLocalUserId: (value: string) => ({ ok: true, value }),
            validateDecryptAttachmentsInput: (value: unknown) => ({ ok: true, value }),
            decryptIncoming: async () => ++checks === 1 ? accepted : { ...accepted, status },
            decodeBase64Url: () => masterKey, ATTACHMENT_DOWNLOAD_TIMEOUT_MS: 1000,
            downloadEncryptedAttachment: async () => ({ ciphertext, hadDownloadFailure: false }),
            decryptAttachmentBytes: async () => ({ data: bytes, metadata: { name: "fixture.txt", size: 3 } }),
            attachmentBundleRoot: async () => "root",
            cacheAuthenticatedAttachment: () => { cached++; },
            resolveDetachedMessageText: (_value: unknown, attachments: unknown) => ({ plaintext: "fixture", attachments }),
        });
        const result = await decrypt({}, "100000000000000001", { attachments: [{ id: "200000000000000001" }], channelId: "channel" });
        assert.equal(result.status, status);
        assert.equal(checks, 2);
        assert.equal(cached, status === "decrypted" ? 1 : 0);
        assert.deepEqual([...masterKey], [0, 0]);
        if (status !== "decrypted") {
            assert.deepEqual([...bytes], [0, 0, 0]);
            assert.deepEqual([...ciphertext], [0, 0]);
        }
    });
}

test("future-window document loads reconcile after queued screenshot operations", async () => {
    const app = new EventEmitter();
    const contents = new EventEmitter();
    const pendingTransition = deferred<void>();
    const hidden: boolean[] = [];
    const globals = { newWindowHookInstalled: false, app, screenCaptureProtectionEnabled: true,
        screenCaptureProtectionTransitioning: false,
        screenCaptureProtectionHealthy: true, screenCaptureProtectionOperation: pendingTransition.promise,
        setEncryptedContentHidden: async (_windows: unknown, value: boolean) => { hidden.push(value); },
        markProtectionUnhealthyAfterWindowFailure: () => assert.fail("unexpected window failure") };
    const install = extracted("native.ts", "installNewWindowProtectionHook", globals);
    install();
    install();
    assert.equal(app.listenerCount("browser-window-created"), 1);
    app.emit("browser-window-created", {}, { webContents: contents, setContentProtection: (value: boolean) => assert.equal(value, false) });
    assert.deepEqual(hidden, [false]);
    contents.emit("did-finish-load");
    await setImmediate();
    assert.deepEqual(hidden, [false]);
    globals.screenCaptureProtectionEnabled = false;
    pendingTransition.resolve();
    await globals.screenCaptureProtectionOperation;
    assert.deepEqual(hidden, [false, true]);
});

test("media teardown exceptions do not leak URLs or leave metadata unresolved", async () => {
    const media = new EventTarget() as EventTarget & { duration: number; load(): void; removeAttribute(): void; };
    let loads = 0;
    let revoked = 0;
    Object.assign(media, { duration: 12, load() { if (++loads > 1) throw new Error("disposed"); }, removeAttribute() {} });
    const metadata = extracted("attachmentUploads.ts", "mediaMetadata", {
        imageDimensions: async () => null, document: { createElement: () => media },
        URL: { createObjectURL: () => "blob:fixture", revokeObjectURL: () => { revoked++; } },
        setTimeout, clearTimeout, MEDIA_METADATA_TIMEOUT_MS: 5000, validMediaDuration: (value: number) => value,
    });
    const pending = metadata({}, "audio/ogg");
    await setImmediate();
    media.dispatchEvent(new Event("loadedmetadata"));
    assert.equal((await pending).duration, 12);
    assert.equal(revoked, 1);
});

test("windows created during screenshot transitions hide before final reconciliation", async () => {
    const app = new EventEmitter();
    const transition = deferred<void>();
    const hidden: boolean[] = [];
    const globals = { newWindowHookInstalled: false, app, screenCaptureProtectionEnabled: true,
        screenCaptureProtectionHealthy: true, screenCaptureProtectionTransitioning: true,
        screenCaptureProtectionOperation: transition.promise,
        setEncryptedContentHidden: async (_windows: unknown, value: boolean) => { hidden.push(value); },
        markProtectionUnhealthyAfterWindowFailure: () => assert.fail("unexpected window failure") };
    extracted("native.ts", "installNewWindowProtectionHook", globals)();
    app.emit("browser-window-created", {}, { webContents: new EventEmitter(), setContentProtection() {} });
    assert.deepEqual(hidden, [true]);
    globals.screenCaptureProtectionEnabled = false;
    globals.screenCaptureProtectionTransitioning = false;
    transition.resolve();
    await globals.screenCaptureProtectionOperation;
    assert.deepEqual(hidden, [true, true]);
});

test("ceremony server shutdown closes lingering connections", async () => {
    let complete!: () => void;
    const close = extracted("securityKeyVault.ts", "closeServer", {});
    let connectionsClosed = false;
    await close({ close(callback: () => void) { complete = callback; }, closeAllConnections() { connectionsClosed = true; complete(); } });
    assert.equal(connectionsClosed, true);
});

test("attachment singleflight admissions stay bounded while pending", async () => {
    const completion = deferred<any>();
    const runtime = caches({ decryptIncomingAttachments: () => completion.promise });
    const cache = runtime.load("attachmentCache");
    const pending = Array.from({ length: 128 }, (_, index) => cache.decryptIncomingAttachmentsCached("100000000000000001", message(index), "all"));
    assert.equal((await cache.decryptIncomingAttachmentsCached("100000000000000001", message(129), "all")).status, "failed");
    cache.clearEncryptedAttachmentCache();
    completion.resolve({ status: "decrypted", plaintext: "fixture", attachments: [] });
    await Promise.all(pending);
});

test("preview cache saturation does not schedule more decryption", () => {
    const cache = new Map(Array.from({ length: 256 }, (_, index) => [String(index), { status: "loading" }]));
    let loads = 0;
    const ensure = extracted("embedCache.ts", "ensureEntry", { cache, isEncryptedMessage: () => true,
        cacheKey: () => "new", pruneCache() {}, MAX_CACHE_ENTRIES: 256, Date, loadEntry: () => { loads++; } });
    const entry = ensure(message());
    assert.equal(entry.status, "ready");
    assert.equal(entry.embeds.length, 0);
    assert.equal(cache.size, 256);
    assert.equal(loads, 0);
});

test("empty and proxy-only embed selections cannot count as forwarded content", () => {
    const code = readFileSync(new URL("../src/equicordplugins/secureMessagingForwarding.desktop/index.ts", import.meta.url), "utf8");
    const parsed = createSourceFile("forwarding.ts", code, ScriptTarget.Latest, true);
    const declaration = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === "selectedEmbedCount");
    assert.ok(declaration);
    const count = runInNewContext(transpileModule(declaration.getText(parsed) + "; selectedEmbedCount", {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
    }).outputText, { secureForwardEmbedText });
    assert.equal(count([{}], [0]), 0);
    assert.equal(count([{ image: { proxyURL: "fixture" } }], [0]), 0);
    assert.equal(count([{ title: "Usable text" }], [0]), 1);
});

function secureForwardFixture() {
    const code = readFileSync(new URL("../src/equicordplugins/secureMessagingForwarding.desktop/index.ts", import.meta.url), "utf8");
    const parsed = createSourceFile("forwarding.ts", code, ScriptTarget.Latest, true);
    const declarations = ["selectedEmbedCount", "secureForward"].map(name => {
        const declaration = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === name);
        assert.ok(declaration, name);
        return declaration.getText(parsed);
    });
    const sends: unknown[][] = [];
    let decryptions = 0;
    const forward = runInNewContext(transpileModule(declarations.join("\n") + "; secureForward", {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
    }).outputText, {
        generation: 1, UserStore: { getCurrentUser: () => ({ id: "100000000000000001" }) },
        assertForwardStillActive() {}, normalizeAttachmentSelection: (value: string[] | undefined) => value === undefined ? undefined : new Set(value),
        normalizeEmbedSelection: (value: number[] | undefined) => value, isEncryptedMessage: (value: string) => value === "encrypted-fixture",
        secureForwardEmbedText, composeSecureForwardText,
        prepareEncryptedSource: async () => { decryptions++; return { plaintext: "Authenticated https://example.invalid/verified", uploads: [], stickerIds: [] }; },
        preparePlainSource: async () => ({ plaintext: "", uploads: [], stickerIds: [] }),
        inspectProtection: async () => ({ protected: true, ready: true }), authorLabel: () => "Fixture", mentionResolvers: () => ({}),
        timestampMs: () => undefined, cloudUpload: () => { throw new Error("Unexpected upload"); },
        sendMessage: async (...args: unknown[]) => { sends.push(args); },
    });
    return { forward, sends, decryptions: () => decryptions };
}

test("encrypted forwards use authenticated text rather than host embeds", async () => {
    const fixture = secureForwardFixture();
    await fixture.forward({ content: "encrypted-fixture", embeds: [{ title: "Unauthenticated host text" }] }, "destination");
    assert.equal(fixture.sends.length, 1);
    const payload = fixture.sends[0][1] as { content: string; };
    assert.match(payload.content, /Authenticated https:\/\/example\.invalid\/verified/u);
    assert.doesNotMatch(payload.content, /Unauthenticated host text/u);
});

test("selected encrypted host embeds fail closed before decryption or send", async () => {
    const fixture = secureForwardFixture();
    await assert.rejects(fixture.forward({ content: "encrypted-fixture", embeds: [{ title: "Host text" }] }, "destination", { onlyEmbedIndices: [0] }), /Forward the whole encrypted message/u);
    assert.equal(fixture.decryptions(), 0);
    assert.equal(fixture.sends.length, 0);
});

test("proxy-only selected embeds cannot produce a header-only forward", async () => {
    const fixture = secureForwardFixture();
    await assert.rejects(fixture.forward({ content: "ordinary", embeds: [{ image: { proxyURL: "fixture" } }] }, "destination", { onlyEmbedIndices: [0] }), /selected forwarded content is no longer available/u);
    assert.equal(fixture.sends.length, 0);
});
