/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { Settings } from "@api/Settings";
import { localStorage } from "@utils/localStorage";
import { Logger } from "@utils/Logger";
import { relaunch } from "@utils/native";
import { SettingsRouter } from "@webpack/common";
import { deflateSync, Inflate } from "fflate";

import plugins from "~plugins";

import {
    buildCloudDocument,
    type CloudPluginRegistry,
    sanitizeCloudDocument,
    sanitizeCloudSettings,
} from "./cloudPolicy";
import {
    cancelCloudAuthorization,
    type CloudRequestContext,
    deauthorizeCloud,
    getCloudRequestContext,
    getCloudSyncScope,
    getCloudUrl,
} from "./cloudSetup";
import { importSettings } from "./offline";
import { ManifestEntry, SyncRequest, SyncResponse } from "./types";

const logger = new Logger("SettingsSync:Cloud", "#39b7e0");
const cloudPluginRegistry = plugins as CloudPluginRegistry;

const API_VERSION_STORE_KEY = "Vencord_cloudApiVersions";
const MANIFEST_STORE_KEY = "Vencord_cloudManifest";
const V1_VERSION_STORE_KEY = "Vencord_cloudV1Versions";
const MAX_CLOUD_VALUE_BYTES = 4 * 1024 * 1024;
const MAX_CLOUD_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 4096;
const CLOUD_KEYS = new Set(["settings", "quickCss"]);
const MAX_ENCODED_VALUE_LENGTH = Math.ceil(MAX_CLOUD_VALUE_BYTES / 3) * 4;

type ApiVersion = "v2" | "v1";

const SYNC_DIRECTION_KEY = "Vencord_cloudSyncDirection";
const SETTINGS_DIRTY_KEY = "Vencord_settingsDirty";
let localSettingsRevision = 0;
export const getCloudSyncDirection = () => localStorage.getItem(SYNC_DIRECTION_KEY) || "both";
export const setCloudSyncDirection = (direction: "push" | "pull" | "both" | "manual") => localStorage.setItem(SYNC_DIRECTION_KEY, direction);
export const areLocalSettingsDirty = () => localStorage.getItem(SETTINGS_DIRTY_KEY) === "true";
export const markLocalSettingsDirty = () => {
    localSettingsRevision++;
    localStorage.setItem(SETTINGS_DIRTY_KEY, "true");
};
export const markLocalSettingsClean = () => localStorage.removeItem(SETTINGS_DIRTY_KEY);

function isRecord(value: unknown): value is Record<string, unknown> {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cancelBody(response: Response) {
    void response.body?.cancel().catch(() => { });
}

async function readBoundedBytes(response: Response, maxBytes = MAX_CLOUD_DOCUMENT_BYTES): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
        cancelBody(response);
        throw new Error("Cloud response exceeded the allowed size");
    }
    if (!response.body) return new Uint8Array();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw new Error("Cloud response exceeded the allowed size");
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => { });
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

async function readBoundedJson(response: Response, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBytes(response, maxBytes)));
    } catch {
        throw new Error("Cloud response was invalid");
    }
}

function toBase64(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
    return btoa(binary);
}

