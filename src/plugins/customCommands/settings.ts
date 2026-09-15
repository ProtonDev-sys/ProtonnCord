/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { registerTagCommand } from ".";
import { SettingsTagList } from "./SettingsTagList";

export const settings = definePluginSettings({
    tagsList: {
        type: OptionType.CUSTOM,
        description: "",
        default: {} as Record<string, Tag>,
    },
    tagComponent: {
        type: OptionType.COMPONENT,
        component: SettingsTagList
    }
});

export interface Tag {
    name: string;
    message: string;
}

export function getTags(tags: unknown = settings.store.tagsList): Tag[] {
    if (!tags || typeof tags !== "object" || Array.isArray(tags)) return [];
    return Object.entries(tags).flatMap(([name, tag]: [string, unknown]) => {
        if (!tag || typeof tag !== "object" || !("name" in tag) || tag.name !== name || !("message" in tag) || typeof tag.message !== "string") return [];
        return [{ name, message: tag.message }];
    });
}

export function getTag(name: string) {
    return getTags().find(tag => tag.name === name);
}

export function addTag(tag: Tag, previousName?: string) {
    registerTagCommand(tag);
    const tags = { ...settings.store.tagsList, [tag.name]: tag };
    if (previousName && previousName !== tag.name) delete tags[previousName];
    settings.store.tagsList = tags;
}

export function removeTag(name: string) {
    const tags = { ...settings.store.tagsList };
    delete tags[name];
    settings.store.tagsList = tags;
}
