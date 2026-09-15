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

import { parseImportedOverrides } from "../src/equicordplugins/customSounds/settingsImport";
import * as types from "../src/equicordplugins/customSounds/types";

const React = {
    createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    useRef: (current: unknown) => ({ current }),
    useState: (value: unknown) => [value, () => {}],
    useEffect: (_effect: () => unknown) => {}
};

function load(file: string, overrides: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const mocks: Record<string, unknown> = {
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, StartAt: {}, OptionType: {}, makeRange: () => [] },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/Logger": { Logger: class { error() {} } },
        ...overrides
    };
    const code = transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, Promise, console: { log() {}, error() {} }, ArrayBuffer, Uint8Array, Blob, btoa,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, `Unexpected import: ${name}`);
            return mocks[name];
        },
        ...globals
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function descendants(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(descendants);
    if (!node || typeof node !== "object") return [];
    return [node, ...descendants(node.props?.children)];
}

function audioStore(initial: Record<string, any>, failFirstWrite = false) {
    let stored = initial;
    let writes = 0;
    let serial = 0;
    const api = load("src/equicordplugins/customSounds/audioStore.ts", {
        "@api/DataStore": {
            get: async () => stored,
            async set(_key: string, value: typeof stored) {
                await Promise.resolve();
                if (++writes === 1 && failFirstWrite) throw new Error("disk full");
                stored = value;
            }
        }
    }, {
        crypto: { randomUUID: () => `new-${++serial}` },
        FileReader: class {
            onerror!: (error: Error) => void;
            readAsDataURL() { Promise.resolve().then(() => this.onerror(new Error("reader failed"))); }
        }
    });
    return { api, stored: () => stored };
}

const audioFile = (name: string) => ({ name, type: "", size: 2, arrayBuffer: async () => new Uint8Array([1, 2]).buffer });

test("CustomSounds serializes audio saves, deletes and legacy migration without losing other records", async () => {
    const legacy = { id: "legacy", name: "legacy.wav", type: "", buffer: new Uint8Array([1]).buffer, future: { retained: true } };
    const { api, stored } = audioStore({ legacy, remove: { id: "remove" }, unknown: { opaque: true } });
    const [one, two] = await Promise.all([
        api.saveAudio(audioFile("one.ogg")), api.saveAudio(audioFile("two.mp3")),
        api.deleteAudio("remove"), api.getAudioDataURI("legacy")
    ]);
    assert.deepEqual(Object.keys(stored()).sort(), ["legacy", "unknown", one, two].sort());
    assert.equal(stored().unknown.opaque, true);
    assert.equal(stored().legacy.future.retained, true);
    assert.equal(stored().legacy.buffer, undefined);
    assert.equal(stored().legacy.dataUri, "data:audio/wav;base64,AQ==");
    assert.equal(stored()[one].dataUri, "data:audio/ogg;base64,AQI=", "asynchronous FileReader fallback retains inferred MIME type");
});

test("failed audio writes leave the cache unchanged and the next write can succeed", async () => {
    const { api, stored } = audioStore({ old: { id: "old", name: "old.mp3" } }, true);
    await assert.rejects(api.saveAudio(audioFile("first.mp3")), /disk full/);
    assert.deepEqual(Object.keys(await api.getAllAudio()), ["old"]);
    const id = await api.saveAudio(audioFile("retry.mp3"));
    assert.deepEqual(Object.keys(stored()).sort(), ["old", id].sort());
});

test("settings imports validate every entry before applying and retain unknown override fields and IDs", () => {
    for (const invalid of ["not json", "{}", '{"overrides":[null]}', '{"overrides":[{"id":"enabled"}]}', '{"overrides":[{"id":"call_calling","volume":101}]}']) {
        assert.throws(() => parseImportedOverrides(invalid));
    }
    const parsed = parseImportedOverrides(JSON.stringify({ overrides: [{ id: "future_sound", volume: 37, future: { opaque: true } }] }));
    assert.equal(parsed[0].id, "future_sound");
    assert.equal(parsed[0].override.volume, 37);
    assert.equal((parsed[0].override as any).future.opaque, true);
});

function indexModule(store: Record<string, any>, getAudioDataURI: (id: string) => Promise<string | undefined>, globals: Record<string, unknown> = {}) {
    return load("src/equicordplugins/customSounds/index.tsx", {
        "@api/Settings": { definePluginSettings: (def: unknown) => ({ store, def }) },
        "@components/Button": { Button: "Button" }, "@components/Heading": {},
        "@webpack/common": { React, showToast() {} },
        "./audioStore": { getAudioDataURI, getAllAudio: async () => ({}) },
        "./settingsImport": { parseImportedOverrides }, "./SoundOverrideComponent": {}, "./types": types
    }, globals);
}

