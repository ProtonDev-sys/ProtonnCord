/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";

import { PluginManifest as plugins } from "~plugins";

import {
    getNewSettings as getNewSettingsFromSnapshots,
    isNotifiablePlugin,
    isSerializedKnownSettings,
    KnownPluginSettingsMap,
    normalizeKnownSettings,
    serializeKnownSettings,
} from "./knownSettingsData";

export type { KnownPluginSettingsMap } from "./knownSettingsData";

export const KNOWN_PLUGINS_LEGACY_DATA_KEY = "NewPluginsManager_KnownPlugins";
export const KNOWN_SETTINGS_DATA_KEY = "NewPluginsManager_KnownSettings";
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => undefined);
    return result;
}

function getSettingsSetForPlugin(plugin: string): Set<string> {
    return new Set((plugins[plugin]?.settingsKeys ?? []).filter(setting => setting !== "enabled"));
}

function getCurrentSettings(pluginList: string[]): KnownPluginSettingsMap {
    return new Map(pluginList.map(name => [
        name,
        getSettingsSetForPlugin(name)
    ]));
}

async function persistKnownSettings(settings: KnownPluginSettingsMap): Promise<void> {
    await DataStore.set(KNOWN_SETTINGS_DATA_KEY, serializeKnownSettings(settings));
}

async function readKnownSettings(): Promise<KnownPluginSettingsMap> {
    const raw = await DataStore.get<unknown>(KNOWN_SETTINGS_DATA_KEY);

    if (raw == null) {
        const legacyData = await DataStore.get<unknown>(KNOWN_PLUGINS_LEGACY_DATA_KEY);
        const knownPlugins = Array.isArray(legacyData)
            ? legacyData.filter((plugin): plugin is string => typeof plugin === "string")
            : [];
        const settings = getCurrentSettings([...new Set([...Object.keys(plugins), ...knownPlugins])]);
        await persistKnownSettings(settings);
        return settings;
    }

    const settings = normalizeKnownSettings(raw);
    if (!isSerializedKnownSettings(raw)) await persistKnownSettings(settings);
    return settings;
}

export function getKnownSettings(): Promise<KnownPluginSettingsMap> {
    return enqueue(readKnownSettings);
}

export async function getNewPluginChanges(): Promise<{
    newPlugins: Set<string>;
    newSettings: KnownPluginSettingsMap;
}> {
    const currentSettings = getCurrentSettings(Object.keys(plugins));
    const knownSettings = await getKnownSettings();
    const knownPlugins = new Set(knownSettings.keys());
    const newPlugins = new Set(Object.keys(plugins).filter(plugin => (
        !knownPlugins.has(plugin) && isNotifiablePlugin(plugins[plugin])
    )));

    return {
        newPlugins,
        newSettings: getNewSettingsFromSnapshots(currentSettings, knownSettings),
    };
}

export async function getNewSettings(): Promise<KnownPluginSettingsMap> {
    return (await getNewPluginChanges()).newSettings;
}

export async function getKnownPlugins(): Promise<Set<string>> {
    const knownSettings = await getKnownSettings();
    return new Set(knownSettings.keys());
}

export async function getNewPlugins(): Promise<Set<string>> {
    return (await getNewPluginChanges()).newPlugins;
}

export async function writeKnownSettings(): Promise<void> {
    await enqueue(async () => {
        const known = await readKnownSettings();
        for (const [plugin, current] of getCurrentSettings(Object.keys(plugins))) {
            known.set(plugin, new Set([...(known.get(plugin) ?? []), ...current]));
        }
        await persistKnownSettings(known);
    });
}

export async function editRawData(
    patcher: (data: KnownPluginSettingsMap) => Promise<void> | void,
): Promise<void> {
    await enqueue(async () => {
        const settings = await readKnownSettings();
        const patchedSettings = new Map(
            Array.from(settings, ([plugin, pluginSettings]) => [plugin, new Set(pluginSettings)]),
        );
        await patcher(patchedSettings);
        await persistKnownSettings(patchedSettings);
    });
}
