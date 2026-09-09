/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { parseSyncedLyrics } from "../src/equicordplugins/musicControls/parseSyncedLyrics";

const react = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };

function load(path: string, helpers = "", mocks: Record<string, any> = {}, globals: Record<string, any> = {}) {
    const settings: any = { store: {}, use: () => settings.store };
    const defaults: Record<string, any> = {
        "@api/Settings": { definePluginSettings: (def: any) => {
            settings.def = def;
            for (const [key, option] of Object.entries<any>(def)) settings.store[key] = option.default ?? option.options?.find((o: any) => o.default)?.value;
            return settings;
        } },
        "@utils/types": { default: (plugin: any) => plugin, OptionType: {}, StartAt: {}, makeRange: () => [] },
        "@utils/constants": { EquicordDevs: {}, Devs: {} },
        "@utils/css": { classNameFactory: () => (value: string) => value },
        "@utils/Logger": { Logger: class { error() { } } },
        "@utils/discord": { getIntlMessage: (key: string) => key },
        "@components/ErrorBoundary": { default: { wrap: (fn: any) => fn } },
        "@webpack": { findComponentByCodeLazy: () => () => undefined },
        "@components/settings": { wrapTab: (component: any) => component },
        "@equicordplugins/musicControls/parseSyncedLyrics": { parseSyncedLyrics }
    };
    const exports: any = {};
    const code = transpileModule(readFileSync(`src/equicordplugins/${path}`, "utf8") + helpers, {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, esModuleInterop: false }
    }).outputText;
    runInNewContext(code, {
        exports, React: react, Map, Set, URL, URLSearchParams, AbortController, AbortSignal, structuredClone,
        setTimeout, clearTimeout, setInterval, clearInterval, console: { error() { } },
        require: (id: string) => mocks[id] ?? defaults[id] ?? {}, ...globals
    });
    return { ...exports, settings };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

function hookHarness() {
    const slots: any[] = [];
    let cursor = 0;
    let pending: (() => void)[] = [];
    const hooks = {
        useState(initial: any) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
            return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
        },
        useRef(initial: any) {
            const i = cursor++;
            return slots[i] ??= { current: initial };
        },
        useMemo(factory: () => any, dependencies: any[]) {
            const i = cursor++;
            const previous = slots[i];
            if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index])))
                slots[i] = { dependencies, value: factory() };
            return slots[i].value;
        },
        useEffect(effect: any, dependencies?: any[]) {
            const i = cursor++;
            const previous = slots[i];
            if (!previous || !dependencies || dependencies.some((value, index) => !Object.is(value, previous.dependencies?.[index]))) {
                pending.push(() => {
                    previous?.cleanup?.();
                    slots[i] = { dependencies, cleanup: effect() };
                });
            }
        },
        useStateFromStores: (_: any, select: any) => select()
    };
    return {
        hooks,
        render<T>(fn: () => T) {
            cursor = 0;
            const output = fn();
            const effects = pending;
            pending = [];
            effects.forEach(effect => effect());
            return output;
        },
        unmount() { slots.forEach(slot => slot?.cleanup?.()); }
    };
}

function findNode(node: any, predicate: (node: any) => boolean): any {
    if (predicate(node)) return node;
    for (const child of node?.props?.children?.flat(Infinity) ?? []) {
        const found = findNode(child, predicate);
        if (found) return found;
    }
}

test("QR verification cancels pending confirmation and the first animation frame on leave/unmount", () => {
    const harness = hookHarness();
    const timers = new Map<number, () => void>();
    const frames = new Map<number, () => void>();
    let id = 0;
    let requests = 0;
    let aborts = 0;
    const { VerifyModal } = load("loginWithQR/ui/modals/VerifyModal.tsx", "\nexport { VerifyModal };", {
        "@equicordplugins/loginWithQR": { default: { started: true } },
        "@equicordplugins/loginWithQR/images": { images: { deviceImage: {} } },
        "@components/Button": { Button: "button", TextButton: "text-button" },
        "..": { cl: (value: string) => value },
        "@webpack": { findByPropsLazy: () => ({ Controller: class { start() { } stop() { } get() { return { progress: "0%" }; } } }) },
        "@webpack/common": { ...harness.hooks, Modal: "modal", RestAPI: { post: () => { requests++; return Promise.resolve(); } } }
    }, {
        setTimeout: (fn: () => void) => { timers.set(++id, fn); return id; }, clearTimeout: (key: number) => timers.delete(key),
        requestAnimationFrame: (fn: () => void) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (key: number) => frames.delete(key)
    });
    const tree = harness.render(() => VerifyModal({ token: "fixture", onAbort: () => aborts++ }));
    const button = findNode(tree, node => node?.props?.onPointerDown);
    button.props.ref.current = {};
    button.props.onPointerDown();
    assert.equal(timers.size, 1);
    button.props.onPointerLeave();
    assert.equal(timers.size, 0);
    button.props.onPointerDown();
    harness.unmount();
    assert.equal(timers.size, 0);
    assert.equal(frames.size, 0);
    assert.equal(requests, 0);
    assert.equal(aborts, 1);
});

test("QR handshake arriving after scanner closure is canceled without opening verification", async () => {
    const pending = deferred<any>();
    let active = true;
    let opened = 0;
    const routes: string[] = [];
    const { verifyUrl } = load("loginWithQR/ui/modals/QrModal.tsx", "\nexport { verifyUrl };", {
        "@webpack/common": { RestAPI: { post: ({ url }: any) => { routes.push(url); return routes.length === 1 ? pending.promise : Promise.resolve(); } } },
        "./VerifyModal": { default: () => opened++ }
    });
    const verifying = verifyUrl("fixture", { current: { isActive: () => active } });
    active = false;
    pending.resolve({ ok: true, status: 200, body: { handshake_token: "fixture-handshake" } });
    await verifying;
    assert.equal(opened, 0);
    assert.equal(routes.at(-1), "/users/@me/remote-auth/cancel");
});

test("MessageColors replaces its hex rule on restart instead of accumulating stale rules", () => {
    const constants = load("messageColors/constants.ts");
    const { default: plugin } = load("messageColors/index.tsx", "", {
        "./constants": constants,
        "@webpack/common": { React: react }
    });
    plugin.start();
    const size = constants.regex.length;
    constants.settings.store.enableShortHexCodes = false;
    plugin.start();
    plugin.start();
    assert.equal(constants.regex.length, size);
    assert.equal(plugin.getColor(1).match("#abc"), null);
    assert.ok(plugin.getColor(1).match("#abcdef"));
});

