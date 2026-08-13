/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MAX_CLOUD_URL_LENGTH = 4096;
const MAX_JSON_DEPTH = 32;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Cloud sync is deliberately limited to these two protocol values. Plugin
 * DataStore records are local-only and may only be moved through an explicit
 * offline export/import chosen by the user.
 */
export const CLOUD_SYNC_VALUE_KEYS = ["settings", "quickCss"] as const;
export type CloudSyncValueKey = typeof CLOUD_SYNC_VALUE_KEYS[number];
const CLOUD_SYNC_VALUE_KEY_SET = new Set<string>(CLOUD_SYNC_VALUE_KEYS);

export function isCloudSyncValueKey(value: unknown): value is CloudSyncValueKey {
    return typeof value === "string" && CLOUD_SYNC_VALUE_KEY_SET.has(value);
}

const CLOUD_SAFE_BOOLEAN_SETTING_KEYS = [
    "mainWindowFrameless",
    "frameless",
    "transparent",
    "winCtrlQ",
    "disableMinSize",
    "winNativeTitleBar",
    "ignoreResetWarning",
] as const;

const MACOS_VIBRANCY_STYLES = new Set([
    "content",
    "fullscreen-ui",
    "header",
    "hud",
    "menu",
    "popover",
    "selection",
    "sidebar",
    "titlebar",
    "tooltip",
    "under-page",
    "window",
]);
const WINDOWS_MATERIALS = new Set(["none", "mica", "tabbed", "acrylic"]);

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue; };

export interface CloudPluginRegistry {
    [pluginName: string]: {
        settings?: {
            def?: Record<string, {
                cloudSync?: boolean;
                isValid?(value: unknown): boolean | string;
                markers?: number[];
                options?: readonly { value: string | number | boolean; }[];
                stickToMarkers?: boolean;
                type?: number;
            }>;
        };
    } | undefined;
}

export interface CloudDocument {
    settings: Record<string, JsonValue>;
    quickCss?: string;
}

function hasControlCharacters(value: string) {
    return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/** Parse the authority used by every cloud request. Cloud backends are origin-only HTTPS endpoints. */
export function parseCloudBackendUrl(value: unknown): URL {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_CLOUD_URL_LENGTH)
        throw new Error("Cloud backend URL must be a non-empty HTTPS URL");
    if (value !== value.trim() || hasControlCharacters(value))
        throw new Error("Cloud backend URL contains invalid characters");

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Cloud backend URL is invalid");
    }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash)
        throw new Error("Cloud backend must be a credential-free HTTPS origin");
    if (url.pathname !== "/")
        throw new Error("Cloud backend URL must not contain a path");

    return new URL(url.origin + "/");
}

function cloneJsonValue(value: unknown, depth = 0): JsonValue | undefined {
    if (depth > MAX_JSON_DEPTH) return undefined;
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

    if (Array.isArray(value)) {
        const output: JsonValue[] = [];
        for (const item of value) {
            const cloned = cloneJsonValue(item, depth + 1);
            if (cloned !== undefined) output.push(cloned);
        }
        return output;
    }

    if (typeof value !== "object") return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) continue;
        const cloned = cloneJsonValue(item, depth + 1);
        if (cloned !== undefined) output[key] = cloned;
    }
    return output;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    return value as Record<string, unknown>;
}

/**
 * Construct the settings subset that is safe to place on a server-readable cloud backend.
 * Plugin settings are deliberately opt-in. Unknown and private settings therefore remain local.
 */
export function sanitizeCloudSettings(value: unknown, pluginRegistry: CloudPluginRegistry = {}): Record<string, JsonValue> {
    const input = getRecord(value);
    if (!input) return {};

    const output: Record<string, JsonValue> = {};
    for (const key of CLOUD_SAFE_BOOLEAN_SETTING_KEYS)
        if (typeof input[key] === "boolean") output[key] = input[key];

    if (typeof input.macosVibrancyStyle === "string" && MACOS_VIBRANCY_STYLES.has(input.macosVibrancyStyle))
        output.macosVibrancyStyle = input.macosVibrancyStyle;
    if (typeof input.windowsMaterial === "string" && WINDOWS_MATERIALS.has(input.windowsMaterial))
        output.windowsMaterial = input.windowsMaterial;

    const inputPlugins = getRecord(input.plugins);
    if (!inputPlugins) return output;

    const safePlugins: Record<string, JsonValue> = {};
    for (const [pluginName, rawPluginSettings] of Object.entries(inputPlugins)) {
        if (!Object.hasOwn(pluginRegistry, pluginName)) continue;
        const plugin = pluginRegistry[pluginName];
        if (!plugin || FORBIDDEN_OBJECT_KEYS.has(pluginName) || pluginName.length > 128) continue;
        const pluginSettings = getRecord(rawPluginSettings);
        if (!pluginSettings) continue;

        const safePlugin: Record<string, JsonValue> = {};
        if (typeof pluginSettings.isFavorite === "boolean") safePlugin.isFavorite = pluginSettings.isFavorite;

        const definitions = plugin.settings?.def;
        if (definitions) {
            for (const [settingName, definition] of Object.entries(definitions)) {
                if (!definition.cloudSync || FORBIDDEN_OBJECT_KEYS.has(settingName)) continue;
                const value = pluginSettings[settingName];
                // Cloud values are server-readable and untrusted on import. Only primitive,
                // schema-checkable option types are eligible for explicit plugin opt-in.
                let typeValid = false;
                switch (definition.type) {
                    case 1: // NUMBER
                        typeValid = typeof value === "number" && Number.isFinite(value);
                        break;
                    case 3: // BOOLEAN
                        typeValid = typeof value === "boolean";
                        break;
                    case 4: // SELECT
                        typeValid = definition.options?.some(option => Object.is(option.value, value)) === true;
                        break;
                    case 5: // SLIDER
                        if (typeof value === "number" && Number.isFinite(value) && definition.markers?.length) {
                            const minimum = Math.min(...definition.markers);
                            const maximum = Math.max(...definition.markers);
                            typeValid = definition.stickToMarkers === false
                                ? value >= minimum && value <= maximum
                                : definition.markers.includes(value);
                        }
                        break;
                }
                const validation = definition.isValid?.call(pluginSettings, value);
                if (!typeValid || validation === false || typeof validation === "string") continue;
                const cloned = cloneJsonValue(value);
                if (cloned !== undefined) safePlugin[settingName] = cloned;
            }
        }

        if (Object.keys(safePlugin).length !== 0) safePlugins[pluginName] = safePlugin;
    }

    output.plugins = safePlugins;
    return output;
}

export function buildCloudDocument(
    settings: unknown,
    quickCss: unknown,
    pluginRegistry: CloudPluginRegistry = {}
): CloudDocument {
    const document: CloudDocument = { settings: sanitizeCloudSettings(settings, pluginRegistry) };
    if (typeof quickCss === "string") document.quickCss = quickCss;
    return document;
}

export function sanitizeCloudDocument(value: unknown, pluginRegistry: CloudPluginRegistry = {}): CloudDocument {
    const input = getRecord(value);
    return buildCloudDocument(input?.settings, input?.quickCss, pluginRegistry);
}