function fromBase64(value: unknown): Uint8Array {
    if (typeof value !== "string" || value.length > MAX_ENCODED_VALUE_LENGTH) throw new Error("Invalid cloud payload");
    const binary = atob(value);
    if (binary.length > MAX_CLOUD_VALUE_BYTES) throw new Error("Cloud payload exceeded the allowed size");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function checksum(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
    return Array.from(new Uint8Array(digest, 0, 8), byte => byte.toString(16).padStart(2, "0")).join("");
}

function isSafeChecksum(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{16}$/u.test(value);
}

function isSafeVersion(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function patchMatches(current: unknown, patch: unknown): boolean {
    if (Array.isArray(patch)) {
        return Array.isArray(current) && patch.length === current.length &&
            patch.every((item, index) => patchMatches(current[index], item));
    }
    if (isRecord(patch)) {
        if (!isRecord(current)) return false;
        return Object.entries(patch).every(([key, value]) => patchMatches(current[key], value));
    }
    return Object.is(current, patch);
}

function encodeCloudValue(value: string): Uint8Array {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > MAX_CLOUD_VALUE_BYTES) throw new Error("Cloud value exceeded the allowed size");
    return bytes;
}

function inflateBounded(data: Uint8Array, maxBytes: number, signal: AbortSignal): Uint8Array {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const stream = new Inflate(chunk => {
        total += chunk.byteLength;
        if (total > maxBytes) throw new Error("Cloud document exceeded the allowed size");
        chunks.push(chunk);
    });

    const inputChunkSize = 1024;
    for (let offset = 0; offset < data.byteLength; offset += inputChunkSize) {
        if (signal.aborted) throw new Error("Cloud operation was cancelled");
        const end = Math.min(offset + inputChunkSize, data.byteLength);
        stream.push(data.subarray(offset, end), end === data.byteLength);
    }
    if (data.byteLength === 0) stream.push(data, true);

    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function projectManifest(value: unknown): ManifestEntry[] | null {
    if (!Array.isArray(value) || value.length > MAX_MANIFEST_ENTRIES) return null;
    const output: ManifestEntry[] = [];
    const keys = new Set<string>();
    for (const raw of value) {
        if (!isRecord(raw) || typeof raw.key !== "string" || !CLOUD_KEYS.has(raw.key)) continue;
        const { key, checksum, version } = raw;
        if (
            keys.has(key) || !isSafeChecksum(checksum) || !isSafeVersion(version)
        ) return null;
        keys.add(key);
        output.push({ key, checksum, version });
    }
    return output;
}

function projectSyncResponse(value: unknown): SyncResponse | null {
    if (!isRecord(value)) return null;
    const manifest = projectManifest(value.server_manifest);
    if (!manifest || !Array.isArray(value.downloads) || !Array.isArray(value.uploaded) || !Array.isArray(value.errors))
        return null;
    if (value.downloads.length > MAX_MANIFEST_ENTRIES || value.uploaded.length > MAX_MANIFEST_ENTRIES || value.errors.length > MAX_MANIFEST_ENTRIES)
        return null;

    const manifestByKey = new Map(manifest.map(entry => [entry.key, entry]));
    const downloadKeys = new Set<string>();
    const downloads: SyncResponse["downloads"] = [];
    for (const raw of value.downloads) {
        if (!isRecord(raw) || typeof raw.key !== "string") return null;
        if (!CLOUD_KEYS.has(raw.key)) continue;
        const manifestEntry = manifestByKey.get(raw.key);
        if (
            downloadKeys.has(raw.key) || !manifestEntry ||
            typeof raw.value !== "string" || raw.value.length > MAX_ENCODED_VALUE_LENGTH ||
            !isSafeChecksum(raw.checksum) || !isSafeVersion(raw.version) ||
            raw.checksum !== manifestEntry.checksum || raw.version !== manifestEntry.version
        ) return null;
        downloadKeys.add(raw.key);
        downloads.push({ key: raw.key, value: raw.value, checksum: raw.checksum, version: raw.version });
    }

    const uploadedKeys = new Set<string>();
    const uploaded: SyncResponse["uploaded"] = [];
    for (const raw of value.uploaded) {
        if (!isRecord(raw) || typeof raw.key !== "string") return null;
        if (!CLOUD_KEYS.has(raw.key)) continue;
        const manifestEntry = manifestByKey.get(raw.key);
        if (
            uploadedKeys.has(raw.key) || !manifestEntry ||
            !isSafeChecksum(raw.checksum) || !isSafeVersion(raw.version) ||
            raw.checksum !== manifestEntry.checksum || raw.version !== manifestEntry.version
        ) return null;
        uploadedKeys.add(raw.key);
        uploaded.push({ key: raw.key, checksum: raw.checksum, version: raw.version });
    }

    // Remote error text and keys are intentionally not retained or logged.
    const errors: SyncResponse["errors"] = value.errors.map(() => ({ key: "", error: "remote sync error" }));
    return { server_manifest: manifest, downloads, uploaded, errors };
}

function isCurrentContext(context: CloudRequestContext) {
    try {
        return getCloudUrl().origin === context.origin && getCloudSyncScope() === context.scope && Settings.cloud.authenticated && Settings.cloud.settingsSync;
    } catch {
        return false;
    }
}

function isCurrentAccountContext(context: CloudRequestContext) {
    try {
        return getCloudUrl().origin === context.origin && getCloudSyncScope() === context.scope && Settings.cloud.authenticated;
    } catch {
        return false;
    }
}

async function getScopedRecord<T>(key: string): Promise<Record<string, T>> {
    const value = await DataStore.get<Record<string, T>>(key);
    return isRecord(value) ? value as Record<string, T> : {};
}

async function getApiVersion(origin: string): Promise<ApiVersion> {
    const map = await getScopedRecord<ApiVersion>(API_VERSION_STORE_KEY);
    return map[origin] === "v1" ? "v1" : "v2";
}

async function setApiVersion(origin: string, version: ApiVersion) {
    await DataStore.update<Record<string, ApiVersion>>(API_VERSION_STORE_KEY, value => {
        const map = isRecord(value) ? value : {};
        map[origin] = version;
        return map;
    });
}

async function getManifest(scope: string): Promise<ManifestEntry[]> {
    const map = await getScopedRecord<unknown>(MANIFEST_STORE_KEY);
    return projectManifest(map[scope]) ?? [];
}

async function saveManifest(scope: string, manifest: ManifestEntry[]) {
    const safe = projectManifest(manifest);
    if (!safe) throw new Error("Refusing to save an invalid cloud manifest");
    await DataStore.update<Record<string, ManifestEntry[]>>(MANIFEST_STORE_KEY, value => {
        const map = isRecord(value) ? value as Record<string, ManifestEntry[]> : {};
        map[scope] = safe;
        return map;
    });
}

async function getV1Version(scope: string) {
    const map = await getScopedRecord<number>(V1_VERSION_STORE_KEY);
    return isSafeVersion(map[scope]) ? map[scope] : 0;
}

async function setV1Version(scope: string, version: number) {
    await DataStore.update<Record<string, number>>(V1_VERSION_STORE_KEY, value => {
        const map = isRecord(value) ? value as Record<string, number> : {};
        map[scope] = isSafeVersion(version) ? version : 0;
        return map;
    });
}

async function buildLocalData() {
    return new Map<string, Uint8Array>([
        ["settings", encodeCloudValue(canonicalJson(sanitizeCloudSettings(VencordNative.settings.get(), cloudPluginRegistry)))],
        ["quickCss", encodeCloudValue(await VencordNative.quickCss.get())],
    ]);
}

async function checksumsFor(data: Map<string, Uint8Array>) {
    const result = new Map<string, string>();
    for (const [key, value] of data) result.set(key, await checksum(value));
    return result;
}

async function localSnapshotMatches(context: CloudRequestContext, expected: Map<string, string>, expectedRevision: number) {
    if (!isCurrentContext(context) || localSettingsRevision !== expectedRevision) return false;
    try {
        const current = await checksumsFor(await buildLocalData());
        return isCurrentContext(context) && localSettingsRevision === expectedRevision && expected.size === current.size &&
            Array.from(expected).every(([key, value]) => current.get(key) === value);
    } catch {
        return false;
    }
}

interface ApplyResult {
    accepted: boolean;
    changed: boolean;
}

async function applyDownloads(downloads: SyncResponse["downloads"], context: CloudRequestContext): Promise<ApplyResult> {
    let changed = false;
    for (const download of downloads) {
        if (!isCurrentContext(context)) return { accepted: false, changed };

        let bytes: Uint8Array;
        try {
            bytes = fromBase64(download.value);
            if (await checksum(bytes) !== download.checksum) return { accepted: false, changed };
        } catch {
            return { accepted: false, changed };
        }

        if (download.key === "settings") {
            try {
                const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
                const safe = sanitizeCloudSettings(parsed, cloudPluginRegistry);
                if (patchMatches(VencordNative.settings.get(), safe)) continue;
                if (!isCurrentContext(context)) return { accepted: false, changed };
                await importSettings(JSON.stringify({ settings: safe }), "all", true);
                changed = true;
            } catch {
                return { accepted: false, changed };
            }
        } else {
            try {
                const css = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                if (await VencordNative.quickCss.get() === css) continue;
                if (!isCurrentContext(context)) return { accepted: false, changed };
                await VencordNative.quickCss.set(css);
                changed = true;
            } catch {
                return { accepted: false, changed };
            }
        }
    }
    return { accepted: isCurrentContext(context), changed };
}

function handleAuthFailure(context: CloudRequestContext) {
    if (!isCurrentContext(context)) return;
    Settings.cloud.authenticated = false;
    showNotification({
        title: "Cloud Settings",
        body: "Cloud sync was disabled because this account is not connected. Reconnect in Cloud Settings.",
        color: "var(--yellow-360)",
        onClick: () => SettingsRouter.openUserSettings("equicord_cloud_panel"),
    });
}

async function doSyncV2(
    context: CloudRequestContext,
    uploads: SyncRequest["uploads"],
    clientManifest: ManifestEntry[],
    signal: AbortSignal
): Promise<SyncResponse | null> {
    if (!isCurrentContext(context) || signal.aborted) return null;
    let response: Response;
    try {
        response = await fetch(new URL("/v2/sync", context.url), {
            method: "POST",
            headers: { Authorization: context.authorization, "Content-Type": "application/json" },
            body: JSON.stringify({ client_manifest: clientManifest, uploads } satisfies SyncRequest),
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal,
        });
    } catch {
        logger.error("V2 cloud sync network error");
        return null;
    }

    if (response.status === 404) {
        cancelBody(response);
        await setApiVersion(context.origin, "v1");
        return null;
    }
    if (response.status === 401) {
        cancelBody(response);
        handleAuthFailure(context);
        return null;
    }
    if (!response.ok) {
        cancelBody(response);
        logger.error("Cloud sync returned an HTTP error");
        return null;
    }

    try {
        return projectSyncResponse(await readBoundedJson(response));
    } catch {
        logger.error("Cloud sync returned an invalid or oversized response");
        return null;
    }
}

async function verifyV2SourceSnapshot(
    context: CloudRequestContext,
    localChecksums: Map<string, string>,
    signal: AbortSignal
) {
    if (!isCurrentContext(context) || signal.aborted) return null;
    let response: Response;
    try {
        response = await fetch(new URL("/v2/manifest", context.url), {
            headers: { Authorization: context.authorization },
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal,
        });
    } catch {
        return null;
    }
    if (!response.ok) {
        cancelBody(response);
        return null;
    }

    let manifest: ManifestEntry[] | null = null;
    try {
        const value = await readBoundedJson(response);
        manifest = isRecord(value) ? projectManifest(value.entries) : null;
    } catch { }
    if (!manifest || !isCurrentContext(context)) return null;

    return manifest;
}

async function putV2(context: CloudRequestContext, signal: AbortSignal, manual = false, retried = false): Promise<boolean> {
    const localRevision = localSettingsRevision;
    const manifest = await getManifest(context.scope);
    const byKey = new Map(manifest.map(entry => [entry.key, entry]));
    const local = await buildLocalData();
    const localChecksums = await checksumsFor(local);
    const uploads: SyncRequest["uploads"] = [];

    for (const [key, value] of local) {
        const valueChecksum = localChecksums.get(key)!;
        if (byKey.get(key)?.checksum !== valueChecksum)
            uploads.push({ key, value: toBase64(value), checksum: valueChecksum });
    }

    if (uploads.length === 0 && !manual) {
        const unchanged = await localSnapshotMatches(context, localChecksums, localRevision);
        if (unchanged) markLocalSettingsClean();
        else markLocalSettingsDirty();
        return unchanged;
    }

    const response = await doSyncV2(context, uploads, manifest, signal);
    if (!response || !isCurrentContext(context)) return false;

    if (response.errors.length !== 0) {
        logger.error(`Cloud reported ${response.errors.length} sync error(s); details were redacted`);
        if (!retried && response.downloads.some(download => isRecord(download) && uploads.some(upload => upload.key === download.key))) {
            await saveManifest(context.scope, response.server_manifest);
            return await putV2(context, signal, manual, true);
        }
        markLocalSettingsDirty();
        return false;
    }

    // A put is a local/source operation. Never apply bundled server values. If the server
    // reports a stale non-uploaded key, establish its manifest then retry our local snapshot.
    if (!retried && response.downloads.some(download => isRecord(download) && CLOUD_KEYS.has(download.key))) {
        await saveManifest(context.scope, response.server_manifest);
        return await putV2(context, signal, manual, true);
    }
    if (!isCurrentContext(context)) return false;

    const uploaded = new Map(response.uploaded.map(entry => [entry.key, entry.checksum]));
    const authoritative = new Map(response.server_manifest.map(entry => [entry.key, entry.checksum]));
    const responseAcknowledged = uploads.every(upload =>
        uploaded.get(upload.key) === upload.checksum && authoritative.get(upload.key) === upload.checksum
    ) && Array.from(localChecksums).every(([key, valueChecksum]) => authoritative.get(key) === valueChecksum);
    if (!responseAcknowledged) {
        markLocalSettingsDirty();
        return false;
    }

    // The V2 response manifest is built from a pre-write server snapshot, so it cannot prove
    // that another client did not race a non-uploaded key. Verify in a fresh request before clean.
    const verifiedManifest = await verifyV2SourceSnapshot(context, localChecksums, signal);
    if (!verifiedManifest) {
        markLocalSettingsDirty();
        return false;
    }
    await saveManifest(context.scope, verifiedManifest);
    const verifiedChecksums = new Map(verifiedManifest.map(entry => [entry.key, entry.checksum]));
    const remoteMatches = Array.from(localChecksums).every(([key, value]) => verifiedChecksums.get(key) === value);
    const acknowledged = remoteMatches && await localSnapshotMatches(context, localChecksums, localRevision);
    if (acknowledged) markLocalSettingsClean();
    else markLocalSettingsDirty();

    return acknowledged;
}

async function getV2(context: CloudRequestContext, signal: AbortSignal, shouldNotify: boolean, force: boolean) {
    const manifest = force ? [] : await getManifest(context.scope);
    const response = await doSyncV2(context, [], manifest, signal);
    if (!response) {
        if (shouldNotify && await getApiVersion(context.origin) === "v2" && isCurrentContext(context))
            showNotification({ title: "Cloud Settings", body: "Could not read settings from the cloud.", color: "var(--red-360)", noPersist: true });
        return false;
    }
    if (!isCurrentContext(context)) return false;
    if (response.errors.length !== 0) {
        if (shouldNotify) showNotification({ title: "Cloud Settings", body: "The cloud reported an error while reading settings.", color: "var(--red-360)", noPersist: true });
        return false;
    }

    const previous = new Map(manifest.map(entry => [entry.key, entry]));
    const downloadedKeys = new Set(response.downloads.map(download => download.key));
    const complete = response.server_manifest.every(entry => {
        const existing = previous.get(entry.key);
        return existing?.checksum === entry.checksum && existing.version === entry.version || downloadedKeys.has(entry.key);
    });
    if (!complete) {
        if (shouldNotify) showNotification({ title: "Cloud Settings", body: "The cloud returned an incomplete settings snapshot.", color: "var(--red-360)", noPersist: true });
        return false;
    }

    const applied = await applyDownloads(response.downloads, context);
    if (!applied.accepted || !isCurrentContext(context)) {
        if (shouldNotify && isCurrentContext(context))
            showNotification({ title: "Cloud Settings", body: "The cloud returned invalid settings data.", color: "var(--red-360)", noPersist: true });
        return false;
    }
    await saveManifest(context.scope, response.server_manifest);

    if (shouldNotify) {
        showNotification({
            title: "Cloud Settings",
            body: applied.changed ? "Your settings were updated; restart to fully apply changes." : "Your settings are up to date.",
            color: applied.changed ? "var(--green-360)" : undefined,
            onClick: applied.changed ? (IS_WEB ? () => location.reload() : relaunch) : undefined,
            noPersist: true,
        });
    }
    return applied.changed;
}

async function putV1(context: CloudRequestContext, signal: AbortSignal) {
    if (!isCurrentContext(context) || signal.aborted) return false;
    const localRevision = localSettingsRevision;
    const local = await buildLocalData();
    const localChecksums = await checksumsFor(local);
    const document = buildCloudDocument(
        JSON.parse(new TextDecoder().decode(local.get("settings")!)),
        new TextDecoder().decode(local.get("quickCss")!),
        cloudPluginRegistry
    );
    if (!isCurrentContext(context) || signal.aborted) return false;

    const documentBytes = new TextEncoder().encode(canonicalJson(document));
    if (documentBytes.byteLength > MAX_CLOUD_DOCUMENT_BYTES) return false;
    const compressed = deflateSync(documentBytes);
    if (compressed.byteLength > MAX_CLOUD_DOCUMENT_BYTES) return false;

    const response = await fetch(new URL("/v1/settings", context.url), {
        method: "PUT",
        headers: { Authorization: context.authorization, "Content-Type": "application/octet-stream" },
        body: compressed as Uint8Array<ArrayBuffer>,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal,
    });
    if (!response.ok) {
        cancelBody(response);
        return false;
    }

    let payload: unknown;
    try {
        payload = await readBoundedJson(response, 64 * 1024);
    } catch {
        return false;
    }
    if (!isRecord(payload) || !isSafeVersion(payload.written) || !isCurrentContext(context)) {
        markLocalSettingsDirty();
        return false;
    }
    await setV1Version(context.scope, Number(payload.written));
    const unchanged = await localSnapshotMatches(context, localChecksums, localRevision);
    if (unchanged) markLocalSettingsClean();
    else markLocalSettingsDirty();
    return unchanged;
}

async function getV1(context: CloudRequestContext, signal: AbortSignal, shouldNotify: boolean, force: boolean) {
    if (!isCurrentContext(context) || signal.aborted) return false;
    const response = await fetch(new URL("/v1/settings", context.url), {
        headers: {
            Authorization: context.authorization,
            Accept: "application/octet-stream",
            "If-None-Match": force ? "" : String(await getV1Version(context.scope)),
        },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal,
    });

    if (response.status === 401) {
        cancelBody(response);
        handleAuthFailure(context);
        return false;
    }
    if (response.status === 404 || response.status === 304) {
        cancelBody(response);
        if (shouldNotify) showNotification({
            title: "Cloud Settings",
            body: response.status === 404 ? "There are no settings on this cloud backend." : "Your settings are up to date.",
            noPersist: true,
        });
        return false;
    }
    if (!response.ok) {
        cancelBody(response);
        if (shouldNotify) showNotification({ title: "Cloud Settings", body: "Could not read settings from the cloud.", color: "var(--red-360)", noPersist: true });
        return false;
    }

    const etagHeader = response.headers.get("etag");
    const etag = etagHeader !== null && /^(?:0|[1-9]\d*)$/u.test(etagHeader) ? Number(etagHeader) : NaN;
    if (!isSafeVersion(etag)) {
        cancelBody(response);
        if (shouldNotify) showNotification({ title: "Cloud Settings", body: "The cloud returned an invalid settings version.", color: "var(--red-360)", noPersist: true });
        return false;
    }

    let document;
    try {
        const compressed = await readBoundedBytes(response, MAX_CLOUD_DOCUMENT_BYTES);
        const inflated = inflateBounded(compressed, MAX_CLOUD_DOCUMENT_BYTES, signal);
        document = sanitizeCloudDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inflated)), cloudPluginRegistry);
    } catch {
        if (shouldNotify) showNotification({ title: "Cloud Settings", body: "The cloud returned invalid or oversized settings.", color: "var(--red-360)", noPersist: true });
        return false;
    }
    if (!isCurrentContext(context)) return false;

    const currentQuickCss = await VencordNative.quickCss.get();
    let changed = false;
    if (!patchMatches(VencordNative.settings.get(), document.settings)) {
        if (!isCurrentContext(context)) return false;
        await importSettings(JSON.stringify({ settings: document.settings }), "all", true);
        changed = true;
    }
    if (document.quickCss !== undefined && currentQuickCss !== document.quickCss) {
        if (!isCurrentContext(context)) return false;
        await VencordNative.quickCss.set(document.quickCss);
        changed = true;
    }
    if (!isCurrentContext(context)) return false;

    await setV1Version(context.scope, etag);
    if (shouldNotify) {
        showNotification({
            title: "Cloud Settings",
            body: changed ? "Your settings were updated; restart to fully apply changes." : "Your settings are up to date.",
            color: changed ? "var(--green-360)" : undefined,
            onClick: changed ? (IS_WEB ? () => location.reload() : relaunch) : undefined,
            noPersist: true,
        });
    }
    return changed;
}

