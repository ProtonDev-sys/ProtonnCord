/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { makeEmptyOverride, SoundOverride } from "./types";

const reservedIds = new Set(["enabled", "isFavorite", "overrides", "__proto__", "constructor", "prototype"]);

export function parseImportedOverrides(text: string): { id: string; override: SoundOverride; }[] {
    const imported = JSON.parse(text);
    if (!imported || !Array.isArray(imported.overrides)) throw new Error("Expected a sound overrides array.");

    return imported.overrides.map((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid sound override.");
        const { id, enabled = false, selectedSound = "default", selectedFileId, volume = 100, useFile = false, ...extra } = entry as Record<string, unknown>;
        if (typeof id !== "string" || !id.trim() || reservedIds.has(id)) throw new Error("Invalid sound identifier.");
        if (typeof enabled !== "boolean" || typeof selectedSound !== "string" || typeof useFile !== "boolean"
            || (selectedFileId != null && typeof selectedFileId !== "string")
            || typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 100) {
            throw new Error(`Invalid override for ${id}.`);
        }

        return { id, override: { ...extra, enabled, selectedSound, selectedFileId: selectedFileId ?? undefined, volume, useFile } };
    });
}

export function exportOverrides(store: Record<string, unknown>, soundIds: readonly string[]) {
    const ids = new Set([...soundIds, ...Object.keys(store)]);
    return Array.from(ids).flatMap(id => {
        if (reservedIds.has(id)) return [];
        const stored = store[id];
        if (stored == null) return soundIds.includes(id) ? [{ ...makeEmptyOverride(), id }] : [];
        try {
            const override = typeof stored === "string" ? JSON.parse(stored) : stored;
            if (!override || typeof override !== "object" || Array.isArray(override)) return [];
            return [{ ...makeEmptyOverride(), ...override, id }];
        } catch {
            return [];
        }
    });
}

export function clearAudioReferences(store: Record<string, unknown>, fileId: string) {
    for (const { id, ...override } of exportOverrides(store, [])) {
        if (override.selectedFileId !== fileId) continue;
        store[id] = JSON.stringify({ ...override, selectedFileId: undefined, selectedSound: "default" });
    }
}
