/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AvatarDecoration } from "@plugins/decor";
import { Decoration } from "@plugins/decor/lib/api";
import { SKU_ID } from "@plugins/decor/lib/constants";

export function decorationToAsset(decoration: Decoration) {
    return `${decoration.animated ? "a_" : ""}${decoration.hash}`;
}

export function decorationToAvatarDecoration(decoration: Decoration): AvatarDecoration {
    return { asset: decorationToAsset(decoration), skuId: SKU_ID };
}

export async function validateDecorationFile(file: File) {
    const header = new DataView(await file.slice(0, 24).arrayBuffer());
    if (file.size < 33 || header.byteLength < 24
        || header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a
        || header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452)
        throw new Error("Choose a PNG or APNG decoration.");
    if (header.getUint32(16) === 0 || header.getUint32(16) !== header.getUint32(20))
        throw new Error("Choose a square decoration with a nonzero width and height.");
}
