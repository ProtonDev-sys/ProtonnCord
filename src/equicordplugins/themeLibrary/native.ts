/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { THEMES_DIR } from "@main/utils/constants";
import { ensureSafePath } from "@main/utils/ensureSafePath";
import { IpcMainInvokeEvent } from "electron";
import { existsSync } from "fs";
import { mkdtemp, rename, rm, writeFile } from "fs/promises";
import { join } from "path";

import type { Theme } from "./types";

const MAX_THEME_BYTES = 5 * 1024 * 1024;

function getThemePath(theme: Theme): string | null {
    if (typeof theme?.name !== "string" || !theme.name || theme.name.length > 200
        || /[\x00-\x1f<>:"/\\|?*]/u.test(theme.name) || /[. ]$/u.test(theme.name)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(theme.name)) return null;
    return ensureSafePath(THEMES_DIR, `${theme.name}.theme.css`);
}

export async function themeExists(_: IpcMainInvokeEvent, theme: Theme) {
    const path = getThemePath(theme);
    return path ? existsSync(path) : false;
}

export async function downloadTheme(_: IpcMainInvokeEvent, theme: Theme) {
    if (!theme?.content || typeof theme.id !== "string" || !theme.id || theme.id.length > 200) throw new Error("Invalid theme");

    const path = getThemePath(theme);
    if (!path) throw new Error("Invalid theme name");

    const download = await fetch(`https://themes.equicord.org/api/download/${encodeURIComponent(theme.id)}`, {
        signal: AbortSignal.timeout(15_000), redirect: "error", credentials: "omit"
    });
    if (!download.ok || Number(download.headers.get("content-length")) > MAX_THEME_BYTES) {
        await download.body?.cancel().catch(() => undefined);
        throw new Error(download.ok ? "Theme exceeds the 5 MB download limit" : `Theme download failed (${download.status})`);
    }
    if (!download.body) throw new Error("Theme download has no body");
    const reader = download.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_THEME_BYTES) throw new Error("Theme exceeds the 5 MB download limit");
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }

    const directory = await mkdtemp(join(THEMES_DIR, ".theme-download-"));
    try {
        const temporaryPath = join(directory, "theme.css");
        await writeFile(temporaryPath, Buffer.concat(chunks));
        await rename(temporaryPath, path);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
