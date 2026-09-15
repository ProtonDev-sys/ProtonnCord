/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { THEMES_DIR } from "@main/utils/constants";
import { ensureSafePath } from "@main/utils/ensureSafePath";
import { IpcMainInvokeEvent } from "electron";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";

import type { Theme } from "./types";

function getThemePath(theme: Theme): string | null {
    if (typeof theme?.name !== "string" || !theme.name) return null;
    return ensureSafePath(THEMES_DIR, `${theme.name}.theme.css`);
}

export async function themeExists(_: IpcMainInvokeEvent, theme: Theme) {
    const path = getThemePath(theme);
    return path ? existsSync(path) : false;
}

export async function downloadTheme(_: IpcMainInvokeEvent, theme: Theme) {
    if (!theme?.content || !theme?.name || !theme?.id) throw new Error("Invalid theme");

    const path = getThemePath(theme);
    if (!path) throw new Error("Invalid theme name");

    const download = await fetch(`https://themes.equicord.org/api/download/${encodeURIComponent(theme.id)}`, { signal: AbortSignal.timeout(15_000) });
    if (!download.ok) throw new Error(`Theme download failed (${download.status})`);
    const content = await download.text();
    await writeFile(path, content);
}
