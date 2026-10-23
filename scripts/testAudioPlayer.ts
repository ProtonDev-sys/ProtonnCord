import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, forEachChild, isMethodDeclaration, ScriptTarget, transpileModule } from "typescript";

import type { AudioPlayerInterface } from "../src/api/AudioPlayer";
import { proxyLazy } from "../src/utils/lazy";
import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordAudioPlayerSource } from "./fixtures/discordAudioPlayer";
import { loadTestModule } from "./utils/loadTestModule";

function loadAudio(webpack: Record<string, unknown>) {
    const logged: unknown[][] = [];
    const api = loadTestModule<typeof import("../src/api/AudioPlayer")>("src/api/AudioPlayer.ts", {
        "@webpack": webpack,
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { logged.push(args); } } }
    }, { Error, URL });
    return { api, logged };
}

function loadWrapper(internalPlayer: Record<string, unknown>) {
    const { api, logged } = loadAudio({
        findByCodeLazy: () => function () { return internalPlayer; },
        findLazy: () => ({ keys: () => ["./fixture.mp3"] })
    });
    return { player: api.createAudioPlayer("fixture"), logged };
}

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("fire-and-forget audio controls report failed loading without unhandled rejections", async () => {
    const actions = [
        (player: AudioPlayerInterface) => { player.time = 3; },
        (player: AudioPlayerInterface) => { player.muted = true; },
        (player: AudioPlayerInterface) => { player.preload = true; },
        (player: AudioPlayerInterface) => player.load(),
        (player: AudioPlayerInterface) => player.seek(3),
        (player: AudioPlayerInterface) => player.mute(),
        (player: AudioPlayerInterface) => player.unmute()
    ];
    for (const action of actions) {
        const failure = new Error("audio unavailable");
        const reported: Error[] = [];
        const { player } = loadWrapper({
            ensureAudio: () => Promise.reject(failure),
            onError: (error: Error) => reported.push(error)
        });
        action(player);
        await settled();
        assert.deepEqual(reported, [failure]);
    }
});

test("audio controls preserve successful mutations and caller-owned getter promises", async () => {
    const audio = { currentTime: 0, muted: false, paused: false, duration: 60 };
    const ready = Promise.resolve(audio);
    const { player } = loadWrapper({ _audio: ready, ensureAudio: () => ready });
    player.time = 12;
    player.mute();
    await settled();
    assert.equal(await player.time, 12);
    assert.equal(await player.muted, true);
    assert.equal(await player.duration, 60);
    player.unmute();
    await settled();
    assert.equal(audio.muted, false);
});

test("audio controls contain synchronous loading errors and failed error callbacks", async () => {
    const { player, logged } = loadWrapper({
        ensureAudio: () => { throw new Error("load failed"); },
        onError: () => { throw new Error("callback failed"); }
    });
    player.load();
    await settled();
    assert.equal(logged.length, 1);
    assert.equal((logged[0][1] as Error).message, "callback failed");
});

test("audio controls ignore cancellation and report other failures without an error callback", async () => {
    let failure = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const { player, logged } = loadWrapper({ ensureAudio: () => Promise.reject(failure) });
    player.load();
    await settled();
    assert.equal(logged.length, 0);
    failure = new Error("load failed");
    player.load();
    await settled();
    assert.equal(logged.length, 1);
    assert.equal(logged[0][1], failure);
});

test("audio initialization respects explicit silence and retains volume defaults", () => {
    const source = createSourceFile("audioPlayer.ts", readFileSync("src/equicordplugins/_api/audioPlayer.ts", "utf8"), ScriptTarget.Latest, true);
    const method = forEachChild(source, function visit(node): string | undefined {
        if (isMethodDeclaration(node) && node.name.getText(source) === "buildPlayer") return node.getText(source);
        return forEachChild(node, visit);
    });
    assert.ok(method);
    const { outputText } = transpileModule(`({ ${method} });`, { compilerOptions: { target: ScriptTarget.ES2022 } });
    const builder = runInNewContext(outputText, { identifyAudioType: () => "url" });
    builder.processAudio = () => { };
    for (const [volume, internalVolume, expected] of [
        [undefined, undefined, 1], [0, undefined, 0], [25, undefined, 0.25],
        [100, 0, 0], [25, 0.5, 0.5], [150, undefined, 1], [-1, undefined, 0]
    ]) {
        const player = { _volume: -1, preprocessDataOriginal: { volume: -1 } };
        builder.buildPlayer(player, { volume }, "fixture", null, internalVolume, "default");
        assert.equal(player._volume, expected);
        assert.equal(player.preprocessDataOriginal.volume, expected);
    }
});