async function deleteV2(context: CloudRequestContext, signal: AbortSignal) {
    const manifestResponse = await fetch(new URL("/v2/manifest", context.url), {
        headers: { Authorization: context.authorization },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal,
    });
    if (manifestResponse.status === 404) {
        cancelBody(manifestResponse);
        return true;
    }
    if (!manifestResponse.ok) {
        cancelBody(manifestResponse);
        return false;
    }

    let entries: ManifestEntry[];
    try {
        const payload = await readBoundedJson(manifestResponse);
        if (!isRecord(payload) || !Array.isArray(payload.entries) || payload.entries.length > MAX_MANIFEST_ENTRIES) return false;
        entries = payload.entries.filter(isRecord).map(entry => ({
            key: typeof entry.key === "string" ? entry.key : "",
            checksum: "",
            version: 0,
        })).filter(entry => entry.key && entry.key !== "." && entry.key !== ".." && entry.key.length <= 512);
        if (entries.length !== payload.entries.length) return false;
    } catch {
        return false;
    }

    let index = 0;
    const failures: unknown[] = [];
    const workers = await Promise.allSettled(Array.from({ length: Math.min(8, entries.length) }, async () => {
        while (index < entries.length) {
            const entry = entries[index++];
            const response = await fetch(new URL(`/v2/data/${encodeURIComponent(entry.key)}`, context.url), {
                method: "DELETE",
                headers: { Authorization: context.authorization },
                redirect: "error",
                credentials: "omit",
                cache: "no-store",
                signal,
            });
            cancelBody(response);
            if (!response.ok && response.status !== 404) failures.push(response.status);
        }
    }));
    return failures.length === 0 && workers.every(result => result.status === "fulfilled");
}

