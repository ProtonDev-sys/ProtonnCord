/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function fixture() {
    const data = new Map<string, unknown>();
    const local = new Map<string, string>();
    const logs: unknown[][] = [];
    let response = { ok: false, status: 503, text: async () => "error page" };
    const mocks: Record<string, unknown> = {
        "file://monacoWin.html?minify": { default: "" },
        "@api/DataStore": { createStore: () => ({}),
            get: async (key: string) => data.get(key), set: async (key: string, value: unknown) => { data.set(key, value); },
            entries: async () => [], del: async () => {} },
        "@main/themes": { getThemeInfo() {} },
        "@shared/debounce": { debounce: (callback: unknown) => callback },
        "@utils/localStorage": { localStorage: {
            getItem: (key: string) => local.get(key) ?? null,
            setItem: (key: string, value: string) => { local.set(key, value); },
        } },
        "@utils/web": { getStylusWebStoreUrl() {} },
        "@utils/web-metadata": { metaReady: Promise.resolve(), RENDERER_CSS_URL: "fixture.css" },
        "./externalLinks": { openExternalInBrowser() {} },
    };
    const window: { VencordNative?: typeof import("../src/VencordNative").default; } = {};
    const source = ts.transpileModule(readFileSync("browser/VencordNativeStub.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(source, { exports: {}, window, IS_USERSCRIPT: false,
        console: { error: (...args: unknown[]) => { logs.push(args); } },
        fetch: async () => response,
        require(name: string) { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; },
    });
    return { api: window.VencordNative!, data, local, logs, setResponse(value: typeof response) { response = value; } };
}

test("QuickCSS observer failures cannot invalidate durable writes or skip healthy observers", async () => {
    const f = fixture();
    let observed = "";
    f.api.quickCss.addChangeListener(() => { throw new Error("Fixture observer failure"); });
    f.api.quickCss.addChangeListener(async () => { throw new Error("Fixture async observer failure"); });
    const dispose = f.api.quickCss.addChangeListener(css => { observed = css; });
    await f.api.quickCss.set("body {}");
    await Promise.resolve();
    assert.equal(f.data.get("VencordQuickCss"), "body {}");
    assert.equal(observed, "body {}");
    assert.equal(f.logs.length, 2);
    dispose();
    await f.api.quickCss.set("div {}");
    assert.equal(observed, "body {}");
});

test("browser settings reject non-object roots while leaving stored data untouched", () => {
    const f = fixture();
    for (const value of ["null", "[]", "42", '"value"', "invalid JSON"]) {
        f.local.set("ProtonnCordSettings", value);
        assert.equal(JSON.stringify(f.api.settings.get()), "{}");
        assert.equal(f.local.get("ProtonnCordSettings"), value);
    }
    f.local.set("ProtonnCordSettings", '{"plugins":{"Fixture":{"enabled":true}}}');
    assert.equal(f.api.settings.get().plugins.Fixture.enabled, true);
});

test("renderer CSS failures reject rather than treating an error page as styles", async () => {
    const f = fixture();
    await assert.rejects(f.api.native.getRendererCss(), /503/u);
    f.setResponse({ ok: true, status: 200, text: async () => "body {}" });
    assert.equal(await f.api.native.getRendererCss(), "body {}");
});
