/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function redirectFixture(locations: (string | undefined)[], stall = false) {
    const requests: string[] = [];
    const timers = new Set<() => void>();
    const path = "src/plugins/openInApp/native.ts";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const native = runInNewContext(code + "\nexports;", {
        exports: {}, URL,
        setTimeout: (callback: () => void, ms: number) => { assert.equal(ms, 10000); timers.add(callback); return callback; },
        clearTimeout: (callback: () => void) => timers.delete(callback),
        require: () => ({ request: (url: URL, _options: unknown, callback: (response: unknown) => void) => {
            requests.push(url.href);
            let onError: (error: Error) => void;
            return { on: (_name: string, listener: typeof onError) => onError = listener,
                destroy: (error: Error) => onError(error), end: () => {
                    if (!stall) callback({ statusCode: 302, headers: { location: locations.shift() }, resume() {} });
                } };
        } })
    });
    return { native, requests, timers };
}

test("native short links allow known destinations and stop loops or unsupported redirects", async () => {
    const valid = redirectFixture(["/next", "https://open.spotify.com/track/fixture"]);
    assert.equal(await valid.native.resolveRedirect(null, "https://spotify.link/start"), "https://open.spotify.com/track/fixture");
    assert.equal(valid.requests.length, 2);
    assert.equal(valid.timers.size, 0);
    for (const next of ["https://example.test/unrelated", "http://open.spotify.com/track/fixture", "/start"]) {
        const blocked = redirectFixture([next]);
        await assert.rejects(blocked.native.resolveRedirect(null, "https://spotify.link/start"));
        assert.equal(blocked.requests.length, 1);
        assert.equal(blocked.timers.size, 0);
    }
    const deep = redirectFixture(["/1", "/2", "/3", "/4", "/5"]);
    await assert.rejects(deep.native.resolveRedirect(null, "https://spotify.link/start"), /Too many/);
    assert.equal(deep.requests.length, 5);
});

test("native short link deadlines destroy stalled requests and clear their timer", async () => {
    const api = redirectFixture([], true);
    const pending = api.native.resolveRedirect(null, "https://s.team/start");
    [...api.timers][0]();
    await assert.rejects(pending, /timed out/);
    assert.equal(api.timers.size, 0);
});