async function deleteV1(context: CloudRequestContext, signal: AbortSignal) {
    const response = await fetch(new URL("/v1/settings", context.url), {
        method: "DELETE",
        headers: { Authorization: context.authorization },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal,
    });
    cancelBody(response);
    return response.ok || response.status === 404;
}

let operationQueue = Promise.resolve();

export async function runCloudOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = operationQueue;
    let release!: () => void;
    operationQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        return await operation(controller.signal);
    } finally {
        clearTimeout(timeout);
        release();
    }
}

async function putUnlocked(manual: boolean, signal: AbortSignal) {
    const context = await getCloudRequestContext();
    if (!isCurrentContext(context)) return false;
    const version = await getApiVersion(context.origin);
    if (version === "v2") {
        const result = await putV2(context, signal, manual);
        if (await getApiVersion(context.origin) === "v1") return await putV1(context, signal);
        return result;
    }
    return await putV1(context, signal);
}

export const putCloudSettings = (manual = false) => runCloudOperation(async signal => {
    try {
        const succeeded = await putUnlocked(manual, signal);
        if (manual) showNotification({
            title: "Cloud Settings",
            body: succeeded ? "Settings synchronized to the cloud." : "Could not synchronize every setting to the cloud.",
            color: succeeded ? "var(--green-360)" : "var(--red-360)",
            noPersist: true,
        });
        return succeeded;
    } catch {
        logger.error("Cloud upload failed");
        showNotification({ title: "Cloud Settings", body: "Could not synchronize settings to the cloud.", color: "var(--red-360)" });
        return false;
    }
});

