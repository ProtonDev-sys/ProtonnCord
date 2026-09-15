/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Plugin, PluginDef } from "@utils/types";

import pluginApiDependencies from "./pluginApiDependencies.json";

export interface PluginManifestEntry extends Pick<PluginDef,
    "name" | "description" | "required" | "enabledByDefault" | "dependencies" | "startAt" | "requiresRestart" | "hidden" | "tags" | "searchTerms" | "isModified"> {
    hasPatches: boolean;
    hasSettings: boolean;
    hasVisibleSettings?: boolean;
    settingsKeys: string[];
    eager: boolean;
}

const definitions = new Map<string, Plugin>();
const initialized = new WeakSet<Plugin>();
let initializeDefinition: ((plugin: Plugin) => void) | undefined;

export function getLoadedPluginDefinition(name: string): Plugin | undefined {
    return definitions.get(name);
}

/** Called for both catalog loads and direct imports; the original object keeps its identity. */
export function registerPluginDefinition<P extends Plugin>(plugin: P): P {
    definitions.set(plugin.name, plugin);
    if (plugin.settings) plugin.settings.pluginName = plugin.name;
    initialize(plugin);
    return plugin;
}

function initialize(plugin: Plugin) {
    if (!initializeDefinition || initialized.has(plugin)) return;
    initialized.add(plugin);
    try {
        initializeDefinition(plugin);
    } catch (error) {
        initialized.delete(plugin);
        throw error;
    }
}

export function getLoadedPluginNames(): string[] {
    return [...definitions.keys()];
}

export function createPluginCatalog(loaders: Record<string, () => Plugin>): Record<string, Plugin> {
    const catalog: Record<string, Plugin> = {};
    for (const [name, load] of Object.entries(loaders)) {
        let definition: Plugin | undefined;
        Object.defineProperty(catalog, name, {
            enumerable: true,
            configurable: true,
            get: () => definition ??= load(),
            set: (value: Plugin) => { definition = value; }
        });
    }
    return catalog;
}

export function setPluginDefinitionInitializer(initializer: (plugin: Plugin) => void) {
    initializeDefinition = initializer;
    for (const plugin of definitions.values()) initialize(plugin);
}

export function getPluginDependencies(plugin: PluginDef): string[] {
    const dependencies = new Set(plugin.dependencies);
    for (const [property, dependency] of Object.entries(pluginApiDependencies)) {
        const value = plugin[property as keyof PluginDef];
        if (value && (!Array.isArray(value) || value.length)) dependencies.add(dependency);
    }
    if (!plugin.dependencies?.includes(plugin.name)) dependencies.delete(plugin.name);
    return [...dependencies];
}

/** Dynamic or side-effectful definitions remain eager and supply their own metadata. */
export function describePlugin(plugin: Plugin): PluginManifestEntry {
    return {
        get name() { return plugin.name; },
        get description() { return plugin.description; },
        get required() { return plugin.required; },
        get enabledByDefault() { return plugin.enabledByDefault; },
        get startAt() { return plugin.startAt; },
        get requiresRestart() { return plugin.requiresRestart; },
        get hidden() { return plugin.hidden; },
        get tags() { return plugin.tags; },
        get searchTerms() { return plugin.searchTerms; },
        get isModified() { return plugin.isModified; },
        get dependencies() { return getPluginDependencies(plugin); },
        get hasPatches() { return !!plugin.patches?.length; },
        get hasSettings() { return !!plugin.settings?.def; },
        get hasVisibleSettings() {
            const visibility = plugin.settings && Object.values(plugin.settings.def).map(setting => {
                const hidden = Object.getOwnPropertyDescriptor(setting, "hidden");
                if (hidden?.get || typeof hidden?.value === "function" || !hidden && "hidden" in setting) return undefined;
                return !hidden?.value;
            });
            return visibility?.includes(true) ? true : visibility?.includes(undefined) ? undefined : false;
        },
        get settingsKeys() { return Object.keys(plugin.settings?.def ?? {}); },
        eager: true
    };
}
