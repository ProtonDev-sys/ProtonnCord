/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { parseSyncedLyrics } from "../src/equicordplugins/musicControls/parseSyncedLyrics";
import { Provider } from "../src/equicordplugins/musicControls/spotify/lyrics/providers/types";

const prefix = "@equicordplugins/musicControls/";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function load(file: string, modules: Record<string, any>, globals: Record<string, unknown> = {}) {
    const output = transpileModule(readFileSync(`src/equicordplugins/musicControls/${file}`, "utf8"), {
        fileName: file, compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, jsx: JsxEmit.React, esModuleInterop: false }
    }).outputText;
    return runInNewContext(`${output}\nexports;`, {
        exports: {}, AbortController, AbortSignal, SyntaxError, URL, console: { error() {} },
        require: (name: string) => modules[name] ?? {}, ...globals
    });
}

function timers() {
    let now = Date.UTC(2026, 8, 28);
    let id = 0;
    const timeouts = new Map<number, { callback: () => void; delay: number; }>();
    const intervals = new Map<number, () => void>();
    return {
        timeouts, intervals, now: () => now,
        advance(ms: number) { now += ms; },
        fireTimeout() {
            const entry = timeouts.entries().next().value;
            assert.ok(entry, "a retry must wait for its scheduled backoff");
            const [key, timer] = entry;
            timeouts.delete(key);
            now += timer.delay;
            timer.callback();
        },
        globals: {
            Date: class extends Date { static now() { return now; } },
            setTimeout(callback: () => void, delay: number) { timeouts.set(++id, { callback, delay }); return id; },
            clearTimeout(key: number) { timeouts.delete(key); },
            setInterval(callback: () => void, delay: number) { assert.equal(delay, 1000); intervals.set(++id, callback); return id; },
            clearInterval(key: number) { intervals.delete(key); }
        }
    };
}

function storeFixture(service: "spotify" | "tidal", getLyrics?: (...args: any[]) => Promise<any>) {
    const clock = timers();
    const requests: Array<ReturnType<typeof deferred<any>> & { signal?: AbortSignal; }> = [];
    const listeners = new Set<() => void>();
    let handlers: Record<string, (event: any) => Promise<void>>;
    let changes = 0;
    const player = { track: null as any, init() {}, addChangeListener: (fn: () => void) => listeners.add(fn), removeChangeListener: (fn: () => void) => listeners.delete(fn) };
    const modules = {
        "@webpack": { proxyLazyWebpack: (factory: () => unknown) => factory() },
        "@webpack/common": { Flux: { Store: class {
            constructor(_: unknown, next: typeof handlers) { handlers = next; }
            emitChange() { changes++; }
        } }, FluxDispatcher: { dispatch() {} } },
        [`${prefix}settings`]: { settings: { store: { lyricsProvider: Provider.Lrclib, lyricsConversion: Provider.None } } },
        [`${prefix}${service}/${service === "spotify" ? "SpotifyStore" : "TidalStore"}`]: service === "spotify" ? { SpotifyStore: player } : { TidalStore: player },
        [`${prefix}${service}/lyrics/api`]: { getLyrics: getLyrics ?? ((_: unknown, _retries: unknown, signal?: AbortSignal) => {
            const request = { ...deferred<any>(), signal };
            requests.push(request);
            return request.promise;
        }) },
        "./types": { Provider }
    };
    const exports = load(`${service}/lyrics/providers/store.ts`, modules, clock.globals);
    const store = exports[service === "spotify" ? "SpotifyLrcStore" : "TidalLrcStore"];
    store.init();
    return {
        store, player, requests, clock, changes: () => changes,
        value: (name: string) => service === "spotify" ? { useLyric: Provider.Lrclib, lyricsVersions: { [Provider.Lrclib]: [{ time: 0, text: name }] } } : [{ time: 0, text: name }],
        read: () => service === "spotify" ? store.lyricsInfo : store.lyrics,
        select(id: string | null) {
            player.track = id ? { id, name: id, artist: "fixture" } : null;
            if (service === "spotify") return handlers.SPOTIFY_PLAYER_STATE({ track: player.track });
            for (const listener of listeners) listener();
        }
    };
}

