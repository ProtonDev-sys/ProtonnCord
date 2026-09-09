/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const React = { Fragment: "fragment", createElement: (type: unknown, props: any, ...children: unknown[]) => ({ type, props: props ?? {}, children }) };

function load(path: string, mocks: Record<string, any>, globals: Record<string, unknown> = {}) {
    const modules = { "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} }, ...mocks };
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", { exports: {}, React, Blob, Uint8Array, ...globals, require: (name: string) => modules[name] });
}

function hooks() {
    const slots: any[] = [];
    const cleanups: Array<() => void> = [];
    const effects: Array<() => (() => void) | void> = [];
    let index = 0;
    const common = {
        useState(initial: any) {
            const slot = index++;
            if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
            return [slots[slot], (value: any) => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }];
        },
        useRef(initial: unknown) {
            const slot = index++;
            return slots[slot] ??= { current: initial };
        },
        useEffect(effect: () => (() => void) | void) {
            const slot = index++;
            if (slot in slots) return;
            slots[slot] = true;
            effects.push(effect);
        }
    };
    return { common, render(component: (props: any) => any, props: any) {
        index = 0;
        const result = component(props);
        for (const effect of effects.splice(0)) {
            const cleanup = effect();
            if (cleanup) cleanups.push(cleanup);
        }
        return result;
    }, unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); } };
}

function webFixture() {
    const state = hooks();
    const requests: Array<(value: any) => void> = [];
    const recordings: any[] = [];
    const blobs: Blob[] = [];
    const toasts: string[] = [];
    class Recorder {
        static isTypeSupported() { return false; }
        state = "inactive";
        mimeType = "audio/webm;codecs=opus";
        listeners = new Map<string, (event?: unknown) => void>();
        constructor(public stream: any) { recordings.push(this); }
        addEventListener(name: string, handler: (event?: unknown) => void) { this.listeners.set(name, handler); }
        removeEventListener(name: string) { this.listeners.delete(name); }
        start() { this.state = "recording"; }
        pause() { this.state = "paused"; }
        resume() { this.state = "recording"; }
        stop() {
            this.state = "inactive";
            this.listeners.get("dataavailable")?.({ data: new Blob(["fixture"], { type: this.mimeType }) });
            this.listeners.get("stop")?.();
        }
    }
    const component = load("src/plugins/voiceMessages/components/WebRecorder.tsx", {
        "..": { settings: { store: {} } },
        "@webpack/common": { ...state.common, Button: "button", MediaEngineStore: { getInputDeviceId: () => "device" },
            showToast: (text: string) => toasts.push(text), Toasts: { Type: {} } }
    }, { navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => requests.push(resolve)) } }, MediaRecorder: Recorder }).VoiceRecorderWeb;
    return { ...state, requests, recordings, blobs, toasts,
        render: () => state.render(component, { setAudioBlob: (blob: Blob) => blobs.push(blob) }) };
}

test("web recording deduplicates permission requests and closes late streams after unmount", async () => {
    const fixture = webFixture();
    const click = fixture.render().children[0].props.onClick;
    const pending = click();
    await click();
    assert.equal(fixture.requests.length, 1);
    fixture.unmount();
    let stopped = 0;
    fixture.requests[0]({ getTracks: () => [{ stop: () => stopped++ }] });
    await pending;
    assert.equal(stopped, 1);
    assert.equal(fixture.recordings.length, 0);
    assert.equal(fixture.blobs.length, 0);
});

test("web recording keeps its actual MIME type and releases tracks on normal stop", async () => {
    const fixture = webFixture();
    let stopped = 0;
    const pending = fixture.render().children[0].props.onClick();
    fixture.requests[0]({ getTracks: () => [{ stop: () => stopped++ }] });
    await pending;
    fixture.render().children[1].props.onClick();
    assert.equal(fixture.recordings[0].state, "paused");
    fixture.render().children[1].props.onClick();
    assert.equal(fixture.recordings[0].state, "recording");
    await fixture.render().children[0].props.onClick();
    assert.equal(fixture.blobs[0].type, "audio/webm;codecs=opus");
    assert.equal(stopped, 1);
    assert.equal(fixture.recordings[0].listeners.size, 0);
});

