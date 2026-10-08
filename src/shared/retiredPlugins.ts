/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Explicit retirements; the historical catalog fixture remains unchanged. */
export const retiredPlugins = {
    HideChatButtons: { replacement: "CollapsibleUI", settings: ["color", "open"] },
    NoMiddleClickPaste: { replacement: "MiddleClickTweaks", settings: [] },
} as const;

interface SavedPlugin {
    enabled: boolean;
    isFavorite?: boolean;
    [key: string]: unknown;
}

interface SavedSettings {
    plugins: Record<string, SavedPlugin>;
    pluginRetirements?: Record<string, string>;
}

/** Retain old namespaces for recovery; explicit replacement choices take precedence. */
export function migrateRetiredPlugins(settings: SavedSettings): boolean {
    let changed = false;
    for (const [name, { replacement }] of Object.entries(retiredPlugins)) {
        const previous = settings.plugins[name];
        if (!previous || settings.pluginRetirements?.[name] === replacement) continue;

        const target = settings.plugins[replacement] ??= { enabled: previous.enabled === true };
        if (typeof previous.isFavorite === "boolean" && !Object.hasOwn(target, "isFavorite"))
            target.isFavorite = previous.isFavorite;

        if (name === "HideChatButtons") {
            if (!Object.hasOwn(target, "chatButtonsCollapsed"))
                target.chatButtonsCollapsed = !(previous.open ?? previous.Open ?? false);
            if (!Object.hasOwn(target, "chatButtonsColor"))
                target.chatButtonsColor = previous.color ?? previous.Color ?? false;
        } else if (!Object.hasOwn(target, "pasteScope")) {
            target.pasteScope = "always";
        }

        (settings.pluginRetirements ??= {})[name] = replacement;
        changed = true;
    }
    return changed;
}