test("Message previews fetch once per identity and ignore obsolete results", async () => {
    const harness = hookHarness();
    const requests: { id: string; pending: ReturnType<typeof deferred<any>>; }[] = [];
    const { useMessage } = load("messageLinkTooltip/index.tsx", "\nexport { useMessage };", {
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@webpack/common": {
            ...harness.hooks,
            ChannelStore: { getChannel: (id: string) => ({ id }) },
            MessageStore: { getMessage: () => undefined, getMessages: () => ({ receiveMessage: (raw: any) => ({ get: () => raw }) }) },
            Constants: { Endpoints: { MESSAGES: (channel: string) => channel } },
            RestAPI: { get: ({ query }: any) => { const pending = deferred<any>(); requests.push({ id: query.around, pending }); return pending.promise; } }
        }
    });
    harness.render(() => useMessage("c", "old"));
    harness.render(() => useMessage("c", "old"));
    assert.equal(requests.length, 1);
    harness.render(() => useMessage("c", "new"));
    requests[0].pending.resolve({ body: [{ id: "old", channel_id: "c" }] });
    requests[1].pending.resolve({ body: [{ id: "new", channel_id: "c" }] });
    await new Promise(resolve => setImmediate(resolve));
    const state = harness.render(() => useMessage("c", "new"));
    assert.equal(state.message.id, "new");
    assert.equal(state.loading, false);
    assert.equal(requests.length, 2);
    harness.unmount();
});

test("MessageTranslate cancels superseded text and stopped requests without caching late responses", async () => {
    const requests: { pending: ReturnType<typeof deferred<any>>; signal: AbortSignal; }[] = [];
    const settings = { store: { targetLanguage: "en&extra", confidenceRequirement: 0.8 } };
    const excluded = new Set<string>();
    const { translate, getCached, clearAllTranslations } = load("messageTranslate/utils/translate.ts", "", {
        "../settings": { settings, getExcludedLanguages: () => excluded }
    }, {
        fetch: (_: string, { signal }: any) => { const pending = deferred<any>(); requests.push({ pending, signal }); return pending.promise; }
    });
    const response = (text: string) => ({ ok: true, json: async () => ({ src: "ja", confidence: 1, sentences: [{ trans: text }] }) });
    const old = translate("message", "old");
    const latest = translate("message", "new");
    assert.equal(requests[0].signal.aborted, true);
    requests[0].pending.resolve(response("OLD"));
    requests[1].pending.resolve(response("NEW"));
    await Promise.all([old, latest]);
    assert.equal(getCached("message").translated, "NEW");
    const stopping = translate("pending", "text");
    clearAllTranslations();
    assert.equal(requests[2].signal.aborted, true);
    requests[2].pending.resolve(response("late"));
    await stopping;
    assert.equal(getCached("pending"), undefined);
});

test("MessageTranslate bounds successful caches and encodes the selected language", async () => {
    let requestUrl = "";
    const excluded = new Set<string>();
    const { translate, translationCache, translationConfigurations, clearAllTranslations } = load("messageTranslate/utils/translate.ts", "\nexport { translationCache, translationConfigurations };", {
        "../settings": { settings: { store: { targetLanguage: "en&extra", confidenceRequirement: 0.8 } }, getExcludedLanguages: () => excluded }
    }, {
        fetch: async (url: string) => { requestUrl = url; return { ok: true, json: async () => ({ src: "ja", confidence: 1, sentences: [{ trans: "translated" }] }) }; }
    });
    for (let i = 0; i < 1002; i++) await translate(String(i), "original");
    assert.equal(translationCache.size, 1000);
    assert.equal(translationConfigurations.size, 1000);
    assert.equal(new URL(requestUrl).searchParams.get("tl"), "en&extra");
    assert.equal(new URL(requestUrl).searchParams.has("extra"), false);
    clearAllTranslations();
});

test("Synced lyrics retain fractional times, embedded brackets, repeated timestamps and metadata gaps", () => {
    assert.deepEqual(parseSyncedLyrics("[ar:Fixture]\n[00:09.59]one ] two\n[00:02][00:03.5]repeat\n[00:99]invalid\n[00:10.00]♪"), [
        { time: 2, text: "repeat" }, { time: 3.5, text: "repeat" }, { time: 9.59, text: "one ] two" }, { time: 10, text: null }
    ]);
});

test("MiddleClickTweaks keeps paste protection when link blocking is set to none", () => {
    const listeners = new Map<string, Function>();
    const { default: plugin, settings } = load("middleClickTweaks/index.ts", "", {
        "@utils/index": { EquicordDevs: {} }
    }, {
        document: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) }
    });
    plugin.start();
    settings.store.openScope = "none";
    settings.def.openScope.onChange?.("none");
    listeners.get("mouseup")?.({ button: 1 });
    assert.equal(plugin.isPastingDisabled(false), true);
    plugin.stop();
    assert.equal(listeners.size, 0);
    assert.equal(plugin.isPastingDisabled(false), false);
});

test("Moyai stops active audio and queued repetitions when disabled", async () => {
    const sleeping = deferred<void>();
    let audioCount = 0;
    let paused = 0;
    const { default: plugin } = load("moyai/index.ts", "", {
        "@utils/misc": { sleep: () => sleeping.promise },
        "@webpack/common": { SelectedChannelStore: { getChannelId: () => "c" }, RelationshipStore: { isBlocked: () => false } }
    }, {
        document: { createElement: () => {
            audioCount++;
            return { addEventListener() { }, play: () => Promise.resolve(), pause: () => paused++, removeAttribute() { }, load() { } };
        } }
    });
    plugin.start();
    const playing = plugin.flux.MESSAGE_CREATE({ type: "MESSAGE_CREATE", channelId: "c", message: { content: "🗿 🗿", author: { id: "u" } } });
    plugin.stop();
    sleeping.resolve();
    await playing;
    assert.equal(audioCount, 1);
    assert.equal(paused, 1);
});

const providerTypes = { Provider: { Spotify: "Spotify", Lrclib: "LRCLIB", Translated: "Translated", Romanized: "Romanized", None: "None" } };

function musicApi(settings: any, spotify: any, lrclib: any, initial: any = {}) {
    let data = structuredClone(initial);
    const dataStore = {
        get: async () => structuredClone(data),
        set: async (_: string, next: any) => { data = structuredClone(next); },
        update: async (_: string, updater: any) => { data = structuredClone(updater(data)); }
    };
    return { api: load("musicControls/spotify/lyrics/api.tsx", "", {
        "@api/index": { DataStore: dataStore },
        "@equicordplugins/musicControls/settings": { settings },
        "./providers/SpotifyAPI": { getLyricsSpotify: spotify },
        "./providers/lrclibAPI": { getLyricsLrclib: lrclib },
        "./providers/types": providerTypes
    }), data: () => data };
}

