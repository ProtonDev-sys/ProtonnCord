/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function load(file: string, mocks: Record<string, any> = {}, globals: Record<string, unknown> = {}) {
    const path = `src/plugins/translate/${file}`;
    const code = transpileModule(readFileSync(path, "utf8"), { fileName: path, compilerOptions: {
        module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React
    } }).outputText;
    return runInNewContext(code + "\nexports;", { exports: {}, AbortSignal, URLSearchParams, ...globals,
        require: (name: string) => mocks[name] ?? {} });
}

test("translation services use request deadlines and invalid results cannot replace message text", async () => {
    const requests: RequestInit[] = [];
    let response: any = { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    const fetch = async (_url: string, options: RequestInit) => { requests.push(options); return response; };
    const native = load("native.ts", {}, { fetch });
    await native.makeDeeplTranslateRequest(null, false, "fixture-key", "{}");
    await native.makeKagiTranslateRequest(null, "fixture-session", "fixture text", "auto", "en_us");
    const utils = load("utils.ts", {
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/onlyOnce": { onlyOnce: (fn: unknown) => fn },
        "@webpack/common": { showToast() {}, Toasts: { Type: { FAILURE: 1 } } },
        "./settings": { settings: { store: { service: "google" } } },
        "./languages": { GoogleLanguages: {}, DeeplLanguages: {}, KagiLanguages: {} }
    }, { fetch, IS_WEB: true, VencordNative: { pluginHelpers: { Translate: {} } } });
    await assert.rejects(utils.translateText("private fixture text", "auto", "en"), /invalid response/);
    response = { ok: false, status: 503, statusText: "Unavailable" };
    await assert.rejects(utils.translateText("private fixture text", "auto", "en"), (error: Error) => {
        assert.equal(error.message.includes("private fixture text"), false);
        return error.message.includes("503");
    });
    assert.ok(requests.every(request => request.signal instanceof AbortSignal));
});

test("translation completion cannot alter a stopped session or another account's outgoing message", async () => {
    for (const stop of [true, false]) {
        let account = "first";
        let finish!: (value: unknown) => void;
        const plugin = load("index.tsx", {
            "@utils/constants": { Devs: {} }, "@utils/types": { __esModule: true, default: (value: unknown) => value },
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: account }) } },
            "./settings": { settings: { store: { autoTranslate: true } } },
            "./utils": { translate: () => new Promise(resolve => finish = resolve) }
        }, { setTimeout: () => 1, clearTimeout() {} }).default;
        plugin.start();
        const message = { content: "original" };
        const pending = plugin.onBeforeMessageSend("fixture", message);
        if (stop) plugin.stop();
        else account = "second";
        finish({ sourceLanguage: "Fixture", text: "translated" });
        assert.equal((await pending).cancel, true);
        assert.equal(message.content, "original");
    }
});

test("translation accessories own individual listeners and tolerate missing or removed messages", () => {
    const effects: (() => () => void)[] = [];
    const updates: unknown[][] = [];
    const api = load("TranslationAccessory.tsx", {
        "@webpack/common": { useState: () => {
            const values: unknown[] = [];
            updates.push(values);
            return [undefined, (value: unknown) => values.push(value)];
        }, useEffect: (fn: () => () => void) => effects.push(fn) }
    });
    api.handleTranslate("missing", { text: "ignored" });
    api.TranslationAccessory({ message: { id: "same" } });
    api.TranslationAccessory({ message: { id: "same" } });
    const cleanup = effects.map(effect => effect());
    updates.forEach(values => values.length = 0);
    api.handleTranslate("same", { text: "first" });
    assert.equal(updates[0].length, 1);
    assert.equal(updates[1].length, 1);
    cleanup[0]();
    api.handleTranslate("same", { text: "second" });
    assert.equal(updates[0].length, 1);
    assert.equal(updates[1].length, 2);
    cleanup[1]();
    api.handleTranslate("same", { text: "ignored" });
    assert.equal(updates[1].length, 2);
});

test("translation language defaults use an offered Kagi output code", () => {
    const store: Record<string, unknown> = { service: "kagi" };
    const settings = { store, withPrivateSettings() { return this; } };
    const api = load("settings.tsx", {
        "@api/Settings": { definePluginSettings: () => settings }, "@utils/types": { OptionType: {} }
    }, { IS_WEB: false });
    api.resetLanguageDefaults();
    assert.equal(store.sentInput, "auto");
    assert.equal(store.sentOutput, "en_us");
    store.service = "google";
    api.resetLanguageDefaults();
    assert.equal(store.sentOutput, "en");
});
