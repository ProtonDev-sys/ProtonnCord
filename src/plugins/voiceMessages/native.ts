/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { readFile, realpath, rm } from "fs/promises";
import { basename, isAbsolute, normalize, relative, sep } from "path";

export async function readRecording(_: any, filePath: string) {
    if (typeof filePath !== "string") return null;
    filePath = normalize(filePath);
    const filename = basename(filePath);
    const discordBaseDirWithTrailingSlash = normalize(app.getPath("userData") + "/");
    if (!/^\d*recording\.ogg$/.test(filename) || !filePath.startsWith(discordBaseDirWithTrailingSlash)) return null;

    try {
        const [basePath, recordingPath] = await Promise.all([realpath(app.getPath("userData")), realpath(filePath)]);
        const relativePath = relative(basePath, recordingPath);
        if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
        const buf = await readFile(recordingPath);
        await rm(filePath).catch(() => { });
        return Uint8Array.from(buf);
    } catch {
        return null;
    }
}
