/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function parseSyncedLyrics(source: string): { time: number; text: string | null; }[] {
    const lyrics: { time: number; text: string | null; }[] = [];
    for (const line of source.split(/\r?\n/)) {
        let remaining = line.trimStart();
        const times: number[] = [];
        let match: RegExpExecArray | null;
        while ((match = /^\[(\d+):(\d{1,2}(?:\.\d+)?)\]/.exec(remaining))) {
            const minutes = Number(match[1]);
            const seconds = Number(match[2]);
            if (Number.isFinite(minutes) && seconds < 60) times.push(minutes * 60 + seconds);
            remaining = remaining.slice(match[0].length).trimStart();
        }
        const text = remaining.trim();
        for (const time of times) lyrics.push({ time, text: text && text !== "♪" ? text : null });
    }
    return lyrics.sort((a, b) => a.time - b.time);
}
