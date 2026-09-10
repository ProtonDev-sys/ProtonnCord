/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { Toasts } from "@webpack/common";

import { getStickerPackMetas, stickerPackToMeta, validateStickerPack } from "./stickers";
import { Sticker, StickerPack, StickerPackMeta } from "./types";

const PACKS_KEY = "MoreStickers:Packs";
const PACKS_KEY_OLD = "Vencord-MoreStickers-Packs";

const RECENT_STICKERS_KEY = "MoreStickers:RecentStickers";
const RECENT_STICKERS_KEY_OLD = "Vencord-MoreStickers-RecentStickers";

function migrateStickerPackId(oldStickerPackId: string): string {
    if (oldStickerPackId.startsWith("Vencord-MoreStickers-Line-Pack-")) {
        const id = oldStickerPackId.replace("Vencord-MoreStickers-Line-Pack-", "");
        return "MoreStickers:Line:Pack:" + id;
    } else if (oldStickerPackId.startsWith("Vencord-MoreStickers-Line-Emoji-Pack-")) {
        const id = oldStickerPackId.replace("Vencord-MoreStickers-Line-Emoji-Pack-", "");
        return "MoreStickers:Line:Emoji-Pack:" + id;
    } else {
        return oldStickerPackId;
    }
}

function migrateStickerId(oldStickerId: string): string {
    if (oldStickerId.startsWith("Vencord-MoreStickers-Line-Sticker-")) {
        const [stickerPackId, stickerId] = oldStickerId.replace("Vencord-MoreStickers-Line-Sticker-", "").split("-", 2);
        return "MoreStickers:Line:Sticker:" + stickerPackId + ":" + stickerId;
    } else if (oldStickerId.startsWith("Vencord-MoreStickers-Line-Emoji-")) {
        const [stickerPackId, stickerId] = oldStickerId.replace("Vencord-MoreStickers-Line-Emoji-", "").split("-", 2);
        return "MoreStickers:Line-Emoji:" + stickerPackId + ":" + stickerId;
    } else {
        return oldStickerId;
    }
}

function migrateSticker(oldSticker: Sticker): Sticker {
    return {
        ...oldSticker,
        id: migrateStickerId(oldSticker.id),
        stickerPackId: migrateStickerPackId(oldSticker.stickerPackId),
    };
}

function migrateStickerPack(oldStickerPack: StickerPack): StickerPack {
    return {
        ...oldStickerPack,
        id: migrateStickerPackId(oldStickerPack.id),
        logo: migrateSticker(oldStickerPack.logo),
        stickers: oldStickerPack.stickers.map(migrateSticker),
    };
}

export async function isV1() {
    const [newPackMetas, oldPackMetas] = await Promise.all([getStickerPackMetas(PACKS_KEY), getStickerPackMetas(PACKS_KEY_OLD)]);
    return oldPackMetas.some(meta => !newPackMetas.some(current => current.id === migrateStickerPackId(meta.id)));
}

export async function migrate() {
    const discoveredMetas = await getStickerPackMetas(PACKS_KEY_OLD);
    if (discoveredMetas.length === 0) {
        Toasts.show({
            message: "Old sticker packs not found, nothing to migrate",
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
            options: {
                duration: 1000
            }
        });
        return;
    }

    const keys = [...new Set([
        PACKS_KEY_OLD, PACKS_KEY, RECENT_STICKERS_KEY_OLD, RECENT_STICKERS_KEY,
        ...discoveredMetas.flatMap(meta => [meta.id, migrateStickerPackId(meta.id)])
    ])];
    await DataStore.updateMany(keys, values => {
        const records = new Map(keys.map((key, index) => [key, values[index]]));
        const oldMetas: StickerPackMeta[] = records.get(PACKS_KEY_OLD) ?? [];
        let newMetas: StickerPackMeta[] = records.get(PACKS_KEY) ?? [];
        const oldRecent: Sticker[] = records.get(RECENT_STICKERS_KEY_OLD) ?? [];
        const newRecent: Sticker[] = records.get(RECENT_STICKERS_KEY) ?? [];
        if (![oldMetas, newMetas, oldRecent, newRecent].every(Array.isArray)) throw new Error("Invalid sticker migration data; originals were preserved");
        const writes = new Map<string, unknown>();
        for (const meta of oldMetas) {
            if (!keys.includes(meta.id) || !keys.includes(migrateStickerPackId(meta.id)))
                throw new Error("Sticker packs changed during migration. Try again");
            const original = records.get(meta.id);
            validateStickerPack(original);
            if (original.id !== meta.id) throw new Error("Stored sticker pack ID does not match");
            const migrated = migrateStickerPackId(original.id) === original.id ? original : migrateStickerPack(original);
            validateStickerPack(migrated);
            const existing = writes.get(migrated.id) ?? records.get(migrated.id);
            if (existing !== undefined) {
                validateStickerPack(existing);
                if (existing.id !== migrated.id) throw new Error("Stored sticker pack ID does not match");
            }
            const combined: StickerPack = existing ? {
                ...migrated, ...existing,
                stickers: [...existing.stickers, ...migrated.stickers.filter(sticker => !existing.stickers.some(current => current.id === sticker.id))]
            } : migrated;
            writes.set(combined.id, combined);
            const migratedMeta = { ...meta, ...stickerPackToMeta(combined) };
            newMetas = newMetas.some(current => current.id === combined.id)
                ? newMetas.map(current => current.id === combined.id ? { ...migratedMeta, ...current } : current)
                : [...newMetas, migratedMeta];
        }
        writes.set(PACKS_KEY, newMetas);
        const migratedRecent = oldRecent.map(migrateSticker);
        writes.set(RECENT_STICKERS_KEY, [...newRecent, ...migratedRecent.filter(sticker => !newRecent.some(current => current.id === sticker.id))]);
        // Keep all v1 keys and records as a recoverable original; publish the new set atomically.
        return { set: [...writes] };
    });

    Toasts.show({
        message: "Sticker Pack Migration Complete",
        type: Toasts.Type.SUCCESS,
        id: Toasts.genId(),
        options: {
            duration: 1000
        }
    });
}
