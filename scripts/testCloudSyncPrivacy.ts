/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build, type Plugin } from "esbuild";
import { deflateSync, inflateSync } from "fflate";

import {
    buildCloudDocument,
    type CloudPluginRegistry,
    parseCloudBackendUrl,
    sanitizeCloudSettings,
} from "../src/api/SettingsSync/cloudPolicy";

type CloudSetupModule = typeof import("../src/api/SettingsSync/cloudSetup");
type CloudSyncModule = typeof import("../src/api/SettingsSync/cloudSync");

interface RequestRecord {
    body: BodyInit | null | undefined;
    headers: Headers;
    method: string;
    signal: AbortSignal | null | undefined;
    url: string;
}

interface Runtime {
    afterUpdate?: (key: string, value: unknown) => Promise<void>;
    bodyCancellations: number;
    dataStore: Map<string, unknown>;
    dataStoreEntriesCalls: number;
    dataStoreSetManyCalls: number;
    dataStoreUpdates: string[];
    fetchHandler(request: RequestRecord): Promise<Response>;
    importedDocuments: Array<Record<string, unknown>>;
    localStorage: Record<string, string>;
    logs: unknown[][];
    modal?: { props?: Record<string, any>; type?: unknown; };
    notifications: Array<Record<string, unknown>>;
    plugins: CloudPluginRegistry;
    quickCss: string;
    quickCssWrites: number;
    requests: RequestRecord[];
    settings: Record<string, any>;
    settingsWrites: number;
    userId: string;
    v2Manifest: Array<{ checksum: string; key: string; version: number; }>;
}

interface HarnessGlobal {
    __cloudPrivacyHarness: Runtime;
}

const harnessGlobal = globalThis as typeof globalThis & HarnessGlobal;
const ORIGIN_A = "https://cloud-a.example.test";
const ORIGIN_B = "https://cloud-b.example.test";
const USER_A = "111111111111111111";
const USER_B = "222222222222222222";
const AUTH_SECRET = "test-only-cloud-auth";
const SECRET_SENTINEL = "PRIVATE_SENTINEL_MUST_NEVER_REACH_CLOUD";
const QUICK_CSS = ".privacy-regression { color: rebeccapurple; }";
const API_VERSION_STORE_KEY = "Vencord_cloudApiVersions";
const MANIFEST_STORE_KEY = "Vencord_cloudManifest";
const SECRET_STORE_KEY = "Vencord_cloudSecret";
const V1_VERSION_STORE_KEY = "Vencord_cloudV1Versions";

const pluginDefinitions = {
    FileUpload: { settings: { def: { s3SecretAccessKey: {} } } },
    InvisibleChat: { settings: { def: { savedPasswords: {} } } },
    RichPresence: { settings: { def: { jf_apiKey: {} } } },
    SafePlugin: {
        settings: {
            def: {
                localCredential: { cloudSync: false },
                freeSlider: { cloudSync: true, markers: [0, 100], stickToMarkers: false, type: 5 },
                rejectedBoolean: { cloudSync: true, isValid: () => false, type: 3 },
                safeBoolean: { cloudSync: true, type: 3 },
                safeChoice: {
                    cloudSync: true,
                    isValid: value => value === "safe-local-choice" || value === "safe-remote-choice",
                    options: [{ value: "safe-local-choice" }, { value: "safe-remote-choice" }],
                    type: 4,
                },
                safeNumber: { cloudSync: true, isValid: value => typeof value === "number" && value >= 0, type: 1 },
                safeSlider: { cloudSync: true, markers: [0, 50, 100], type: 5 },
                structuredCredential: { cloudSync: true },
            },
        },
    },
    Translate: { settings: { def: { deeplApiKey: {} } } },
    TriviaAI: { settings: { def: { apiKey: {} } } },
} satisfies CloudPluginRegistry;

function cloudScope(origin = ORIGIN_A, userId = USER_A): string {
    return `${origin}:${userId}`;
}

function settingsFixture(origin = ORIGIN_A): Record<string, any> {
    return {
        autoUpdate: false,
        cloud: {
            authenticated: true,
            settingsSync: true,
            settingsSyncVersion: 987,
            url: origin,
        },
        dataStore: { futureEntry: SECRET_SENTINEL },
        enableOnlineThemes: true,
        futureTopLevelSecret: SECRET_SENTINEL,
        macosVibrancyStyle: "sidebar",
        notifications: { futureNestedCredential: SECRET_SENTINEL },
        plugins: {
            FileUpload: { enabled: true, s3SecretAccessKey: SECRET_SENTINEL },
            InvisibleChat: { enabled: true, savedPasswords: [SECRET_SENTINEL] },
            RichPresence: { enabled: true, jf_apiKey: SECRET_SENTINEL },
            SafePlugin: {
                enabled: true,
                futureUnknownField: SECRET_SENTINEL,
                isFavorite: true,
                localCredential: SECRET_SENTINEL,
                freeSlider: 51,
                rejectedBoolean: true,
                safeBoolean: true,
                safeChoice: "safe-local-choice",
                safeNumber: 7,
                safeSlider: 50,
                structuredCredential: { token: SECRET_SENTINEL },
            },
            Translate: { deeplApiKey: SECRET_SENTINEL, enabled: true },
            TriviaAI: { apiKey: SECRET_SENTINEL, enabled: true },
            UnknownFuturePlugin: { enabled: true, tokenAddedLater: SECRET_SENTINEL },
        },
        unknownNestedSettings: { password: SECRET_SENTINEL },
        useQuickCss: true,
        windowsMaterial: "mica",
    };
}

function makeRuntime(origin = ORIGIN_A, userId = USER_A): Runtime {
    const runtime: Runtime = {
        bodyCancellations: 0,
        dataStore: new Map(),
        dataStoreEntriesCalls: 0,
        dataStoreSetManyCalls: 0,
        dataStoreUpdates: [],
        async fetchHandler() {
            throw new Error("No hermetic cloud response was configured");
        },
        importedDocuments: [],
        localStorage: {},
        logs: [],
        notifications: [],
        plugins: pluginDefinitions,
        quickCss: QUICK_CSS,
        quickCssWrites: 0,
        requests: [],
        settings: settingsFixture(origin),
        settingsWrites: 0,
        userId,
        v2Manifest: [],
    };
    runtime.dataStore.set(SECRET_STORE_KEY, {
        [cloudScope(origin, userId)]: AUTH_SECRET,
    });
    runtime.dataStore.set("Unrelated_private_DataStore_record", {
        password: SECRET_SENTINEL,
        token: SECRET_SENTINEL,
    });
    return runtime;
}

function useRuntime(runtime: Runtime): void {
    harnessGlobal.__cloudPrivacyHarness = runtime;
}

function currentRuntime(): Runtime {
    return harnessGlobal.__cloudPrivacyHarness;
}

function installGlobals(): void {
    (globalThis as any).React = {
        createElement(type: unknown, props: unknown) {
            return { props, type };
        },
    };
    (globalThis as any).window = globalThis;
    (globalThis as any).location ??= { reload() {} };
    (globalThis as any).VencordNative = {
        quickCss: {
            async get() { return currentRuntime().quickCss; },
            async set(value: string) {
                currentRuntime().quickCss = value;
                currentRuntime().quickCssWrites++;
            },
        },
        settings: {
            get() { return currentRuntime().settings; },
            async set() { currentRuntime().settingsWrites++; },
        },
    };
}

const runtimeStubs: Plugin = {
    name: "cloud-privacy-hermetic-runtime",
    setup(bundle) {
        const stub = (filter: RegExp, modulePath: string) =>
            bundle.onResolve({ filter }, () => ({ namespace: "cloud-privacy-test", path: modulePath }));
        stub(/^@api\/DataStore$/, "data-store");
        stub(/^@api\/Notifications$/, "notifications");
        stub(/^@api\/Settings$/, "settings");
        stub(/^@utils\/localStorage$/, "local-storage");
        stub(/^@utils\/Logger$/, "logger");
        stub(/^@utils\/native$/, "native");
        stub(/^@webpack\/common$/, "webpack-common");
        stub(/^~plugins$/, "plugins");
        bundle.onResolve({ filter: /^\.\/offline$/ }, () => ({ namespace: "cloud-privacy-test", path: "offline" }));

        bundle.onLoad({ filter: /.*/, namespace: "cloud-privacy-test" }, args => {
            const modules: Record<string, string> = {
                "data-store": `
                    const runtime = () => globalThis.__cloudPrivacyHarness;
                    export const get = async key => runtime().dataStore.get(key);
                    export const set = async (key, value) => { runtime().dataStore.set(key, value); };
                    export const update = async (key, callback) => {
                        const value = await callback(runtime().dataStore.get(key));
                        runtime().dataStore.set(key, value);
                        runtime().dataStoreUpdates.push(key);
                        const hook = runtime().afterUpdate;
                        if (hook) await hook(key, value);
                        return value;
                    };
                    export const entries = async () => {
                        runtime().dataStoreEntriesCalls++;
                        throw new Error("Cloud code must never enumerate DataStore");
                    };
                    export const setMany = async () => {
                        runtime().dataStoreSetManyCalls++;
                        throw new Error("Cloud code must never restore DataStore");
                    };
                `,
                logger: `
                    export class Logger {
                        constructor() {}
                        debug(...args) { globalThis.__cloudPrivacyHarness.logs.push(args); }
                        error(...args) { globalThis.__cloudPrivacyHarness.logs.push(args); }
                        info(...args) { globalThis.__cloudPrivacyHarness.logs.push(args); }
                        warn(...args) { globalThis.__cloudPrivacyHarness.logs.push(args); }
                    }
                `,
                "local-storage": `
                    const runtime = () => globalThis.__cloudPrivacyHarness;
                    export const localStorage = new Proxy({}, {
                        get(_target, key) {
                            if (key === "getItem") return item => Object.hasOwn(runtime().localStorage, item) ? runtime().localStorage[item] : null;
                            if (key === "removeItem") return item => { delete runtime().localStorage[item]; };
                            if (key === "setItem") return (item, value) => { runtime().localStorage[item] = String(value); };
                            return runtime().localStorage[String(key)];
                        },
                        set(_target, key, value) { runtime().localStorage[String(key)] = String(value); return true; },
                    });
                `,
                native: "export const relaunch = () => undefined;",
                notifications: `
                    export const showNotification = notification => globalThis.__cloudPrivacyHarness.notifications.push(notification);
                `,
                offline: `
                    function merge(target, source) {
                        for (const [key, value] of Object.entries(source)) {
                            if (value && typeof value === "object" && !Array.isArray(value)) {
                                if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) target[key] = {};
                                merge(target[key], value);
                            } else target[key] = value;
                        }
                    }
                    export const importSettings = async data => {
                        const parsed = JSON.parse(data);
                        globalThis.__cloudPrivacyHarness.importedDocuments.push(parsed);
                        if (parsed.settings) merge(globalThis.__cloudPrivacyHarness.settings, parsed.settings);
                    };
                `,
                plugins: `
                    const runtime = () => globalThis.__cloudPrivacyHarness;
                    const plugins = new Proxy({}, {
                        get(_target, key) { return runtime().plugins[String(key)]; },
                        ownKeys() { return Reflect.ownKeys(runtime().plugins); },
                        getOwnPropertyDescriptor() { return { configurable: true, enumerable: true }; },
                    });
                    export { plugins };
                    export default plugins;
                `,
                settings: `
                    const runtime = () => globalThis.__cloudPrivacyHarness;
                    const settings = new Proxy({}, {
                        get(_target, key) { return runtime().settings[String(key)]; },
                        set(_target, key, value) { runtime().settings[String(key)] = value; return true; },
                        ownKeys() { return Reflect.ownKeys(runtime().settings); },
                        getOwnPropertyDescriptor() { return { configurable: true, enumerable: true }; },
                    });
                    export const PlainSettings = settings;
                    export const Settings = settings;
                `,
                "webpack-common": `
                    const runtime = () => globalThis.__cloudPrivacyHarness;
                    export const OAuth2AuthorizeModal = props => props;
                    export const SettingsRouter = { openUserSettings() {} };
                    export const UserStore = { getCurrentUser: () => ({ id: runtime().userId }) };
                    export const openModal = renderer => { runtime().modal = renderer({}); };
                `,
            };
            return { contents: modules[args.path], loader: "js" };
        });
    },
};

