/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MAX_EXTERNAL_URL_LENGTH = 4096;
const FORBIDDEN_URL_CHARACTERS = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export type ThemeUrlField = "website" | "source" | "donate";

/**
 * Parse an untrusted web link for use in an external browser context.
 *
 * Theme metadata is content, not authority: only canonical HTTPS URLs are
 * allowed. In particular, this prevents browser builds from handing active
 * schemes such as javascript: or data: to window.open.
 */
export function parseExternalHttpsUrl(value: unknown): string | null {
    if (typeof value !== "string"
        || value.length === 0
        || value.length > MAX_EXTERNAL_URL_LENGTH
        || value.trim() !== value
        || FORBIDDEN_URL_CHARACTERS.test(value)
        || !/^https:\/\//iu.test(value)) {
        return null;
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }

    if (url.protocol !== "https:"
        || url.username !== ""
        || url.password !== ""
        || url.hostname === ""
        || url.hostname === "."
        || url.hostname.endsWith(".")) {
        return null;
    }

    const { href } = url;
    return href.length <= MAX_EXTERNAL_URL_LENGTH ? href : null;
}

/** Extract and validate an HTTPS URL from a BetterDiscord-style metadata block. */
export function getThemeMetadataHttpsUrl(css: unknown, field: ThemeUrlField): string | null {
    if (typeof css !== "string") return null;

    const blockStart = css.indexOf("/**");
    if (blockStart === -1 || blockStart > 4096) return null;

    const blockEnd = css.indexOf("*/", blockStart + 3);
    if (blockEnd === -1 || blockEnd - blockStart > 65536) return null;

    const metadata = css.slice(blockStart + 3, blockEnd);
    const [, rawUrl] = metadata.match(new RegExp(`(?:^|[\\r\\n])\\s*\\*?\\s*@${field}\\s+([^\\r\\n*]+)`, "iu")) ?? [];
    return parseExternalHttpsUrl(rawUrl?.trim());
}
