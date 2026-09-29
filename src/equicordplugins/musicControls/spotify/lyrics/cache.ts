/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";

import { LyricsData, Provider } from "./providers/types";

export const CACHE_INDEX = "MusicControls:SpotifyLyrics:v1:index";
export const CACHE_PREFIX = "MusicControls:SpotifyLyrics:v1:track:";
export const MAX_CACHE_ENTRIES = 500;
export const MAX_CACHE_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 256 * 1024;
export const CACHE_AGE = 30 * 24 * 60 * 60_000;
const LEGACY_KEYS = ["SpotifyLyricsCache", "SpotifyLyricsCacheNew"];
type Metadata = { bytes: number; updatedAt: number; };
type Index = Record<string, Metadata>;
type Entry = Metadata & { data: LyricsData; };

function entry(data: LyricsData): Entry {
    return { data, bytes: new TextEncoder().encode(JSON.stringify(data)).byteLength, updatedAt: Date.now() };
}

function trim(index: Index): string[] {
    const ordered = Object.keys(index).sort((a, b) => index[a].updatedAt - index[b].updatedAt);
    let bytes = ordered.reduce((sum, key) => sum + index[key].bytes, 0);
    let remaining = ordered.length;
    const removed: string[] = [];
    for (const key of ordered) {
        if (remaining <= MAX_CACHE_ENTRIES && bytes <= MAX_CACHE_BYTES && index[key].updatedAt > Date.now() - CACHE_AGE) continue;
        remaining--;
        bytes -= index[key].bytes;
        delete index[key];
        removed.push(CACHE_PREFIX + key);
    }
    return removed;
}

/** Bounded metadata and one record per lookup; bulk reads are limited to explicit maintenance/migration. */
export class LyricsCache {
    generation = 0;
    private ready = false;
    private queue = Promise.resolve();
    private hot = new Map<string, Entry>();

    constructor(private keyForTrack: (id: string) => string) { }

    private run<T>(operation: () => Promise<T>): Promise<T> {
        const pending = this.queue.then(operation);
        this.queue = pending.then(() => { }, () => { });
        return pending;
    }

    private remember(key: string, value: Entry) {
        this.hot.delete(key);
        if (value.bytes > MAX_ENTRY_BYTES) return;
        this.hot.set(key, value);
        if (this.hot.size > 32) this.hot.delete(this.hot.keys().next().value!);
    }

    private async initialize(generation: number) {
        if (this.ready || generation !== this.generation) return;
        await DataStore.updateMany([CACHE_INDEX, ...LEGACY_KEYS], ([savedIndex, old, previous]) => {
            if (generation !== this.generation) return {};
            const index: Index = { ...savedIndex };
            const migrated = new Map<string, Entry>();
            for (const [id, lines] of Object.entries(old ?? {})) {
                if (Array.isArray(lines)) migrated.set(this.keyForTrack(id), entry({ useLyric: Provider.Lrclib, lyricsVersions: { [Provider.Lrclib]: lines } }));
            }
            for (const [id, data] of Object.entries(previous ?? {})) {
                if (data && typeof data === "object" && "lyricsVersions" in data) {
                    const key = this.keyForTrack(id);
                    const current = data as LyricsData;
                    migrated.set(key, entry({ ...current, lyricsVersions: { ...migrated.get(key)?.data.lyricsVersions, ...current.lyricsVersions } }));
                }
            }
            for (const [key, value] of migrated) {
                if (index[key] || value.bytes > MAX_ENTRY_BYTES) { migrated.delete(key); continue; }
                index[key] = { bytes: value.bytes, updatedAt: value.updatedAt };
            }
            const removed = trim(index);
            return {
                set: [[CACHE_INDEX, index], ...Array.from(migrated).filter(([key]) => index[key]).map(([key, value]) => [CACHE_PREFIX + key, value] as [string, Entry])],
                delete: [...LEGACY_KEYS, ...removed]
            };
        });
        if (generation === this.generation) this.ready = true;
    }

    migrate() { return this.run(() => this.initialize(this.generation)); }

    get(key: string, generation = this.generation): Promise<LyricsData | null> {
        return this.run(async () => {
            await this.initialize(generation);
            if (generation !== this.generation) return null;
            const value = this.hot.get(key) ?? await DataStore.get<Entry>(CACHE_PREFIX + key);
            if (generation !== this.generation || !value || value.updatedAt <= Date.now() - CACHE_AGE) {
                this.hot.delete(key);
                return null;
            }
            this.remember(key, value);
            return structuredClone(value.data);
        });
    }

    update(key: string, updater: (current: LyricsData | undefined) => LyricsData, generation = this.generation): Promise<void> {
        return this.run(async () => {
            await this.initialize(generation);
            if (generation !== this.generation) return;
            let saved: Entry | undefined;
            let removed: string[] = [];
            await DataStore.updateMany([CACHE_INDEX, CACHE_PREFIX + key], ([savedIndex, current]) => {
                if (generation !== this.generation) return {};
                const value = entry(updater(current?.updatedAt > Date.now() - CACHE_AGE ? current.data : undefined));
                const index: Index = { ...savedIndex };
                if (value.bytes > MAX_ENTRY_BYTES) return {};
                index[key] = { bytes: value.bytes, updatedAt: value.updatedAt };
                removed = trim(index);
                if (index[key]) saved = value;
                return { set: [[CACHE_INDEX, index], ...(saved ? [[CACHE_PREFIX + key, saved] as [string, Entry]] : [])], delete: removed };
            });
            if (generation !== this.generation) return;
            for (const removedKey of removed) this.hot.delete(removedKey.slice(CACHE_PREFIX.length));
            if (saved) this.remember(key, saved);
        });
    }

    clear(): Promise<void> {
        this.generation++;
        this.hot.clear();
        return this.run(async () => {
            await DataStore.updateMany([CACHE_INDEX], ([index]) => ({
                set: [[CACHE_INDEX, {}]],
                delete: [...LEGACY_KEYS, ...Object.keys(index ?? {}).map(key => CACHE_PREFIX + key)]
            }));
            this.ready = true;
        });
    }

    removeTranslations(): Promise<void> {
        const generation = ++this.generation;
        this.hot.clear();
        return this.run(async () => {
            await this.initialize(generation);
            if (generation !== this.generation) return;
            const index = await DataStore.get<Index>(CACHE_INDEX) ?? {};
            const keys = Object.keys(index);
            await DataStore.updateMany([CACHE_INDEX, ...keys.map(key => CACHE_PREFIX + key)], ([savedIndex, ...values]) => {
                if (generation !== this.generation) return {};
                const nextIndex: Index = { ...savedIndex };
                const set: [string, unknown][] = [];
                values.forEach((value: Entry | undefined, i) => {
                    if (!value) return;
                    const { [Provider.Translated]: _, ...lyricsVersions } = value.data.lyricsVersions;
                    const useLyric = value.data.useLyric === Provider.Translated ? lyricsVersions[Provider.Spotify] ? Provider.Spotify : Provider.Lrclib : value.data.useLyric;
                    const next = { ...entry({ ...value.data, lyricsVersions, useLyric }), updatedAt: value.updatedAt };
                    nextIndex[keys[i]] = { bytes: next.bytes, updatedAt: next.updatedAt };
                    set.push([CACHE_PREFIX + keys[i], next]);
                });
                set.push([CACHE_INDEX, nextIndex]);
                return { set };
            });
        });
    }
}
