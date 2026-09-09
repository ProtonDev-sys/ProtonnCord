/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function getUrlExtension(url: string) {
    try {
        const parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
        return parsed.pathname.match(/\.([^./]+)$/)?.[1].toLowerCase();
    } catch {
        return undefined;
    }
}