test("MusicControls honors disabled lyric fallback and atomically saves concurrent tracks", async () => {
    let fallbacks = 0;
    const settings = { store: { lyricsProvider: "Spotify", fallbackProvider: false } };
    const disabled = musicApi(settings, async () => null, async () => { fallbacks++; return {}; });
    assert.equal(await disabled.api.getLyrics({ id: "a" }), null);
    assert.equal(fallbacks, 0);
    const pending = new Map(["a", "b"].map(id => [id, deferred<any>()]));
    const concurrent = musicApi(settings, (id: string) => pending.get(id)!.promise, async () => null);
    const first = concurrent.api.getLyrics({ id: "a" });
    const second = concurrent.api.getLyrics({ id: "b" });
    await Promise.resolve();
    pending.get("a")!.resolve({ useLyric: "Spotify", lyricsVersions: {} });
    pending.get("b")!.resolve({ useLyric: "Spotify", lyricsVersions: {} });
    await Promise.all([first, second]);
    assert.deepEqual(Object.keys(concurrent.data()).sort(), ["a", "b"]);
});

test("MusicControls cache clear prevents a pending provider response from repopulating saved lyrics", async () => {
    const pending = deferred<any>();
    const fixture = musicApi({ store: { lyricsProvider: "Spotify", fallbackProvider: false } }, () => pending.promise, async () => null);
    const fetching = fixture.api.getLyrics({ id: "a" });
    await Promise.resolve();
    await fixture.api.clearLyricsCache();
    pending.resolve({ useLyric: "Spotify", lyricsVersions: {} });
    assert.equal(await fetching, null);
    assert.deepEqual(fixture.data(), {});
});

test("MusicControls legacy lyric migration preserves newer entries before clearing the legacy key", async () => {
    const current = { useLyric: "Spotify", lyricsVersions: { Spotify: [{ time: 1, text: "new" }] } };
    const data = new Map<string, any>([
        ["SpotifyLyricsCache", { old: [{ time: 1, text: "old" }], newer: [{ time: 0, text: "outdated" }] }],
        ["SpotifyLyricsCacheNew", { newer: current }]
    ]);
    const { migrateOldLyrics } = load("musicControls/spotify/lyrics/api.tsx", "", {
        "@api/index": { DataStore: {
            get: async (key: string) => data.get(key),
            set: async (key: string, value: any) => data.set(key, value),
            update: async (key: string, updater: any) => data.set(key, updater(data.get(key)))
        } },
        "./providers/types": providerTypes
    });
    await migrateOldLyrics();
    assert.equal(data.get("SpotifyLyricsCacheNew").newer, current);
    assert.equal(data.get("SpotifyLyricsCacheNew").old.lyricsVersions.LRCLIB[0].text, "old");
    assert.deepEqual(Object.keys(data.get("SpotifyLyricsCache")), []);
});

test("Spotify lyrics fetch once per track and ignore player events after destruction", async () => {
    let requests = 0;
    const track = { id: "a" };
    const { SpotifyLrcStore } = load("musicControls/spotify/lyrics/providers/store.ts", "", {
        "@equicordplugins/musicControls/settings": { settings: { store: { lyricsProvider: "Spotify", lyricsConversion: "None" } } },
        "@equicordplugins/musicControls/spotify/SpotifyStore": { SpotifyStore: { track } },
        "@equicordplugins/musicControls/spotify/lyrics/api": { getLyrics: async () => { requests++; return null; } },
        "@webpack": { proxyLazyWebpack: (factory: any) => factory() },
        "@webpack/common": { Flux: { Store: class {
            constructor(_: any, public handlers: any) { }
            emitChange() { }
        } } },
        "./types": providerTypes
    });
    SpotifyLrcStore.init();
    await SpotifyLrcStore.handlers.SPOTIFY_PLAYER_STATE({ track });
    await SpotifyLrcStore.handlers.SPOTIFY_PLAYER_STATE({ track });
    assert.equal(requests, 1);
    SpotifyLrcStore.destroy();
    await SpotifyLrcStore.handlers.SPOTIFY_PLAYER_STATE({ track });
    assert.equal(requests, 1);
    SpotifyLrcStore.init();
    await SpotifyLrcStore.handlers.SPOTIFY_PLAYER_STATE({ track });
    assert.equal(requests, 2);
});

test("MusicControls lyric translation uses the selected language with four concurrent requests and linear deduplication", async () => {
    let active = 0;
    let maxActive = 0;
    const requests: URL[] = [];
    const { lyricsAlternativeFetchers } = load("musicControls/spotify/lyrics/providers/translator/index.ts", "", {
        "@equicordplugins/musicControls/settings": { settings: { store: { translateTo: "fr" } } },
        "@equicordplugins/musicControls/spotify/lyrics/providers/types": providerTypes
    }, {
        fetch: async (value: string) => {
            const url = new URL(value);
            requests.push(url);
            maxActive = Math.max(maxActive, ++active);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            return { ok: true, json: async () => ({ sentences: [{ trans: "T:" }, { trans: url.searchParams.get("q") }] }) };
        }
    });
    const lyrics = ["one", "two", "three", "four", "five", "one"].map((text, time) => ({ text, time }));
    const translated = await lyricsAlternativeFetchers.Translated(lyrics);
    assert.equal(requests.length, 5);
    assert.equal(maxActive, 4);
    assert.ok(requests.every(url => url.searchParams.get("tl") === "fr"));
    assert.equal(translated[0].text, "T:one");
    assert.equal(translated[5].text, "T:one");
});

test("Tidal clears removed tracks, accepts incremental state, supports mute, and reconnects after stop", () => {
    const sockets: any[] = [];
    class FakeSocket {
        listeners: Record<string, Function> = {};
        sent: any[] = [];
        closed = false;
        constructor() { sockets.push(this); }
        addEventListener(name: string, fn: Function) { this.listeners[name] = fn; }
        send(value: string) { this.sent.push(JSON.parse(value)); }
        close() { this.closed = true; }
        message(message: any) { this.listeners.message({ data: JSON.stringify(message) }); }
    }
    const { TidalStore } = load("musicControls/tidal/TidalStore.ts", "", {
        "../settings": { settings: { store: {} } },
        "@webpack": { proxyLazyWebpack: (factory: any) => factory() },
        "@webpack/common": { Flux: { Store: class { emitChange() { } } } }
    }, { WebSocket: FakeSocket });
    sockets[0].listeners.open();
    sockets[0].message({ type: "update", all: true, fields: { track: { id: "a", title: "Track" }, currentTime: 1, playing: true } });
    assert.equal(TidalStore.track.id, "a");
    sockets[0].message({ type: "update", all: false, field: "currentTime", value: 3 });
    assert.equal(TidalStore.mPosition, 3000);
    TidalStore.setVolume(0);
    assert.equal(sockets[0].sent.at(-1).volume, 0);
    sockets[0].message({ type: "update", all: false, field: "track", value: null });
    assert.equal(TidalStore.track, null);
    TidalStore.destroy();
    assert.equal(sockets[0].closed, true);
    TidalStore.init();
    assert.equal(sockets.length, 2);
    TidalStore.destroy();
});

