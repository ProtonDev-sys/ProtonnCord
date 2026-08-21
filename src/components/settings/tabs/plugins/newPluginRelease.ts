/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface NewPluginRelease {
    plugins: readonly string[];
    version: string;
}

export const NEW_PLUGIN_RELEASE = {
    plugins: [],
    version: "1.15.1.5",
} as const satisfies NewPluginRelease;

export function getReleaseNewPlugins(
    version: string,
    availablePluginNames: Iterable<string>,
): Set<string> | null {
    if (version !== NEW_PLUGIN_RELEASE.version) return null;

    const available = new Set(availablePluginNames);
    const plugins = NEW_PLUGIN_RELEASE.plugins.filter(plugin => available.has(plugin));
    return plugins.length > 0 ? new Set(plugins) : null;
}
