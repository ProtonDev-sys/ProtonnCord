/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type KnownPluginSettingsMap = Map<string, Set<string>>;

function toStringSet(value: unknown): Set<string> {
    if (value instanceof Set) {
        return new Set(Array.from(value, String));
    }

    if (Array.isArray(value)) {
        return new Set(value.map(String));
    }

    if (typeof value === "string") {
        return new Set([value]);
    }

    return new Set();
}

export function normalizeKnownSettings(value: unknown): KnownPluginSettingsMap {
    const normalized: KnownPluginSettingsMap = new Map();
    const addEntry = (plugin: unknown, settings: unknown) => {
        if (typeof plugin !== "string") return;
        normalized.set(plugin, toStringSet(settings));
    };

    if (value instanceof Map) {
        value.forEach((settings, plugin) => addEntry(plugin, settings));
    } else if (Array.isArray(value)) {
        value.forEach(entry => {
            if (!Array.isArray(entry)) return;
            addEntry(entry[0], entry[1]);
        });
    } else if (value && typeof value === "object") {
        Object.entries(value).forEach(([plugin, settings]) => addEntry(plugin, settings));
    }

    return normalized;
}

export function serializeKnownSettings(settings: KnownPluginSettingsMap): [string, string[]][] {
    return Array.from(settings, ([plugin, pluginSettings]) => [plugin, Array.from(pluginSettings)]);
}

export function isSerializedKnownSettings(value: unknown): value is [string, string[]][] {
    return Array.isArray(value) && value.every(entry => (
        Array.isArray(entry)
        && typeof entry[0] === "string"
        && Array.isArray(entry[1])
        && entry[1].every(setting => typeof setting === "string")
    ));
}

export function getNewSettings(
    currentSettings: KnownPluginSettingsMap,
    knownSettings: KnownPluginSettingsMap,
): KnownPluginSettingsMap {
    const newSettings: KnownPluginSettingsMap = new Map();

    currentSettings.forEach((pluginSettings, plugin) => {
        const knownPluginSettings = knownSettings.get(plugin);
        const addedSettings = new Set(
            Array.from(pluginSettings).filter(setting => !knownPluginSettings?.has(setting)),
        );
        if (addedSettings.size) newSettings.set(plugin, addedSettings);
    });

    return newSettings;
}

export function isNotifiablePlugin(plugin: { hidden?: boolean; required?: boolean; }): boolean {
    return !plugin.hidden && !plugin.required;
}
