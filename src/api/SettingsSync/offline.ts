/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PlainSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { chooseFile, saveFile } from "@utils/web";
import { moment, Toasts } from "@webpack/common";

import { DataStore } from "..";

type BackupType = "all" | "plugins" | "css" | "datastore";
type BackupKey = string | number | BackupKey[];
interface Backup {
    settings?: typeof PlainSettings;
    quickCss?: string;
    dataStore?: [IDBValidKey, unknown][];
}

const logger = new Logger("SettingsSync:Offline", "#39b7e0");
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
let importing = false;

const toast = (type: string, message: string) =>
    Toasts.show({ type, message, id: Toasts.genId() });

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isSafeJson(value: unknown): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return Object.keys(value).length === value.length && Array.from(value).every(isSafeJson);
    return isRecord(value) && Reflect.ownKeys(value).every(key =>
        typeof key === "string" && !forbiddenKeys.has(key) && isSafeJson(value[key])
    );
}

function isBackupKey(value: unknown): value is BackupKey {
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
        || (Array.isArray(value) && value.every(isBackupKey));
}

function isDataStoreBackup(value: unknown): value is [BackupKey, unknown][] {
    if (!Array.isArray(value)) return false;
    const keys = new Set<string>();
    return value.every(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || !isBackupKey(entry[0]) || !isSafeJson(entry[1])) return false;
        const key = JSON.stringify(entry[0]);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
    });
}

function deepMerge(target: object, source: Record<string, unknown>) {
    for (const [key, value] of Object.entries(source)) {
        if (isRecord(value)) {
            const current: unknown = Reflect.get(target, key);
            const nested = isRecord(current) ? current : {};
            Reflect.set(target, key, nested);
            deepMerge(nested, value);
        } else {
            Reflect.set(target, key, value);
        }
    }
}

export async function importSettings(data: string, type: BackupType = "all") {
    if (importing) throw new Error("Wait for the current import to finish.");
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch {
        throw new Error("The backup is not valid JSON.");
    }
    if (!isRecord(parsed)) throw new Error("The backup must contain a JSON object.");
    if (!isSafeJson(parsed)) throw new Error("The backup contains unsupported values or reserved object keys.");
    if (!["all", "plugins", "css", "datastore"].includes(type)) throw new Error("Unknown backup type.");
    const settings = type === "all" || type === "plugins" ? parsed.settings : undefined;
    const quickCss = type === "all" || type === "css" ? parsed.quickCss : undefined;
    const dataStore = type === "all" || type === "datastore" ? parsed.dataStore : undefined;
    if ((type === "all" || type === "plugins") && !isRecord(settings)) throw new Error("Settings are missing or invalid.");
    if (isRecord(settings)) {
        for (const key of ["plugins", "cloud", "notifications", "uiElements", "themeNames", "themeActivationModes"]) {
            if (Object.hasOwn(settings, key) && !isRecord(settings[key])) throw new Error("Invalid settings section: " + key + ".");
        }
        if (isRecord(settings.plugins)) {
            for (const plugin of Object.values(settings.plugins)) {
                if (!isRecord(plugin)) throw new Error("Invalid plugin settings.");
                for (const key of ["enabled", "isFavorite"]) {
                    if (Object.hasOwn(plugin, key) && typeof plugin[key] !== "boolean") throw new Error("Invalid plugin setting: " + key + ".");
                }
            }
        }
    }
    if ((type === "css" || quickCss !== undefined) && typeof quickCss !== "string") throw new Error("QuickCSS is missing or invalid.");
    const entries = isDataStoreBackup(dataStore) ? dataStore : undefined;
    if ((type === "datastore" || dataStore !== undefined) && !entries) throw new Error("DataStore entries are missing or invalid.");

    importing = true;
    const completed: string[] = [];
    try {
        if (isRecord(settings)) {
            const next = structuredClone(PlainSettings);
            deepMerge(next, settings);
            await VencordNative.settings.set(next);
            deepMerge(PlainSettings, settings);
            completed.push("settings");
        }
        if (typeof quickCss === "string") {
            await VencordNative.quickCss.set(quickCss);
            completed.push("QuickCSS");
        }
        if (entries) {
            await DataStore.setMany(typeof quickCss === "string" ? entries.filter(([key]) => key !== "VencordQuickCss") : entries);
            completed.push("DataStore");
        }
    } catch (cause) {
        throw new Error(completed.length
            ? `Import stopped after saving ${completed.join(" and ")}. Those changes remain applied.`
            : "The import could not be saved.", { cause });
    } finally {
        importing = false;
    }
}

export async function exportSettings({ type = "all", minify }: { type?: BackupType; minify?: boolean; } = {}) {
    const backup: Backup = {};
    if (!["all", "plugins", "css", "datastore"].includes(type)) throw new Error("Unknown backup type.");
    if (type === "all" || type === "plugins") backup.settings = VencordNative.settings.get();
    if (type === "all" || type === "css") backup.quickCss = await VencordNative.quickCss.get();
    if (type === "all" || type === "datastore") {
        const entries = (await DataStore.entries()).filter(([key]) => key !== "VencordQuickCss");
        if (!isDataStoreBackup(entries)) throw new Error("DataStore contains values that cannot be restored from a JSON backup. Export settings or QuickCSS separately.");
        backup.dataStore = entries;
    }
    return JSON.stringify(backup, null, minify ? undefined : 4);
}

export async function downloadSettingsBackup(type: BackupType = "all", { minify }: { minify?: boolean; } = {}) {
    try {
        const backup = await exportSettings({ minify, type });
        const filename = `protonncord-${type}-backup-${moment().format("YYYY-MM-DD")}.json`;
        const data = new TextEncoder().encode(backup);
        if (IS_DISCORD_DESKTOP) {
            await DiscordNative.fileManager.saveWithDialog(data, filename);
        } else {
            saveFile(new File([data], filename, { type: "application/json" }));
        }
    } catch (err) {
        logger.error("Failed to export settings:", err);
        toast(Toasts.Type.FAILURE, `Failed to export settings: ${String(err)}`);
    }
}

export async function uploadSettingsBackup(type: BackupType = "all"): Promise<void> {
    try {
        let data: Uint8Array | ArrayBuffer;
        if (IS_DISCORD_DESKTOP) {
            const [file] = await DiscordNative.fileManager.openFiles({
                filters: [
                    { name: "Protonn Cord Settings Backup", extensions: ["json"] },
                    { name: "all", extensions: ["*"] }
                ]
            });
            if (!file) return;
            data = file.data;
        } else {
            const file = await chooseFile("application/json");
            if (!file) return;
            data = await file.arrayBuffer();
        }
        await importSettings(new TextDecoder("utf-8", { fatal: true }).decode(data), type);
        toast(Toasts.Type.SUCCESS, "Settings successfully imported. Restart to apply changes!");
    } catch (err) {
        logger.error("Failed to import settings:", err);
        toast(Toasts.Type.FAILURE, `Failed to import settings: ${String(err)}`);
    }
}
