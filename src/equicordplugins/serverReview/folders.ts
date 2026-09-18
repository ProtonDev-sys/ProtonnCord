/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ProtoFolder {
    id?: { value: unknown; };
    name?: { value: string; };
    guildIds: unknown[];
    [key: string]: unknown;
}

export function withGuildIds(folder: ProtoFolder, guildIds: unknown[]): ProtoFolder {
    // Protobuf messages also carry non-enumerable metadata and unknown fields.
    const copy = Object.create(Object.getPrototypeOf(folder), Object.getOwnPropertyDescriptors(folder));
    copy.guildIds = guildIds;
    return copy;
}

/** Only the selected memberships change; folder metadata and unrelated order survive. */
export function moveToFolder(folders: ProtoFolder[], selected: string[], destination: ProtoFolder): ProtoFolder[] {
    if (!folders.every(folder => Array.isArray(folder.guildIds)))
        throw new Error("Discord's folder format has changed. No servers were moved.");
    const ids = new Set(selected);
    const targetId = String(destination.id?.value);
    if (!destination.id || !Array.isArray(destination.guildIds)) throw new Error("Could not create the folder.");
    const result: ProtoFolder[] = [];
    let added = false;
    for (const folder of folders) {
        if (folder.id && String(folder.id.value) === targetId) {
            result.push(destination);
            added = true;
        } else {
            const guildIds = folder.guildIds.filter(id => !ids.has(String(id)));
            if (guildIds.length || !folder.guildIds.length) result.push(withGuildIds(folder, guildIds));
        }
    }
    if (!added) result.push(destination);
    return result;
}
