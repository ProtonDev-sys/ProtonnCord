/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MAX_EMBED_URLS = 10;
const MAX_EMBED_URL_LENGTH = 2_048;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const EXACT_URL_PATTERN = /^https?:\/\/[^\s<>"'`]+$/iu;
const TRAILING_PUNCTUATION = /[),.!?;:\\}\]]+$/u;
const INLINE_MEDIA_EMBED_TYPES = new Set<string>(["gifv", "image", "video"]);

export type SecureInlineEmbedStatus = "absent" | "pending" | "present";

function normalizeSecureEmbedUrl(candidate: string): string | null {
    if (candidate.length === 0 || candidate.length > MAX_EMBED_URL_LENGTH) return null;
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        return null;
    }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) return null;
    return parsed.toString();
}

export function extractSecureEmbedUrls(plaintext: string): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const match of plaintext.matchAll(URL_PATTERN)) {
        const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
        const normalized = normalizeSecureEmbedUrl(candidate);
        if (normalized === null) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
        if (result.length === MAX_EMBED_URLS) break;
    }
    return result;
}

export function secureEmbedOnlyUrl(plaintext: string): string | null {
    const candidate = plaintext.trim();
    if (!EXACT_URL_PATTERN.test(candidate) || TRAILING_PUNCTUATION.test(candidate)) return null;
    return normalizeSecureEmbedUrl(candidate);
}

export function shouldHideSecureEmbedOnlyPlaintext(
    plaintext: string,
    inlineEmbedStatus: SecureInlineEmbedStatus,
): boolean {
    // Keep the URL visible until a real local embed exists; otherwise the outgoing row goes blank while unfurling.
    return inlineEmbedStatus === "present" && secureEmbedOnlyUrl(plaintext) !== null;
}

export function isSecureInlineMediaEmbedType(type: string): boolean {
    return INLINE_MEDIA_EMBED_TYPES.has(type);
}