async function bundleModules(root: string): Promise<{ setup: CloudSetupModule; sync: CloudSyncModule; }> {
    const common = {
        absWorkingDir: path.resolve("."),
        bundle: true,
        define: { IS_WEB: "true" },
        format: "esm" as const,
        platform: "node" as const,
        plugins: [runtimeStubs],
        target: "node22",
    };
    const syncOutfile = path.join(root, "cloud-sync.mjs");
    const setupOutfile = path.join(root, "cloud-setup.mjs");
    await build({ ...common, entryPoints: ["src/api/SettingsSync/cloudSync.ts"], outfile: syncOutfile });
    await build({ ...common, entryPoints: ["src/api/SettingsSync/cloudSetup.tsx"], outfile: setupOutfile });
    return {
        setup: await import(`${pathToFileURL(setupOutfile).href}?privacy=${Date.now()}`) as CloudSetupModule,
        sync: await import(`${pathToFileURL(syncOutfile).href}?privacy=${Date.now()}`) as CloudSyncModule,
    };
}

function captureFetch(): () => void {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        const request: RequestRecord = {
            body: init?.body,
            headers: new Headers(init?.headers),
            method: init?.method ?? "GET",
            signal: init?.signal,
            url: String(input),
        };
        currentRuntime().requests.push(request);
        return await currentRuntime().fetchHandler(request);
    }) as typeof fetch;
    return () => { globalThis.fetch = originalFetch; };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(value), {
        ...init,
        headers: { "Content-Type": "application/json", ...init.headers },
    });
}

