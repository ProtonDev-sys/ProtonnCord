/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("video generation refuses an existing working directory before browser launch or file replacement", async () => {
    const source = readFileSync(new URL("./createDiscordMcpVideo.ts", import.meta.url), "utf8");
    const parsed = createSourceFile("video.ts", source, ScriptTarget.Latest, true);
    const declaration = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === "renderSlides");
    assert.ok(declaration);
    const code = transpileModule(declaration.getText(parsed), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText;
    const failure = Object.assign(new Error("The fixture directory already exists"), { code: "EEXIST" });
    let creations = 0;
    let removals = 0;
    let launches = 0;
    const renderSlides = runInNewContext(`${code}\nrenderSlides`, {
        workDirectory: "fixture-existing-directory",
        async mkdir(path: string, options: unknown) {
            creations++;
            assert.equal(path, "fixture-existing-directory");
            assert.equal(options, undefined, "recursive directory reuse would silently accept an existing directory");
            throw failure;
        },
        async rm() { removals++; },
        puppeteer: { async launch() { launches++; throw new Error("Browser launch is outside this test"); } },
    }) as () => Promise<string[]>;
    await assert.rejects(renderSlides(), error => error === failure);
    assert.equal(creations, 1);
    assert.equal(removals, 0);
    assert.equal(launches, 0);
});

test("reporter missing-browser validation reports the requested channel before exiting", () => {
    const source = readFileSync(new URL("./generateReport.ts", import.meta.url), "utf8");
    const start = source.indexOf("const CANARY =");
    const end = source.indexOf("let metaData =");
    assert.ok(start >= 0 && end > start);
    const code = transpileModule(source.slice(start, end), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText;
    for (const canary of [false, true]) {
        const messages: unknown[][] = [];
        const exited = new Error("fixture exit");
        assert.throws(() => runInNewContext(code, {
            process: {
                env: canary ? { USE_CANARY: "true" } : {},
                exit(status: number) { assert.equal(status, 1); throw exited; },
            },
            console: { error: (...args: unknown[]) => messages.push(args) },
        }), error => error === exited);
        assert.deepEqual(messages, [[`${canary ? "CANARY" : "STABLE"} ---`, "Missing environment variable CHROMIUM_BIN"]]);
    }
});