for (const service of ["spotify", "tidal"] as const) {
    test(`${service} lyrics clear immediately on track changes and discard out-of-order, missing and failed results`, async () => {
        const f = storeFixture(service);
        f.select("a");
        const a = f.value("track a");
        f.requests[0].resolve(a);
        await flush();
        assert.equal(f.read(), a);
        const beforeChange = f.changes();
        f.select("b");
        assert.equal(f.read(), null, "a pending new track cannot display the old track's lyrics");
        assert.ok(f.changes() > beforeChange, "listeners receive the clearing transition");
        f.select("b");
        assert.equal(f.requests.length, 2, "repeated same-track playback events share the lookup");
        f.select("c");
        if (service === "tidal") assert.equal(f.requests[1].signal?.aborted, true, "changing track cancels the obsolete request");
        f.requests[1].resolve(f.value("late b"));
        await flush();
        assert.equal(f.read(), null);
        const c = f.value("track c");
        f.requests[2].resolve(c);
        await flush();
        assert.equal(f.read(), c);
        f.select("missing");
        f.requests[3].resolve(null);
        await flush();
        assert.equal(f.read(), null);
        f.select("failed");
        f.requests[4].reject(new Error("fixture failure"));
        await flush();
        assert.equal(f.read(), null);
        f.select("stopped");
        f.store.destroy();
        if (service === "tidal") assert.equal(f.requests[5].signal?.aborted, true);
        f.requests[5].resolve(f.value("after stop"));
        await flush();
        assert.equal(f.read(), null);
    });
}

test("Spotify null results retry on later player events at most once per 30 seconds", async () => {
    const f = storeFixture("spotify");
    f.select("a");
    f.requests[0].resolve(null);
    await flush();
    for (let i = 0; i < 10; i++) f.select("a");
    f.clock.advance(29_999);
    f.select("a");
    assert.equal(f.requests.length, 1);
    f.clock.advance(1);
    f.select("a");
    assert.equal(f.requests.length, 2, "same-track failure can recover without changing tracks");
    for (let i = 0; i < 10; i++) f.select("a");
    assert.equal(f.requests.length, 2);
    const recovered = f.value("recovered");
    f.requests[1].resolve(recovered);
    await flush();
    f.clock.advance(60_000);
    f.select("a");
    assert.equal(f.read(), recovered);
    assert.equal(f.requests.length, 2, "successful lyrics do not poll the provider again");
});

test("Spotify stale same-track completion cannot remove a restarted request's pending ownership", async () => {
    const f = storeFixture("spotify");
    f.select("a");
    f.store.destroy();
    f.store.init();
    f.select("a");
    f.requests[0].resolve(f.value("old"));
    await flush();
    f.clock.advance(30_000);
    f.select("a");
    assert.equal(f.requests.length, 2);
    const current = f.value("current");
    f.requests[1].resolve(current);
    await flush();
    assert.equal(f.read(), current);
});

function hookHarness() {
    let cursor = 0;
    const slots: any[] = [];
    let pending: Array<() => void> = [];
    const hooks = {
        React: { createRef: () => ({ current: null }) },
        useState(initial: unknown) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = initial;
            return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
        },
        useMemo(factory: () => unknown, dependencies: unknown[]) {
            const i = cursor++;
            if (!slots[i] || dependencies.some((value, index) => !Object.is(value, slots[i].dependencies[index]))) slots[i] = { dependencies, value: factory() };
            return slots[i].value;
        },
        useEffect(effect: () => (() => void) | undefined, dependencies: unknown[]) {
            const i = cursor++;
            const previous = slots[i];
            if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) pending.push(() => {
                previous?.cleanup?.();
                slots[i] = { dependencies, cleanup: effect() };
            });
        },
        useStateFromStores: (_: unknown, select: () => unknown) => select()
    };
    return {
        hooks,
        render(fn: () => any) {
            cursor = 0;
            const result = fn();
            const effects = pending;
            pending = [];
            effects.forEach(effect => effect());
            return result;
        },
        unmount() { slots.forEach(slot => slot?.cleanup?.()); }
    };
}