test("Soggy creates audio only while enabled and keeps its modal hook order stable", () => {
    const harness = hookHarness();
    const players: any[] = [];
    const fixture = load("soggy/index.tsx", "\nexport { SoggyModal };", {
        "@webpack/common": { React: { ...react, ...harness.hooks }, Modal: "modal" },
        "@api/AudioPlayer": { createAudioPlayer: (_url: string, options: any) => {
            const player = { volume: options.volume, loops: 0, stops: 0, deleted: 0, load() {}, loop() { this.loops++; }, stop() { this.stops++; }, delete() { this.deleted++; } };
            players.push(player); return player;
        } }
    });
    fixture.settings.def.songLink.onChange("fixture");
    assert.equal(players.length, 0);
    fixture.default.start();
    harness.render(() => fixture.SoggyModal({}));
    assert.equal(players[1].loops, 1);
    fixture.settings.store.songVolume = 0;
    fixture.settings.def.songVolume.onChange(0);
    harness.render(() => fixture.SoggyModal({}));
    assert.equal(players[1].stops, 1);
    assert.equal(players[1].volume, 0);
    fixture.default.stop();
    fixture.settings.def.boopLink.onChange("fixture");
    assert.equal(players.length, 2);
    assert(players.every(player => player.deleted === 1));
    harness.unmount();
});

test("Sekai sticker keeps one loaded image across edits and uploads to the captured channel", async () => {
    const harness = hookHarness();
    const images: any[] = [];
    let channel = { id: "first" };
    let uploadedChannel: any;
    let exportBlob!: (blob: Blob | null) => void;
    class FixtureImage {
        complete = true; naturalWidth = 296; width = 296; height = 256;
        onload?: () => void; onerror?: () => void;
        constructor() { images.push(this); }
    }
    const characters = Array.from({ length: 50 }, () => ({ img: "fixture.png", character: "fixture", color: "#ffffff", defaultText: { x: 100, y: 100, s: 30, r: 0 } }));
    const fixture = load("sekaiStickers/Components/SekaiStickersModal.tsx", "", {
        "@equicordplugins/sekaiStickers/characters.json": { characters },
        "./Canvas": { default: "canvas" },
        "@webpack/common": {
            React: { ...react, ...harness.hooks }, Modal: "modal", Toasts: { Type: {} }, showToast() {},
            SelectedChannelStore: { getChannelId: () => channel.id }, ChannelStore: { getChannel: () => channel },
            UploadHandler: { promptToUpload: (_files: any, captured: any) => { uploadedChannel = captured; } }
        }
    }, { Image: FixtureImage, document: { fonts: { load: async () => [] } }, File });
    const render = () => fixture.default({ modalProps: { onClose() {} }, settings: { store: { AutoCloseModal: false } } });
    harness.render(render);
    images[0].onload();
    await new Promise<void>(resolve => setImmediate(resolve));
    const tree = harness.render(render);
    assert.equal(images.length, 1);
    const ctx = { canvas: { toBlob: (callback: typeof exportBlob) => { exportBlob = callback; } }, clearRect() {}, drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, strokeText() {}, fillText() {} };
    findNode(tree, node => node?.type === "canvas").props.draw(ctx);
    tree.props.actions[1].onClick();
    channel = { id: "second" };
    exportBlob(new Blob(["fixture"]));
    assert.equal(uploadedChannel.id, "first");
    harness.unmount();
    assert.equal(images[0].onload, null);
});

test("SongLink bounds native lookup time and validates responses and external URLs", async () => {
    let requests = 0;
    let response: any = { ok: false, status: 503 };
    const fixture = load("songLink.desktop/native.ts", "", {
        "@main/settings": { RendererSettings: { store: {} } }
    }, { fetch: async (_url: string, options: any) => {
        requests++;
        assert(options.signal instanceof AbortSignal);
        return response;
    } });
    await assert.rejects(fixture.getTrackData(null, "file:///fixture"));
    assert.equal(requests, 0);
    await assert.rejects(fixture.getTrackData(null, "https://example.test/song"), /503/);
    response = { ok: true, json: async () => null };
    await assert.rejects(fixture.getTrackData(null, "https://example.test/song"), /invalid response/);
    response = { ok: true, json: async () => ({ linksByPlatform: {
        spotify: { url: "https://open.spotify.com/track/fixture", nativeAppUriDesktop: "spotify:track:fixture" },
        missing: null, bad: { url: "file:///fixture" },
        plain: { url: "https://example.test/plain", nativeAppUriDesktop: "file:///fixture" }
    } }) };
    const data = await fixture.getTrackData(null, "https://example.test/song");
    assert.equal(data.links.spotify.nativeUri, "spotify:track:fixture");
    assert.equal(data.links.bad, undefined);
    assert.equal(data.links.plain.nativeUri, undefined);
});

test("SongLink cache isolates lookup countries and recognizes ordinary Tidal links", () => {
    const fixture = load("songLink.desktop/index.tsx", "\nexport { extractMusicLinks };", {
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {} },
        "./Providers": { Providers: {} }
    }, { VencordNative: { pluginHelpers: { SongLink: {} } } });
    const plugin = fixture.default;
    const us = { links: { us: { url: "https://example.test/us" } } };
    plugin.addToCache("song", us, "US");
    assert.equal(plugin.getFromCache("song", "GB"), undefined);
    assert.equal(plugin.getFromCache("song", "US"), us);
    for (let i = 0; i < 101; i++) plugin.addToCache(String(i), us, "US");
    assert.equal(plugin.cacheKeys.length, 100);
    assert.equal(plugin.getFromCache("song", "US"), undefined);
    assert.deepEqual([...fixture.extractMusicLinks("https://tidal.com/track/123 https://listen.tidal.com/browse/track/456")], ["https://tidal.com/track/123", "https://listen.tidal.com/browse/track/456"]);
});

function spotlightApiFixture(fetchFixture: typeof fetch) {
    let userId = "account-a";
    const tokens: Record<string, any> = {
        "account-a": { access: "fixture-access-a", refresh: "fixture-refresh-a" },
        "account-b": { access: "fixture-access-b", refresh: "fixture-refresh-b" }
    };
    const changes: any[] = [];
    const updates: any[] = [];
    const auth = {
        getToken: (id = userId) => tokens[id],
        setToken: (access: string, refresh: string, id = userId) => { changes.push(["set", id]); tokens[id] = { access, refresh }; },
        deleteTokens: (id: string) => { changes.push(["delete", id]); delete tokens[id]; }
    };
    const fixture = load("songSpotlight.desktop/lib/api.ts", "", {
        "@song-spotlight/api/structs": { UserDataSchema: { max: () => ({ parse: (data: any) => data }) } },
        "./stores/AuthorizationStore": { useAuthorizationStore: { getState: () => auth } },
        "./stores/SongStore": { useSongStore: { getState: () => ({ users: {}, update: (value: any) => updates.push(value) }) } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: userId }) }, showToast() {}, Toasts: { Type: {} } }
    }, { fetch: fetchFixture, Headers });
    return { ...fixture, tokens, changes, updates, setUser: (id: string) => { userId = id; } };
}