test("closing an active web recorder stops tracks without publishing discarded audio", async () => {
    const fixture = webFixture();
    let stopped = 0;
    const pending = fixture.render().children[0].props.onClick();
    fixture.requests[0]({ getTracks: () => [{ stop: () => stopped++ }] });
    await pending;
    fixture.unmount();
    assert.ok(stopped >= 1);
    assert.equal(fixture.recordings[0].state, "inactive");
    assert.equal(fixture.blobs.length, 0);
});

test("voice previews run their timer only while recording and release it on unmount", () => {
    for (const recording of [false, true]) {
        const state = hooks();
        const timers: unknown[] = [];
        const cleared: unknown[] = [];
        const component = load("src/plugins/voiceMessages/components/VoicePreview.tsx", {
            "@webpack/common": state.common, "..": { cl: () => "", VoiceMessage: "audio" }
        }, { setInterval: (callback: unknown) => { timers.push(callback); return 7; }, clearInterval: (id: unknown) => cleared.push(id) }).VoicePreview;
        state.render(component, { recording, waveform: "fixture" });
        assert.equal(timers.length, recording ? 1 : 0);
        state.unmount();
        assert.deepEqual(cleared, recording ? [7] : []);
    }
});

function desktopFixture() {
    const state = hooks();
    const starts: Array<(success: boolean) => void> = [];
    const stops: Array<(path: string) => unknown> = [];
    const reads: string[] = [];
    const blobs: Blob[] = [];
    const toasts: string[] = [];
    let failRead = false;
    const component = load("src/plugins/voiceMessages/components/DesktopRecorder.tsx", {
        "..": { settings: { store: {} } },
        "@webpack/common": { ...state.common, Button: "button", MediaEngineStore: { getInputDeviceId: () => "device" },
            showToast: (text: string) => toasts.push(text), Toasts: { Type: {} } }
    }, { VencordNative: { pluginHelpers: { VoiceMessages: { readRecording: async (path: string) => {
        reads.push(path);
        if (failRead) throw new Error("fixture read failure");
        return [1, 2];
    } } } }, DiscordNative: { nativeModules: { requireModule: () => ({
        startLocalAudioRecording: (_options: unknown, callback: (success: boolean) => void) => starts.push(callback),
        stopLocalAudioRecording: (callback: (path: string) => unknown) => stops.push(callback)
    }) } } }).VoiceRecorderDesktop;
    return { ...state, starts, stops, reads, blobs, toasts, failRead() { failRead = true; },
        render: () => state.render(component, { setAudioBlob: (blob: Blob) => blobs.push(blob) }) };
}

test("desktop recording locks pending starts and cleans a successful callback after close", async () => {
    const fixture = desktopFixture();
    const click = fixture.render().props.onClick;
    click();
    click();
    assert.equal(fixture.starts.length, 1);
    fixture.unmount();
    fixture.starts[0](true);
    assert.equal(fixture.stops.length, 1);
    await fixture.stops[0]("fixture-recording.ogg");
    assert.deepEqual(fixture.reads, ["fixture-recording.ogg"]);
    assert.equal(fixture.blobs.length, 0);
});

test("desktop read failures finish the recording transition and remain visible", async () => {
    const fixture = desktopFixture();
    fixture.render().props.onClick();
    fixture.starts[0](true);
    fixture.render().props.onClick();
    fixture.failRead();
    await fixture.stops[0]("fixture-recording.ogg");
    assert.equal(fixture.blobs.length, 0);
    assert.equal(fixture.toasts[0], "Failed to finish recording");
    assert.equal(fixture.render().props.disabled, false);
    fixture.render().props.onClick();
    assert.equal(fixture.starts.length, 2);
});

