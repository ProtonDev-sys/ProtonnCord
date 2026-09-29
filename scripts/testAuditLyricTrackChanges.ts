/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture(service: "spotify" | "tidal") {
    const requests: { id: string; resolve(value: unknown): void; reject(error: Error): void; }[] = [];
    const listeners = new Set<() => void>();
    const playback = { track: null as { id: string; } | null, init() {},
        addChangeListener: (listener: () => void) => listeners.add(listener),
        removeChangeListener: (listener: () => void) => listeners.delete(listener) };
    let notifications = 0;
    let handlers: Record<string, (event: unknown) => Promise<void>> = {};
    class Store {
        constructor(_dispatcher: unknown, events = {}) { handlers = events; }
        emitChange() { notifications++; }
    }
    const name = service === "spotify" ? "Spotify" : "Tidal";
    const base = `@equicordplugins/musicControls/${service}`;
    const mocks: Record<string, unknown> = {
        "@api/Notifications": { showNotification() {} },
        "@equicordplugins/musicControls/settings": { settings: { store: { lyricsConversion: "None" } } },
        [`${base}/${name}Store`]: { [`${name}Store`]: playback },
        [`${base}/lyrics/api`]: { getLyrics: (track: { id: string; }) => new Promise((resolve, reject) => {
            requests.push({ id: track.id, resolve, reject });
        }) },
        "./types": { Provider: { None: "None", Translated: "Translated", Romanized: "Romanized" } },
        "@webpack": { proxyLazyWebpack: (factory: () => unknown) => factory() },
        "@webpack/common": { Flux: { Store }, FluxDispatcher: { dispatch() {} } }
    };
    const path = `src/equicordplugins/musicControls/${service}/lyrics/providers/store.ts`;
    const code = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const api = runInNewContext(code + "\nexports;", {
        exports: {}, AbortController, require: (key: string) => mocks[key] ?? {}
    })[`${name}LrcStore`];
    api.init();
    return {
        api, requests, listeners, notifications: () => notifications,
        lyrics: () => service === "spotify" ? api.lyricsInfo : api.lyrics,
        change(id: string | null) {
            playback.track = id === null ? null : { id };
            if (service === "spotify") void handlers.SPOTIFY_PLAYER_STATE({ track: playback.track });
            else listeners.forEach(listener => listener());
        }
    };
}

function lyricResult(service: "spotify" | "tidal", text: string) {
    const lines = [{ time: 0, text }];
    return service === "spotify" ? { useLyric: "LRCLIB", lyricsVersions: { LRCLIB: lines } } : lines;
}

for (const service of ["spotify", "tidal"] as const) {
    test(`${service} clears visible lyrics as soon as a different track starts loading`, async () => {
        const state = fixture(service);
        const first = lyricResult(service, "A");
        state.change("a");
        state.requests[0].resolve(first);
        await setImmediate();
        assert.equal(state.lyrics(), first);
        const before = state.notifications();
        state.change("b");
        assert.equal(state.lyrics(), null);
        assert.equal(state.notifications(), before + 1);
        state.change("b");
        assert.equal(state.requests.length, 2, "same-track events do not restart the request");
        state.requests[1].resolve(null);
        await setImmediate();
        assert.equal(state.lyrics(), null);
        state.api.destroy();
    });

    test(`${service} ignores out-of-order track responses and clears failed tracks`, async () => {
        const state = fixture(service);
        state.change("a");
        state.change("b");
        state.change("c");
        const current = lyricResult(service, "C");
        state.requests[2].resolve(current);
        await setImmediate();
        state.requests[0].resolve(lyricResult(service, "A"));
        state.requests[1].reject(new Error("Old request failed"));
        await setImmediate();
        assert.equal(state.lyrics(), current);
        state.change("d");
        assert.equal(state.lyrics(), null);
        state.requests[3].reject(new Error("Current request failed"));
        await setImmediate();
        assert.equal(state.lyrics(), null);
        state.api.destroy();
    });

    test(`${service} missing tracks and destruction invalidate pending results`, async () => {
        const state = fixture(service);
        state.change("a");
        state.change(null);
        state.requests[0].resolve(lyricResult(service, "A"));
        await setImmediate();
        assert.equal(state.lyrics(), null);
        state.change("b");
        state.api.destroy();
        state.requests[1].resolve(lyricResult(service, "B"));
        await setImmediate();
        assert.equal(state.lyrics(), null);
        assert.equal(state.listeners.size, 0);
    });
}