const spotlightDataURL = "https://dc.songspotlight.nexpid.xyz/api/data";

test("SongSpotlight does not publish an old account's refreshed token into a new account", async () => {
    const refresh = deferred<Response>();
    const started = deferred<void>();
    const fixture = spotlightApiFixture(async url => {
        if (String(url).endsWith("/refresh")) { started.resolve(); return refresh.promise; }
        return new Response("expired", { status: 401 });
    });
    const pending = fixture.authFetch(spotlightDataURL);
    await started.promise;
    fixture.setUser("account-b");
    refresh.resolve(new Response("new-fixture-access-a"));
    await assert.rejects(pending, /account changed/);
    assert.equal(fixture.tokens["account-b"].access, "fixture-access-b");
    assert.deepEqual(fixture.changes, []);
});

test("SongSpotlight coalesces concurrent refreshes and preserves Headers options", async () => {
    const refresh = deferred<Response>();
    const started = deferred<void>();
    let refreshes = 0;
    let successful = 0;
    const fixture = spotlightApiFixture(async (url, options) => {
        if (String(url).endsWith("/refresh")) { refreshes++; started.resolve(); return refresh.promise; }
        const headers = new Headers(options?.headers);
        assert.equal(headers.get("X-Fixture"), "present");
        if (headers.get("Authorization") === "new-fixture-access-a") { successful++; return new Response("ok"); }
        return new Response("expired", { status: 401 });
    });
    const options = { headers: new Headers({ "X-Fixture": "present" }) };
    const first = fixture.authFetch(spotlightDataURL, options);
    const second = fixture.authFetch(spotlightDataURL, options);
    await started.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(refreshes, 1);
    refresh.resolve(new Response("new-fixture-access-a"));
    await Promise.all([first, second]);
    assert.equal(successful, 2);
    assert.deepEqual(fixture.changes, [["set", "account-a"]]);
});

test("SongSpotlight rejects foreign credential destinations and discards late account data", async () => {
    const body = deferred<any>();
    const started = deferred<void>();
    let requests = 0;
    const fixture = spotlightApiFixture(async () => {
        requests++;
        return { ok: true, headers: new Headers(), json: () => { started.resolve(); return body.promise; } } as any;
    });
    await assert.rejects(fixture.authFetch("https://example.test/fixture"), /outside its API/);
    assert.equal(requests, 0);
    const pending = fixture.getData();
    await started.promise;
    fixture.setUser("account-b");
    body.resolve([]);
    await assert.rejects(pending, /account changed/);
    assert.deepEqual(fixture.updates, []);
});

test("SongSpotlight targeted sign-out preserves other account tokens and legacy migration", () => {
    let persistence: any;
    const fixture = load("songSpotlight.desktop/lib/stores/AuthorizationStore.ts", "", {
        "@utils/lazy": { proxyLazy: (fn: any) => fn() },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "a" }) },
            zustandPersist: (definition: any, options: any) => { persistence = options; return definition; },
            zustandCreate: (definition: any) => {
                let state: any;
                state = definition((next: any) => { state = { ...state, ...next }; }, () => state);
                return { getState: () => state };
            }
        }
    });
    const get = fixture.useAuthorizationStore.getState;
    get().setToken("a", "ar", "a");
    get().setToken("b", "br", "b");
    get().deleteTokens("a");
    assert.equal(get().getToken("a"), undefined);
    assert.equal(get().getToken("b").access, "b");
    const migrated = persistence.migrate({ tokens: { a: "legacy" } }, 0);
    assert.equal(migrated.tokens.a.access, "legacy");
    assert.equal(migrated.tokens.a.refresh, "");
});