function sendFixture() {
    let account = "first";
    let selected = "channel";
    let reply: object | undefined = { id: "first-reply" };
    let beforeSend: () => Promise<boolean> = async () => false;
    let sending: () => Promise<void> = async () => undefined;
    const sent: any[] = [];
    const events: unknown[] = [];
    const toasts: string[] = [];
    const module = load("src/plugins/voiceMessages/index.tsx", {
        "./styles.css": {}, "@api/ContextMenu": {},
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@api/MessageEvents": { _handlePreSend: () => beforeSend() },
        "@components/Card": {}, "@components/Icons": {}, "@components/Link": {}, "@components/Paragraph": {},
        "@plugins/silentMessageToggle": { lastState: true }, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/margins": {}, "@utils/react": {}, "@utils/web": {},
        "@vencord/discord-types/enums": { CloudUploadPlatform: { WEB: "web" } },
        "./components/DesktopRecorder": {}, "./components/WebRecorder": {}, "./components/VoicePreview": {},
        "./waveform": { DEFAULT_WAVEFORM: "fixture" },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) }, SelectedChannelStore: { getChannelId: () => selected },
            ChannelStore: { getChannel: (id: string) => ({ id }) }, PendingReplyStore: { getPendingReply: () => reply },
            CloudUploader: class { constructor(public data: unknown) {} },
            MessageActions: { getSendMessageOptionsForReply: () => ({}), sendMessage: async (...args: any[]) => { sent.push(args); await sending(); } },
            FluxDispatcher: { dispatch: (event: unknown) => events.push(event) },
            showToast: (value: string) => toasts.push(value), Toasts: { Type: {} }
        }
    }, { IS_DISCORD_DESKTOP: false, File });
    return { module, sent, events, toasts, setAccount(value: string) { account = value; }, setChannel(value: string) { selected = value; },
        setReply(value: object) { reply = value; }, setBeforeSend(value: typeof beforeSend) { beforeSend = value; }, setSending(value: typeof sending) { sending = value; } };
}

const audio = new Blob(["fixture"], { type: "audio/webm" });
const metadata = { duration: 1, waveform: "fixture" };

test("voice sends abort after account changes or plugin stop during presend hooks", async () => {
    for (const stop of [false, true]) {
        const fixture = sendFixture();
        let resolve!: (value: boolean) => void;
        fixture.setBeforeSend(() => new Promise(done => { resolve = done; }));
        const pending = fixture.module.sendAudio(audio, metadata);
        if (stop) fixture.module.default.stop();
        else fixture.setAccount("second");
        resolve(false);
        assert.equal(await pending, false);
        assert.equal(fixture.sent.length, 0);
        assert.equal(fixture.events.length, 0);
    }
});

test("voice sends keep their channel, encoding and newer pending replies", async () => {
    const fixture = sendFixture();
    let resolve!: () => void;
    fixture.setSending(() => new Promise(done => { resolve = done; }));
    const pending = fixture.module.sendAudio(audio, metadata, "recording-channel");
    await setImmediate();
    fixture.setChannel("other-channel");
    fixture.setReply({ id: "new-reply" });
    resolve();
    assert.equal(await pending, true);
    assert.equal(fixture.sent[0][0], "recording-channel");
    assert.equal(fixture.sent[0][3].attachmentsToUpload[0].data.file.type, "audio/webm");
    assert.equal(fixture.sent[0][3].flags, (1 << 13) | 4096);
    assert.equal(fixture.events.length, 0);
});

test("voice send failures preserve the pending reply and report failure", async () => {
    const fixture = sendFixture();
    fixture.setSending(async () => { throw new Error("fixture send failure"); });
    assert.equal(await fixture.module.sendAudio(audio, metadata), false);
    assert.equal(fixture.events.length, 0);
    assert.equal(fixture.toasts[0], "Failed to send voice message");
});

test("native recording reads require the resolved file to remain inside the application directory", async () => {
    const calls: string[] = [];
    let resolvedRecording = "C:\\Fixture\\UserData\\123recording.ogg";
    const base = "C:\\Fixture\\UserData";
    const module = load("src/plugins/voiceMessages/native.ts", {
        electron: { app: { getPath: () => base } }, path: win32,
        "fs/promises": { realpath: async (path: string) => path === base ? base : resolvedRecording,
            readFile: async (path: string) => { calls.push(path); return new Uint8Array([1, 2]); },
            rm: async (path: string) => { calls.push(path); } }
    });
    assert.equal((await module.readRecording(null, `${base}\\123recording.ogg`)).length, 2);
    assert.equal(calls.length, 2);
    resolvedRecording = "C:\\Fixture\\Outside\\123recording.ogg";
    assert.equal(await module.readRecording(null, `${base}\\123recording.ogg`), null);
    assert.equal(await module.readRecording(null, 123), null);
    assert.equal(calls.length, 2);
});
