/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { isObject } from "@utils/misc";

import type { RpcConfig } from ".";

const PRESETS_KEY = "CustomRPC_presets";
const STRING_KEYS = [
    "appID", "appName", "details", "detailsURL", "state", "stateURL", "streamLink",
    "imageBig", "imageBigURL", "imageBigTooltip", "imageSmall", "imageSmallURL", "imageSmallTooltip",
    "buttonOneText", "buttonOneURL", "buttonTwoText", "buttonTwoURL"
] as const;
const NUMBER_KEYS = ["startTime", "endTime", "partySize", "partyMaxSize"] as const;
export const RPC_CONFIG_KEYS: (keyof RpcConfig)[] = [...STRING_KEYS, ...NUMBER_KEYS, "type", "timestampMode"];

export type RpcStringKey = typeof STRING_KEYS[number];
export type RpcNumberKey = typeof NUMBER_KEYS[number];

export interface RpcPreset {
    name: string;
    config: RpcConfig;
}

export function readRpcConfig(value: unknown): RpcConfig {
    if (!isObject(value)) throw new Error("Preset settings must be an object.");
    const source = value as Record<string, unknown>;
    const config: RpcConfig = {};
    for (const key of STRING_KEYS) {
        const field = source[key];
        if (field === undefined) continue;
        if (typeof field !== "string") throw new Error(`Invalid preset field: ${key}.`);
        config[key] = field;
    }
    for (const key of NUMBER_KEYS) {
        const field = source[key];
        if (field === undefined) continue;
        if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0
            || ((key === "startTime" || key === "endTime") && field > 8.64e15))
            throw new Error(`Invalid preset field: ${key}.`);
        config[key] = field;
    }
    const { type, timestampMode } = source;
    if (type !== undefined) {
        if (type !== 0 && type !== 1 && type !== 2 && type !== 3 && type !== 5)
            throw new Error("Invalid preset activity type.");
        config.type = type;
    }
    if (timestampMode !== undefined) {
        if (timestampMode !== 0 && timestampMode !== 1 && timestampMode !== 2 && timestampMode !== 3)
            throw new Error("Invalid preset timestamp mode.");
        config.timestampMode = timestampMode;
    }
    return config;
}

export function applyRpcConfig(target: RpcConfig, value: unknown) {
    const config = readRpcConfig(value);
    for (const key of RPC_CONFIG_KEYS) Object.assign(target, { [key]: config[key] });
}

function readPresets(value: unknown): RpcPreset[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("Saved presets must be a list.");
    const names = new Set<string>();
    return value.map((preset: unknown) => {
        if (!isObject(preset) || !("name" in preset) || typeof preset.name !== "string"
            || !preset.name.trim() || names.has(preset.name) || !("config" in preset))
            throw new Error("A saved preset is invalid.");
        names.add(preset.name);
        return { name: preset.name, config: readRpcConfig(preset.config) };
    });
}

export async function loadPresets() {
    return readPresets(await DataStore.get<unknown>(PRESETS_KEY));
}

export async function savePreset(name: string, value: unknown) {
    name = name.trim();
    if (!name) throw new Error("Enter a preset name.");
    const config = readRpcConfig(value);
    await DataStore.update<unknown>(PRESETS_KEY, old => [
        ...readPresets(old).filter(preset => preset.name !== name), { name, config }
    ].sort((a, b) => a.name.localeCompare(b.name)));
}

export async function deletePreset(name: string) {
    await DataStore.update<unknown>(PRESETS_KEY, old => readPresets(old).filter(preset => preset.name !== name));
}