test("SongSpotlight render ignores a previous song's late native result", async () => {
    const harness = hookHarness();
    const waiting: ReturnType<typeof deferred>[] = [];
    const fixture = load("songSpotlight.desktop/service.ts", "", {
        "@song-spotlight/api/util": { sid: (song: any) => song.id },
        "@webpack/common": harness.hooks
    }, { VencordNative: { pluginHelpers: { SongSpotlight: { renderSong: () => { const value = deferred(); waiting.push(value); return value.promise; } } } } });
    harness.render(() => fixture.useRender({ id: "a" }));
    harness.render(() => fixture.useRender({ id: "b" }));
    waiting[1].resolve({ label: "b" });
    await new Promise<void>(resolve => setImmediate(resolve));
    waiting[0].resolve({ label: "a" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(harness.render(() => fixture.useRender({ id: "b" })).render.label, "b");
    harness.unmount();
});

test("SongSpotlight idle progress indicators schedule no animation frames", () => {
    const harness = hookHarness();
    let frames = 0;
    const cancelled: number[] = [];
    const playingRef: any = { current: undefined };
    const audioRef = { current: undefined };
    const fixture = load("songSpotlight.desktop/ui/components/ProgressCircle.tsx", "", {
        "@webpack/common": harness.hooks
    }, { requestAnimationFrame: () => ++frames, cancelAnimationFrame: (id: number) => cancelled.push(id) });
    const render = () => fixture.default({ border: 2.5, audioRef, playingRef });
    harness.render(render);
    assert.equal(frames, 0);
    playingRef.current = { audio: {} };
    harness.render(render);
    assert.equal(frames, 1);
    playingRef.current = undefined;
    harness.render(render);
    assert.deepEqual(cancelled, [1]);
    harness.unmount();
});

test("SongSpotlight preview advances by numeric track order and cleans up on unmount", () => {
    const harness = hookHarness();
    let playing: number | undefined;
    const selections: any[] = [];
    const nodes: any[] = [];
    const list = Array.from({ length: 12 }, (_, i) => ({ audio: { previewUrl: `fixture:${i}` } }));
    const audioRef = { current: undefined };
    const fixture = load("songSpotlight.desktop/ui/components/AudioPlayer.tsx", "", {
        "@equicordplugins/songSpotlight.desktop/settings": { default: { store: { previewVolume: 100 }, use: () => ({ previewVolume: 100 }) } },
        "@webpack/common": { ...harness.hooks, useCallback: (fn: any) => fn, Toasts: { Type: {} }, showToast() {} }
    });
    const render = () => fixture.default({ audioRef, list, playing, setPlaying: (value: any) => selections.push(value), setLoadedAudio() {} });
    let tree = harness.render(render);
    for (const i of [1, 2, 10]) {
        const node = { paused: true, pauses: 0, currentTime: 0, volume: 1, addEventListener() {}, removeEventListener() {}, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; this.pauses++; } };
        nodes.push(node);
        const entry = findNode(tree, node => node?.props?.index === i);
        entry.props.handleRef(i, node);
        entry.props.handleLoaded(i, true);
    }
    playing = 1;
    tree = harness.render(render);
    findNode(tree, node => node?.props?.index === 1).props.handleStopped(1, true);
    assert.equal(selections.at(-1), 2);
    harness.unmount();
    assert(nodes.every(node => node.paused));
    assert.equal(audioRef.current, undefined);
});

test("GIF collection creation stays open on persistence failure and prevents duplicate submissions", async () => {
    const harness = hookHarness();
    const finish = deferred<void>();
    let fail = true;
    let writes = 0;
    let closes = 0;
    const props = { onClose: () => { closes++; } };
    const fixture = load("gifCollections/components/modals.tsx", "\nexport { CreateCollectionModal };", {
        "@webpack/common": { ...harness.hooks, useCallback: (fn: any) => fn, Modal: "modal", TextInput: "input" },
        "../utils/misc": { cl: (value: string) => value },
        "../utils/collectionManager": { createCollection: async () => {
            writes++;
            await finish.promise;
            if (fail) throw new Error("fixture write failed");
        } }
    });
    const render = () => fixture.CreateCollectionModal({ props, gif: {} });
    let tree = harness.render(render);
    findNode(tree, node => node?.type === "input").props.onChange("Saved name");
    tree = harness.render(render);
    const first = tree.props.actions[0].onClick();
    await tree.props.actions[0].onClick();
    assert.equal(writes, 1);
    assert.equal(closes, 0);
    finish.resolve();
    await first;
    tree = harness.render(render);
    assert.equal(closes, 0);
    assert.equal(findNode(tree, node => node?.type === "input").props.value, "Saved name");
    assert(findNode(tree, node => node?.props?.role === "alert"));
    fail = false;
    await tree.props.actions[0].onClick();
    assert.equal(closes, 1);
});

test("streaming codec toggles retain the initial capabilities and restore them on stop", async () => {
    const enabled: Record<string, boolean> = {};
    let queries = 0;
    const preferences = { disableAv1Codec: true, disableH265Codec: false, disableH264Codec: false };
    const engine = {
        getCodecCapabilities: (cb: any) => { queries++; cb(JSON.stringify([{ codec: "AV1", encode: true }, { codec: "H264", encode: false }])); },
        setAv1Enabled: (value: boolean) => { enabled.AV1 = value; },
        setH265Enabled: (value: boolean) => { enabled.H265 = value; },
        setH264Enabled: (value: boolean) => { enabled.H264 = value; }
    };
    const { default: plugin } = load("streamingCodecDisabler/index.ts", "", {
        "@api/Settings": { definePluginSettings: (value: any) => value, Settings: { plugins: { StreamingCodecDisabler: preferences } } },
        "@webpack/common": { MediaEngineStore: { getMediaEngine: () => engine } }
    });
    plugin.start();
    await plugin.updateDisabledCodecs();
    assert.equal(enabled.AV1, false);
    preferences.disableAv1Codec = false;
    await plugin.updateDisabledCodecs();
    assert.equal(enabled.AV1, true);
    assert.equal(queries, 1);
    preferences.disableAv1Codec = true;
    await plugin.updateDisabledCodecs();
    plugin.stop();
    assert.equal(enabled.AV1, true);
    assert.equal(enabled.H264, false);
});

test("TalkInReverse registers one send handler and reverses Unicode graphemes intact", () => {
    const harness = hookHarness();
    const listeners = new Set<any>();
    const { default: plugin } = load("talkInReverse/index.tsx", "", {
        "@api/MessageEvents": { addMessagePreSendListener: (fn: any) => listeners.add(fn), removeMessagePreSendListener: (fn: any) => listeners.delete(fn) },
        "@webpack/common": { ...harness.hooks, React: react }
    }, { Intl });
    plugin.start();
    const tree = harness.render(() => plugin.chatBarButton.render({ isMainChat: true }));
    tree.props.onClick();
    const message = { content: "a👨‍👩‍👧‍👦e\u0301" };
    for (const listener of listeners) listener("channel", message);
    assert.equal(message.content, "e\u0301👨‍👩‍👧‍👦a");
    harness.render(() => plugin.chatBarButton.render({ isMainChat: false }));
    assert.equal(listeners.size, 1);
    plugin.stop();
    harness.unmount();
    assert.equal(listeners.size, 0);
});

function streakStoreFixture(fetcher: typeof fetch, datastore: any = {}) {
    let user = "11111111111111111";
    const fixture = load("streaks/stores/StreaksStore.ts", "", {
        "@api/DataStore": datastore,
        "@utils/lazy": { proxyLazy: (fn: any) => fn() },
        "../constants": { API_URL: "https://fixture.invalid" },
        "./AuthorizationStore": { useAuthorizationStore: { getState: () => ({ tokens: { "11111111111111111": "fixture-a", "22222222222222222": "fixture-b" } }) } },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: user }) },
            zustandCreate: (fn: any) => {
                let state: any;
                state = fn((value: any) => { state = { ...state, ...value }; }, () => state);
                return { getState: () => state };
            }
        }
    }, { fetch: fetcher });
    return { ...fixture, setUser: (value: string) => { user = value; } };
}

test("Streaks ignores inactive requests and stale account responses", async () => {
    const response = deferred<Response>();
    let requests = 0;
    const fixture = streakStoreFixture(async () => { requests++; return response.promise; });
    await fixture.useStreaksStore.getState().fetch();
    assert.equal(requests, 0);
    fixture.setStreaksActive(true);
    const pending = fixture.useStreaksStore.getState().fetch();
    fixture.setUser("22222222222222222");
    response.resolve(new Response(JSON.stringify([{ user_a_id: "11111111111111111", user_b_id: "33333333333333333", count: 5 }])));
    await pending;
    assert.equal(Object.keys(fixture.useStreaksStore.getState().streaks).length, 0);
    fixture.setStreaksActive(false);
});

test("Streaks migration coalesces calls and preserves local data changed during upload", async () => {
    const response = deferred<Response>();
    let requests = 0;
    let deletions = 0;
    let data = { fixture: 1 };
    const fixture = streakStoreFixture(async () => { requests++; return response.promise; }, {
        get: async () => data, del: async () => { deletions++; }
    });
    fixture.setStreaksActive(true);
    const a = fixture.useStreaksStore.getState().migrate();
    const b = fixture.useStreaksStore.getState().migrate();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests, 1);
    data = { fixture: 2 };
    response.resolve(new Response("ok"));
    await Promise.all([a, b]);
    assert.equal(deletions, 0);
});

test("ThemeLibrary token reads cannot overwrite a newer stored token and 401 is unauthorized", async () => {
    const oldRead = deferred<string>();
    const started = deferred<void>();
    let saved = "old-fixture";
    const fixture = load("themeLibrary/utils/auth.tsx", "\nexport { setThemeLibraryToken, deleteThemeLibraryToken };", {
        "@api/DataStore": { get: () => { started.resolve(); return oldRead.promise; }, set: async (_: string, value: string) => { saved = value; }, del: async () => { saved = ""; } },
        "@equicordplugins/themeLibrary/components/ThemeTab": { themeRequest: async () => new Response("no", { status: 401 }), logger: { error() {} } }
    });
    const reading = fixture.getThemeLibraryToken();
    await started.promise;
    await fixture.setThemeLibraryToken("new-fixture");
    oldRead.resolve("old-fixture");
    assert.equal(await reading, "new-fixture");
    assert.equal(saved, "new-fixture");
    assert.equal(await fixture.getAuthorization(), false);
    await fixture.deleteThemeLibraryToken("old-fixture");
    assert.equal(await fixture.getThemeLibraryToken(), "new-fixture");
    await fixture.deleteThemeLibraryToken("new-fixture");
    assert.equal(await fixture.getThemeLibraryToken(), null);
});

