/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MAX_EMBED_URLS = 10;
const MAX_EMBED_URL_LENGTH = 2_048;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[),.!?;:\\}\]]+$/u;

export function extractSecureEmbedUrls(plaintext: string): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const match of plaintext.matchAll(URL_PATTERN)) {
        const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
        if (candidate.length === 0 || candidate.length > MAX_EMBED_URL_LENGTH) continue;
        let parsed: URL;
        try {
            parsed = new URL(candidate);
        } catch {
            continue;
        }
        if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) continue;
        const normalized = parsed.toString();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
        if (result.length === MAX_EMBED_URLS) break;
    }
    return result;
}
