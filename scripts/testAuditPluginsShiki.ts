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

function load(path: string, modules: Record<string, any>, globals: Record<string, any> = {}) {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + "\nexports;", { exports: {}, AbortSignal, setTimeout, clearTimeout, ...globals,
        require: (name: string) => { if (!(name in modules)) throw new Error(`Missing fixture module: ${name}`); return modules[name]; } });
}

function workerFixture() {
    const clients: WorkerFixture[] = [];
    const themes: unknown[] = [];
    let fetchImpl = async (): Promise<any> => ({ ok: true, blob: async () => "fixture-worker" });
    let runImpl = async (name: string, options: any): Promise<any> => name === "getTheme" ? { themeData: JSON.stringify({ name: options.theme }) } : [];
    class WorkerFixture {
        calls: { name: string; options: any; }[] = [];
        destroyed = false;
        constructor() { clients.push(this); }
        async init() {}
        run(name: string, options: any) { this.calls.push({ name, options }); return runImpl(name, options); }
        destroy() { this.destroyed = true; }
    }
    const language = { id: "typescript", grammar: {} };
    const modules = {
        "@plugins/shikiCodeblocks.desktop/hooks/useTheme": { dispatchTheme: (value: unknown) => themes.push(value) },
        "@utils/dependencies": { shikiWorkerSrc: "https://example.test/worker.js", shikiOnigasmSrc: "https://example.test/grammar.wasm" },
        "@vap/core/ipc": { WorkerClient: WorkerFixture },
        "./languages": { languages: {}, loadLanguages: async () => {}, getGrammar: async () => ({}), resolveLang: () => language },
        "./themes": { themes: { default: "fixture-default" } }
    };
    const { shiki } = load("src/plugins/shikiCodeblocks.desktop/api/shiki.ts", modules, { fetch: () => fetchImpl() });
    return { shiki, clients, themes, setFetch: (value: typeof fetchImpl) => fetchImpl = value,
        setRun: (value: typeof runImpl) => runImpl = value };
}

test("Shiki recreates worker state after restart and deduplicates canonical language loads", async () => {
    const f = workerFixture();
    await f.shiki.init(undefined);
    await Promise.all([f.shiki.loadLang("ts"), f.shiki.loadLang("typescript")]);
    assert.equal(f.clients[0].calls.filter(call => call.name === "loadLanguage").length, 1);
    await f.shiki.tokenizeCode("fixture code", "ts");
    assert.equal(f.clients[0].calls.at(-1)!.options.lang, "typescript");
    f.shiki.destroy();
    assert.equal(f.clients[0].destroyed, true);
    assert.equal(f.shiki.client, null);
    assert.equal(f.shiki.loadedLangs.size, 0);
    assert.equal(f.shiki.loadedThemes.size, 0);
    await f.shiki.init(undefined);
    await f.shiki.loadLang("ts");
    assert.equal(f.clients.length, 2);
    assert.equal(f.clients[1].calls.filter(call => call.name === "loadLanguage").length, 1);
    f.shiki.destroy();
});

test("Shiki never creates a worker from a download completed after stop", async () => {
    const f = workerFixture();
    let finish!: (response: any) => void;
    f.setFetch(() => new Promise(resolve => finish = resolve));
    const init = f.shiki.init(undefined);
    f.shiki.destroy();
    finish({ ok: true, blob: async () => "fixture-worker" });
    await init;
    assert.equal(f.clients.length, 0);
    assert.equal(f.shiki.currentTheme, null);
});

test("Shiki bounds a worker operation that never replies", async () => {
    const f = workerFixture();
    await f.shiki.init(undefined);
    f.shiki.timeoutMs = 1;
    f.setRun(() => new Promise(() => {}));
    await assert.rejects(f.shiki.tokenizeCode("fixture", "ts"), /timed out/);
    f.shiki.destroy();
});

