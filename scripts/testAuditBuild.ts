/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadFunction(path: string, name: string, globals: Record<string, unknown>) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration);
    const code = declaration.getText(source).replace(/^export /u, "");
    return runInNewContext(`${code}\n${name};`, globals);
}

test("reproducible build timestamp accepts epoch zero and rejects invalid or unsafe values", () => {
    const getTimestamp = loadFunction("scripts/build/common.mjs", "getBuildTimestamp", { process: { env: {} }, Date });
    assert.equal(getTimestamp("0"), 0);
    assert.equal(getTimestamp("1700000000"), 1700000000000);
    for (const value of ["", "-1", "no", "1.5", "Infinity", "9007199254740992"])
        assert.throws(() => getTimestamp(value), /SOURCE_DATE_EPOCH/u);
    const before = Date.now();
    assert.ok(getTimestamp() >= before);
});

test("watch packaging waits for initial outputs and disposes all opened contexts after failure", async () => {
    const calls: string[] = [];
    const buildAll = loadFunction("scripts/build/common.mjs", "buildOrWatchAll", {
        watch: true,
        context: async (name: string) => ({
            rebuild: async () => { calls.push(`build:${name}`); if (name === "broken") throw new Error("Fixture build failed"); },
            watch: async () => { calls.push(`watch:${name}`); },
            dispose: async () => { calls.push(`dispose:${name}`); },
        }),
    });
    await buildAll(["first", "second"]);
    assert.deepEqual(calls, ["watch:first", "build:first", "watch:second", "build:second"]);
    calls.length = 0;
    await assert.rejects(buildAll(["first", "broken"]), /Fixture build failed/u);
    assert.deepEqual(calls, ["watch:first", "build:first", "watch:broken", "build:broken", "dispose:first", "dispose:broken"]);
});

test("extension packaging propagates archive-read and save failures and waits for completion", async () => {
    let callback!: (error: unknown, archive?: unknown) => void;
    const packed: string[] = [];
    const pack = loadFunction("scripts/build/buildWeb.mjs", "packExtension", {
        join, console: { info() {} }, Zip: { zip: (_path: string, onZip: typeof callback) => { callback = onZip; } },
    });
    const failure = pack("fixture", "fixture.zip");
    callback(new Error("Fixture read failure"));
    await assert.rejects(failure, /Fixture read failure/u);
    const saveFailure = pack("fixture", "fixture.zip");
    callback(null, { compress: () => ({ save(_path: string, saved: (error: Error) => void) { saved(new Error("Fixture save failure")); } }) });
    await assert.rejects(saveFailure, /Fixture save failure/u);
    let complete = false;
    const success = pack("fixture", "fixture.zip").then(() => { complete = true; });
    await Promise.resolve();
    assert.equal(complete, false);
    let finishSave!: (error?: unknown) => void;
    callback(null, { compress: () => ({ save: (path: string, saved: typeof finishSave) => { packed.push(path); finishSave = saved; } }) });
    await Promise.resolve();
    assert.equal(complete, false, "creating an archive does not finish its asynchronous file write");
    finishSave();
    await success;
    assert.deepEqual(packed, [join("dist", "fixture.zip")]);
});

test("managed styles retain literal template markers and replacement characters and watch their source", async () => {
    const path = "scripts/build/common.mjs";
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const statement = source.statements.find(node => ts.isVariableStatement(node)
        && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === "stylePlugin"));
    assert.ok(statement);
    const css = '.fixture::before { content: "STYLE_NAME STYLE_SOURCE $& $$"; }';
    const plugin = runInNewContext(`${statement.getText(source).replace(/^export /u, "")}\nstylePlugin;`, {
        readFile: async () => css, relative, resolve, process: { cwd: () => process.cwd() },
        styleModule: readFileSync("scripts/build/module/style.js", "utf8"),
    });
    let onLoad!: (args: { path: string; }) => Promise<{ contents: string; watchFiles: string[]; }>;
    plugin.setup({ onResolve() {}, onLoad(_filter: unknown, callback: typeof onLoad) { onLoad = callback; } });
    const name = "src/fixture.css";
    const result = await onLoad({ path: name });
    const window = { VencordStyles: new Map() };
    const generated = ts.transpileModule(result.contents, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    runInNewContext(generated, { window, exports: {} });
    assert.equal(window.VencordStyles.get(name).source, css);
    assert.equal(result.watchFiles[0], resolve(name));
});