for (const service of ["spotify", "tidal"] as const) {
    test(`${service} lyric highlighting follows delayed ticks, pause, seek, track replacement and duration`, () => {
        const clock = timers();
        const h = hookHarness();
        const player = { track: { id: "a", duration: 50_000, songDuration: 50 }, position: 10_000, mPosition: 10_000, isPlaying: true };
        const lyrics = [0, 5, 10, 15, 20, 30, 40, 50].map(time => ({ time, text: String(time) }));
        const follower = load("playbackPosition.ts", {}, clock.globals);
        const fixture = load(`${service}/lyrics/components/util.tsx`, {
            [`${prefix}playbackPosition`]: follower,
            [`${prefix}settings`]: { settings: { use: () => ({ lyricDelay: 0 }) } },
            [`${prefix}${service}/${service === "spotify" ? "SpotifyStore" : "TidalStore"}`]: service === "spotify" ? { SpotifyStore: player } : { TidalStore: player },
            [`${prefix}${service}/lyrics/providers/store`]: service === "spotify"
                ? { SpotifyLrcStore: { lyricsInfo: { useLyric: Provider.Lrclib, lyricsVersions: { [Provider.Lrclib]: lyrics } } } }
                : { TidalLrcStore: { lyrics } },
            "@webpack/common": h.hooks,
            "@webpack": { findCssClassesLazy: () => ({}) }, "@utils/css": { classNameFactory: () => () => "" }
        }, clock.globals);
        const render = () => { h.render(() => fixture.useLyrics({ scroll: false })); return h.render(() => fixture.useLyrics({ scroll: false })); };
        assert.equal(render().currLrcIndex, 2);
        assert.equal(clock.intervals.size, 1);
        clock.advance(30_000);
        player.position = 40_000;
        for (const tick of clock.intervals.values()) tick();
        assert.equal(render().currLrcIndex, 6, "one delayed callback samples the actual 40-second position");
        player.isPlaying = false;
        assert.equal(render().currLrcIndex, 6);
        assert.equal(clock.intervals.size, 0);
        player.mPosition = player.position = 15_000;
        assert.equal(render().currLrcIndex, 3, "paused seeking uses the new playback position");
        player.isPlaying = true;
        render();
        player.track = { ...player.track, id: "b" };
        player.position = 5_000;
        assert.equal(render().currLrcIndex, 1, "same-duration track replacement resets position without requiring another state change");
        assert.equal(clock.intervals.size, 1);
        player.position = 99_000;
        for (const tick of clock.intervals.values()) tick();
        assert.equal(render().currLrcIndex, 7, "position clamps to track duration");
        h.unmount();
        assert.equal(clock.intervals.size, 0);
    });
}

function apiFixture(responses: Array<Response | Error>) {
    const clock = timers();
    const calls: AbortSignal[] = [];
    const api = load("tidal/lyrics/api.tsx", { [`${prefix}parseSyncedLyrics`]: { parseSyncedLyrics } }, {
        ...clock.globals,
        fetch: async (_url: string, options: { signal: AbortSignal; }) => {
            calls.push(options.signal);
            const response = responses.shift();
            if (response instanceof Error) throw response;
            assert.ok(response, "unexpected extra provider request");
            return response;
        }
    });
    return { clock, calls, api, get: (signal?: AbortSignal) => api.getLyrics({ id: "a", name: "fixture", artist: "artist" }, 3, signal) };
}

for (const status of [400, 401, 403, 404, 422, 501]) {
    test(`Tidal HTTP ${status} does not retry a permanent result`, async () => {
        const f = apiFixture([new Response("missing", { status })]);
        assert.equal(await f.get(), null);
        assert.equal(f.calls.length, 1);
        assert.equal(f.clock.timeouts.size, 0);
    });
}