async function getUnlocked(shouldNotify: boolean, force: boolean, signal: AbortSignal) {
    const context = await getCloudRequestContext();
    if (!isCurrentContext(context)) return false;
    const version = await getApiVersion(context.origin);
    if (version === "v2") {
        const result = await getV2(context, signal, shouldNotify, force);
        if (await getApiVersion(context.origin) === "v1") return await getV1(context, signal, shouldNotify, force);
        return result;
    }
    return await getV1(context, signal, shouldNotify, force);
}

export const getCloudSettings = (shouldNotify = true, force = false) =>
    runCloudOperation(async signal => {
        try {
            return await getUnlocked(shouldNotify, force, signal);
        } catch {
            logger.error("Cloud download failed");
            showNotification({ title: "Cloud Settings", body: "Could not synchronize settings from the cloud.", color: "var(--red-360)" });
            return false;
        }
    });

export const deleteCloudSettings = () => {
    const contextPromise = getCloudRequestContext();
    void contextPromise.catch(() => { });
    return runCloudOperation(async signal => {
        try {
            const context = await contextPromise;
            const v2 = await deleteV2(context, signal);
            const v1 = await deleteV1(context, signal);
            if (!v1 || !v2) {
                if (isCurrentAccountContext(context))
                    showNotification({ title: "Cloud Settings", body: "Some cloud settings could not be deleted.", color: "var(--red-360)" });
                return;
            }
            await saveManifest(context.scope, []);
            await setV1Version(context.scope, 0);
            if (isCurrentAccountContext(context)) {
                Settings.cloud.settingsSync = false;
                markLocalSettingsClean();
                showNotification({ title: "Cloud Settings", body: "The current backend accepted the visible-settings deletion requests. Settings sync is now disabled.", color: "var(--green-360)" });
            }
        } catch {
            logger.error("Cloud settings deletion failed");
            try {
                if (isCurrentAccountContext(await contextPromise))
                    showNotification({ title: "Cloud Settings", body: "Could not delete cloud settings.", color: "var(--red-360)" });
            } catch { }
        }
    });
};

