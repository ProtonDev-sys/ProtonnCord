/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginManifestEntry } from "@shared/pluginDefinition";
import type { PluginTag } from "@utils/types";

export const enum SearchStatus {
    ALL, FAVORITES, ENABLED, DISABLED, EQUICORD, VENCORD, NEW, USER_PLUGINS, API_PLUGINS
}

export interface PluginFilter {
    value: string;
    tags: readonly PluginTag[];
    status: SearchStatus;
}

export interface CatalogCard {
    plugin: Pick<PluginManifestEntry, "name" | "description" | "isModified">;
    enabled: boolean;
    disabled: boolean;
    isNew: boolean;
    hasVisibleSettings: boolean;
    requiredBy?: readonly string[];
}

interface CatalogSource {
    plugins: Record<string, PluginManifestEntry>;
    metadata: Record<string, { folderName: string; userPlugin: boolean; }>;
    isEnabled(name: string): boolean;
    isDependency(name: string): boolean;
    getSettings(name: string): { enabled?: boolean; isFavorite?: boolean; } | undefined;
    hasVisibleSettings(name: string): boolean;
}

interface CatalogView {
    cards: CatalogCard[];
    requiredCards: CatalogCard[];
    matchingPlugins: number;
    enabledPlugins: string[];
    counts: { totalStockPlugins: number; totalUserPlugins: number; enabledStockPlugins: number; enabledUserPlugins: number; };
}