test("Tidal transient errors and transport timeout back off for one then two seconds", async () => {
    const f = apiFixture([new Response("busy", { status: 503 }), new Error("fixture transport timeout"), Response.json({ syncedLyrics: "[00:01.00]Recovered" })]);
    const pending = f.get();
    await flush();
    assert.equal(f.calls.length, 1);
    assert.equal([...f.clock.timeouts.values()][0].delay, 1000);
    f.clock.fireTimeout();
    await flush();
    assert.equal(f.calls.length, 2);
    assert.equal([...f.clock.timeouts.values()][0].delay, 2000);
    f.clock.fireTimeout();
    assert.equal((await pending)[0].text, "Recovered");
    assert.equal(f.calls.length, 3);
});

for (const status of [408, 429, 500, 502, 503, 504]) {
    test(`Tidal HTTP ${status} retries at most three attempts`, async () => {
        const f = apiFixture(Array.from({ length: 3 }, () => new Response("temporary", { status })));
        const pending = f.get();
        await flush();
        f.clock.fireTimeout();
        await flush();
        f.clock.fireTimeout();
        assert.equal(await pending, null);
        assert.equal(f.calls.length, 3);
        assert.equal(f.clock.timeouts.size, 0);
    });
}

test("Tidal malformed or empty lyric responses are terminal", async () => {
    for (const response of [new Response("invalid JSON"), Response.json({}), Response.json({ syncedLyrics: "" })]) {
        const f = apiFixture([response]);
        assert.equal(await f.get(), null);
        assert.equal(f.calls.length, 1);
        assert.equal(f.clock.timeouts.size, 0);
    }
});

for (const header of ["60", "date", "invalid", undefined, "61"]) {
    test(`Tidal Retry-After ${header ?? "missing"} respects the deadline or bounded retry policy`, async () => {
        const value = header === "date" ? new Date(Date.UTC(2026, 8, 28) + 7000).toUTCString() : header;
        const g = apiFixture([new Response("limited", { status: 429, headers: value ? { "Retry-After": value } : {} }), Response.json({ syncedLyrics: "[00:01]Recovered" })]);
        const pending = g.get();
        await flush();
        assert.equal(g.calls.length, 1);
        if (header === "61") {
            assert.equal(await pending, null);
            assert.equal(g.clock.timeouts.size, 0, "a long deadline must not be shortened into an early retry");
        } else {
            assert.equal([...g.clock.timeouts.values()][0].delay, header === "60" ? 60_000 : header === "date" ? 7000 : 1000);
            g.clock.fireTimeout();
            assert.equal((await pending)[0].text, "Recovered");
        }
    });
}

test("Tidal cancellation releases backoff immediately without another fetch", async () => {
    const f = apiFixture([new Response("busy", { status: 500 })]);
    const controller = new AbortController();
    const pending = f.get(controller.signal);
    await flush();
    assert.equal(f.clock.timeouts.size, 1);
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(f.clock.timeouts.size, 0);
    assert.equal(f.calls[0].aborted, true);
    assert.equal(f.calls.length, 1);
});

test("Tidal track changes cancel real API backoff and destruction aborts its replacement fetch", async () => {
    const clock = timers();
    const signals: AbortSignal[] = [];
    const api = load("tidal/lyrics/api.tsx", { [`${prefix}parseSyncedLyrics`]: { parseSyncedLyrics } }, {
        ...clock.globals,
        fetch: (_url: string, options: { signal: AbortSignal; }) => {
            signals.push(options.signal);
            if (signals.length === 1) return Promise.resolve(new Response("busy", { status: 503 }));
            return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
        }
    });
    const f = storeFixture("tidal", api.getLyrics);
    f.select("a");
    await flush();
    assert.equal(clock.timeouts.size, 1);
    f.select("b");
    await flush();
    assert.equal(signals[0].aborted, true);
    assert.equal(clock.timeouts.size, 0);
    assert.equal(signals.length, 2);
    assert.equal(signals[1].aborted, false);
    f.store.destroy();
    await flush();
    assert.equal(signals[1].aborted, true);
    assert.equal(signals.length, 2);
    assert.equal(clock.timeouts.size, 0);
    assert.equal(f.read(), null);
});
