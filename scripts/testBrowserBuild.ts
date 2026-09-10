/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { context } from "esbuild";
import { createSourceFile, isFunctionDeclaration, ScriptTarget } from "typescript";

const source = createSourceFile("buildWeb.mjs", readFileSync("scripts/build/buildWeb.mjs", "utf8"), ScriptTarget.Latest, true);
const code = source.statements.filter(node =>
    isFunctionDeclaration(node) && ["buildExtension", "appendCssRuntime", "afterBuild"].includes(node.name?.text ?? "")
).map(node => node.getText(source)).join("\n");

test("browser packaging replaces stale output and preserves literal userscript CSS", async () => {
    const root = await mkdtemp(join(tmpdir(), "protonn-browser-build-"));
    const at = (path: string) => {
        const result = resolve(root, path);
        assert.ok(result.startsWith(root + sep), "build writes must stay inside the fixture");
        return result;
    };
    const css = '.fixture::before { content: "\\e001 ${color} ` quote\\\""; }\n';
    const files = {
        "dist/browser/extension.js": "renderer",
        "dist/browser/extension.css": "styles",
        "dist/browser/fixture-unpacked/stale.js": "old release",
        "dist/ProtonnCord.user.css": css,
        "dist/ProtonnCord.user.js": "",
        "browser/manifest.json": '{"manifest_version":3}',
        "browser/icon.png": "icon"
    };
    try {
        for (const [path, content] of Object.entries(files)) {
            await mkdir(join(at(path), ".."), { recursive: true });
            await writeFile(at(path), content);
        }
        await runInNewContext(`${code}\nPromise.all([appendCssRuntime(), buildExtension("fixture-unpacked", ["manifest.json", "icon.png"])]);`, {
            VERSION: "1.2.3", Buffer, TextEncoder, join, resolve, sep,
            console: { info() { } },
            readFile: (path: string, encoding: BufferEncoding) => readFile(at(path), encoding),
            appendFile: (path: string, content: string) => appendFile(at(path), content),
            rm: (path: string, options: Parameters<typeof rm>[1]) => rm(at(path), options),
            mkdir: (path: string, options: Parameters<typeof mkdir>[1]) => mkdir(at(path), options),
            writeFile: (path: string, content: Buffer) => writeFile(at(path), content)
        });
        await assert.rejects(readFile(at("dist/browser/fixture-unpacked/stale.js")), { code: "ENOENT" });
        assert.equal(await readFile(at("dist/browser/fixture-unpacked/dist/ProtonnCord.js"), "utf8"), "renderer");
        assert.deepEqual(JSON.parse(await readFile(at("dist/browser/fixture-unpacked/manifest.json"), "utf8")), { manifest_version: 3, version: "1.2.3" });
        const unsafeWindow = { _vcUserScriptRendererCss: "" };
        runInNewContext(await readFile(at("dist/ProtonnCord.user.js"), "utf8"), { unsafeWindow });
        assert.equal(unsafeWindow._vcUserScriptRendererCss, css);
    } finally {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(basename(root).startsWith("protonn-browser-build-"));
        await rm(root, { recursive: true, force: true });
    }
});

test("watched userscript outputs retain embedded CSS after initial and later builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "protonn-browser-watch-"));
    const at = (path: string) => {
        const result = resolve(root, path);
        assert.ok(result.startsWith(root + sep));
        return result;
    };
    const runtime = runInNewContext(`${code}\n({ afterBuild, appendCssRuntime });`, {
        readFile: (path: string, encoding: BufferEncoding) => readFile(at(path), encoding),
        appendFile: (path: string, content: string) => appendFile(at(path), content),
    });
    let builds = 0;
    let buildContext: Awaited<ReturnType<typeof context>> | undefined;
    try {
        await writeFile(at("entry.js"), 'import "./entry.css";');
        await writeFile(at("entry.css"), '.first { color: red; }');
        buildContext = await context({
            absWorkingDir: root,
            entryPoints: ["entry.js"],
            outfile: at("dist/ProtonnCord.user.js"),
            bundle: true,
            plugins: [runtime.afterBuild("embed-css-fixture", async () => {
                await runtime.appendCssRuntime();
                builds++;
            })],
        });
        await buildContext.watch();
        await buildContext.rebuild();
        const first = await readFile(at("dist/ProtonnCord.user.js"), "utf8");
        assert.match(first, /_vcUserScriptRendererCss=/);
        assert.match(first, /\.first/);
        const firstBuilds = builds;
        await writeFile(at("entry.css"), '.second { color: blue; }');
        await buildContext.rebuild();
        const second = await readFile(at("dist/ProtonnCord.user.js"), "utf8");
        assert.match(second, /\.second/);
        assert.doesNotMatch(second, /\.first/);
        assert.equal(second.split("_vcUserScriptRendererCss=").length - 1, 1);
        assert.ok(builds > firstBuilds, "postprocessing runs on each completed rebuild");
    } finally {
        await buildContext?.dispose();
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(basename(root).startsWith("protonn-browser-watch-"));
        await rm(root, { recursive: true, force: true });
    }
});