test("native app links use exact hostnames and recover when short link resolution fails", async () => {
    const opened: string[] = [];
    const notices: unknown[] = [];
    const path = "src/plugins/openInApp/index.ts";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const mocks = {
        "@api/Settings": { definePluginSettings: () => ({ store: { spotify: true, steam: true, vrcx: true } }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": { showToast: (notice: unknown) => notices.push(notice), Toasts: { Type: {} } }
    };
    const plugin = runInNewContext(code + "\nexports.default;", {
        exports: {}, require: (name: string) => mocks[name],
        VencordNative: { pluginHelpers: { OpenInApp: { resolveRedirect: async () => { throw new Error("Offline"); } } },
            native: { openExternal: (url: string) => opened.push(url) } },
        window: { open: (url: string, _target: string, features: string) => { assert.equal(features, "noopener,noreferrer"); opened.push(url); } }
    });
    assert.equal(await plugin.handleLink({ href: "https://sXteam/fixture" }), false);
    assert.equal(await plugin.handleLink({ href: "https://vrchatXcom/home/user/fixture" }), false);
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    assert.equal(await plugin.handleLink({ href: "https://spotify.link/fixture" }, event), true);
    assert.deepEqual(opened, ["https://spotify.link/fixture"]);
    assert.equal(notices.length, 1);
});

function loadAppleMusic() {
    const commands: { command: string; timeout: number; }[] = [];
    const requests: { resolve(response: object): void; }[] = [];
    const deadlines: { controller: AbortController; timeout: number; }[] = [];
    const mocks: Record<string, object> = {
        "@shared/vencordUserAgent": { VENCORD_USER_AGENT: "fixture" },
        child_process: { execFile: async (command: string, args: string[], options: { timeout: number; }) => {
            commands.push({ command, timeout: options.timeout });
            return { stdout: command === "pgrep" ? "123\n"
                : args.includes("get player state") ? "playing\n"
                    : args.includes("get player position") ? "0\n"
                        : "42\nSong\nAlbum\nArtist\n60\n" };
        } },
        util: { promisify: (fn: unknown) => fn }
    };
    const path = "src/plugins/appleMusic.desktop/native.ts";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const native = runInNewContext(code + "\nexports;", {
        exports: {}, URL, console: { error() {} },
        require: (name: string) => mocks[name],
        AbortSignal: { timeout: (timeout: number) => {
            const controller = new AbortController();
            deadlines.push({ controller, timeout });
            return controller.signal;
        } },
        fetch: (_url: URL | string, options: { signal: AbortSignal; }) => new Promise<object>((resolve, reject) => {
            requests.push({ resolve });
            options.signal.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
        })
    });
    return { native, commands, requests, deadlines };
}

test("Apple Music gives each subprocess a deadline and retries timed-out remote metadata", async () => {
    const { native, commands, requests, deadlines } = loadAppleMusic();
    const first = native.fetchTrackData();
    await setImmediate();
    assert.equal(commands.length, 4);
    assert.ok(commands.every(command => command.timeout === 10_000));
    assert.equal(deadlines[0].timeout, 10_000);
    deadlines[0].controller.abort();
    assert.equal((await first).name, "Song");
    const second = native.fetchTrackData();
    await setImmediate();
    assert.equal(requests.length, 2);
    requests[1].resolve({ ok: false, status: 503 });
    assert.equal((await second).name, "Song");
});

test("an Apple Music artist artwork deadline preserves successful track enrichment", async () => {
    const { native, requests, deadlines } = loadAppleMusic();
    const pending = native.fetchTrackData();
    await setImmediate();
    requests[0].resolve({ ok: true, json: async () => ({ resultCount: 1, results: [{
        collectionName: "Album", trackViewUrl: "https://music.apple.com/album/fixture?i=42",
        artistViewUrl: "https://music.apple.com/artist/fixture", artworkUrl100: "https://example.test/100x100.png"
    }] }) });
    await setImmediate();
    assert.equal(deadlines[1].timeout, 10_000);
    deadlines[1].controller.abort();
    const track = await pending;
    assert.equal(track.appleMusicLink, "https://music.apple.com/album/fixture?i=42");
    assert.equal(track.albumArtwork, "https://example.test/512x512.png");
    assert.equal(track.artistArtwork, undefined);
});

test("Spotify embed volume clamps settings, catches frame failures, and drops navigated frames", async () => {
    const reported: unknown[] = [];
    const calls: string[] = [];
    const frame = {
        processId: 1, routingId: 2, url: "https://open.spotify.com/embed/track/fixture",
        executeJavaScript: async (script: string) => {
            calls.push(script);
            throw new Error("Frame detached");
        }
    };
    const mocks: Record<string, object> = {
        "@main/settings": { RendererSettings: { addChangeListener() {} } },
        electron: { app: { on() {} }, webFrameMain: { fromId: () => frame } }
    };
    const path = "src/plugins/fixSpotifyEmbeds.desktop/native.ts";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const api = runInNewContext(code + "\n({getVolume,updateFrame,cleanUpAndGetSpotifyFrames,ids});", {
        exports: {}, require: (name: string) => mocks[name],
        console: { error: (...args: unknown[]) => reported.push(args) }
    });
    assert.equal(api.getVolume(-5), 0);
    assert.equal(api.getVolume(150), 1);
    assert.equal(api.getVolume(NaN), 0.1);
    assert.equal(api.getVolume("50"), 0.1);
    assert.equal(api.getVolume(50), 0.5);
    await api.updateFrame(frame, "fixture");
    assert.equal(reported.length, 1);
    api.ids.push({ processId: 1, routingId: 2 });
    assert.equal(api.cleanUpAndGetSpotifyFrames().length, 1);
    frame.url = "https://example.invalid/";
    await api.updateFrame(frame, "fixture");
    assert.equal(calls.length, 1);
    assert.equal(api.cleanUpAndGetSpotifyFrames().length, 0);
    assert.equal(api.ids.length, 0);
});
