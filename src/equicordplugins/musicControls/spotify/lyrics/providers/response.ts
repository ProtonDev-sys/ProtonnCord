/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Only a confirmed missing record is a cacheable miss; other failures must be retried. */
export function checkLyricsResponse(response: Response): boolean {
    if (response.status === 404) return false;
    if (response.ok) return true;

    const retryAfter = response.headers.get("Retry-After");
    const seconds = Number(retryAfter);
    const retryAfterMs = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
    throw Object.assign(new Error(`Lyrics request failed (${response.status})`), { retryAfterMs });
}
