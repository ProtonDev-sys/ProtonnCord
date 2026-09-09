/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { Logger } from "@utils/Logger";
import { ProfilePreset } from "@vencord/discord-types";
import { showToast, Toasts, UserStore } from "@webpack/common";

const logger = new Logger("ProfilePresets");
const LEGACY_PRESETS_KEY = "ProfileDataset";
const MAIN_PRESETS_KEY = "ProfilePresets_v2_Main";
const SERVER_PRESETS_KEY = "ProfilePresets_v2_Server";

export type PresetSection = "main" | "server";

export type ProfilePresetEx = ProfilePreset & {
    avatarRaw?: string | null;
};

export let presets: ProfilePresetEx[] = [];
export let currentPresetIndex = -1;
let activeScopeKey: string | null = null;
let loadGeneration = 0;
let ready = false;
let saveQueue: Promise<unknown> = Promise.resolve();

export function isProfilePresetList(value: unknown): value is ProfilePresetEx[] {
    return Array.isArray(value) && value.every(preset => {
        if (!preset || typeof preset !== "object" || Array.isArray(preset)
            || typeof preset.name !== "string" || !Number.isFinite(preset.timestamp)) return false;
        for (const field of ["avatarDataUrl", "bannerDataUrl", "avatarRaw", "bio", "globalName", "pronouns", "primaryGuildId"])
            if (preset[field] != null && typeof preset[field] !== "string") return false;
        if (preset.accentColor != null && !Number.isFinite(preset.accentColor)) return false;
        if (preset.themeColors != null && (!Array.isArray(preset.themeColors) || !preset.themeColors.every(Number.isFinite))) return false;
        for (const field of ["avatarDecoration", "profileEffect", "nameplate", "customStatus", "displayNameStyles"])
            if (preset[field] != null && (typeof preset[field] !== "object" || Array.isArray(preset[field]))) return false;
        return true;
    });
}

export function getPresetScope(section: PresetSection) {
    const userId = getCurrentUserId();
    return ready && userId && activeScopeKey === getPresetsKey(section, userId)
        ? `${activeScopeKey}:${loadGeneration}`
        : null;
}

function resetPresets(nextPresets: ProfilePresetEx[] = []) {
    presets = nextPresets;
    currentPresetIndex = -1;
}

function getPresetsKey(section: PresetSection, userId: string) {
    const baseKey = section === "main" ? MAIN_PRESETS_KEY : SERVER_PRESETS_KEY;
    return `${baseKey}:${userId}`;
}

function getLegacyKey(userId: string) {
    return `${LEGACY_PRESETS_KEY}:${userId}:main`;
}

function getCurrentUserId() {
    return UserStore.getCurrentUser()?.id ?? null;
}

function isCurrentLoad(generation: number, key: string) {
    return generation === loadGeneration && activeScopeKey === key;
}

export async function loadPresets(section: PresetSection) {
    ready = false;
    resetPresets();
    const userId = getCurrentUserId();
    if (!userId) {
        activeScopeKey = null;
        loadGeneration++;
        resetPresets();
        return;
    }

    const key = getPresetsKey(section, userId);
    const generation = ++loadGeneration;
    activeScopeKey = key;

    try {
        await saveQueue;
        const stored = await DataStore.get(key);
        if (!isCurrentLoad(generation, key)) return;

        if (stored != null) {
            if (!isProfilePresetList(stored)) throw new Error("Stored presets are invalid; preserved without modification.");
            resetPresets(stored);
            ready = true;
            return;
        }

        if (section === "main") {
            const legacyKey = getLegacyKey(userId);
            const [legacyStored, legacyBaseStored] = await Promise.all([
                DataStore.get(legacyKey),
                DataStore.get(LEGACY_PRESETS_KEY)
            ]);
            if (!isCurrentLoad(generation, key)) return;

            const legacyToUse = isProfilePresetList(legacyStored)
                ? legacyStored
                : (isProfilePresetList(legacyBaseStored) ? legacyBaseStored : null);
            if (legacyToUse) {
                await DataStore.set(key, legacyToUse);
                await DataStore.del(legacyKey);
                await DataStore.del(LEGACY_PRESETS_KEY);
                if (!isCurrentLoad(generation, key)) return;
                resetPresets(legacyToUse);
                ready = true;
                return;
            }
        }
        resetPresets();
        ready = true;
    } catch (err) {
        if (!isCurrentLoad(generation, key)) return;

        logger.error("Failed to load presets", err);
        resetPresets();
    }
}

export async function savePresetsData(section?: PresetSection) {
    const userId = getCurrentUserId();
    const key = section && userId ? getPresetsKey(section, userId) : activeScopeKey;
    if (!ready || !userId || !key || activeScopeKey !== key) return false;
    const snapshot = presets.slice();
    const operation = saveQueue.then(() => DataStore.set(key, snapshot));
    saveQueue = operation.catch(() => { });
    try {
        await operation;
        return true;
    } catch (err) {
        logger.error("Failed to save presets", err);
        showToast("Could not save profile presets. Try again.", Toasts.Type.FAILURE);
        return false;
    }
}

export function setCurrentPresetIndex(index: number) {
    currentPresetIndex = index;
}

export function addPreset(preset: ProfilePresetEx) {
    presets.push(preset);
}

export function updatePreset(index: number, preset: ProfilePresetEx) {
    if (index >= 0 && index < presets.length) {
        presets[index] = preset;
    }
}

export function removePreset(index: number) {
    if (index >= 0 && index < presets.length) {
        presets.splice(index, 1);
        if (currentPresetIndex === index) {
            currentPresetIndex = -1;
        } else if (currentPresetIndex > index) {
            currentPresetIndex--;
        }
    }
}

export function movePresetInArray(fromIndex: number, toIndex: number) {
    if (fromIndex < 0 || fromIndex >= presets.length || toIndex < 0 || toIndex >= presets.length) return;
    const [preset] = presets.splice(fromIndex, 1);
    presets.splice(toIndex, 0, preset);
    if (currentPresetIndex === fromIndex) currentPresetIndex = toIndex;
    else if (fromIndex < currentPresetIndex && currentPresetIndex <= toIndex) currentPresetIndex--;
    else if (toIndex <= currentPresetIndex && currentPresetIndex < fromIndex) currentPresetIndex++;
}

export function replaceAllPresets(newPresets: ProfilePresetEx[]) {
    presets = newPresets;
}
