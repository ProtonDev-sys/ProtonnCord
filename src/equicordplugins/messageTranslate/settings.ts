/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

const ID_REGEX = /^\d{17,20}$/;

let ignoredGuildIds = new Set<string>();
let ignoredChannelIds = new Set<string>();
let ignoredUserIds = new Set<string>();
let idCachesInitialized = false;

function parseIdList(value: string): Set<string> {
    const ids = new Set<string>();

    for (const rawId of value.split(",")) {
        const id = rawId.trim();
        if (ID_REGEX.test(id)) ids.add(id);
    }

    return ids;
}

function validateIdList(value: string) {
    if (!value) return true;

    for (const rawId of value.split(",")) {
        const id = rawId.trim();
        if (!id) continue;
        if (!ID_REGEX.test(id)) return `${id} isn't a valid Discord id`;
    }

    return true;
}

export function refreshIgnoredIdCaches() {
    ignoredGuildIds = parseIdList(settings.store.ignoredGuilds);
    ignoredChannelIds = parseIdList(settings.store.ignoredChannels);
    ignoredUserIds = parseIdList(settings.store.ignoredUsers);
    idCachesInitialized = true;
}

export const settings = definePluginSettings({
    targetLanguage: {
        type: OptionType.STRING,
        description: "Target language code for translations (e.g. en, es, fr, de, ja).",
        default: "en",
    },
    confidenceRequirement: {
        type: OptionType.NUMBER,
        description: "Minimum confidence (0 to 1) required to show a translation.",
        default: 0.8,
    },
    autoTranslate: {
        type: OptionType.BOOLEAN,
        description: "Automatically translate messages as they appear.",
        default: true,
    },
    skipOwnMessages: {
        type: OptionType.BOOLEAN,
        description: "Do not translate your own messages.",
        default: true,
    },
    skipBotMessages: {
        type: OptionType.BOOLEAN,
        description: "Do not translate bot messages.",
        default: false,
    },
    ignoredGuilds: {
        type: OptionType.STRING,
        description: "Comma-separated list of server IDs to not translate in.",
        onChange: value => {
            ignoredGuildIds = parseIdList(value);
            idCachesInitialized = true;
        },
        isValid: validateIdList,
        default: "",
    },
    ignoredChannels: {
        type: OptionType.STRING,
        description: "Comma-separated list of channel IDs to not translate in.",
        onChange: value => {
            ignoredChannelIds = parseIdList(value);
            idCachesInitialized = true;
        },
        isValid: validateIdList,
        default: "",
    },
    ignoredUsers: {
        type: OptionType.STRING,
        description: "Comma-separated list of user IDs to not translate.",
        onChange: value => {
            ignoredUserIds = parseIdList(value);
            idCachesInitialized = true;
        },
        isValid: validateIdList,
        default: "",
    },
    showIndicator: {
        type: OptionType.BOOLEAN,
        description: "Append a small (translated) indicator to translated messages.",
        default: true,
    },
});

export function getIgnoredGuilds(): Set<string> {
    if (!idCachesInitialized) refreshIgnoredIdCaches();
    return ignoredGuildIds;
}

export function getIgnoredChannels(): Set<string> {
    if (!idCachesInitialized) refreshIgnoredIdCaches();
    return ignoredChannelIds;
}

export function getIgnoredUsers(): Set<string> {
    if (!idCachesInitialized) refreshIgnoredIdCaches();
    return ignoredUserIds;
}