function loadAudioPlugin(api: object) {
    return loadTestModule("src/equicordplugins/_api/audioPlayer.ts", {
        "@api/AudioPlayer": api,
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin }
    }, { structuredClone }).default;
}

function loadDiscordAudio() {
    const instances: any[] = [];
    const loaded = new Set<number>();
    const host: Record<string, any> = {};
    const failures: unknown[] = [];
    let playFailure: Error | undefined;
    const sounds = Object.assign((key: string) => `https://cdn.discord.test/${key}`, {
        resolve() {}, id: 696354, keys: () => ["./discodo.mp3", "./message1.mp3"]
    });
    const { api } = loadAudio({
        findLazy: (filter: (module: unknown) => boolean) => proxyLazy(() => loaded.has(696354) && filter(sounds) ? sounds : null),
        findByCodeLazy: () => function (...args: unknown[]) { return new host.WebAudioSound(...args); }
    });
    const plugin = loadAudioPlugin(api);
    const source = plugin.patches[0].replacement.reduce((current: string, replacement: any) => {
        const next = current.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, "plugin"));
        assert.ok(next !== current, `the entire audio patch group must apply: ${replacement.match}`);
        return next;
    }, discordAudioPlayerSource);
    const modules: Record<number, any> = {
        696354: sounds,
        102597: { A: (name: string) => `https://cdn.discord.test/gifts/${name}` },
        904054: { A: (volume: number) => volume / 100 },
        192820: { Ay: { getOutputVolume: () => 100 } },
        723702: { isPlatformEmbedded: false },
        731738: { K: {} }, 807393: { A: { increment() {} } },
        38405: { A: { captureException: (error: unknown) => failures.push(error) } }
    };
    const requireHost = Object.assign((id: number) => { loaded.add(id); return modules[id] ?? {}; }, {
        r() {}, n: (value: unknown) => value,
        d(target: object, getters: Record<string, () => unknown>) {
            Object.defineProperties(target, Object.fromEntries(Object.entries(getters).map(([key, get]) => [key, { get }])));
        }
    });
    const factory = runInNewContext(`(${source})`, {
        plugin, setTimeout, Error,
        Audio: class {
            volume = 1;
            playbackRate = 1;
            onloadeddata?: () => void;
            constructor() { instances.push(this); }
            load() { this.onloadeddata?.(); }
            play() { return playFailure ? Promise.reject(playFailure) : Promise.resolve(); }
            pause() {}
        }
    });
    factory({}, host, requireHost);
    return { api, host, instances, failures, failPlay: (error: Error) => { playFailure = error; } };
}

test("current Discord audio patches preload sound discovery and retain native constructor fields", async () => {
    const { api, host, instances, failPlay, failures } = loadDiscordAudio();
    assert.deepEqual(Array.from(api.defaultAudioNames()), ["discodo", "message1"]);
    const player = new host.WebAudioSound(undefined, "discodo", null, 0.25, "voice", true);
    assert.equal(player.name, "discodo");
    assert.equal(player.type, api.AudioType.DISCORD);
    assert.equal(player.outputChannel, "voice");
    assert.equal(player.trackNotificationFailure, true);
    assert.equal(instances.length, 0, "discovery does not create an audio element during startup");
    const audio = await player.ensureAudio();
    assert.equal(audio.src, "https://cdn.discord.test/./discodo.mp3");
    assert.equal(audio.volume, 0.25);
    const failure = new Error("autoplay denied");
    failPlay(failure);
    player.play();
    player.loop();
    await settled();
    assert.deepEqual(failures, [failure, failure], "native playback rejection handlers still receive the rejected promise");
});

test("current Discord gift sounds retain source and normalized volume through the shared player", async () => {
    const { host, instances } = loadDiscordAudio();
    host.playGiftSound("fixture", 40);
    await settled();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].src, "https://cdn.discord.test/gifts/fixture");
    assert.equal(instances[0].volume, 0.4);
});

test("observing audio play failures retains the original promise for caller-owned handlers", async () => {
    const errors: unknown[] = [];
    const plugin = loadAudioPlugin({ handleAudioError: (_player: unknown, error: unknown) => errors.push(error) });
    const failure = new Error("play failed");
    const play = Promise.reject(failure);
    assert.equal(plugin.handlePlayPromise({}, play), play);
    await assert.rejects(play, error => error === failure);
    assert.deepEqual(errors, [failure]);
    assert.equal(plugin.handlePlayPromise({}, undefined), undefined);
});
