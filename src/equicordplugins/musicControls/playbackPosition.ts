/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function followPlaybackPosition(store: { readonly position: number; isPlaying: boolean; }, duration: number, update: (position: number) => void) {
    const sample = () => update(Math.min(store.position, duration));
    sample();
    if (!store.isPlaying) return;

    const interval = setInterval(sample, 1000);
    return () => clearInterval(interval);
}

export function getLyricIndexes(lyrics: { time: number; }[], position: number, delay: number): [number | null, number | null] {
    const posInSec = (position + delay) / 1000;
    let left = 0;
    let right = lyrics.length - 1;
    let currentIndex: number | null = null;

    while (left <= right) {
        const middle = Math.floor((left + right) / 2);
        const current = lyrics[middle];
        const next = lyrics[middle + 1];

        if (current.time <= posInSec && (!next || next.time > posInSec)) {
            currentIndex = middle;
            break;
        }

        if (current.time > posInSec) right = middle - 1;
        else left = middle + 1;
    }

    const nextIndex = currentIndex !== null ? currentIndex + 1 : left;
    const nextLyric = nextIndex < lyrics.length ? nextIndex : null;

    if (currentIndex !== null && posInSec - lyrics[currentIndex].time > 8) {
        return [null, nextLyric];
    }

    return [currentIndex, nextLyric];
}
