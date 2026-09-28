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
    const data = new Map(initial);
    const reads: string[] = [], writes: string[] = [];
    const settings = { store: { lyricsProvider: Provider.Spotify, fallbackProvider: fallback, spotifyLyricsApiUrl: "", translateTo: "en" } };
    const fetchers: any = { spotify: async () => null, lrclib: async () => null };
    const storage = {
        async get(key: string) { reads.push(key); return structuredClone(data.get(key)); },
        async set(key: string, value: any) { if (failWrite) throw Error("storage failure"); writes.push(key); data.set(key, structuredClone(value)); },
        async update(key: string, updater: any) { if (failWrite) throw Error("storage failure"); writes.push(key); data.set(key, structuredClone(updater(structuredClone(data.get(key))))); },
        async updateMany(keys: string[], updater: any) {
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
    return { api: load("api.tsx"), data, reads, writes, fetchers, settings, advance: (ms: number) => { now += ms; }, failWrite: (value: boolean) => { failWrite = value; } };
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
