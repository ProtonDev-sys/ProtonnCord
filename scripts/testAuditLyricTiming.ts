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

function fixture(service: "spotify" | "tidal", surface: "lyrics" | "seekbar" = "lyrics") {
    let now = 0;
    let anchor = 0;
    let position: number | undefined;
    let effectIndex = 0;
    const effects: { deps: unknown[]; cleanup?: () => void; }[] = [];
    const pending: (() => void)[] = [];
    const timers = new Set<() => void>();
    const store = {
        track: { id: "a", duration: 60_000, songDuration: 60 }, mPosition: 10_000, isPlaying: true, isSettingPosition: false,
        get position() { return this.mPosition + (this.isPlaying ? now - anchor : 0); }
    };
    const name = service === "spotify" ? "Spotify" : "Tidal";
    const base = `@equicordplugins/musicControls/${service}`;
    const intervals = {
        setInterval(callback: () => void, delay: number) { assert.equal(delay, 1000); timers.add(callback); return callback; },
        clearInterval: (callback: () => void) => timers.delete(callback)
    };
    const compile = (file: string, expose = "") => transpileModule(readFileSync(file, "utf8") + expose, {
        fileName: file,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const playbackPosition = runInNewContext(compile("src/equicordplugins/musicControls/playbackPosition.ts") + "\nexports;", { exports: {}, ...intervals });
    const mocks: Record<string, unknown> = {
        "@api/Settings": {}, "@components/BaseText": {}, "@components/Flex": {}, "@components/Icons": {},
        "@components/Paragraph": {}, "@components/Span": {}, "@utils/discord": {}, "@utils/misc": {},
        "@utils/text": { formatDuration: String },
        "../settings": {}, "./SeekBar": {}, "@equicordplugins/musicControls/spotify/SeekBar": {},
        [`./${name}Store`]: { [`${name}Store`]: store },
        "@equicordplugins/musicControls/playbackPosition": playbackPosition,
        "@equicordplugins/musicControls/settings": { settings: { use: () => ({ lyricDelay: 0 }) } },
        [`${base}/${name}Store`]: { [`${name}Store`]: store },
        [`${base}/lyrics/providers/store`]: { [`${name}LrcStore`]: { lyrics: null, lyricsInfo: null } },
        "@utils/css": { classNameFactory: () => () => "" },
        "@webpack": { findCssClassesLazy: () => ({}) },
        "@webpack/common": {
            React: { createRef: () => ({ current: null }), createElement: (type: unknown, props: object) => ({ type, props }) },
            lodash: { debounce: (callback: () => void) => Object.assign(callback, { cancel() {} }) },
            useStateFromStores: (_stores: unknown, selector: () => unknown) => selector(),
            useMemo: (factory: () => unknown) => factory(),
            useState(value: number) {
                position ??= value;
                return [position, (update: number | ((previous: number) => number)) => {
                    position = typeof update === "function" ? update(position!) : update;
                }];
            },
            useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
                const index = effectIndex++;
                const old = effects[index];
                if (old && deps.length === old.deps.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return;
                pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
            }
        }
    };
    const component = service === "spotify" ? "PlayerComponent.tsx" : "TidalPlayer.tsx";
    const path = `src/equicordplugins/musicControls/${service}/${surface === "lyrics" ? "lyrics/components/util.tsx" : component}`;
    const expose = surface === "lyrics" ? "" : `\nexports.SeekBarForTest = ${service === "spotify" ? "SpotifySeekBar" : "TdlSeekBar"};`;
    const api = runInNewContext(compile(path, expose) + "\nexports;", {
        exports: {}, require(key: string) { if (key.endsWith(".css")) return {}; assert.ok(key in mocks, key); return mocks[key]; }, ...intervals
    });
    const render = () => {
        effectIndex = 0;
        if (surface === "lyrics") api.useLyrics({ scroll: false });
        else api.SeekBarForTest();
        pending.splice(0).forEach(run => run());
    };
    render();
    return {
        store, render, timers, position: () => position,
        advance(ms: number) { now += ms; },
        seek(ms: number) { store.mPosition = ms; anchor = now; render(); },
        tick() { [...timers].forEach(callback => callback()); },
        unmount() { effects.forEach(effect => effect.cleanup?.()); }
    };
}

for (const service of ["spotify", "tidal"] as const) for (const surface of ["lyrics", "seekbar"] as const) {
    test(`${service} ${surface} samples playback after delayed ticks and clamps to duration`, () => {
        const state = fixture(service, surface);
        assert.equal(state.position(), 10_000);
        state.advance(30_000);
        state.tick();
        assert.equal(state.position(), 40_000);
        state.advance(30_000);
        state.tick();
        assert.equal(state.position(), 60_000);
        state.unmount();
        assert.equal(state.timers.size, 0);
    });

    test(`${service} ${surface} stops on pause and resynchronizes after seek/resume`, () => {
        const state = fixture(service, surface);
        state.store.isPlaying = false;
        state.seek(2000);
        assert.equal(state.timers.size, 0);
        state.advance(30_000);
        state.tick();
        assert.equal(state.position(), 2000);
        state.store.isPlaying = true;
        state.seek(2000);
        state.advance(4500);
        state.tick();
        assert.equal(state.position(), 6500);
        state.seek(5000);
        assert.equal(state.position(), 5000);
        assert.equal(state.timers.size, 1);
        state.unmount();
    });

    test(`${service} ${surface} resets for a new track even when duration and reported position are unchanged`, () => {
        const state = fixture(service, surface);
        state.advance(30_000);
        state.tick();
        state.store.track = { ...state.store.track, id: "b" };
        state.seek(10_000);
        assert.equal(state.position(), 10_000);
        assert.equal(state.timers.size, 1);
        state.unmount();
    });
}

test("Spotify seekbar stops sampling during a pending seek and resynchronizes on completion", () => {
    const state = fixture("spotify", "seekbar");
    state.store.isSettingPosition = true;
    state.render();
    assert.equal(state.timers.size, 0);
    state.advance(30_000);
    state.tick();
    assert.equal(state.position(), 10_000);
    state.seek(5000);
    assert.equal(state.position(), 5000, "a reported position still applies while seeking");
    state.store.isSettingPosition = false;
    state.render();
    assert.equal(state.timers.size, 1);
    state.advance(5000);
    state.tick();
    assert.equal(state.position(), 10_000);
    state.unmount();
    assert.equal(state.timers.size, 0);
});