test("stopping or deleting a sound invalidates in-flight loads and concurrent readers share one load", async () => {
    const pending: ReturnType<typeof deferred<string>>[] = [];
    const api = indexModule({ call_calling: JSON.stringify({ enabled: true, selectedSound: "custom", selectedFileId: "file", volume: 50 }) }, () => {
        const load = deferred<string>();
        pending.push(load);
        return load.promise;
    });
    const first = api.ensureDataURICached("file");
    const shared = api.ensureDataURICached("file");
    assert.equal(pending.length, 1);
    api.default.stop();
    pending[0].resolve("data:audio/mpeg;base64,old");
    assert.deepEqual(await Promise.all([first, shared]), [null, null]);
    const current = api.ensureDataURICached("file");
    api.forgetDataURI("file");
    pending[1].resolve("data:audio/mpeg;base64,deleted");
    assert.equal(await current, null);
    const newest = api.ensureDataURICached("file");
    pending[2].resolve("data:audio/mpeg;base64,current");
    await newest;
    const data = { audio: "call_calling", volume: 100 };
    api.getCustomSoundURL(data);
    assert.equal(data.audio, "data:audio/mpeg;base64,current");
    assert.equal(data.volume, 50);
});

test("invalid imports preserve saved settings while valid imports preload existing custom audio", async () => {
    let reader: any;
    const store = { enabled: true, call_calling: JSON.stringify({ enabled: true, selectedSound: "default", volume: 42 }), opaque: "preserve" };
    const cached: string[] = [];
    const api = indexModule(store, async id => { cached.push(id); return "data:audio/mpeg;base64,AQ=="; }, {
        FileReader: class { constructor() { reader = this; } readAsText() {} }
    });
    const view = api.default.settings.def.overrides.component();
    const input = descendants(view).find(node => node.type === "input");
    const upload = async (text: string) => {
        input.props.onChange({ target: { files: [{}], value: "selected" } });
        await reader.onload({ target: { result: text } });
    };
    const before = JSON.stringify(store);
    await upload('{"overrides":[{"id":"call_calling"},{"id":"isFavorite"}]}');
    assert.equal(JSON.stringify(store), before);
    await upload(JSON.stringify({ overrides: [{ id: "call_calling", enabled: true, selectedSound: "custom", selectedFileId: "saved-file", volume: 24, future: "retained" }] }));
    assert.equal(store.enabled, true);
    assert.equal(store.opaque, "preserve");
    assert.equal(JSON.parse(store.call_calling).future, "retained");
    assert.deepEqual(cached, ["saved-file"]);
});

test("sound preview Stop and component unmount cancel pending playback and stop active audio", async () => {
    const effects: (() => unknown)[] = [];
    const pending: ReturnType<typeof deferred<string>>[] = [];
    let plays = 0;
    let stops = 0;
    const component = load("src/equicordplugins/customSounds/SoundOverrideComponent.tsx", {
        "@api/AudioPlayer": { playAudio: () => { plays++; return { stop: () => stops++ }; } },
        "@components/Button": { Button: "Button" }, "@components/Card": { Card: "Card" },
        "@components/FormSwitch": {}, "@components/Heading": {}, "@utils/margins": { Margins: {} },
        "@utils/react": { useForceUpdater: () => () => {} },
        "@webpack/common": { React: { ...React, useEffect: (effect: () => unknown) => effects.push(effect) }, showToast() {} },
        "./audioStore": { getAllAudio: async () => ({}) },
        "./index": { ensureDataURICached: () => { const load = deferred<string>(); pending.push(load); return load.promise; } }
    }).SoundOverrideComponent;
    const view = component({ type: { id: "call_calling" }, override: { enabled: true, selectedSound: "custom", selectedFileId: "file", volume: 20 }, onChange: async () => {} });
    const cleanup = effects[0]() as () => void;
    const buttons = descendants(view).filter(node => node.type === "Button");
    const preview = buttons.find(node => node.props.children[0] === "Preview").props.onClick;
    const stop = buttons.find(node => node.props.children[0] === "Stop").props.onClick;
    const first = preview();
    stop();
    pending[0].resolve("data:audio/mpeg;base64,AQ==");
    await first;
    assert.equal(plays, 0);
    const second = preview();
    pending[1].resolve("data:audio/mpeg;base64,AQ==");
    await second;
    assert.equal(plays, 1);
    const third = preview();
    cleanup();
    pending[2].resolve("data:audio/mpeg;base64,AQ==");
    await third;
    assert.equal(plays, 1);
    assert.equal(stops, 1);
});

test("reopening a custom folder icon preserves its saved size when saving the same image", () => {
    let saved: any;
    const api = load("src/equicordplugins/customFolderIcons/components.tsx", {
        "@webpack/common": { Button: "Button", Slider: "Slider", useState: React.useState, closeModal() {}, Menu: {} },
        "./settings": { settings: { store: { folderIcons: { folder: { url: "image.png", size: 175 } } } } },
        "./util": { setFolderData: (_props: unknown, value: unknown) => { saved = value; } }
    });
    const nodes = descendants(api.ImageModal({ folderId: "folder" }));
    assert.equal(nodes.find(node => node.type === "Slider").props.initialValue, 175);
    nodes.find(node => node.type === "Button" && node.props.children[0] === "Save").props.onClick();
    assert.equal(saved.size, 175);
    assert.equal(saved.url, "image.png");
});