function sameItems<T>(left: readonly T[] | undefined, right: readonly T[] | undefined) {
    return left === right || !!left && !!right && left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Keep the single settings subscription while reusing unchanged list/card output. */
export function createPluginCatalogView(source: CatalogSource) {
    const names = Object.keys(source.plugins);
    const alphabetical = names.toSorted((a, b) => a.localeCompare(b));
    const dependants = new Map<string, string[]>();
    for (const name of names) {
        for (const dependency of source.plugins[name].dependencies ?? []) {
            if (!dependants.has(dependency)) dependants.set(dependency, []);
            dependants.get(dependency)!.push(name);
        }
    }

    const textCache = new Map<string, { description: string; text: string; terms?: readonly string[]; searchTerms?: string[]; }>();
    const nameCache = new Map(names.map(name => [name, { name: name.toLowerCase(), acronym: name.match(/[A-Z]/g)?.join("").toLowerCase() ?? "" }]));
    const cardCache = new Map<string, CatalogCard>();
    let previous: CatalogView | undefined;
    let previousFavorites = new Set<string>();
    let ordered = alphabetical;

    function matchesText(plugin: PluginManifestEntry, search: string, compactSearch: string) {
        const name = nameCache.get(plugin.name)!;
        if (name.name.includes(compactSearch) || name.acronym.includes(search)) return true;
        const { description } = plugin;
        let cached = textCache.get(plugin.name);
        if (!cached || cached.description !== description) {
            cached = { description, text: description.toLowerCase() };
            textCache.set(plugin.name, cached);
        }
        if (cached.text.includes(search)) return true;
        const terms = plugin.searchTerms ?? [];
        if (!sameItems(cached.terms, terms)) {
            cached.terms = [...terms];
            cached.searchTerms = terms.map(term => term.toLowerCase());
        }
        return cached.searchTerms!.some(term => term.includes(search));
    }

    function read(filter: PluginFilter, newPlugins: ReadonlySet<string> | null, limit: number): CatalogView {
        const enabled = new Set<string>();
        const favorites = new Set<string>();
        const enabledPlugins: string[] = [];
        let totalStockPlugins = 0;
        let totalUserPlugins = 0;
        let enabledStockPlugins = 0;
        let enabledUserPlugins = 0;

        for (const name of names) {
            const plugin = source.plugins[name];
            const { userPlugin } = source.metadata[name];
            if (source.isEnabled(name)) enabled.add(name);
            if (source.getSettings(name)?.isFavorite) favorites.add(name);
            if (name.endsWith("API") || plugin.required) continue;
            if (userPlugin) totalUserPlugins++;
            else if (!plugin.hidden) totalStockPlugins++;
            if (!enabled.has(name)) continue;
            enabledPlugins.push(name);
            if (userPlugin) enabledUserPlugins++;
            else if (!plugin.hidden) enabledStockPlugins++;
        }

        const search = filter.value.toLowerCase();
        const compactSearch = search.replace(/\s+/g, "");
        const ordinary: string[] = [];
        const required: string[] = [];
        const activeDependants = new Map<string, string[] | undefined>();
        // A stable partition retains alphabetical ordering within both favorite groups.
        if (favorites.size !== previousFavorites.size || [...favorites].some(name => !previousFavorites.has(name))) {
            ordered = [...alphabetical.filter(name => favorites.has(name)), ...alphabetical.filter(name => !favorites.has(name))];
            previousFavorites = favorites;
        }
        for (const name of ordered) {
            const plugin = source.plugins[name];
            const meta = source.metadata[name];
            if (plugin.hidden || !plugin.hasSettings && name.endsWith("API") && filter.status !== SearchStatus.API_PLUGINS) continue;
            switch (filter.status) {
                case SearchStatus.FAVORITES: if (!favorites.has(name)) continue; break;
                case SearchStatus.ENABLED: if (!enabled.has(name)) continue; break;
                case SearchStatus.DISABLED: if (enabled.has(name)) continue; break;
                case SearchStatus.EQUICORD: if (!meta.folderName.startsWith("src/equicordplugins/")) continue; break;
                case SearchStatus.VENCORD: if (!meta.folderName.startsWith("src/plugins/")) continue; break;
                case SearchStatus.NEW: if (!newPlugins?.has(name)) continue; break;
                case SearchStatus.USER_PLUGINS: if (!meta.userPlugin) continue; break;
                case SearchStatus.API_PLUGINS: if (!name.endsWith("API")) continue; break;
            }
            if (filter.tags.some(tag => !plugin.tags?.includes(tag))) continue;
            if (search && !matchesText(plugin, search, compactSearch)) continue;
            const active = dependants.get(name)?.filter(dependant => enabled.has(dependant));
            if (plugin.required || source.isDependency(name) || active?.length) {
                required.push(name);
                activeDependants.set(name, plugin.required ? undefined : active);
            } else ordinary.push(name);
        }

        function card(name: string, disabled: boolean): CatalogCard {
            const plugin = source.plugins[name];
            const { description, isModified } = plugin;
            const isEnabled = enabled.has(name);
            const isNew = !disabled && !!newPlugins?.has(name);
            const requiredBy = activeDependants.get(name);
            const hasVisibleSettings = plugin.hasVisibleSettings ?? source.hasVisibleSettings(name);
            const old = cardCache.get(name);
            if (old && old.plugin.description === description && old.plugin.isModified === isModified
                && old.enabled === isEnabled && old.disabled === disabled && old.isNew === isNew
                && old.hasVisibleSettings === hasVisibleSettings && sameItems(old.requiredBy, requiredBy)) return old;
            const next: CatalogCard = {
                plugin: { name, description, isModified }, enabled: isEnabled, disabled, isNew, hasVisibleSettings, requiredBy
            };
            cardCache.set(name, next);
            return next;
        }

        const cards = ordinary.slice(0, limit).map(name => card(name, false));
        const requiredCards = required.map(name => card(name, true));
        const counts = { totalStockPlugins, totalUserPlugins, enabledStockPlugins, enabledUserPlugins };
        if (previous && previous.matchingPlugins === ordinary.length && sameItems(previous.cards, cards)
            && sameItems(previous.requiredCards, requiredCards) && sameItems(previous.enabledPlugins, enabledPlugins)
            && Object.keys(counts).every(key => previous!.counts[key] === counts[key])) return previous;
        return previous = {
            cards: sameItems(previous?.cards, cards) ? previous!.cards : cards,
            requiredCards: sameItems(previous?.requiredCards, requiredCards) ? previous!.requiredCards : requiredCards,
            matchingPlugins: ordinary.length,
            enabledPlugins: sameItems(previous?.enabledPlugins, enabledPlugins) ? previous!.enabledPlugins : enabledPlugins,
            counts
        };
    }

    return { read };
}
