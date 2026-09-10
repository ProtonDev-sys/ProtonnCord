/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, forEachChild, isMethodDeclaration, ScriptTarget, transpileModule } from "typescript";

import type { AudioPlayerInterface } from "../src/api/AudioPlayer";

function loadWrapper(internalPlayer: Record<string, unknown>) {
    const exports: Record<string, any> = {};
    const logged: unknown[][] = [];
    const { outputText } = transpileModule(readFileSync("src/api/AudioPlayer.ts", "utf8"), {
        compilerOptions: { target: ScriptTarget.ES2022, module: 1 }
    });
    runInNewContext(outputText, {
        exports, Error, URL,
        require(name: string) {
            if (name === "@webpack") return {
                findByCodeLazy: () => function () { return internalPlayer; },
                findLazy: () => ({ keys: () => ["./fixture.mp3"] })
            };
            if (name === "@utils/Logger") return { Logger: class { error(...args: unknown[]) { logged.push(args); } } };
            throw new Error(`Unexpected dependency: ${name}`);
        }
    });
    return { player: exports.createAudioPlayer("fixture") as AudioPlayerInterface, logged };
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