test("ThemeLibrary prevents a second like while authorization is pending", async () => {
    const harness = hookHarness();
    const authorization = deferred<boolean>();
    let authCalls = 0;
    let writes = 0;
    const fixture = load("themeLibrary/components/LikesComponent.tsx", "", {
        "@webpack/common": harness.hooks,
        "@components/margins": { Margins: {} },
        "@equicordplugins/themeLibrary/utils/Icons": { LikeIcon() {} },
        "@equicordplugins/themeLibrary/utils/auth": { isAuthorized: () => { authCalls++; return authorization.promise; }, getThemeLibraryToken: async () => "fixture" },
        "./ThemeTab": { logger: { error() {} }, themeRequest: async (_: string, options: any) => { if (options.method === "POST") writes++; return new Response("bad", { status: 503 }); } }
    });
    const likedThemes = { status: 200, likes: [{ themeId: 1, likes: 3, hasLiked: false }] };
    const render = () => fixture.LikesComponent({ themeId: "1", likedThemes });
    harness.render(render);
    const tree = harness.render(render);
    const first = tree.props.onClick();
    await tree.props.onClick();
    assert.equal(authCalls, 1);
    authorization.resolve(true);
    await first;
    assert.equal(writes, 1);
    assert.equal(harness.render(render).props.children.at(-1), 3);
    harness.unmount();
});

test("toast queue settles every waiter on teardown even when a close callback throws", async () => {
    let unmounts = 0;
    let closes = 0;
    const fixture = load("toastNotifications/components/Notifications.tsx", "", {
        "@equicordplugins/toastNotifications/index": { settings: { store: { maxNotifications: 3 } } },
        "@webpack/common": { createRoot: () => ({ render() {}, unmount() { unmounts++; } }) }
    }, { document: { createElement: () => ({ remove() {} }), body: { append() {} } } });
    const a = fixture.showNotification({ title: "a", body: "a", onClose() { closes++; throw new Error("fixture"); } });
    const b = fixture.showNotification({ title: "b", body: "b", onClose() { closes++; } });
    fixture.teardownNotifications();
    await Promise.all([a, b]);
    assert.equal(closes, 2);
    assert.equal(unmounts, 1);
});

test("TriviaAI does not place a late answer into another channel or act after an account switch", async () => {
    let inserted = 0;
    const utility = load("triviaAI/utils.ts", "", {
        "./settings": { settings: { store: { mode: "chatbar" } } },
        "@webpack/common": { SelectedChannelStore: { getChannelId: () => "different" } },
        "@utils/discord": { insertTextIntoChatInputBox() { inserted++; } }
    });
    await utility.handleResponse({ channel_id: "original" }, "fixture answer");
    assert.equal(inserted, 0);
    const response = deferred<string>();
    const started = deferred<void>();
    let user = "a";
    let handled = 0;
    const fixture = load("triviaAI/index.tsx", "\nexport { answerMessage };", {
        "./settings": { settings: { store: { mode: "bot" } } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: user }) } },
        "./utils": { getPayload: async () => [], getResponse: () => { started.resolve(); return response.promise; }, handleResponse() { handled++; } }
    });
    fixture.default.start();
    const pending = fixture.answerMessage({});
    await started.promise;
    user = "b";
    response.resolve("fixture answer");
    await pending;
    assert.equal(handled, 0);
});

test("UserPFP preserves local overrides and serializes local-only persistence", async () => {
    const localId = "11111111111111111";
    const remoteId = "22222222222222222";
    const newId = "33333333333333333";
    let fail = false;
    const writes: any[] = [];
    const fixture = load("userpfp/index.tsx", "", {
        "@api/DataStore": { get: async () => ({ [localId]: "local" }), set: async (_: string, value: any) => { if (fail) throw Error("fixture"); writes.push({ ...value }); } },
        "@webpack": { extractAndLoadChunksLazy: () => () => undefined }
    }, { IS_DEV: false, fetch: async () => new Response(JSON.stringify({ avatars: { [localId]: "remote-overlap", [remoteId]: "remote" } })) });
    await fixture.default.start();
    assert.equal(fixture.data.avatars[localId], "local");
    assert.equal(fixture.data.avatars[remoteId], "remote");
    await Promise.all([fixture.saveAvatar(localId, "edited"), fixture.saveAvatar(newId, "new")]);
    assert.equal(writes.at(-1)[localId], "edited");
    assert.equal(writes.at(-1)[newId], "new");
    assert.equal(writes.at(-1)[remoteId], undefined);
    fail = true;
    await assert.rejects(fixture.saveAvatar(localId, "failed"));
    assert.equal(fixture.data.avatars[localId], "edited");
});

test("userplugin callback IDs stay distinct within one clock tick and self-removal does not skip listeners", () => {
    const { VariableWithCallbacks } = load("userpluginInstaller.dev/VariableWithCallbacks.ts", "", {}, { Date: { now: () => 1 } });
    const variable = new VariableWithCallbacks(0);
    const calls: number[] = [];
    const a = variable.registerCallback((_: number, id: number) => { calls.push(1); variable.deregisterCallback(id); });
    const b = variable.registerCallback(() => calls.push(2));
    assert.notEqual(a, b);
    variable.value(1);
    assert.deepEqual(calls, [1, 2]);
    variable.deregisterCallback(b);
    variable.value(2);
    assert.deepEqual(calls, [1, 2]);
});

test("userplugin install failures reject without starting a build and metadata stays literal", async () => {
    let builds = 0;
    const fixture = load("userpluginInstaller.dev/native.ts", "\ncloneRepo = async () => { throw new Error('fixture clone failed'); }; export { generateReviewPluginContent };", {
        "@main/settings": { NativeSettings: { store: { plugins: {} } } },
        "child_process": { exec() { builds++; } },
        "electron": { dialog: { showMessageBox: async () => ({ response: 1 }) } },
        "path": { basename: () => "desktop", join: (...parts: string[]) => parts.join("/"), resolve: (...parts: string[]) => parts.join("/") },
        "./repositorySafety": { parseUserpluginRepositoryUrl: () => ({ href: "https://fixture.invalid/repo", owner: "fixture", repo: "repo", source: "fixture.invalid" }), resolveUserpluginDirectory: () => "fixture/repo" },
        "./misc/pluginValidate.txt": { default: "<h3>%PLUGINNAME%</h3><p>%PLUGINDESC%</p>" }
    }, { __dirname: "fixture/desktop", Buffer });
    await assert.rejects(fixture.initPluginInstall(null, "fixture"), /fixture clone failed/);
    assert.equal(builds, 0);
    const markup = Buffer.from(fixture.generateReviewPluginContent({ name: "<sample>&", description: "$&", usesNative: false, usesPreSend: false }).split(",")[1], "base64").toString();
    assert.equal(markup, "<h3>&lt;sample&gt;&amp;</h3><p>$&amp;</p>");
});

