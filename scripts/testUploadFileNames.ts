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

function fixture() {
    const store = {
        anonymiseByDefault: true, spoilerMessages: false, method: 0,
        randomisedLength: 7, consistent: "image", dateFormat: "YYYY-MM-DD_HH-mm-ss-SSS"
    };
    const enabled = { AnonymiseFileNames: false, FixFileExtensions: false };
    const mocks: Record<string, object> = {
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {} },
        "@api/PluginManager": { isPluginEnabled: (name: keyof typeof enabled) => enabled[name] },
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, store }), Settings: { plugins: { FixFileExtensions: { get enabled() { return enabled.FixFileExtensions; } } } } },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, ReporterTestable: {} },
        "@webpack": { findByCodeLazy: () => "icon" },
        "@webpack/common": {}
    };
    function load(path: string, result = "exports") {
        const code = transpileModule(readFileSync(path, "utf8"), {
            fileName: path,
            compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText;
        return runInNewContext(code + `\n${result};`, {
            exports: {}, Date,
            require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
        });
    }
    const extensions = load("src/equicordplugins/fixFileExtensions/index.tsx");
    mocks["@equicordplugins/fixFileExtensions"] = extensions;
    const { plugin, symbol } = load("src/plugins/anonymiseFileNames/index.tsx", "({ plugin: exports.default, symbol: ANONYMISE_UPLOAD_SYMBOL })");
    function anonymise(filename: string, override?: boolean) {
        const upload = { filename, [symbol]: override };
        [upload].forEach(plugin.anonymise);
        return upload.filename;
    }
    return { store, enabled, plugin, extensions: extensions.default, anonymise };
}

test("extension correction preserves extensionless names, unknown suffixes and compound archives", () => {
    const { extensions } = fixture();
    for (const [input, expected] of [
        ["README", "README"], ["image.JPE", "image.jpg"], ["video.m4v", "video.mp4"],
        ["archive.tar.gz", "archive.tar.gz"], ["archive.TAR.AAC", "archive.TAR.AAC"],
        ["name.custom", "name.custom"], ["file.", "file."], ["", ""]
    ]) {
        const upload = { filename: input };
        extensions.fixExt(upload);
        assert.equal(upload.filename, expected, input);
    }
});

test("opting out of anonymisation still applies enabled extension and spoiler preferences once", () => {
    const { store, enabled, anonymise, extensions } = fixture();
    enabled.FixFileExtensions = true;
    enabled.AnonymiseFileNames = true;
    store.spoilerMessages = true;
    assert.equal(extensions.patches[0].predicate(), false);
    assert.equal(anonymise("personal.JPE", false), "SPOILER_personal.jpg");
    assert.equal(anonymise("SPOILER_personal.jpg", false), "SPOILER_personal.jpg");
    assert.equal(anonymise("README", false), "SPOILER_README");
    store.anonymiseByDefault = false;
    assert.equal(anonymise("name.m4v"), "SPOILER_name.mp4");
    enabled.FixFileExtensions = false;
    assert.equal(anonymise("name.m4v"), "SPOILER_name.m4v");
    store.spoilerMessages = false;
    assert.equal(anonymise("SPOILER_name.m4v"), "SPOILER_name.m4v");
    enabled.AnonymiseFileNames = false;
    assert.equal(extensions.patches[0].predicate(), true);
});

test("anonymous names retain the original suffix and per-upload opt-in overrides the default", () => {
    const { store, anonymise } = fixture();
    store.anonymiseByDefault = false;
    store.method = 1;
    assert.equal(anonymise("personal.tar.gz", true), "image.tar.gz");
    assert.equal(anonymise("personal", true), "image");
    store.spoilerMessages = true;
    store.consistent = "SPOILER_image";
    assert.equal(anonymise("personal.jpg", true), "SPOILER_image.jpg");
});

test("invalid random lengths and unknown methods produce bounded anonymous names", () => {
    const { store, plugin, anonymise } = fixture();
    for (const length of [0, -1, 1.5, NaN, Infinity, 257, "7"]) {
        Object.assign(store, { randomisedLength: length });
        assert.notEqual(plugin.settings.def.randomisedLength.isValid(length), true);
        assert.match(anonymise("personal.png"), /^[0-9bdfhjkmnpqrstvwxz]{7}\.png$/);
    }
    for (const length of [1, 7, 256]) {
        store.randomisedLength = length;
        assert.equal(plugin.settings.def.randomisedLength.isValid(length), true);
        assert.equal(anonymise("personal").length, length);
    }
    store.method = 99;
    store.randomisedLength = 7;
    assert.match(anonymise("personal.png"), /^[0-9bdfhjkmnpqrstvwxz]{7}\.png$/);
});

test("timestamp and date names retain their configured formats and empty-date fallback", () => {
    const { store, anonymise } = fixture();
    store.method = 2;
    assert.match(anonymise("personal.png"), /^\d+\.png$/);
    store.method = 3;
    assert.match(anonymise("personal.png"), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.png$/);
    store.dateFormat = "";
    store.spoilerMessages = true;
    assert.match(anonymise("personal.png"), /^SPOILER_\d+\.png$/);
});
