/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { join, normalize } from "path";

export function ensureSafePath(basePath: string, path: string) {
    const normalizedBasePath = normalize(basePath + "/");
    const normalizedPath = join(basePath, path);
    return normalizedPath === normalize(basePath) || normalizedPath.startsWith(normalizedBasePath)
        ? normalizedPath
        : null;
}
