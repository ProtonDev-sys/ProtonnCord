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
