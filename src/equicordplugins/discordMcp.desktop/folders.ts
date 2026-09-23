/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ProtoFolder, withGuildIds } from "../serverReview/folders";

export function folderId(folder: ProtoFolder): string | null {
    return folder.id ? String(folder.id.value) : null;
}

export function validateFolders(folders: ProtoFolder[]): void {
    if (!Array.isArray(folders) || !folders.every(folder => folder && Array.isArray(folder.guildIds)))
        throw new Error("Discord's folder format has changed. No servers were moved.");
}

export function findFolder(folders: ProtoFolder[], id: string): ProtoFolder {
    const matches = folders.filter(folder => folderId(folder) === id);
    if (matches.length !== 1) throw new Error("Folder was not found or its ID is ambiguous");
    return matches[0];
}

export function withField(folder: ProtoFolder, field: string, value: unknown): ProtoFolder {
    const copy = Object.create(Object.getPrototypeOf(folder), Object.getOwnPropertyDescriptors(folder));
    copy[field] = value;
    return copy;
}

/** Move memberships and remove folders that no longer contain a server. */
export function moveServers(
    folders: ProtoFolder[], selected: string[], destinationId: string | null,
    makeUnfiled: (id: string) => ProtoFolder = id => ({ guildIds: [id] })
): ProtoFolder[] {
    validateFolders(folders);
    const selectedIds = new Set(selected);
    const destination = destinationId === null ? null : findFolder(folders, destinationId);
    const destinationGuildIds = destination
        ? [...destination.guildIds, ...selected.filter(id => !destination.guildIds.some(old => String(old) === id))]
        : [];
    const result: ProtoFolder[] = [];
    for (const folder of folders) {
        if (destination && folder === destination) result.push(withGuildIds(folder, destinationGuildIds));
        else {
            const remaining = folder.guildIds.filter(id => !selectedIds.has(String(id)));
            if (remaining.length) result.push(withGuildIds(folder, remaining));
        }
    }
    if (!destination) for (const id of selected) result.push(makeUnfiled(id));
    return result;
}

/** Removing a folder leaves its servers in the same position as individual entries. */
export function deleteFolder(
    folders: ProtoFolder[], id: string,
    makeUnfiled: (id: string) => ProtoFolder = guildId => ({ guildIds: [guildId] })
): ProtoFolder[] {
    validateFolders(folders);
    const target = findFolder(folders, id);
    return folders.flatMap(folder => folder === target
        ? folder.guildIds.map(guildId => makeUnfiled(String(guildId)))
        : [folder]);
}

export function reorderFolder(folders: ProtoFolder[], id: string, position: number, visibleKeys: string[]): ProtoFolder[] {
    validateFolders(folders);
    const target = findFolder(folders, id);
    const targetKey = `f:${id}`;
    if (!visibleKeys.includes(targetKey)) throw new Error("Folder is not visible in the server bar");
    const remainingVisible = visibleKeys.filter(key => key !== targetKey);
    if (!Number.isInteger(position) || position < 0 || position > remainingVisible.length)
        throw new Error(`position must be between 0 and ${remainingVisible.length}`);
    const result = folders.filter(folder => folder !== target);
    const keyOf = (folder: ProtoFolder) => folderId(folder) ? `f:${folderId(folder)}` : `g:${String(folder.guildIds[0])}`;
    const rawIndex = remainingVisible.slice(position)
        .map(key => result.findIndex(folder => keyOf(folder) === key))
        .find(index => index >= 0) ?? result.length;
    result.splice(rawIndex, 0, target);
    return result;
}
