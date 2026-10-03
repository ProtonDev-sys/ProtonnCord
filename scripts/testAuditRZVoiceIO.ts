/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}

function renderer(visible = true, holdDecode = false) {
    const downloads: { id: string; gate: ReturnType<typeof deferred<Uint8Array>>; }[] = [];
    const cancelled: string[] = [];
    const contexts: { closed: boolean; gate: ReturnType<typeof deferred<any>>; }[] = [];
    let effects: (() => void | (() => void))[] = [];
    let values: unknown[] = [];
    let callbacks: Function[] = [];
    const decoded = { length: 2, numberOfChannels: 2, getChannelData: (channel: number) => new Float32Array(channel ? [0, 1] : [1, 0]) };
    class AudioContext {
        state = { closed: false, gate: deferred<any>() };
        constructor() { contexts.push(this.state); }
        decodeAudioData() { return holdDecode ? this.state.gate.promise : Promise.resolve(decoded); }
        close() { this.state.closed = true; return Promise.resolve(); }
    }
    const imports = Object.fromEntries([
        "@api/index", "@components/BaseText", "@components/Button", "@components/Flex",
        "@components/Heading", "@components/Span", "@plugins/translate/utils", "@utils/clipboard",
        "./options"
    ].map(name => [name, {}]));
    const api = loadTestModule("src/equicordplugins/voiceMessageTranscriber.desktop/index.tsx", {
        ...imports,
        "@api/Settings": { definePluginSettings: () => ({ use: () => ({ autoTranscribe: false }) }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@plugins/voiceMessages": { DEFAULT_WAVEFORM: "default", VoiceMessage: "voice" },
        "@plugins/voiceMessages/waveform": { generateWaveform: () => "generated" },
        "./audioValidation": { detectAudioMimeType: () => "audio/ogg" },
        "./transcriptionData": { IdleResultCache: class {
            get() { return undefined; }
            clear() {}
            subscribe() { return () => {}; }
        } },
        "./utils": { cl: () => "", terminateTranscriptionWorkers() {} },
        "@webpack/common": {
            useState: (value: unknown) => {
                const updates = values;
                return [value, (next: unknown) => updates.push(next)];
            },
            useRef: (current: unknown) => ({ current }),
            useMemo: (fn: () => unknown) => fn(),
            useCallback: (fn: Function) => { callbacks.push(fn); return fn; },
            useEffect: (fn: () => void | (() => void)) => effects.push(fn)
        }
    }, {
        Blob, Float32Array, AbortController, crypto: { randomUUID },
        window: { AudioContext },
        document: { visibilityState: visible ? "visible" : "hidden", addEventListener() {}, removeEventListener() {} },
        URL: { createObjectURL: () => "blob:prepared", revokeObjectURL() {} },
        React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) },
        VencordNative: { pluginHelpers: { VoiceMessageTranscriber: {
            fetchAudio: (_src: string, id: string) => {
                const gate = deferred<Uint8Array>();
                downloads.push({ id, gate });
                return gate.promise;
            },
            cancelAudioFetch: async (id: string) => { cancelled.push(id); }
        } } }
    }, "\nexport { prepareAudio, clearTranscriptionState, VoiceMessageTranscriptionAccessory };\n");
    const mount = (src: string) => {
        effects = [];
        values = [];
        callbacks = [];
        api.VoiceMessageTranscriptionAccessory({ src, messageId: src, needsPlaybackFallback: true });
        const updates = values;
        const cleanups = effects.map(effect => effect());
        return { updates, start: callbacks[2], cancel: callbacks[4], unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
    };
    return { api, mount, downloads, cancelled, contexts };
}

test("RZ2-02: fourth visible fallback waits for a slot and receives playback and waveform", async () => {
    const fixture = renderer();
    const mounts = Array.from({ length: 4 }, (_, index) => fixture.mount("audio-" + index));
    assert.equal(fixture.downloads.length, 3);
    fixture.downloads[0].gate.resolve(new Uint8Array([1]));
    await tick();
    assert.equal(fixture.downloads.length, 4);
    fixture.downloads[3].gate.resolve(new Uint8Array([1]));
    await tick();
    assert.ok(mounts[3].updates.includes("blob:prepared"));
    assert.ok(mounts[3].updates.includes("generated"));
    mounts.forEach(mount => mount.unmount());
});

test("RZ2-02: hidden document does not download fallback audio", () => {
    const fixture = renderer(false);
    const mount = fixture.mount("hidden");
    assert.equal(fixture.downloads.length, 0);
    mount.unmount();
});

test("RZ2-03: unmount cancels active download and releases the queued slot", async () => {
    const fixture = renderer();
    const mounts = Array.from({ length: 4 }, (_, index) => fixture.mount("audio-" + index));
    mounts[0].unmount();
    await tick();
    assert.deepEqual(fixture.cancelled, [fixture.downloads[0].id]);
    assert.equal(fixture.downloads.length, 4);
    fixture.api.clearTranscriptionState();
    await tick();
    assert.equal(fixture.cancelled.length, 4);
    fixture.downloads[0].gate.resolve(new Uint8Array([1]));
    await tick();
    assert.equal(fixture.contexts.length, 0);
});

test("RZ2-03: cancellation closes decoding context and discards late decode", async () => {
    const fixture = renderer(true, true);
    const controller = new AbortController();
    const pending = fixture.api.prepareAudio("audio", controller.signal);
    fixture.downloads[0].gate.resolve(new Uint8Array([1]));
    await tick();
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(fixture.contexts[0].closed, true);
    fixture.contexts[0].gate.resolve({ length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([1]) });
    await tick();
});

test("RZ2-03: Cancel aborts both transcription preparation and playback fallback", async () => {
    const fixture = renderer();
    const mount = fixture.mount("audio");
    mount.start();
    assert.equal(fixture.downloads.length, 2);
    mount.cancel();
    await tick();
    assert.equal(fixture.cancelled.length, 2);
    for (const download of fixture.downloads) download.gate.resolve(new Uint8Array([1]));
    await tick();
    assert.equal(fixture.contexts.length, 0);
    assert.ok(!mount.updates.includes("blob:prepared"));
    mount.unmount();
});

test("RZ2-03: stop and connection reset cancel queued work without starting downloads", async () => {
    for (const mode of ["stop", "connection"]) {
        const fixture = renderer();
        const mounts = Array.from({ length: 5 }, (_, index) => fixture.mount("audio-" + index));
        assert.equal(fixture.downloads.length, 3);
        if (mode === "stop") fixture.api.default.stop();
        else fixture.api.default.flux.CONNECTION_OPEN();
        await tick();
        assert.equal(fixture.downloads.length, 3);
        assert.equal(fixture.cancelled.length, 3);
        mounts.forEach(mount => mount.unmount());
        const controller = new AbortController();
        const pending = fixture.api.prepareAudio("after-reset", controller.signal);
        assert.equal(fixture.downloads.length, 4);
        controller.abort();
        await assert.rejects(pending, /cancelled/);
    }
});

function native() {
    const requests: RequestInit[] = [];
    const api = loadTestModule("src/equicordplugins/voiceMessageTranscriber.desktop/native.ts", {
        "node:child_process": { execFile() {} },
        "node:crypto": {}, "node:fs/promises": {}, "node:os": {}, "node:path": {},
        "node:util": { promisify: () => () => {} },
        "@main/utils/constants": { DATA_DIR: "" },
        "fflate": {}, "./audioValidation": { isRecognizedAudioContainer: () => true },
        "./transcriptionData": {}
    }, {
        AbortController, AbortSignal, URL, Uint8Array,
        fetch: async (_url: string, options: RequestInit) => {
            requests.push(options);
            return {
                ok: true, headers: { get: () => null },
                body: { getReader: () => ({
                    read: () => new Promise((_resolve, reject) => {
                        options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                    }),
                    cancel: async () => {}, releaseLock() {}
                }) }
            };
        }
    });
    const sender = Object.assign(new EventEmitter(), { id: 1 });
    return { api, requests, sender };
}

test("RZ2-03: native cancellation is scoped to sender and request; destroy cleans up", async () => {
    for (const mode of ["cancel", "destroy"]) {
        const fixture = native();
        const event = { sender: fixture.sender };
        const pending = fixture.api.fetchAudio(event, "https://cdn.discordapp.com/attachments/1/2/voice.ogg", "request");
        await tick();
        fixture.api.cancelAudioFetch({ sender: { id: 2 } }, "request");
        fixture.api.cancelAudioFetch(event, "other");
        assert.equal(fixture.requests[0].signal!.aborted, false);
        assert.equal(fixture.requests[0].redirect, "error");
        assert.equal(fixture.requests[0].credentials, "omit");
        if (mode === "cancel") fixture.api.cancelAudioFetch(event, "request");
        else fixture.sender.emit("destroyed");
        await assert.rejects(pending, /aborted/);
        assert.equal(fixture.requests[0].signal!.aborted, true);
        assert.equal(fixture.sender.listenerCount("destroyed"), 0);
        await assert.rejects(fixture.api.fetchAudio(event, "https://example.com/audio", "request"), /untrusted/);
        await assert.rejects(fixture.api.fetchAudio(event, "https://cdn.discordapp.com/audio", "!"), /request ID/);
    }
});
