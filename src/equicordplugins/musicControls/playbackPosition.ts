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