export const eraseAllCloudData = () => {
    cancelCloudAuthorization();
    const contextPromise = getCloudRequestContext();
    void contextPromise.catch(() => { });
    return runCloudOperation(async signal => {
        try {
            const context = await contextPromise;
            const response = await fetch(new URL("/v1/", context.url), {
                method: "DELETE",
                headers: { Authorization: context.authorization },
                redirect: "error",
                credentials: "omit",
                cache: "no-store",
                signal,
            });
            cancelBody(response);
            if (!response.ok) {
                if (isCurrentAccountContext(context))
                    showNotification({ title: "Cloud Integrations", body: "Could not erase all cloud data.", color: "var(--red-360)" });
                return;
            }
            await deauthorizeCloud(context.origin, context.userId);
            await saveManifest(context.scope, []);
            await setV1Version(context.scope, 0);
            if (isCurrentAccountContext(context)) {
                Settings.cloud.authenticated = false;
                Settings.cloud.settingsSync = false;
                showNotification({ title: "Cloud Integrations", body: "The current backend accepted the account-erasure request.", color: "var(--green-360)" });
            }
        } catch {
            logger.error("Cloud account erasure failed");
            try {
                if (isCurrentAccountContext(await contextPromise))
                    showNotification({ title: "Cloud Integrations", body: "Could not erase all cloud data.", color: "var(--red-360)" });
            } catch { }
        }
    });
};

export function shouldCloudSync(direction: "push" | "pull") {
    const selected = localStorage.Vencord_cloudSyncDirection;
    return selected === direction || selected === "both";
}
