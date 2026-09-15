/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { DynamicStickerPackMeta, StickerPack, StickerPackMeta } from "./types";

const PACKS_KEY = "MoreStickers:Packs";
const RECENTS_KEY = "MoreStickers:RecentStickers";
const RESERVED_KEYS = new Set([PACKS_KEY, RECENTS_KEY, "Vencord-MoreStickers-Packs", "Vencord-MoreStickers-RecentStickers"]);

export function validateStickerPack(value: unknown): asserts value is StickerPack {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sticker pack");
    const pack = value as StickerPack;
    const validSticker = (sticker: any) => sticker && typeof sticker === "object" && !Array.isArray(sticker)
        && typeof sticker.id === "string" && !!sticker.id && typeof sticker.title === "string"
        && typeof sticker.image === "string" && typeof sticker.stickerPackId === "string";
    if (typeof pack.id !== "string" || !pack.id || RESERVED_KEYS.has(pack.id) || typeof pack.title !== "string"
        || !validSticker(pack.logo) || !Array.isArray(pack.stickers) || !pack.stickers.every(validSticker))
        throw new Error("Invalid sticker pack");
}

function readMetas(value: unknown): StickerPackMeta[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error("Stored sticker metadata is invalid and has been preserved");
    return value;
}

/**
  * Convert StickerPack to StickerPackMeta
  *
  * @param {StickerPack} sp The StickerPack to convert.
  * @return {StickerPackMeta} The sticker pack metadata.
  */
export function stickerPackToMeta(sp: StickerPack): StickerPackMeta {
    return {
        id: sp.id,
        title: sp.title === "null" ? sp.id.match(/\d+/)?.[0] ?? sp.id : sp.title,
        author: sp.author,
        logo: sp.logo,
        dynamic: sp.dynamic,
    };
}

/**
  * Save a sticker pack to the DataStore
  *
  * @param {StickerPack} sp The StickerPack to save.
  * @return {Promise<void>}
  */
export async function saveStickerPack(sp: StickerPack, packsKey: string = PACKS_KEY): Promise<void> {
    return saveStickerPacks([sp], packsKey);
}

export async function saveStickerPacks(imported: StickerPack[], packsKey: string = PACKS_KEY): Promise<void> {
    imported.forEach(sp => {
        validateStickerPack(sp);
        if (sp.id === packsKey) throw new Error("Invalid sticker pack ID");
    });
    const keys = [...new Set([packsKey, ...imported.map(sp => sp.id)])];
    await DataStore.updateMany(keys, values => {
        const records = new Map(keys.map((key, index) => [key, values[index]]));
        let packs = readMetas(records.get(packsKey));
        const writes = new Map<string, unknown>();
        for (const sp of imported) {
            const existing = writes.get(sp.id) ?? records.get(sp.id);
            if (existing !== undefined) {
                validateStickerPack(existing);
                if (existing.id !== sp.id) throw new Error("Stored sticker pack ID does not match");
            }
            const meta = stickerPackToMeta(sp);
            writes.set(sp.id, { ...existing as StickerPack | undefined, ...sp });
            packs = packs.some(p => p.id === sp.id)
                ? packs.map(p => p.id === sp.id ? { ...p, ...meta } : p)
                : [...packs, meta];
        }
        writes.set(packsKey, packs);
        return { set: [...writes] };
    });
}

/**
  * Get sticker packs' metadata from the DataStore
  *
  * @return {Promise<StickerPackMeta[]>}
  */
export async function getStickerPackMetas(packsKey: string | undefined = PACKS_KEY): Promise<StickerPackMeta[]> {
    const packs = (await DataStore.get(packsKey)) ?? null as (StickerPackMeta[] | null);
    return readMetas(packs);
}

/**
 * Get a sticker pack from the DataStore
 *
 * @param {string} id The id of the sticker pack.
 * @return {Promise<StickerPack | null>}
 * */
export async function getStickerPack(id: string): Promise<StickerPack | null> {
    return (await DataStore.get(id)) ?? null as StickerPack | null;
}

/**
 * Delete a sticker pack from the DataStore
 *
 * @param {string} id The id of the sticker pack.
 * @return {Promise<void>}
 * */
export async function deleteStickerPack(id: string, packsKey: string = PACKS_KEY): Promise<void> {
    if (!id || RESERVED_KEYS.has(id) || id === packsKey) throw new Error("Invalid sticker pack ID");
    await DataStore.updateMany([id, packsKey, RECENTS_KEY], ([pack, metas, recents]) => {
        if (pack !== undefined) {
            validateStickerPack(pack);
            if (pack.id !== id) throw new Error("Stored sticker pack ID does not match");
        }
        if (recents !== undefined && !Array.isArray(recents)) throw new Error("Stored recent stickers are invalid and have been preserved");
        return { delete: [id], set: [
            [packsKey, readMetas(metas).filter(meta => meta.id !== id)],
            [RECENTS_KEY, (recents ?? []).filter(sticker => sticker.stickerPackId !== id)]
        ] };
    });
}

// ---------------------------- Dynamic Packs ----------------------------

export async function getDynamicStickerPack(dspm: DynamicStickerPackMeta): Promise<StickerPack | null> {
    const dsp = await fetch(dspm.dynamic.refreshUrl, {
        headers: dspm.dynamic.authHeaders,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
    });
    if (!dsp.ok) return null;
    const pack = await dsp.json();
    validateStickerPack(pack);
    if (pack.id !== dspm.id) throw new Error("Refreshed pack ID does not match");
    return pack;
}