test("Shiki failed startup can retry and out-of-order theme completion preserves the latest choice", async () => {
    const f = workerFixture();
    f.setFetch(async () => ({ ok: false, status: 503 }));
    await assert.rejects(f.shiki.init(undefined), /503/);
    f.setFetch(async () => ({ ok: true, blob: async () => "fixture-worker" }));
    await f.shiki.init(undefined);
    const replies = new Map<string, (value: any) => void>();
    f.shiki.loadedThemes.add("first");
    f.shiki.loadedThemes.add("second");
    f.setRun((_name, options) => new Promise(resolve => replies.set(options.theme, resolve)));
    const first = f.shiki.setTheme("first");
    await setImmediate();
    const second = f.shiki.setTheme("second");
    await setImmediate();
    replies.get("second")!({ themeData: JSON.stringify({ name: "second" }) });
    await second;
    replies.get("first")!({ themeData: JSON.stringify({ name: "first" }) });
    await first;
    assert.equal(f.shiki.currentThemeUrl, "second");
    assert.equal(f.shiki.currentTheme.name, "second");
    f.shiki.destroy();
});

test("Shiki language and theme downloads enforce deadlines without caching HTTP failures", async () => {
    const requests: RequestInit[] = [];
    let response: any = { ok: false, status: 503 };
    const fakeFetch = async (_url: string, options: RequestInit) => { requests.push(options); return response; };
    const languages = load("src/plugins/shikiCodeblocks.desktop/api/languages.ts", {
        "./themes": { SHIKI_REPO: "fixture", SHIKI_REPO_COMMIT: "fixture" }
    }, { fetch: fakeFetch });
    await assert.rejects(languages.loadLanguages(), /503/);
    response = { ok: true, json: async () => [{ name: "fixture", displayName: "Fixture", scopeName: "source.fixture", aliases: ["f"] }] };
    await Promise.all([languages.loadLanguages(), languages.loadLanguages()]);
    assert.equal(requests.length, 2);
    assert.equal(languages.resolveLang("f").name, "Fixture");
    const themes = load("src/plugins/shikiCodeblocks.desktop/api/themes.ts", {}, { fetch: fakeFetch });
    response = { ok: false, status: 404 };
    await assert.rejects(themes.getTheme("https://example.test/theme.json"), /404/);
    assert.equal(themes.themeCache.size, 0);
    response = { ok: true, json: async () => ({ name: "Fixture" }) };
    assert.equal((await themes.getTheme("https://example.test/theme.json")).name, "Fixture");
    assert.equal(themes.themeCache.size, 1);
    assert.ok(requests.every(options => options.signal instanceof AbortSignal));
});

test("Shiki copy feedback waits for clipboard success and cannot update an unmounted hook", async () => {
    const effects: (() => () => void)[] = [];
    const updates: unknown[] = [];
    const timers: (() => void)[] = [];
    let copyImpl: () => Promise<void> = async () => { throw new Error("Clipboard unavailable"); };
    const { useCopyCooldown } = load("src/plugins/shikiCodeblocks.desktop/hooks/useCopyCooldown.ts", {
        "@utils/clipboard": { copyToClipboard: () => copyImpl() },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack/common": { React: { useState: () => [false, (value: unknown) => updates.push(value)],
            useRef: (value: unknown) => ({ current: value }), useEffect: (effect: () => () => void) => effects.push(effect) } }
    }, { setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; } });
    const [, copy] = useCopyCooldown(1000);
    const cleanup = effects[0]();
    await copy("fixture");
    assert.equal(updates.length, 0);
    let finish!: () => void;
    copyImpl = () => new Promise<void>(resolve => finish = resolve);
    const pending = copy("fixture");
    cleanup();
    finish();
    await pending;
    assert.equal(updates.length, 0);
    assert.equal(timers.length, 0);
});

test("Shiki named style replacement removes the old element and cleanup removes the current one", () => {
    const elements: { removed: boolean; }[] = [];
    const styles = load("src/plugins/shikiCodeblocks.desktop/utils/createStyle.ts", {}, {
        document: { createElement: () => {
            const style = { removed: false, remove() { this.removed = true; } };
            elements.push(style);
            return style;
        }, head: { appendChild() {} } }
    });
    styles.setStyle("first", "same");
    styles.setStyle("second", "same");
    assert.equal(elements[0].removed, true);
    assert.equal(elements[1].removed, false);
    styles.clearStyles();
    assert.equal(elements[1].removed, true);
});
