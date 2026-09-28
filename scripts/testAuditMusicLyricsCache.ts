/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { parseSyncedLyrics } from "../src/equicordplugins/musicControls/parseSyncedLyrics";
import { checkLyricsResponse } from "../src/equicordplugins/musicControls/spotify/lyrics/providers/response";
import { Provider } from "../src/equicordplugins/musicControls/spotify/lyrics/providers/types";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

function fixture(fallback = false, initial = new Map<string, any>()) {
    let now = 1_800_000_000_000;
    let failWrite = false;
    let beforeWrite: (() => Promise<void>) | undefined;
    const data = new Map(initial);
    const reads: string[] = [], writes: string[] = [];
    const settings = { store: { lyricsProvider: Provider.Spotify, fallbackProvider: fallback, spotifyLyricsApiUrl: "", translateTo: "en" } };
    const fetchers: any = { spotify: async () => null, lrclib: async () => null };
    const storage = {
        async get(key: string) { reads.push(key); return structuredClone(data.get(key)); },
        async set(key: string, value: any) { if (failWrite) throw Error("storage failure"); writes.push(key); data.set(key, structuredClone(value)); },
        async update(key: string, updater: any) { if (failWrite) throw Error("storage failure"); writes.push(key); data.set(key, structuredClone(updater(structuredClone(data.get(key))))); },
        async updateMany(keys: string[], updater: any) {
            const before = beforeWrite;
            beforeWrite = undefined;
            await before?.();
            if (failWrite) throw Error("storage failure");
            reads.push(...keys);
            const changes = updater(keys.map(key => structuredClone(data.get(key))));
            for (const [key, value] of changes.set ?? []) { writes.push(key); data.set(key, structuredClone(value)); }
            for (const key of changes.delete ?? []) data.delete(key);
        }
    };
    const modules = new Map<string, any>();
    function load(path: string) {
        if (modules.has(path)) return modules.get(path);
        const exports: any = {};
        const code = transpileModule(readFileSync(`src/equicordplugins/musicControls/spotify/lyrics/${path}`, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText;
        runInNewContext(code, {
            exports, Date: class extends Date { static now() { return now; } }, Map, Set, JSON, Error, URL, TextEncoder, structuredClone,
            require: (name: string) => {
                if (name === "@api/index") return { DataStore: storage };
                if (name === "@equicordplugins/musicControls/settings") return { settings };
                if (name.endsWith("providers/types") || name === "./types") return { Provider };
                if (name === "./providers/SpotifyAPI") return { getLyricsSpotify: (...args: any[]) => fetchers.spotify(...args) };
                if (name === "./providers/lrclibAPI") return { getLyricsLrclib: (...args: any[]) => fetchers.lrclib(...args) };
                if (name === "./cache") return load("cache.ts");
                throw Error(`Unexpected import ${name}`);
            }
        });
        modules.set(path, exports);
        return exports;
    }
    const api = load("api.tsx");
    return { api, cache: load("cache.ts"), data, reads, writes, fetchers, settings, advance: (ms: number) => { now += ms; }, failWrite: (value: boolean) => { failWrite = value; },
        pauseNextWrite() {
            const started = deferred<void>(), release = deferred<void>();
            beforeWrite = async () => { started.resolve(); await release.promise; };
            return { started: started.promise, release: () => release.resolve() };
        }
    };
}

const lyrics = (text = "line") => ({ useLyric: Provider.Spotify, lyricsVersions: { [Provider.Spotify]: [{ time: 1, text }] } });

for (const fallback of [false, true]) test(`transient lyric errors recover after bounded backoff with fallback ${fallback}`, async () => {
    const f = fixture(fallback);
    let calls = 0;
    f.fetchers.spotify = f.fetchers.lrclib = async () => { calls++; throw Error("offline"); };
    assert.equal(await f.api.getLyrics({ id: "track" }), null);
    const failedCalls = fallback ? 2 : 1;
    assert.equal(calls, failedCalls);
    assert.equal(await f.api.getLyrics({ id: "track" }), null);
    assert.equal(calls, failedCalls, "retry deadline prevents request loops");
    f.advance(30_000);
    f.fetchers.spotify = async () => { calls++; return lyrics(); };
    assert.equal((await f.api.getLyrics({ id: "track" }))?.lyricsVersions.Spotify[0].text, "line");
    assert.equal(calls, failedCalls + 1);
});

test("authoritative lyric misses expire, provider settings invalidate retry state, and clear cancels stale responses", async () => {
    const f = fixture();
    let calls = 0;
    f.fetchers.spotify = async () => { calls++; return null; };
    await f.api.getLyrics({ id: "miss" });
    f.advance(60_000);
    await f.api.getLyrics({ id: "miss" });
    assert.equal(calls, 1);
    f.advance(24 * 60 * 60_000);
    await f.api.getLyrics({ id: "miss" });
    assert.equal(calls, 2);
    f.settings.store.spotifyLyricsApiUrl = "https://fixture.invalid";
    await f.api.getLyrics({ id: "miss" });
    assert.equal(calls, 3);
    const pending = deferred<any>();
    f.fetchers.spotify = () => pending.promise;
    const request = f.api.getLyrics({ id: "pending" });
    await new Promise(resolve => setImmediate(resolve));
    await f.api.clearLyricsCache();
    pending.resolve(lyrics());
    assert.equal(await request, null);
});

test("rate limits honor Retry-After and repeated transport failures have a capped retry delay", async () => {
    const f = fixture();
    let calls = 0;
    f.fetchers.spotify = async () => { calls++; checkLyricsResponse(new Response(null, { status: 429, headers: { "Retry-After": "120" } })); };
    await f.api.getLyrics({ id: "limited" });
    f.advance(119_999);
    await f.api.getLyrics({ id: "limited" });
    assert.equal(calls, 1);
    f.advance(1);
    f.fetchers.spotify = async () => { calls++; return lyrics(); };
    assert.ok(await f.api.getLyrics({ id: "limited" }));
    assert.equal(calls, 2);
    f.fetchers.spotify = async () => { calls++; checkLyricsResponse(new Response(null, { status: 429, headers: { "Retry-After": "7200" } })); };
    await f.api.getLyrics({ id: "long-limit" });
    f.advance(3_600_000);
    await f.api.getLyrics({ id: "long-limit" });
    assert.equal(calls, 3, "a server's longer deadline is never shortened to the ordinary backoff cap");
    f.advance(3_600_000);
    f.fetchers.spotify = async () => { calls++; return lyrics(); };
    assert.ok(await f.api.getLyrics({ id: "long-limit" }));
    assert.equal(calls, 4);
    f.fetchers.spotify = async () => { calls++; throw null; };
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
        const before = calls;
        await f.api.getLyrics({ id: "offline" });
        assert.equal(calls, before + 1);
        f.advance(delay - 1);
        await f.api.getLyrics({ id: "offline" });
        assert.equal(calls, before + 1);
        f.advance(1);
    }
});

test("per-track migration is atomic, retryable, and preserves selected versions and unrelated data", async () => {
    const selected = { useLyric: Provider.Translated, lyricsVersions: {
        Spotify: [{ time: 1, text: "current" }], Translated: [{ time: 1, text: "translated" }], Romanized: [{ time: 1, text: "romanized" }]
    } };
    const f = fixture(false, new Map([
        ["SpotifyLyricsCache", { old: [{ time: 0, text: "legacy" }], shared: [{ time: 0, text: "legacy alternative" }], overlap: [{ time: 0, text: "obsolete" }] }],
        ["SpotifyLyricsCacheNew", { shared: selected, overlap: { useLyric: Provider.Lrclib, lyricsVersions: { LRCLIB: [{ time: 1, text: "newer version" }] } } }], ["unrelated", { retained: true }]
    ]));
    f.failWrite(true);
    await assert.rejects(f.api.migrateOldLyrics(), /storage failure/);
    assert.ok(f.data.has("SpotifyLyricsCache"));
    assert.ok(f.data.has("SpotifyLyricsCacheNew"));
    f.failWrite(false);
    await f.api.migrateOldLyrics();
    assert.equal(f.data.has("SpotifyLyricsCache"), false);
    assert.equal(f.data.has("SpotifyLyricsCacheNew"), false);
    assert.deepEqual(await f.api.getLyrics({ id: "shared" }), { ...selected, lyricsVersions: { ...selected.lyricsVersions, LRCLIB: [{ time: 0, text: "legacy alternative" }] } });
    assert.equal((await f.api.getLyrics({ id: "overlap" })).lyricsVersions.LRCLIB[0].text, "newer version", "newer provider versions override their legacy counterpart");
    assert.equal((await f.api.getLyrics({ id: "old" })).lyricsVersions.LRCLIB[0].text, "legacy");
    assert.deepEqual(f.data.get("unrelated"), { retained: true });
    await f.api.updateLyrics("shared", [{ time: 1, text: "new translation" }], Provider.Translated);
    await f.api.removeTranslations();
    const cleaned = await f.api.getLyrics({ id: "shared" });
    assert.equal(cleaned.useLyric, Provider.Spotify);
    assert.equal(cleaned.lyricsVersions.Translated, undefined);
    assert.equal(cleaned.lyricsVersions.Romanized[0].text, "romanized");
    f.failWrite(true);
    await assert.rejects(f.api.clearLyricsCache(), /storage failure/);
    f.failWrite(false);
    await f.api.clearLyricsCache();
    assert.deepEqual([...f.data.keys()].sort(), ["unrelated", f.cache.CACHE_INDEX].sort());
});

test("cached reads and edits touch only bounded metadata and the requested track", async () => {
    const f = fixture();
    f.fetchers.spotify = async (id: string) => lyrics(id);
    for (let i = 0; i < 40; i++) await f.api.getLyrics({ id: String(i) });
    f.reads.length = f.writes.length = 0;
    assert.equal((await f.api.getLyrics({ id: "0" })).lyricsVersions.Spotify[0].text, "0");
    assert.equal(f.reads.length, 1, "eviction from the 32-entry hot cache reads just one persisted track");
    assert.ok(f.reads[0].startsWith(f.cache.CACHE_PREFIX));
    f.reads.length = 0;
    await f.api.getLyrics({ id: "0" });
    assert.equal(f.reads.length, 0, "a hot-cache hit reads no IndexedDB records");
    await f.api.updateLyrics("0", [{ time: 1, text: "edit" }], Provider.Lrclib);
    assert.equal(f.reads.length, 2);
    assert.equal(f.writes.length, 2);
    assert.equal(f.writes.filter(key => key.startsWith(f.cache.CACHE_PREFIX)).length, 1);
    assert.ok(!f.reads.includes("SpotifyLyricsCacheNew"));
    f.settings.store.spotifyLyricsApiUrl = "https://another.invalid";
    f.fetchers.spotify = async () => lyrics("different configuration");
    assert.equal((await f.api.getLyrics({ id: "0" })).lyricsVersions.Spotify[0].text, "different configuration");
});

test("persisted lyrics respect entry, byte and age budgets without caching oversized records", async () => {
    const f = fixture();
    f.fetchers.spotify = async (id: string) => lyrics(id);
    for (let i = 0; i <= f.cache.MAX_CACHE_ENTRIES; i++) { await f.api.getLyrics({ id: String(i) }); f.advance(1); }
    let index = f.data.get(f.cache.CACHE_INDEX);
    assert.equal(Object.keys(index).length, f.cache.MAX_CACHE_ENTRIES);
    assert.equal([...f.data.keys()].filter(key => key.startsWith(f.cache.CACHE_PREFIX)).length, f.cache.MAX_CACHE_ENTRIES);
    f.advance(f.cache.CACHE_AGE + 1);
    f.fetchers.spotify = async () => lyrics("refreshed");
    assert.equal((await f.api.getLyrics({ id: "500" })).lyricsVersions.Spotify[0].text, "refreshed");
    assert.equal(Object.keys(f.data.get(f.cache.CACHE_INDEX)).length, 1, "writing fresh lyrics evicts aged entries");
    f.fetchers.spotify = async () => lyrics("x".repeat(200_000));
    for (let i = 0; i < 50; i++) { await f.api.getLyrics({ id: `large-${i}` }); f.advance(1); }
    index = f.data.get(f.cache.CACHE_INDEX);
    assert.ok(Object.values<any>(index).reduce((sum, item) => sum + item.bytes, 0) <= f.cache.MAX_CACHE_BYTES);
    assert.ok(Object.keys(index).length < 50);
    const previousKeys = [...f.data.keys()];
    f.fetchers.spotify = async () => lyrics("x".repeat(f.cache.MAX_ENTRY_BYTES + 1));
    assert.ok(await f.api.getLyrics({ id: "oversized" }), "oversized successful results remain usable without persistence");
    assert.deepEqual([...f.data.keys()], previousKeys);
});

test("concurrent provider results retain edited versions and translation removal invalidates pending fetches", async () => {
    const f = fixture();
    const pending = deferred<any>();
    f.fetchers.spotify = () => pending.promise;
    const request = f.api.getLyrics({ id: "same" });
    await new Promise(resolve => setImmediate(resolve));
    await f.api.updateLyrics("same", [{ time: 1, text: "translated" }], Provider.Translated);
    pending.resolve(lyrics("original"));
    const result = await request;
    assert.equal(result.useLyric, Provider.Translated);
    assert.equal(result.lyricsVersions.Spotify[0].text, "original");
    assert.equal(result.lyricsVersions.Translated[0].text, "translated");
    const next = deferred<any>();
    f.fetchers.spotify = () => next.promise;
    const outdated = f.api.getLyrics({ id: "other" });
    await new Promise(resolve => setImmediate(resolve));
    await f.api.removeTranslations();
    next.resolve(lyrics());
    assert.equal(await outdated, null);
    assert.equal((await f.api.getLyrics({ id: "same" })).lyricsVersions.Translated, undefined);
});

test("clear wins over in-flight migration and record updates without repopulating old cache data", async () => {
    const f = fixture(false, new Map([["SpotifyLyricsCacheNew", { old: lyrics("legacy") }]]));
    const migration = f.pauseNextWrite();
    const lookup = f.api.getLyrics({ id: "old" });
    await migration.started;
    const clearing = f.api.clearLyricsCache();
    migration.release();
    await clearing;
    assert.equal(await lookup, null);
    assert.deepEqual([...f.data.keys()], [f.cache.CACHE_INDEX]);

    const writing = f.pauseNextWrite();
    const update = f.api.updateLyrics("new", [{ time: 1, text: "obsolete" }], Provider.Translated);
    await writing.started;
    const clearAgain = f.api.clearLyricsCache();
    writing.release();
    await Promise.all([update, clearAgain]);
    assert.deepEqual([...f.data.keys()], [f.cache.CACHE_INDEX]);
    assert.deepEqual(f.data.get(f.cache.CACHE_INDEX), {});
});

for (const provider of ["SpotifyAPI", "lrclibAPI"]) test(`${provider} distinguishes missing lyrics from HTTP and malformed-response failures`, async () => {
    let response = new Response(null, { status: 404 });
    const exports: any = {};
    const code = transpileModule(readFileSync(`src/equicordplugins/musicControls/spotify/lyrics/providers/${provider}/index.ts`, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(code, { exports, URL, URLSearchParams, AbortSignal, fetch: async () => response, require: (name: string) => {
        if (name.endsWith("/types")) return { Provider };
        if (name.endsWith("/parseSyncedLyrics")) return { parseSyncedLyrics };
        if (name === "../response") return { checkLyricsResponse };
        throw Error(`Unexpected import ${name}`);
    } });
    const get = provider === "SpotifyAPI" ? () => exports.getLyricsSpotify("fixture") : () => exports.getLyricsLrclib({ name: "track", artists: [], album: { name: "album" }, duration: 10 });
    assert.equal(await get(), null);
    for (const status of [429, 500, 503]) {
        response = new Response(null, { status });
        await assert.rejects(get, /Lyrics request failed/);
    }
    response = Response.json({});
    await assert.rejects(get, /Invalid .* lyrics response/);
    response = new Response("broken json");
    await assert.rejects(get);
    response = Response.json(provider === "SpotifyAPI" ? { error: false, lines: [] } : { syncedLyrics: null });
    assert.equal(await get(), null);
});