function cancellableResponse(init: ResponseInit = {}, chunks: Uint8Array[] = [new Uint8Array([123, 125])]): Response {
    const runtime = currentRuntime();
    const body = new ReadableStream<Uint8Array>({
        cancel() { runtime.bodyCancellations++; },
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
    return new Response(body, init);
}

function pendingCancellableResponse(init: ResponseInit = {}): Response {
    const runtime = currentRuntime();
    return new Response(new ReadableStream<Uint8Array>({
        cancel() { runtime.bodyCancellations++; },
    }), init);
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
}

async function checksumBytes(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
    return Array.from(digest.subarray(0, 8), byte => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value != null && typeof value === "object") {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

async function localManifest(runtime: Runtime, version = 1) {
    const settingsBytes = new TextEncoder().encode(canonicalJson(sanitizeCloudSettings(runtime.settings, runtime.plugins)));
    const cssBytes = new TextEncoder().encode(runtime.quickCss);
    return [
        { checksum: await checksumBytes(settingsBytes), key: "settings", version },
        { checksum: await checksumBytes(cssBytes), key: "quickCss", version },
    ];
}

async function downloadEntry(key: string, value: string, version = 1) {
    const bytes = new TextEncoder().encode(value);
    return {
        checksum: await checksumBytes(bytes),
        key,
        value: Buffer.from(bytes).toString("base64"),
        version,
    };
}

function parseV2Request(request: RequestRecord) {
    return JSON.parse(String(request.body)) as {
        client_manifest: Array<{ checksum: string; key: string; version: number; }>;
        uploads: Array<{ checksum: string; key: string; value: string; }>;
    };
}

function acknowledgeUploads(request: RequestRecord): Response {
    const body = parseV2Request(request);
    const entries = new Map(body.client_manifest.map(entry => [entry.key, { ...entry }]));
    const uploaded = body.uploads.map((upload, index) => {
        const entry = {
            checksum: upload.checksum,
            key: upload.key,
            version: (entries.get(upload.key)?.version ?? 0) + index + 1,
        };
        entries.set(upload.key, entry);
        return entry;
    });
    currentRuntime().v2Manifest = Array.from(entries.values());
    return jsonResponse({ downloads: [], errors: [], server_manifest: currentRuntime().v2Manifest, uploaded });
}

function verifyV2Manifest(request: RequestRecord, manifest = currentRuntime().v2Manifest): Response {
    assert.equal(`${request.method} ${requestPath(request)}`, "GET /v2/manifest");
    return jsonResponse({ entries: manifest });
}

function acknowledgeOrVerifyV2Put(request: RequestRecord): Response {
    return requestPath(request) === "/v2/manifest"
        ? verifyV2Manifest(request)
        : acknowledgeUploads(request);
}

function decodeV2Uploads(request: RequestRecord): Record<string, string> {
    return Object.fromEntries(parseV2Request(request).uploads.map(upload => [
        upload.key,
        Buffer.from(upload.value, "base64").toString("utf8"),
    ]));
}

function requestPath(request: RequestRecord): string {
    return new URL(request.url).pathname;
}

function assertNoPrivateData(value: unknown): void {
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, new RegExp(SECRET_SENTINEL, "u"));
    assert.doesNotMatch(serialized, /"(?:autoUpdate|eagerPatches|enableOnlineThemes|enableReactDevtools|enabled|useQuickCss)"\s*:/u);
    assert.doesNotMatch(serialized, /"cloud"\s*:/u);
    assert.doesNotMatch(serialized, /"dataStore"\s*:/u);
    assert.doesNotMatch(serialized, /deeplApiKey|s3SecretAccessKey|jf_apiKey|savedPasswords|localCredential|structuredCredential|tokenAddedLater/u);
}

function assertNoDataStoreBoundary(runtime: Runtime): void {
    assert.equal(runtime.dataStoreEntriesCalls, 0, "cloud sync must not enumerate DataStore");
    assert.equal(runtime.dataStoreSetManyCalls, 0, "cloud sync must not restore DataStore");
}

function assertPolicyBoundary(): void {
    assert.equal(parseCloudBackendUrl(ORIGIN_A).href, `${ORIGIN_A}/`);
    assert.equal(parseCloudBackendUrl(`${ORIGIN_A}/`).href, `${ORIGIN_A}/`);
    assert.equal(parseCloudBackendUrl("https://cloud-a.example.test:8443").href, "https://cloud-a.example.test:8443/");

    const rejected: unknown[] = [
        "http://cloud-a.example.test",
        "https://user@cloud-a.example.test",
        "https://user:password@cloud-a.example.test",
        `${ORIGIN_A}/api`,
        `${ORIGIN_A}/?token=secret`,
        `${ORIGIN_A}/#secret`,
        ` ${ORIGIN_A}`,
        `${ORIGIN_A} `,
        `${ORIGIN_A}/\nowned`,
        `${ORIGIN_A}/\u0000owned`,
        "//cloud-a.example.test",
        "not a URL",
        "",
        null,
        undefined,
        42,
        { toString: () => ORIGIN_A },
    ];
    for (const value of rejected)
        assert.throws(() => parseCloudBackendUrl(value), `${String(value)} must not be accepted as a backend`);

    const sanitized = sanitizeCloudSettings(settingsFixture(), pluginDefinitions);
    assert.deepEqual(sanitized, {
        macosVibrancyStyle: "sidebar",
        plugins: {
            SafePlugin: {
                isFavorite: true,
                freeSlider: 51,
                safeBoolean: true,
                safeChoice: "safe-local-choice",
                safeNumber: 7,
                safeSlider: 50,
            },
        },
        windowsMaterial: "mica",
    });
    assertNoPrivateData(sanitized);

    const emptyCssDocument = buildCloudDocument(settingsFixture(), "", pluginDefinitions);
    assert.equal(emptyCssDocument.quickCss, "", "empty QuickCSS is a real synchronized value");
    assertNoPrivateData(emptyCssDocument);
    assert.deepEqual(sanitizeCloudSettings({
        autoUpdate: "false",
        macosVibrancyStyle: true,
        windowsMaterial: "future-material",
    }, pluginDefinitions), {});

    const inheritedRegistry = Object.create({
        InheritedPlugin: {
            settings: { def: { inheritedSecret: { cloudSync: true, type: 3 } } },
        },
    }) as CloudPluginRegistry;
    assert.deepEqual(sanitizeCloudSettings({
        plugins: {
            InheritedPlugin: { inheritedSecret: true, isFavorite: true },
            UnknownPlugin: { enabled: true, isFavorite: true, token: SECRET_SENTINEL },
        },
    }, inheritedRegistry), { plugins: {} }, "unknown and inherited registry keys are excluded");

    assert.deepEqual(sanitizeCloudSettings({
        plugins: {
            SafePlugin: {
                isFavorite: false,
                rejectedBoolean: true,
                safeBoolean: "true",
                safeChoice: "credential-shaped-choice",
                freeSlider: 101,
                safeNumber: -1,
                safeSlider: 51,
                structuredCredential: SECRET_SENTINEL,
            },
        },
    }, pluginDefinitions), { plugins: { SafePlugin: { isFavorite: false } } }, "only schema-valid primitive opt-ins cross the boundary");

    assert.deepEqual(sanitizeCloudSettings({
        plugins: { SafePlugin: { freeSlider: 25 } },
    }, pluginDefinitions), { plugins: { SafePlugin: { freeSlider: 25 } } }, "a free slider accepts finite values within its marker bounds");
    for (const freeSlider of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.deepEqual(sanitizeCloudSettings({
            plugins: { SafePlugin: { freeSlider } },
        }, pluginDefinitions), { plugins: {} }, `free slider value ${String(freeSlider)} must stay within finite marker bounds`);
    }
}

function bytesFromBody(body: BodyInit | null | undefined): Uint8Array {
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    throw new Error(`Expected a byte request body, received ${Object.prototype.toString.call(body)}`);
}

async function testOutboundV2(sync: CloudSyncModule): Promise<void> {
    const runtime = makeRuntime();
    runtime.quickCss = "";
    useRuntime(runtime);
    runtime.fetchHandler = async request => {
        if (requestPath(request) === "/v2/manifest") return verifyV2Manifest(request);
        assert.equal(requestPath(request), "/v2/sync");
        assert.equal(request.method, "POST");
        return acknowledgeUploads(request);
    };

    await sync.putCloudSettings(true);
    assert.equal(runtime.requests.length, 2, "a successful V2 put is followed by a fresh authority manifest read");
    const request = runtime.requests[0];
    const body = parseV2Request(request);
    assert.deepEqual(body.client_manifest, []);
    assert.deepEqual(body.uploads.map(upload => upload.key).sort(), ["quickCss", "settings"]);
    const uploads = decodeV2Uploads(request);
    assert.equal(uploads.quickCss, "", "V2 must upload an explicitly empty QuickCSS value");
    assert.deepEqual(JSON.parse(uploads.settings), sanitizeCloudSettings(settingsFixture(), pluginDefinitions));
    assertNoPrivateData(body);
    assert.doesNotMatch(String(request.body), /Unrelated_private_DataStore_record/u);
    assertNoDataStoreBoundary(runtime);
    assert.equal(runtime.localStorage.Vencord_settingsDirty, undefined);
}

async function testOutboundV1(sync: CloudSyncModule): Promise<void> {
    const runtime = makeRuntime();
    runtime.quickCss = "";
    runtime.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1" });
    useRuntime(runtime);
    let uploadedDocument: unknown;
    runtime.fetchHandler = async request => {
        assert.equal(requestPath(request), "/v1/settings");
        assert.equal(request.method, "PUT");
        uploadedDocument = JSON.parse(new TextDecoder().decode(inflateSync(bytesFromBody(request.body))));
        return jsonResponse({ written: 41 });
    };

    await sync.putCloudSettings(true);
    assert.equal(runtime.requests.length, 1);
    assert.deepEqual(uploadedDocument, buildCloudDocument(settingsFixture(), "", pluginDefinitions));
    assert.equal((uploadedDocument as { quickCss: string; }).quickCss, "");
    assertNoPrivateData(uploadedDocument);
    assert.doesNotMatch(Buffer.from(bytesFromBody(runtime.requests[0].body)).toString("base64"), /Unrelated_private_DataStore_record/u);
    assert.deepEqual(runtime.dataStore.get(V1_VERSION_STORE_KEY), { [cloudScope()]: 41 });
    assertNoDataStoreBoundary(runtime);
}

function hostileRemoteSettings(remoteSecret: string): Record<string, unknown> {
    return {
        autoUpdate: true,
        cloud: {
            authenticated: false,
            settingsSync: false,
            url: "https://attacker.example.test",
        },
        dataStore: { restoredToken: remoteSecret },
        enableOnlineThemes: false,
        futureTopLevelSecret: remoteSecret,
        notifications: { password: remoteSecret },
        plugins: {
            SafePlugin: {
                enabled: false,
                futureUnknownField: remoteSecret,
                isFavorite: false,
                localCredential: remoteSecret,
                freeSlider: 75,
                rejectedBoolean: true,
                safeBoolean: false,
                safeChoice: "safe-remote-choice",
                safeNumber: 9,
                safeSlider: 100,
                structuredCredential: { token: remoteSecret },
            },
            Translate: { deeplApiKey: remoteSecret, enabled: false },
            UnknownFuturePlugin: { enabled: false, tokenAddedLater: remoteSecret },
        },
        unknownNestedSettings: { token: remoteSecret },
        useQuickCss: false,
        windowsMaterial: "acrylic",
    };
}

function assertInboundPrivacy(runtime: Runtime, remoteSecret: string): void {
    assert.deepEqual(runtime.settings.cloud, {
        authenticated: true,
        settingsSync: true,
        settingsSyncVersion: 987,
        url: ORIGIN_A,
    });
    assert.equal(runtime.settings.futureTopLevelSecret, SECRET_SENTINEL);
    assert.equal(runtime.settings.unknownNestedSettings.password, SECRET_SENTINEL);
    assert.equal(runtime.settings.plugins.SafePlugin.localCredential, SECRET_SENTINEL);
    assert.equal(runtime.settings.plugins.Translate.deeplApiKey, SECRET_SENTINEL);
    assert.equal(runtime.settings.plugins.UnknownFuturePlugin.tokenAddedLater, SECRET_SENTINEL);
    assert.equal(runtime.settings.plugins.SafePlugin.enabled, true, "plugin enabled state is privileged and remains local");
    assert.doesNotMatch(JSON.stringify(runtime.settings), new RegExp(remoteSecret, "u"));
    assert.deepEqual(runtime.dataStore.get("Unrelated_private_DataStore_record"), {
        password: SECRET_SENTINEL,
        token: SECRET_SENTINEL,
    });
    assert.equal((runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()], AUTH_SECRET);
    assertNoDataStoreBoundary(runtime);
}

async function testInboundV2AndOfficialZeroUploadPull(sync: CloudSyncModule): Promise<void> {
    const runtime = makeRuntime();
    const remoteSecret = "REMOTE_PRIVATE_VALUE_MUST_STAY_OUT";
    useRuntime(runtime);
    const settingsDownload = await downloadEntry("settings", JSON.stringify(hostileRemoteSettings(remoteSecret)), 8);
    const cssDownload = await downloadEntry("quickCss", "", 9);
    const downloads = [settingsDownload, cssDownload];
    runtime.fetchHandler = async request => {
        assert.equal(requestPath(request), "/v2/sync");
        const body = parseV2Request(request);
        assert.deepEqual(body.uploads, [], "an Equicloud pull is a zero-upload sync request");
        assert.deepEqual(body.client_manifest, [], "a forced pull asks the backend for all values");
        return jsonResponse({
            downloads,
            errors: [],
            server_manifest: downloads.map(({ checksum, key, version }) => ({ checksum, key, version })),
            uploaded: [],
        });
    };

    assert.equal(await sync.getCloudSettings(false, true), true);
    assert.equal(runtime.settings.autoUpdate, false, "auto-update is privileged and remains local");
    assert.equal(runtime.settings.useQuickCss, true, "QuickCSS activation remains a local trust decision");
    assert.equal(runtime.settings.enableOnlineThemes, true, "online-theme activation remains local");
    assert.equal(runtime.settings.windowsMaterial, "acrylic");
    assert.deepEqual(runtime.settings.plugins.SafePlugin, {
        enabled: true,
        futureUnknownField: SECRET_SENTINEL,
        isFavorite: false,
        localCredential: SECRET_SENTINEL,
        freeSlider: 75,
        rejectedBoolean: true,
        safeBoolean: false,
        safeChoice: "safe-remote-choice",
        safeNumber: 9,
        safeSlider: 100,
        structuredCredential: { token: SECRET_SENTINEL },
    });
    assert.equal(runtime.quickCss, "");
    assertInboundPrivacy(runtime, remoteSecret);

    const stateAfterFirstPull = JSON.stringify({ quickCss: runtime.quickCss, settings: runtime.settings });
    const importsAfterFirstPull = runtime.importedDocuments.length;
    const cssWritesAfterFirstPull = runtime.quickCssWrites;
    assert.equal(await sync.getCloudSettings(false, true), false);
    assert.equal(JSON.stringify({ quickCss: runtime.quickCss, settings: runtime.settings }), stateAfterFirstPull);
    assert.equal(runtime.importedDocuments.length, importsAfterFirstPull, "repeated all-value responses are semantically idempotent");
    assert.equal(runtime.quickCssWrites, cssWritesAfterFirstPull, "identical QuickCSS is not rewritten");
    assert.equal(runtime.requests.length, 2);
    assertInboundPrivacy(runtime, remoteSecret);
}

async function testInboundV1(sync: CloudSyncModule): Promise<void> {
    const runtime = makeRuntime();
    const remoteSecret = "REMOTE_V1_PRIVATE_VALUE_MUST_STAY_OUT";
    runtime.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1" });
    useRuntime(runtime);
    const document = { settings: hostileRemoteSettings(remoteSecret), quickCss: "" };
    runtime.fetchHandler = async request => {
        assert.equal(requestPath(request), "/v1/settings");
        assert.equal(request.method, "GET");
        assert.equal(request.headers.get("If-None-Match"), "0");
        return new Response(deflateSync(new TextEncoder().encode(JSON.stringify(document))), {
            headers: { ETag: "73" },
        });
    };

    assert.equal(await sync.getCloudSettings(false, false), true);
    assert.equal(runtime.quickCss, "");
    assert.equal(runtime.settings.autoUpdate, false);
    assert.equal(runtime.settings.plugins.SafePlugin.safeChoice, "safe-remote-choice");
    assert.deepEqual(runtime.dataStore.get(V1_VERSION_STORE_KEY), { [cloudScope()]: 73 });
    assertInboundPrivacy(runtime, remoteSecret);
}

async function testSourcePushDominanceAndBoundedConflicts(sync: CloudSyncModule): Promise<void> {
    const runtime = makeRuntime();
    useRuntime(runtime);
    const serverSettings = await downloadEntry("settings", JSON.stringify({ autoUpdate: true }), 20);
    const serverCss = await downloadEntry("quickCss", ".server { color: red; }", 21);
    const serverDownloads = [serverSettings, serverCss];
    let calls = 0;
    let postCalls = 0;
    let finalUploads: Record<string, string> = {};
    runtime.fetchHandler = async request => {
        calls++;
        if (requestPath(request) === "/v2/manifest") return verifyV2Manifest(request);
        postCalls++;
        assert.equal(requestPath(request), "/v2/sync");
        if (postCalls === 1) {
            return jsonResponse({
                downloads: serverDownloads,
                errors: [{ key: "settings", message: "conflict" }],
                server_manifest: serverDownloads.map(({ checksum, key, version }) => ({ checksum, key, version })),
                uploaded: [],
            });
        }
        assert.equal(postCalls, 2, "a source conflict gets at most one retry");
        finalUploads = decodeV2Uploads(request);
        return acknowledgeUploads(request);
    };

    const originalSettings = JSON.stringify(runtime.settings);
    await sync.putCloudSettings(true);
    assert.equal(postCalls, 2);
    assert.equal(calls, 3);
    assert.equal(JSON.stringify(runtime.settings), originalSettings, "a source put must never apply bundled downloads");
    assert.equal(runtime.quickCss, QUICK_CSS, "server conflict QuickCSS must not replace the source value");
    assert.deepEqual(JSON.parse(finalUploads.settings), sanitizeCloudSettings(settingsFixture(), pluginDefinitions));
    assert.equal(finalUploads.quickCss, QUICK_CSS);
    assert.equal(runtime.importedDocuments.length, 0);
    assert.equal(runtime.quickCssWrites, 0);
    assert.equal(runtime.localStorage.Vencord_settingsDirty, undefined);

    const bounded = makeRuntime();
    useRuntime(bounded);
    let persistentCalls = 0;
    bounded.fetchHandler = async request => {
        persistentCalls++;
        assert.ok(persistentCalls <= 2, "persistent conflicts must not loop indefinitely");
        return jsonResponse({
            downloads: serverDownloads,
            errors: [{ key: SECRET_SENTINEL, message: SECRET_SENTINEL }],
            server_manifest: serverDownloads.map(({ checksum, key, version }) => ({ checksum, key, version })),
            uploaded: [],
        });
    };
    await sync.putCloudSettings(true);
    assert.equal(persistentCalls, 2);
    assert.equal(bounded.quickCss, QUICK_CSS);
    assert.equal(bounded.settings.autoUpdate, false);
    assert.equal(bounded.localStorage.Vencord_settingsDirty, "true");
    assert.doesNotMatch(JSON.stringify(bounded.logs), new RegExp(SECRET_SENTINEL, "u"), "remote sync errors are redacted before logging");
    assertNoDataStoreBoundary(bounded);

    const sequential = makeRuntime();
    useRuntime(sequential);
    let sequentialCalls = 0;
    let sequentialPosts = 0;
    sequential.fetchHandler = async request => {
        sequentialCalls++;
        if (requestPath(request) === "/v2/manifest") return verifyV2Manifest(request);
        sequentialPosts++;
        if (sequentialPosts % 2 === 1) {
            return jsonResponse({
                downloads: serverDownloads,
                errors: [{ key: "settings", error: "race" }],
                server_manifest: serverDownloads.map(({ checksum, key, version }) => ({ checksum, key, version })),
                uploaded: [],
            });
        }
        return acknowledgeUploads(request);
    };
    assert.equal(await sync.putCloudSettings(true), true);
    sequential.settings.plugins.SafePlugin.safeChoice = "safe-remote-choice";
    sync.markLocalSettingsDirty();
    assert.equal(await sync.putCloudSettings(true), true);
    assert.equal(sequentialPosts, 4, "two sequential server races each receive one bounded source-wins retry");
    assert.equal(sequentialCalls, 6, "each successful retry is followed by authority verification");
    assert.equal(sequential.settings.plugins.SafePlugin.safeChoice, "safe-remote-choice");
    assert.equal(sequential.importedDocuments.length, 0);

    const incompleteAuthority = makeRuntime();
    useRuntime(incompleteAuthority);
    let authorityCalls = 0;
    incompleteAuthority.fetchHandler = async request => {
        authorityCalls++;
        if (authorityCalls === 1) {
            return jsonResponse({
                downloads: serverDownloads,
                errors: [{ key: "settings", error: "race" }],
                server_manifest: serverDownloads.map(({ checksum, key, version }) => ({ checksum, key, version })),
                uploaded: [],
            });
        }
        const body = parseV2Request(request);
        const settingsUpload = body.uploads.find(upload => upload.key === "settings");
        assert.ok(settingsUpload);
        const settingEntry = { checksum: settingsUpload.checksum, key: "settings", version: 99 };
        return jsonResponse({ downloads: [], errors: [], server_manifest: [settingEntry], uploaded: [settingEntry] });
    };
    assert.equal(await sync.putCloudSettings(true), false, "a retry is not successful unless every local key is authoritative");
    assert.equal(authorityCalls, 2);
    assert.equal(incompleteAuthority.localStorage.Vencord_settingsDirty, "true");
}

async function testManualZeroUploadRequiresAllLocalAuthority(sync: CloudSyncModule): Promise<void> {
    const complete = makeRuntime();
    const completeManifest = await localManifest(complete, 7);
    complete.dataStore.set(MANIFEST_STORE_KEY, { [cloudScope()]: completeManifest });
    complete.localStorage.Vencord_settingsDirty = "true";
    useRuntime(complete);
    complete.fetchHandler = async request => {
        if (requestPath(request) === "/v2/manifest") return verifyV2Manifest(request, completeManifest);
        assert.deepEqual(parseV2Request(request).uploads, [], "manual sync still performs a zero-upload authority check");
        complete.v2Manifest = completeManifest;
        return jsonResponse({ downloads: [], errors: [], server_manifest: completeManifest, uploaded: [] });
    };
    assert.equal(await sync.putCloudSettings(true), true);
    assert.equal(complete.localStorage.Vencord_settingsDirty, undefined);

    const incomplete = makeRuntime();
    const incompleteManifest = await localManifest(incomplete, 8);
    incomplete.dataStore.set(MANIFEST_STORE_KEY, { [cloudScope()]: incompleteManifest });
    useRuntime(incomplete);
    incomplete.fetchHandler = async request => {
        assert.deepEqual(parseV2Request(request).uploads, []);
        return jsonResponse({ downloads: [], errors: [], server_manifest: [incompleteManifest[0]], uploaded: [] });
    };
    assert.equal(await sync.putCloudSettings(true), false);
    assert.equal(incomplete.localStorage.Vencord_settingsDirty, "true");
}

async function testPullRejectsChangedManifestWithoutDownload(sync: CloudSyncModule): Promise<void> {
    const runtime = makeRuntime();
    const previous = await localManifest(runtime, 1);
    runtime.dataStore.set(MANIFEST_STORE_KEY, { [cloudScope()]: previous });
    useRuntime(runtime);
    const changed = { ...previous[0], checksum: "0123456789abcdef", version: 2 };
    runtime.fetchHandler = async request => {
        assert.deepEqual(parseV2Request(request).uploads, []);
        return jsonResponse({
            downloads: [],
            errors: [],
            server_manifest: [changed, previous[1]],
            uploaded: [],
        });
    };
    assert.equal(await sync.getCloudSettings(true, false), false);
    assert.deepEqual((runtime.dataStore.get(MANIFEST_STORE_KEY) as Record<string, unknown>)[cloudScope()], previous);
    assert.equal(runtime.importedDocuments.length, 0);
    assert.ok(runtime.notifications.some(notification => notification.body === "The cloud returned an incomplete settings snapshot."));
}

async function testScopedManifestAndV1Versions(sync: CloudSyncModule): Promise<void> {
    const manifestRuntime = makeRuntime();
    const secrets = manifestRuntime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>;
    secrets[cloudScope(ORIGIN_A, USER_B)] = `${AUTH_SECRET}-b`;
    secrets[cloudScope(ORIGIN_B, USER_B)] = `${AUTH_SECRET}-origin-b`;
    useRuntime(manifestRuntime);
    const manifestsSent: Array<Array<{ checksum: string; key: string; version: number; }>> = [];
    const authorizationsSent: string[] = [];
    manifestRuntime.fetchHandler = async request => {
        if (requestPath(request) === "/v2/manifest") return verifyV2Manifest(request);
        manifestsSent.push(parseV2Request(request).client_manifest);
        authorizationsSent.push(request.headers.get("Authorization") ?? "<missing>");
        return acknowledgeUploads(request);
    };
    await sync.putCloudSettings(true);
    manifestRuntime.userId = USER_B;
    await sync.putCloudSettings(true);
    manifestRuntime.settings.cloud.url = ORIGIN_B;
    await sync.putCloudSettings(true);
    assert.deepEqual(manifestsSent[0], []);
    assert.deepEqual(manifestsSent[1], [], "a second account on one origin must not inherit the first account manifest");
    assert.deepEqual(manifestsSent[2], [], "the same account on a second origin must not inherit another origin's manifest");
    assert.deepEqual(authorizationsSent, [
        btoa(`${AUTH_SECRET}:${USER_A}`),
        btoa(`${AUTH_SECRET}-b:${USER_B}`),
        btoa(`${AUTH_SECRET}-origin-b:${USER_B}`),
    ]);
    const storedManifests = manifestRuntime.dataStore.get(MANIFEST_STORE_KEY) as Record<string, unknown>;
    assert.ok(Array.isArray(storedManifests[cloudScope(ORIGIN_A, USER_A)]));
    assert.ok(Array.isArray(storedManifests[cloudScope(ORIGIN_A, USER_B)]));
    assert.ok(Array.isArray(storedManifests[cloudScope(ORIGIN_B, USER_B)]));

    const versionRuntime = makeRuntime();
    const versionSecrets = versionRuntime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>;
    versionSecrets[cloudScope(ORIGIN_A, USER_B)] = `${AUTH_SECRET}-b`;
    versionSecrets[cloudScope(ORIGIN_B, USER_A)] = `${AUTH_SECRET}-origin-b`;
    versionRuntime.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1", [ORIGIN_B]: "v1" });
    useRuntime(versionRuntime);
    const etags: string[] = [];
    let requestNumber = 0;
    versionRuntime.fetchHandler = async request => {
        etags.push(request.headers.get("If-None-Match") ?? "<missing>");
        requestNumber++;
        if (requestNumber === 1) {
            return new Response(deflateSync(new TextEncoder().encode(JSON.stringify({ settings: {}, quickCss: QUICK_CSS }))), {
                headers: { ETag: "91" },
            });
        }
        return new Response(null, { status: 304 });
    };
    await sync.getCloudSettings(false, false);
    versionRuntime.userId = USER_B;
    await sync.getCloudSettings(false, false);
    versionRuntime.userId = USER_A;
    await sync.getCloudSettings(false, false);
    versionRuntime.settings.cloud.url = ORIGIN_B;
    await sync.getCloudSettings(false, false);
    assert.deepEqual(etags, ["0", "0", "91", "0"], "V1 versions are isolated by origin and Discord account");
    assert.deepEqual(versionRuntime.dataStore.get(V1_VERSION_STORE_KEY), { [cloudScope(ORIGIN_A, USER_A)]: 91 });
}

async function testMalformedLocalState(sync: CloudSyncModule): Promise<void> {
    const runtime = makeRuntime();
    runtime.dataStore.set(API_VERSION_STORE_KEY, ["v1"]);
    runtime.dataStore.set(MANIFEST_STORE_KEY, { [cloudScope()]: new Array(4097).fill({ checksum: "x", key: "settings", version: 1 }) });
    runtime.dataStore.set(V1_VERSION_STORE_KEY, { [cloudScope()]: "91" });
    useRuntime(runtime);
    runtime.fetchHandler = async request => {
        if (requestPath(request) === "/v2/manifest") return verifyV2Manifest(request);
        assert.deepEqual(parseV2Request(request).client_manifest, [], "an oversized local manifest is discarded");
        return acknowledgeUploads(request);
    };
    await sync.putCloudSettings(true);
    assert.equal(runtime.requests.length, 2);
    assert.equal(requestPath(runtime.requests[0]), "/v2/sync", "a malformed API map defaults safely to V2");
    assertNoDataStoreBoundary(runtime);
}

async function testDelayedAccountResponsesAreDiscarded(sync: CloudSyncModule): Promise<void> {
    const v2Runtime = makeRuntime();
    const v2Secrets = v2Runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>;
    v2Secrets[cloudScope(ORIGIN_A, USER_B)] = `${AUTH_SECRET}-b`;
    useRuntime(v2Runtime);
    const startedV2 = deferred<void>();
    const responseV2 = deferred<Response>();
    const remoteDownload = await downloadEntry("settings", JSON.stringify({ autoUpdate: true }), 5);
    v2Runtime.fetchHandler = async () => {
        startedV2.resolve();
        return await responseV2.promise;
    };
    const v2Operation = sync.getCloudSettings(false, true);
    await startedV2.promise;
    v2Runtime.userId = USER_B;
    responseV2.resolve(jsonResponse({
        downloads: [remoteDownload],
        errors: [],
        server_manifest: [{ checksum: remoteDownload.checksum, key: remoteDownload.key, version: remoteDownload.version }],
        uploaded: [],
    }));
    assert.equal(await v2Operation, false);
    assert.equal(v2Runtime.settings.autoUpdate, false);
    assert.equal(v2Runtime.importedDocuments.length, 0);
    assert.equal(v2Runtime.dataStore.get(MANIFEST_STORE_KEY), undefined);

    const v1Runtime = makeRuntime();
    const v1Secrets = v1Runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>;
    v1Secrets[cloudScope(ORIGIN_A, USER_B)] = `${AUTH_SECRET}-b`;
    v1Runtime.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1" });
    useRuntime(v1Runtime);
    const startedV1 = deferred<void>();
    const responseV1 = deferred<Response>();
    v1Runtime.fetchHandler = async () => {
        startedV1.resolve();
        return await responseV1.promise;
    };
    const v1Operation = sync.getCloudSettings(false, false);
    await startedV1.promise;
    v1Runtime.userId = USER_B;
    responseV1.resolve(new Response(deflateSync(new TextEncoder().encode(JSON.stringify({ settings: { autoUpdate: true } }))), {
        headers: { ETag: "7" },
    }));
    assert.equal(await v1Operation, false);
    assert.equal(v1Runtime.settings.autoUpdate, false);
    assert.equal(v1Runtime.importedDocuments.length, 0);
    assert.equal(v1Runtime.dataStore.get(V1_VERSION_STORE_KEY), undefined);
}

async function testInFlightLocalChangesStayDirty(sync: CloudSyncModule): Promise<void> {
    const v2 = makeRuntime();
    v2.localStorage.Vencord_settingsDirty = "true";
    useRuntime(v2);
    const v2Started = deferred<RequestRecord>();
    const v2Response = deferred<Response>();
    v2.fetchHandler = async request => {
        if (requestPath(request) === "/v2/manifest") return verifyV2Manifest(request);
        v2Started.resolve(request);
        return await v2Response.promise;
    };
    const v2Operation = sync.putCloudSettings(false);
    const v2Request = await v2Started.promise;
    v2.settings.plugins.SafePlugin.safeChoice = "safe-remote-choice";
    v2Response.resolve(acknowledgeUploads(v2Request));
    assert.equal(await v2Operation, false, "a V2 acknowledgement cannot clean a newer local snapshot");
    assert.equal(v2.localStorage.Vencord_settingsDirty, "true");

    const v1 = makeRuntime();
    v1.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1" });
    v1.localStorage.Vencord_settingsDirty = "true";
    useRuntime(v1);
    const v1Started = deferred<void>();
    const v1Response = deferred<Response>();
    v1.fetchHandler = async () => {
        v1Started.resolve();
        return await v1Response.promise;
    };
    const v1Operation = sync.putCloudSettings(false);
    await v1Started.promise;
    v1.settings.plugins.SafePlugin.safeChoice = "safe-remote-choice";
    v1Response.resolve(jsonResponse({ written: 17 }));
    assert.equal(await v1Operation, false, "a V1 version cannot clean settings changed while its upload was in flight");
    assert.equal(v1.localStorage.Vencord_settingsDirty, "true");

    const zeroUpload = makeRuntime();
    const oldManifest = await localManifest(zeroUpload, 12);
    zeroUpload.dataStore.set(MANIFEST_STORE_KEY, { [cloudScope()]: oldManifest });
    zeroUpload.localStorage.Vencord_settingsDirty = "true";
    useRuntime(zeroUpload);
    const zeroStarted = deferred<void>();
    const zeroResponse = deferred<Response>();
    zeroUpload.fetchHandler = async request => {
        if (requestPath(request) === "/v2/manifest") return verifyV2Manifest(request, oldManifest);
        assert.deepEqual(parseV2Request(request).uploads, []);
        zeroStarted.resolve();
        return await zeroResponse.promise;
    };
    const zeroOperation = sync.putCloudSettings(true);
    await zeroStarted.promise;
    zeroUpload.settings.plugins.SafePlugin.safeChoice = "safe-remote-choice";
    zeroResponse.resolve(jsonResponse({ downloads: [], errors: [], server_manifest: oldManifest, uploaded: [] }));
    assert.equal(await zeroOperation, false, "a manual zero-upload response cannot clean a newer local snapshot");
    assert.equal(zeroUpload.localStorage.Vencord_settingsDirty, "true");
}

async function testInFlightMetadataDirtyEventsStayDirty(sync: CloudSyncModule): Promise<void> {
    const duringPost = makeRuntime();
    duringPost.localStorage.Vencord_settingsDirty = "true";
    useRuntime(duringPost);
    const postStarted = deferred<RequestRecord>();
    const postResponse = deferred<Response>();
    duringPost.fetchHandler = async request => {
        if (requestPath(request) === "/v2/manifest") return verifyV2Manifest(request);
        postStarted.resolve(request);
        return await postResponse.promise;
    };
    const postOperation = sync.putCloudSettings(false);
    const postRequest = await postStarted.promise;
    sync.markLocalSettingsDirty();
    postResponse.resolve(acknowledgeUploads(postRequest));
    assert.equal(await postOperation, false, "a metadata-only dirty event during the V2 POST remains pending");
    assert.equal(duringPost.localStorage.Vencord_settingsDirty, "true");

    const duringVerification = makeRuntime();
    duringVerification.localStorage.Vencord_settingsDirty = "true";
    useRuntime(duringVerification);
    const verificationStarted = deferred<void>();
    const verificationResponse = deferred<Response>();
    duringVerification.fetchHandler = async request => {
        if (requestPath(request) === "/v2/manifest") {
            verificationStarted.resolve();
            return await verificationResponse.promise;
        }
        return acknowledgeUploads(request);
    };
    const verificationOperation = sync.putCloudSettings(false);
    await verificationStarted.promise;
    sync.markLocalSettingsDirty();
    const metadataUpdatedManifest = duringVerification.v2Manifest.map(entry => ({ ...entry, version: entry.version + 10 }));
    verificationResponse.resolve(jsonResponse({ entries: metadataUpdatedManifest }));
    assert.equal(await verificationOperation, false, "a metadata-only dirty event during fresh authority verification remains pending");
    assert.equal(duringVerification.localStorage.Vencord_settingsDirty, "true");

    const duringV1 = makeRuntime();
    duringV1.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1" });
    duringV1.localStorage.Vencord_settingsDirty = "true";
    useRuntime(duringV1);
    const v1Started = deferred<void>();
    const v1Response = deferred<Response>();
    duringV1.fetchHandler = async () => {
        v1Started.resolve();
        return await v1Response.promise;
    };
    const v1Operation = sync.putCloudSettings(false);
    await v1Started.promise;
    sync.markLocalSettingsDirty();
    v1Response.resolve(jsonResponse({ written: 33 }));
    assert.equal(await v1Operation, false, "a metadata-only dirty event during the V1 PUT remains pending");
    assert.equal(duringV1.localStorage.Vencord_settingsDirty, "true");
}

async function testMalformedAndCappedResponses(sync: CloudSyncModule): Promise<void> {
    const malformed = makeRuntime();
    useRuntime(malformed);
    malformed.fetchHandler = async () => jsonResponse({
        downloads: [],
        errors: [],
        server_manifest: new Array(4097).fill({ checksum: "x", key: "settings", version: 1 }),
        uploaded: [],
    });
    assert.equal(await sync.getCloudSettings(false, true), false);
    assert.equal(malformed.importedDocuments.length, 0);
    assert.equal(malformed.dataStore.get(MANIFEST_STORE_KEY), undefined);

    const invalidDownload = makeRuntime();
    useRuntime(invalidDownload);
    invalidDownload.fetchHandler = async () => jsonResponse({
        downloads: [{ checksum: "not-the-checksum", key: "settings", value: "%%%", version: 1 }],
        errors: [],
        server_manifest: [{ checksum: "not-the-checksum", key: "settings", version: 1 }],
        uploaded: [],
    });
    assert.equal(await sync.getCloudSettings(false, true), false);
    assert.equal(invalidDownload.importedDocuments.length, 0);

    const reflectedChecksum = makeRuntime();
    useRuntime(reflectedChecksum);
    reflectedChecksum.fetchHandler = async () => jsonResponse({
        downloads: [],
        errors: [],
        server_manifest: [{ checksum: SECRET_SENTINEL, key: "settings", version: 1 }],
        uploaded: [],
    });
    assert.equal(await sync.getCloudSettings(true, true), false);
    assert.equal(reflectedChecksum.dataStore.get(MANIFEST_STORE_KEY), undefined);
    assert.doesNotMatch(JSON.stringify(reflectedChecksum.logs), new RegExp(SECRET_SENTINEL, "u"));
    assert.doesNotMatch(JSON.stringify(reflectedChecksum.notifications), new RegExp(SECRET_SENTINEL, "u"));

    const capped = makeRuntime();
    useRuntime(capped);
    capped.fetchHandler = async () => cancellableResponse({
        headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
    });
    assert.equal(await sync.getCloudSettings(false, true), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(capped.bodyCancellations, 1, "an oversized declared JSON body is cancelled");

    const httpError = makeRuntime();
    useRuntime(httpError);
    httpError.fetchHandler = async () => pendingCancellableResponse({ status: 500 });
    assert.equal(await sync.getCloudSettings(false, true), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(httpError.bodyCancellations, 1, "an unused HTTP error body is cancelled");

    const badEtag = makeRuntime();
    badEtag.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1" });
    useRuntime(badEtag);
    badEtag.fetchHandler = async () => pendingCancellableResponse({ headers: { ETag: "not-a-number" } });
    assert.equal(await sync.getCloudSettings(false, false), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(badEtag.bodyCancellations, 1, "a V1 body with an invalid ETag is cancelled");
}

async function testStrictV1VersionsAndInflateCap(sync: CloudSyncModule): Promise<void> {
    for (const written of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null] as unknown[]) {
        const runtime = makeRuntime();
        runtime.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1" });
        runtime.localStorage.Vencord_settingsDirty = "true";
        useRuntime(runtime);
        runtime.fetchHandler = async () => jsonResponse({ written });
        assert.equal(await sync.putCloudSettings(false), false, `invalid V1 written version ${String(written)} must be rejected`);
        assert.equal(runtime.dataStore.get(V1_VERSION_STORE_KEY), undefined);
        assert.equal(runtime.localStorage.Vencord_settingsDirty, "true");
    }

    const document = deflateSync(new TextEncoder().encode(JSON.stringify({ settings: {}, quickCss: "safe" })));
    for (const etag of [undefined, "", "-1", "1.5", String(Number.MAX_SAFE_INTEGER + 1), "Infinity"] as const) {
        const runtime = makeRuntime();
        runtime.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1" });
        useRuntime(runtime);
        runtime.fetchHandler = async () => new Response(document, {
            headers: etag === undefined ? {} : { ETag: etag },
        });
        assert.equal(await sync.getCloudSettings(false, false), false, `invalid V1 ETag ${String(etag)} must be rejected`);
        assert.equal(runtime.dataStore.get(V1_VERSION_STORE_KEY), undefined);
        assert.equal(runtime.quickCssWrites, 0);
    }

    const bomb = makeRuntime();
    bomb.dataStore.set(API_VERSION_STORE_KEY, { [ORIGIN_A]: "v1" });
    useRuntime(bomb);
    const inflatedBomb = new TextEncoder().encode(JSON.stringify({
        quickCss: "A".repeat(8 * 1024 * 1024),
        settings: {},
    }));
    const compressedBomb = deflateSync(inflatedBomb);
    assert.ok(compressedBomb.byteLength < 8 * 1024 * 1024, "the fixture is a compressed expansion bomb");
    bomb.fetchHandler = async () => new Response(compressedBomb, { headers: { ETag: "1" } });
    assert.equal(await sync.getCloudSettings(true, false), false);
    assert.equal(bomb.dataStore.get(V1_VERSION_STORE_KEY), undefined);
    assert.equal(bomb.quickCssWrites, 0);
    assert.ok(bomb.notifications.some(notification => notification.body === "The cloud returned invalid or oversized settings."));
}

async function testMalformedUrlAndNetworkErrorsRedact(sync: CloudSyncModule): Promise<void> {
    const malformedUrl = makeRuntime();
    malformedUrl.settings.cloud.url = `${ORIGIN_A}/path?secret=${SECRET_SENTINEL}`;
    useRuntime(malformedUrl);
    assert.equal(await sync.putCloudSettings(false), false);
    assert.equal(malformedUrl.requests.length, 0);
    assert.doesNotMatch(JSON.stringify(malformedUrl.logs), new RegExp(SECRET_SENTINEL, "u"));
    assert.doesNotMatch(JSON.stringify(malformedUrl.notifications), new RegExp(SECRET_SENTINEL, "u"));

    const network = makeRuntime();
    useRuntime(network);
    network.fetchHandler = async () => { throw new Error(SECRET_SENTINEL); };
    assert.equal(await sync.putCloudSettings(false), false);
    assert.doesNotMatch(JSON.stringify(network.logs), new RegExp(SECRET_SENTINEL, "u"));
    assert.doesNotMatch(JSON.stringify(network.notifications), new RegExp(SECRET_SENTINEL, "u"));
}

function makeUnauthenticatedRuntime(): Runtime {
    const runtime = makeRuntime();
    runtime.dataStore.set(SECRET_STORE_KEY, {});
    runtime.settings.cloud.authenticated = false;
    return runtime;
}

function oauthConfiguration(origin = ORIGIN_A): Response {
    return jsonResponse({
        clientId: "123456789012345678",
        redirectUri: `${origin}/oauth/redirect`,
    });
}

function oauthCallback(runtime: Runtime): (result: { location?: string; }) => Promise<void> {
    const callback = runtime.modal?.props?.callback;
    assert.equal(typeof callback, "function", "authorization must open the OAuth modal after validating configuration");
    return callback as (result: { location?: string; }) => Promise<void>;
}

async function testAuthorizationScopingAndOAuthOrigins(setup: CloudSetupModule): Promise<void> {
    const scoped = makeRuntime();
    const secrets = scoped.dataStore.get(SECRET_STORE_KEY) as Record<string, string>;
    secrets[cloudScope(ORIGIN_A, USER_B)] = `${AUTH_SECRET}-b`;
    useRuntime(scoped);
    assert.deepEqual(await setup.getCloudRequestContext(), {
        authorization: btoa(`${AUTH_SECRET}:${USER_A}`),
        origin: ORIGIN_A,
        scope: cloudScope(),
        url: new URL(`${ORIGIN_A}/`),
        userId: USER_A,
    });
    scoped.userId = USER_B;
    assert.equal((await setup.getCloudRequestContext()).authorization, btoa(`${AUTH_SECRET}-b:${USER_B}`));

    const crossOriginRedirect = makeUnauthenticatedRuntime();
    useRuntime(crossOriginRedirect);
    crossOriginRedirect.fetchHandler = async request => {
        assert.equal(requestPath(request), "/v1/oauth/settings");
        return oauthConfiguration(ORIGIN_B);
    };
    await setup.authorizeCloud();
    assert.equal(crossOriginRedirect.modal, undefined, "OAuth configuration cannot redirect to another origin");
    assert.deepEqual(crossOriginRedirect.dataStore.get(SECRET_STORE_KEY), {});

    const crossOriginCallback = makeUnauthenticatedRuntime();
    useRuntime(crossOriginCallback);
    crossOriginCallback.fetchHandler = async request => {
        assert.equal(requestPath(request), "/v1/oauth/settings", "a rejected callback must not be fetched");
        return oauthConfiguration();
    };
    await setup.authorizeCloud();
    await oauthCallback(crossOriginCallback)({ location: `${ORIGIN_B}/oauth/callback?code=test` });
    assert.equal(crossOriginCallback.requests.length, 1);
    assert.deepEqual(crossOriginCallback.dataStore.get(SECRET_STORE_KEY), {});

    const credentialedCallback = makeUnauthenticatedRuntime();
    useRuntime(credentialedCallback);
    credentialedCallback.fetchHandler = async request => {
        assert.equal(requestPath(request), "/v1/oauth/settings", "a credentialed callback URL must not be fetched");
        return oauthConfiguration();
    };
    await setup.authorizeCloud();
    await oauthCallback(credentialedCallback)({ location: "https://user:password@cloud-a.example.test/oauth/callback" });
    assert.equal(credentialedCallback.requests.length, 1);
    assert.deepEqual(credentialedCallback.dataStore.get(SECRET_STORE_KEY), {});
}

async function testOAuthContextRaces(setup: CloudSetupModule): Promise<void> {
    for (const race of ["backend", "account", "cancel"] as const) {
        const runtime = makeUnauthenticatedRuntime();
        useRuntime(runtime);
        const callbackStarted = deferred<void>();
        const callbackResponse = deferred<Response>();
        runtime.fetchHandler = async request => {
            if (requestPath(request) === "/v1/oauth/settings") return oauthConfiguration();
            if (requestPath(request) === "/oauth/callback") {
                callbackStarted.resolve();
                return await callbackResponse.promise;
            }
            throw new Error(`Unexpected OAuth request ${request.url}`);
        };
        await setup.authorizeCloud();
        const callbackPromise = oauthCallback(runtime)({ location: `${ORIGIN_A}/oauth/callback?code=test` });
        await callbackStarted.promise;
        if (race === "backend") runtime.settings.cloud.url = ORIGIN_B;
        else if (race === "account") runtime.userId = USER_B;
        else setup.cancelCloudAuthorization();
        callbackResponse.resolve(jsonResponse({ secret: `${race}-stale-secret` }));
        await callbackPromise;
        const secrets = runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>;
        assert.equal(secrets[cloudScope()], undefined, `a delayed ${race} callback must not install credentials`);
        assert.equal(runtime.settings.cloud.authenticated, false);
    }
}

async function testStaleOnlyOAuthCancellationRemovesWrite(setup: CloudSetupModule): Promise<void> {
    const runtime = makeUnauthenticatedRuntime();
    useRuntime(runtime);
    const secret = "stale-only-secret";
    runtime.fetchHandler = async request => {
        if (requestPath(request) === "/v1/oauth/settings") return oauthConfiguration();
        if (requestPath(request) === "/oauth/callback") return jsonResponse({ secret });
        throw new Error(`Unexpected OAuth request ${request.url}`);
    };
    await setup.authorizeCloud();

    const updateStored = deferred<void>();
    const releaseUpdate = deferred<void>();
    let paused = false;
    runtime.afterUpdate = async key => {
        if (key !== SECRET_STORE_KEY || paused) return;
        paused = true;
        updateStored.resolve();
        await releaseUpdate.promise;
    };
    const callbackPromise = oauthCallback(runtime)({ location: `${ORIGIN_A}/oauth/callback?code=test` });
    await updateStored.promise;
    assert.equal((runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()], secret);
    setup.cancelCloudAuthorization();
    releaseUpdate.resolve();
    await callbackPromise;
    assert.equal(
        (runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()],
        undefined,
        "cancellation with no newer same-scope success removes the stale flow's write"
    );
}

async function testNewerFailedOAuthDoesNotPreserveStaleWrite(setup: CloudSetupModule): Promise<void> {
    const runtime = makeUnauthenticatedRuntime();
    useRuntime(runtime);
    const oldResponse = deferred<Response>();
    runtime.fetchHandler = async request => {
        if (requestPath(request) === "/v1/oauth/settings") return oauthConfiguration();
        const code = new URL(request.url).searchParams.get("code");
        if (code === "old") return await oldResponse.promise;
        if (code === "new") return jsonResponse({ secret: `invalid\n${SECRET_SENTINEL}` });
        throw new Error(`Unexpected OAuth request ${request.url}`);
    };

    await setup.authorizeCloud();
    const oldCallback = oauthCallback(runtime);
    const oldPromise = oldCallback({ location: `${ORIGIN_A}/oauth/callback?code=old` });
    await new Promise(resolve => setImmediate(resolve));

    await setup.authorizeCloud();
    const newCallback = oauthCallback(runtime);
    await newCallback({ location: `${ORIGIN_A}/oauth/callback?code=new` });
    oldResponse.resolve(jsonResponse({ secret: "stale-old-secret" }));
    await oldPromise;

    assert.equal((runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()], undefined);
    assert.equal(runtime.settings.cloud.authenticated, false);
    assert.doesNotMatch(JSON.stringify(runtime.logs), new RegExp(SECRET_SENTINEL, "u"));
}

async function testNewerIdenticalOAuthSuccessWins(setup: CloudSetupModule): Promise<void> {
    const runtime = makeUnauthenticatedRuntime();
    useRuntime(runtime);
    const secret = "identical-current-secret";
    const oldResponse = deferred<Response>();
    runtime.fetchHandler = async request => {
        if (requestPath(request) === "/v1/oauth/settings") return oauthConfiguration();
        const code = new URL(request.url).searchParams.get("code");
        if (code === "old") return await oldResponse.promise;
        if (code === "new") return jsonResponse({ secret });
        throw new Error(`Unexpected OAuth request ${request.url}`);
    };

    await setup.authorizeCloud();
    const oldCallback = oauthCallback(runtime);
    const oldPromise = oldCallback({ location: `${ORIGIN_A}/oauth/callback?code=old` });
    await new Promise(resolve => setImmediate(resolve));

    await setup.authorizeCloud();
    const newCallback = oauthCallback(runtime);
    await newCallback({ location: `${ORIGIN_A}/oauth/callback?code=new` });
    assert.equal((runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()], secret);
    oldResponse.resolve(jsonResponse({ secret }));
    await oldPromise;

    assert.equal(
        (runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()],
        secret,
        "a newer same-scope success owns an identical credential"
    );
    assert.equal(runtime.settings.cloud.authenticated, true);
}

async function testQueuedOAuthWriteInterleaves(setup: CloudSetupModule): Promise<void> {
    for (const newerOutcome of ["failed", "identical-success"] as const) {
        const runtime = makeUnauthenticatedRuntime();
        useRuntime(runtime);
        const secret = "queued-identical-secret";
        let configurationCalls = 0;
        runtime.fetchHandler = async request => {
            if (requestPath(request) === "/v1/oauth/settings") {
                configurationCalls++;
                if (configurationCalls === 2 && newerOutcome === "failed") return jsonResponse([]);
                return oauthConfiguration();
            }
            return jsonResponse({ secret });
        };

        await setup.authorizeCloud();
        const oldCallback = oauthCallback(runtime);
        const oldWriteStored = deferred<void>();
        const releaseOldWrite = deferred<void>();
        let paused = false;
        runtime.afterUpdate = async key => {
            if (key !== SECRET_STORE_KEY || paused) return;
            paused = true;
            oldWriteStored.resolve();
            await releaseOldWrite.promise;
        };
        const oldPromise = oldCallback({ location: `${ORIGIN_A}/oauth/callback?code=old-queued` });
        await oldWriteStored.promise;
        assert.equal((runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()], secret);

        runtime.modal = undefined;
        const newerAuthorize = setup.authorizeCloud();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(configurationCalls, 1, "the newer flow waits for the same-scope credential commit queue");
        releaseOldWrite.resolve();
        await oldPromise;
        await newerAuthorize;

        if (newerOutcome === "failed") {
            assert.equal(configurationCalls, 2);
            assert.equal((runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()], undefined,
                "a failed newer queued flow does not preserve the stale flow's write");
            assert.equal(runtime.settings.cloud.authenticated, false);
        } else {
            const newCallback = oauthCallback(runtime);
            await newCallback({ location: `${ORIGIN_A}/oauth/callback?code=new-queued` });
            assert.equal((runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()], secret,
                "a newer queued success owns an identical secret after the stale write is removed");
            assert.equal(runtime.settings.cloud.authenticated, true);
        }
    }
}

async function testMalformedOAuthStateAndBodies(setup: CloudSetupModule): Promise<void> {
    for (const malformed of [null, 17, "not-a-map", [AUTH_SECRET], new Map([[cloudScope(), AUTH_SECRET]]), new Date()] as unknown[]) {
        const runtime = makeUnauthenticatedRuntime();
        runtime.dataStore.set(SECRET_STORE_KEY, malformed);
        useRuntime(runtime);
        assert.equal(await setup.getAuthorization(), undefined, "malformed top-level auth state is treated as unauthenticated");
    }

    for (const malformed of [new Map([[cloudScope(), AUTH_SECRET]]), new Date()] as unknown[]) {
        const runtime = makeUnauthenticatedRuntime();
        runtime.dataStore.set(SECRET_STORE_KEY, malformed);
        useRuntime(runtime);
        runtime.fetchHandler = async request => {
            if (requestPath(request) === "/v1/oauth/settings") return oauthConfiguration();
            return jsonResponse({ secret: "recovered-plain-record-secret" });
        };
        await setup.authorizeCloud();
        await oauthCallback(runtime)({ location: `${ORIGIN_A}/oauth/callback?code=recover` });
        const recovered = runtime.dataStore.get(SECRET_STORE_KEY);
        assert.equal(Object.getPrototypeOf(recovered), Object.prototype);
        assert.deepEqual(recovered, { [cloudScope()]: "recovered-plain-record-secret" });
    }

    const invalidScoped = makeUnauthenticatedRuntime();
    invalidScoped.dataStore.set(SECRET_STORE_KEY, {
        [cloudScope()]: `bad\n${SECRET_SENTINEL}`,
        [ORIGIN_A]: `bad\u0000${SECRET_SENTINEL}`,
    });
    useRuntime(invalidScoped);
    assert.equal(await setup.getAuthorization(), undefined);
    assert.deepEqual(invalidScoped.dataStore.get(SECRET_STORE_KEY), {}, "invalid scoped and legacy auth records are removed");

    const colonScoped = makeUnauthenticatedRuntime();
    colonScoped.dataStore.set(SECRET_STORE_KEY, {
        [cloudScope()]: `prefix:${SECRET_SENTINEL}`,
        [ORIGIN_A]: `legacy:${SECRET_SENTINEL}`,
    });
    useRuntime(colonScoped);
    assert.equal(await setup.getAuthorization(), undefined, "colon-bearing secrets are rejected to keep the encoded credential unambiguous");
    assert.deepEqual(colonScoped.dataStore.get(SECRET_STORE_KEY), {});

    const malformedConfig = makeUnauthenticatedRuntime();
    useRuntime(malformedConfig);
    malformedConfig.fetchHandler = async () => jsonResponse([]);
    await setup.authorizeCloud();
    assert.equal(malformedConfig.modal, undefined);
    assert.equal(malformedConfig.settings.cloud.authenticated, false);

    const cappedConfig = makeUnauthenticatedRuntime();
    useRuntime(cappedConfig);
    cappedConfig.fetchHandler = async () => cancellableResponse({
        headers: { "Content-Length": String(64 * 1024 + 1) },
    });
    await setup.authorizeCloud();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cappedConfig.bodyCancellations, 1, "an oversized OAuth configuration body is cancelled");
    assert.equal(cappedConfig.modal, undefined);

    const cappedCallback = makeUnauthenticatedRuntime();
    useRuntime(cappedCallback);
    cappedCallback.fetchHandler = async request => {
        if (requestPath(request) === "/v1/oauth/settings") return oauthConfiguration();
        return cancellableResponse({ headers: { "Content-Length": String(64 * 1024 + 1) } });
    };
    await setup.authorizeCloud();
    await oauthCallback(cappedCallback)({ location: `${ORIGIN_A}/oauth/callback?code=test` });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cappedCallback.bodyCancellations, 1, "an oversized OAuth callback body is cancelled");
    assert.deepEqual(cappedCallback.dataStore.get(SECRET_STORE_KEY), {});

    const invalidSecret = makeUnauthenticatedRuntime();
    useRuntime(invalidSecret);
    invalidSecret.fetchHandler = async request => {
        if (requestPath(request) === "/v1/oauth/settings") return oauthConfiguration();
        return jsonResponse({ secret: `invalid\n${SECRET_SENTINEL}` });
    };
    await setup.authorizeCloud();
    await oauthCallback(invalidSecret)({ location: `${ORIGIN_A}/oauth/callback?code=test` });
    assert.doesNotMatch(JSON.stringify(invalidSecret.logs), new RegExp(SECRET_SENTINEL, "u"), "invalid OAuth secrets must not be logged");
    assert.deepEqual(invalidSecret.dataStore.get(SECRET_STORE_KEY), {});

    const colonSecret = makeUnauthenticatedRuntime();
    useRuntime(colonSecret);
    colonSecret.fetchHandler = async request => {
        if (requestPath(request) === "/v1/oauth/settings") return oauthConfiguration();
        return jsonResponse({ secret: `invalid:${SECRET_SENTINEL}` });
    };
    await setup.authorizeCloud();
    await oauthCallback(colonSecret)({ location: `${ORIGIN_A}/oauth/callback?code=colon` });
    assert.deepEqual(colonSecret.dataStore.get(SECRET_STORE_KEY), {});
    assert.doesNotMatch(JSON.stringify(colonSecret.logs), new RegExp(SECRET_SENTINEL, "u"));
    assert.doesNotMatch(JSON.stringify(colonSecret.notifications), new RegExp(SECRET_SENTINEL, "u"));
}

async function testExplicitDeletionOnly(sync: CloudSyncModule): Promise<void> {
    const runtime = makeRuntime();
    useRuntime(runtime);
    runtime.fetchHandler = async request => {
        return acknowledgeOrVerifyV2Put(request);
    };
    await sync.putCloudSettings(true);
    assert.equal(runtime.requests.some(request => request.method === "DELETE"), false, "ordinary sync must never purge remote data");

    runtime.requests.length = 0;
    runtime.settings.cloud.settingsSync = false;
    runtime.localStorage.Vencord_settingsDirty = "true";
    runtime.fetchHandler = async request => {
        const pathname = requestPath(request);
        if (pathname === "/v2/manifest") {
            return jsonResponse({
                entries: [
                    { checksum: "settings", key: "settings", version: 1 },
                    { checksum: "quickCss", key: "quickCss", version: 2 },
                ],
            });
        }
        assert.equal(request.method, "DELETE");
        return pendingCancellableResponse({ status: 200 });
    };
    await sync.deleteCloudSettings();
    assert.deepEqual(runtime.requests.map(request => `${request.method} ${requestPath(request)}`).sort(), [
        "DELETE /v1/settings",
        "DELETE /v2/data/quickCss",
        "DELETE /v2/data/settings",
        "GET /v2/manifest",
    ]);
    assert.deepEqual((runtime.dataStore.get(MANIFEST_STORE_KEY) as Record<string, unknown>)[cloudScope()], []);
    assert.equal((runtime.dataStore.get(V1_VERSION_STORE_KEY) as Record<string, number>)[cloudScope()], 0);
    assert.equal(runtime.settings.cloud.settingsSync, false, "explicit settings deletion disables future synchronization");
    assert.equal(runtime.localStorage.Vencord_settingsDirty, undefined);
    assert.ok(runtime.notifications.some(notification => notification.body === "The current backend accepted the visible-settings deletion requests. Settings sync is now disabled."));

    runtime.requests.length = 0;
    runtime.fetchHandler = async request => {
        assert.equal(`${request.method} ${requestPath(request)}`, "DELETE /v1/");
        return pendingCancellableResponse({ status: 200 });
    };
    await sync.eraseAllCloudData();
    assert.deepEqual(runtime.requests.map(request => `${request.method} ${requestPath(request)}`), ["DELETE /v1/"]);
    assert.equal(runtime.settings.cloud.authenticated, false);
    assert.equal((runtime.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope()], undefined);
    assertNoDataStoreBoundary(runtime);
}

async function testDeletionCapturedAccountState(sync: CloudSyncModule): Promise<void> {
    const deletion = makeRuntime();
    const deletionSecrets = deletion.dataStore.get(SECRET_STORE_KEY) as Record<string, string>;
    deletionSecrets[cloudScope(ORIGIN_A, USER_B)] = `${AUTH_SECRET}-b`;
    deletion.settings.cloud.settingsSync = false;
    useRuntime(deletion);
    const manifestStarted = deferred<void>();
    const releaseManifest = deferred<void>();
    deletion.fetchHandler = async request => {
        assert.equal(request.headers.get("Authorization"), btoa(`${AUTH_SECRET}:${USER_A}`));
        if (requestPath(request) === "/v2/manifest") {
            manifestStarted.resolve();
            await releaseManifest.promise;
            return jsonResponse({ entries: [] });
        }
        assert.equal(`${request.method} ${requestPath(request)}`, "DELETE /v1/settings");
        return new Response(null, { status: 200 });
    };
    const deletionOperation = sync.deleteCloudSettings();
    await manifestStarted.promise;
    deletion.userId = USER_B;
    deletion.settings.cloud.authenticated = true;
    deletion.settings.cloud.settingsSync = true;
    releaseManifest.resolve();
    await deletionOperation;
    assert.equal(deletion.settings.cloud.settingsSync, true, "a completed account-A deletion cannot disable account B");
    assert.equal(deletion.settings.cloud.authenticated, true);
    assert.equal(deletionSecrets[cloudScope(ORIGIN_A, USER_B)], `${AUTH_SECRET}-b`);
    assert.equal(deletion.notifications.some(notification => String(notification.body).includes("accepted")), false);

    const erasure = makeRuntime();
    const erasureSecrets = erasure.dataStore.get(SECRET_STORE_KEY) as Record<string, string>;
    erasureSecrets[cloudScope(ORIGIN_A, USER_B)] = `${AUTH_SECRET}-b`;
    erasure.settings.cloud.settingsSync = false;
    useRuntime(erasure);
    const eraseStarted = deferred<void>();
    const eraseResponse = deferred<Response>();
    erasure.fetchHandler = async request => {
        assert.equal(`${request.method} ${requestPath(request)}`, "DELETE /v1/");
        assert.equal(request.headers.get("Authorization"), btoa(`${AUTH_SECRET}:${USER_A}`));
        eraseStarted.resolve();
        return await eraseResponse.promise;
    };
    const eraseOperation = sync.eraseAllCloudData();
    await eraseStarted.promise;
    erasure.userId = USER_B;
    erasure.settings.cloud.authenticated = true;
    erasure.settings.cloud.settingsSync = true;
    eraseResponse.resolve(new Response(null, { status: 200 }));
    await eraseOperation;
    assert.equal((erasure.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope(ORIGIN_A, USER_A)], undefined);
    assert.equal((erasure.dataStore.get(SECRET_STORE_KEY) as Record<string, string>)[cloudScope(ORIGIN_A, USER_B)], `${AUTH_SECRET}-b`);
    assert.equal(erasure.settings.cloud.authenticated, true, "account-B integration state survives account-A erasure completion");
    assert.equal(erasure.settings.cloud.settingsSync, true);
    assert.equal(erasure.notifications.some(notification => String(notification.body).includes("accepted")), false);
}

async function assertPrivacyWarningSource(): Promise<void> {
    const [syncSource, setupSource, tabSource, startupSource] = await Promise.all([
        readFile("src/api/SettingsSync/cloudSync.ts", "utf8"),
        readFile("src/api/SettingsSync/cloudSetup.tsx", "utf8"),
        readFile("src/components/settings/tabs/sync/CloudTab.tsx", "utf8"),
        readFile("src/Vencord.ts", "utf8"),
    ]);
    assert.match(tabSource, /cannot verify or erase automatically/u);
    assert.match(tabSource, /rotate previously synced API keys, passwords, and tokens/u);
    assert.match(tabSource, /retained backups cannot be verified/u);
    assert.match(tabSource, /Old clients may reintroduce data/u);
    assert.match(tabSource, /onClick=\{\(\) => deleteCloudSettings\(\)\}/u);
    assert.match(tabSource, /onConfirm: eraseAllCloudData/u);
    assert.match(tabSource, /Plugin enabled state, structured credential fields[^.]+local DataStore records are never cloud synced/u);
    assert.match(tabSource, /disabled=\{!isAuthenticated\}[\s\S]+?Delete Cloud Settings/u, "deletion depends on account authorization, not sync enablement");
    assert.doesNotMatch(`${syncSource}\n${setupSource}\n${tabSource}`, /migrateCloudPrivacy|purgeLegacyCloudData/u);
    assert.doesNotMatch(tabSource, /legacy (?:data|credentials) (?:were|was|is|are) (?:purged|erased|deleted|removed)/iu);
    assert.match(startupSource, /import \{ getCloudRequestContext, getCloudSyncScope \} from "\.\/api\/SettingsSync\/cloudSetup"/u);
    assert.match(startupSource, /authenticationContext = await getCloudRequestContext\(\)/u, "startup authentication is sourced from a complete current origin/account context");
    assert.match(startupSource, /const currentContext = await getCloudRequestContext\(\)[\s\S]+?currentContext\.scope !== authenticationContext\.scope/u);
    assert.match(startupSource, /SettingsStore\.addGlobalChangeListener\(\(\) => \{\s*markLocalSettingsDirty\(\);/u);
    assert.match(startupSource, /VencordNative\.quickCss\.addChangeListener\(\(\) => \{\s*markLocalSettingsDirty\(\);/u);
    const settingsListener = startupSource.indexOf("SettingsStore.addGlobalChangeListener");
    const quickCssListener = startupSource.indexOf("VencordNative.quickCss.addChangeListener");
    const authLookup = startupSource.indexOf("authenticationContext = await getCloudRequestContext()");
    assert.ok(settingsListener !== -1 && quickCssListener !== -1 && settingsListener < authLookup && quickCssListener < authLookup,
        "local settings and QuickCSS are marked dirty even before cloud authorization succeeds");
}

async function main(): Promise<void> {
    assertPolicyBoundary();
    await assertPrivacyWarningSource();
    installGlobals();
    useRuntime(makeRuntime());

    const root = await mkdtemp(path.join(tmpdir(), "protonn-cord-cloud-privacy-"));
    const restoreFetch = captureFetch();
    try {
        const { setup, sync } = await bundleModules(root);
        await testOutboundV2(sync);
        await testOutboundV1(sync);
        await testInboundV2AndOfficialZeroUploadPull(sync);
        await testInboundV1(sync);
        await testSourcePushDominanceAndBoundedConflicts(sync);
        await testManualZeroUploadRequiresAllLocalAuthority(sync);
        await testPullRejectsChangedManifestWithoutDownload(sync);
        await testScopedManifestAndV1Versions(sync);
        await testMalformedLocalState(sync);
        await testDelayedAccountResponsesAreDiscarded(sync);
        await testMalformedAndCappedResponses(sync);
        await testStrictV1VersionsAndInflateCap(sync);
        await testMalformedUrlAndNetworkErrorsRedact(sync);
        await testAuthorizationScopingAndOAuthOrigins(setup);
        await testOAuthContextRaces(setup);
        await testStaleOnlyOAuthCancellationRemovesWrite(setup);
        await testNewerFailedOAuthDoesNotPreserveStaleWrite(setup);
        await testNewerIdenticalOAuthSuccessWins(setup);
        await testQueuedOAuthWriteInterleaves(setup);
        await testMalformedOAuthStateAndBodies(setup);
        await testExplicitDeletionOnly(sync);
        await testDeletionCapturedAccountState(sync);
        await testInFlightLocalChangesStayDirty(sync);
        await testInFlightMetadataDirtyEventsStayDirty(sync);
    } finally {
        restoreFetch();
        await rm(root, { force: true, recursive: true });
    }

    console.log("CLOUD_SYNC_PRIVACY_REGRESSION_COMPLETE");
}

const completionGuard = setTimeout(() => {
    console.error("CLOUD_SYNC_PRIVACY_REGRESSION_INCOMPLETE");
    process.exitCode = 1;
}, 120_000);

void main().then(() => {
    clearTimeout(completionGuard);
}, error => {
    clearTimeout(completionGuard);
    console.error(error);
    process.exitCode = 1;
});