test("voice-message native download rejects excess streamed data and cancels its reader", async () => {
    let cancelled = 0;
    let requests = 0;
    const fixture = load("voiceMessageTranscriber.desktop/native.ts", "", {
        "./audioValidation": { isRecognizedAudioContainer: () => true }
    }, { fetch: async (_: string, options: any) => {
        requests++;
        assert.equal(options.redirect, "error");
        assert.ok(options.signal);
        return { ok: true, headers: new Headers(), body: { getReader: () => ({
            read: async () => ({ value: { byteLength: 26 * 1024 * 1024 }, done: false }),
            cancel: async () => { cancelled++; }, releaseLock() {}
        }) } };
    } });
    await assert.rejects(fixture.fetchAudio(null, "https://example.invalid/fixture"), /untrusted/);
    assert.equal(requests, 0);
    await assert.rejects(fixture.fetchAudio(null, "https://cdn.discordapp.com/attachments/fixture"), /25 MB/);
    assert.equal(cancelled, 1);
});

test("speech-worker termination aborts model downloads and prevents late cache writes", async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    let signal: AbortSignal | undefined;
    let writes = 0;
    let terminated = 0;
    let revoked = 0;
    class FixtureURL extends URL {
        static createObjectURL() { return "blob:fixture"; }
        static revokeObjectURL() { revoked++; }
    }
    const fixture = load("voiceMessageTranscriber.desktop/utils.ts", "", {
        "@api/index": { DataStore: { get: async () => undefined, set: async () => { writes++; } } },
        "@webpack/common": { lodash: { isArrayBuffer: () => false } }
    }, { Blob, URL: FixtureURL, Worker: class { postMessage() {} terminate() { terminated++; } }, fetch: (_: string, options: any) => { signal = options.signal; started.resolve(); return response.promise; } });
    const worker = new fixture.TranscriptionWorker(() => {}, () => {}, () => {}, () => {});
    const pending = worker.handleMessage({ data: { type: "fetch_request", id: "fixture", url: "https://huggingface.co/fixture" } });
    await started.promise;
    fixture.terminateTranscriptionWorkers();
    assert.equal(signal?.aborted, true);
    response.resolve(new Response("fixture model"));
    await pending;
    assert.equal(writes, 0);
    assert.equal(terminated, 1);
    assert.equal(revoked, 1);
});

test("VoiceStats preserves unsaved totals after a storage failure and retries them", async () => {
    let fail = true;
    const writes: any[] = [];
    const fixture = load("voiceStats/index.tsx", "\nexport { totalsByUser, persistTotals }; export function markDirty() { totalsDirty = true; }", {
        "@api/DataStore": { set: async (_: string, value: any) => { if (fail) throw Error("fixture"); writes.push(value); } },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => "section" }
    });
    fixture.totalsByUser.set("fixture", 5);
    fixture.markDirty();
    await fixture.persistTotals();
    fail = false;
    await fixture.persistTotals();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].fixture, 5);
});

test("webpack inspection restores an absent prototype descriptor after failure", async () => {
    const fixture = load("webpackTarball/webpack.ts", "\nexport const hasMarker = () => Object.prototype.hasOwnProperty.call(Function.prototype, 'm');");
    await assert.rejects(fixture.protectWebpack([], async () => { throw Error("fixture"); }), /fixture/);
    assert.equal(fixture.hasMarker(), false);
});

test("tar export stores only the selected byte view", () => {
    const fixture = load("webpackTarball/tar.ts");
    const tar = new fixture.default();
    tar.addFile("fixture.bin", new Uint8Array([9, 1, 2, 9]).subarray(1, 3));
    assert.deepEqual([...new Uint8Array(tar.buffers[1])], [1, 2]);
});

test("emoji whitelist validates imports before persistence and coalesces bulk names", async () => {
    const writes: any[] = [];
    const fixture = load("whitelistedEmojis/index.tsx", "\nexport { importEmojis, addBulkToAllowedList };", {
        "@api/index": { DataStore: { set: async (_: string, value: any) => writes.push(value) } },
        "@webpack/common": { EmojiStore: { getCustomEmojiById: () => null }, Toasts: { Type: { SUCCESS: 1, FAILURE: 2 } } }
    });
    fixture.settings.store.disableToasts = true;
    await fixture.importEmojis(JSON.stringify({ emojis: [{ name: 123 }] }));
    assert.equal(writes.length, 0);
    const entry = { type: "emoji", id: "fixture", name: "smile" };
    await fixture.addBulkToAllowedList([entry, entry]);
    assert.equal(writes.at(-1).length, 1);
});

test("stopped emoji whitelist startup does not install delayed context menus", async () => {
    const stored = deferred<any>();
    const started = deferred<void>();
    let installs = 0;
    const fixture = load("whitelistedEmojis/index.tsx", "", {
        "@api/index": { DataStore: { get: () => { started.resolve(); return stored.promise; } } },
        "@api/ContextMenu": { addContextMenuPatch() { installs++; }, removeContextMenuPatch() {} }
    });
    const pending = fixture.default.start();
    await started.promise;
    fixture.default.stop();
    stored.resolve([]);
    await pending;
    assert.equal(installs, 0);
});

test("ZIP cache bounds active downloads and discards cleared native responses before parsing", async () => {
    const responses: ReturnType<typeof deferred<any>>[] = [];
    let parses = 0;
    const fixture = load("zipPreview/utils.ts", "", {
        "./archive": { MAX_ZIP_BYTES: 50 * 1024 * 1024, inspectZipArchive: () => { parses++; return { entries: [] }; } }
    }, { VencordNative: { pluginHelpers: { ZipPreview: { fetchDiscordAttachment: () => { const pending = deferred<any>(); responses.push(pending); return pending.promise; } } } } });
    const a = fixture.getCachedZip("https://cdn.discordapp.com/attachments/1/2/a.zip");
    const b = fixture.getCachedZip("https://cdn.discordapp.com/attachments/1/2/b.zip");
    assert.equal(fixture.getCachedZip("https://cdn.discordapp.com/attachments/1/2/c.zip").status, "rejected");
    const settled = Promise.allSettled([a.promise, b.promise]);
    fixture.clearZipPreviewCache();
    responses.forEach(response => response.resolve({ success: true, data: new ArrayBuffer(0) }));
    const results = await settled;
    assert(results.every(result => result.status === "rejected"));
    assert.equal(parses, 0);
});
