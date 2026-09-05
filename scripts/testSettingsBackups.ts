/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const code = transpileModule(readFileSync("src/api/SettingsSync/offline.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText;
const load = runInThisContext(`(function(exports, require, VencordNative, DiscordNative, IS_DISCORD_DESKTOP) { ${code}; return exports; })`);

function fixture(desktop = false) {
    const plain = { plugins: { Existing: { enabled: true, value: 1, nested: { keep: true } } }, themeLinks: ["keep"], cloud: { settingsSync: false } };
    const io: {
        settings: typeof plain;
        css: string;
        entries: unknown[];
        restored?: unknown[];
        reads: string[];
        writes: string[];
        failRead?: string;
        failWrite?: string;
        beforeSettings?: Promise<void>;
        beforeSave?: Promise<void>;
        file: Pick<File, "arrayBuffer"> | null;
        pickerError?: Error;
        saved: Uint8Array[];
        toasts: { type: string; message: string; }[];
        errors: unknown[][];
    } = {
        settings: structuredClone(plain), css: "body {}", entries: [["first", { value: 1 }]],
        reads: [], writes: [], file: null, saved: [], toasts: [], errors: []
    };
    function read(section: string) {
        io.reads.push(section);
        if (io.failRead === section) throw new Error("Synthetic read failure");
    }
    function write(section: string) {
        io.writes.push(section);
        if (io.failWrite === section) throw new Error("Synthetic write failure");
    }
    const native = {
        settings: {
            get() { read("settings"); return structuredClone(io.settings); },
            async set(value: typeof plain) {
                await io.beforeSettings;
                write("settings"); io.settings = structuredClone(value);
            }
        },
        quickCss: {
            async get() { read("css"); return io.css; },
            async set(value: string) { write("css"); io.css = value; }
        }
    };
    const mocks = {
        "@api/Settings": { PlainSettings: plain },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { io.errors.push(args); } } },
        "@utils/web": {
            async chooseFile() { if (io.pickerError) throw io.pickerError; return io.file; },
            saveFile(file: File) { io.saved.push(new Uint8Array()); assert.equal(file.type, "application/json"); }
        },
        "@webpack/common": {
            moment: () => ({ format: () => "2026-09-05" }),
            Toasts: { Type: { SUCCESS: "success", FAILURE: "failure" }, genId: () => "toast", show: (value: typeof io.toasts[number]) => io.toasts.push(value) }
        },
        "..": { DataStore: {
            async entries() { read("datastore"); return io.entries; },
            async setMany(entries: unknown[]) { write("datastore"); io.restored = structuredClone(entries); }
        } }
    };
    const discordNative = { fileManager: {
        async openFiles() {
            if (io.pickerError) throw io.pickerError;
            return io.file ? [{ data: new Uint8Array(await io.file.arrayBuffer()) }] : [];
        },
        async saveWithDialog(data: Uint8Array) { await io.beforeSave; write("save"); io.saved.push(data); }
    } };
    const api = load({}, (name: string) => {
        assert.ok(Object.hasOwn(mocks, name), name);
        return mocks[name];
    }, native, discordNative, desktop) as typeof import("../src/api/SettingsSync/offline");
    return { api, io, plain };
}

test("backup exports read only the selected sections", async () => {
    for (const [type, reads, fields] of [
        ["all", ["settings", "css", "datastore"], ["settings", "quickCss", "dataStore"]],
        ["plugins", ["settings"], ["settings"]],
        ["css", ["css"], ["quickCss"]],
        ["datastore", ["datastore"], ["dataStore"]]
    ] as const) {
        const f = fixture();
        const backup = JSON.parse(await f.api.exportSettings({ type }));
        assert.deepEqual(f.io.reads, [...reads]);
        assert.deepEqual(Object.keys(backup), [...fields]);
    }
    const f = fixture(); f.io.failRead = "css";
    await f.api.exportSettings({ type: "plugins" });
    await f.api.exportSettings({ type: "datastore" });
    assert.deepEqual(f.io.reads, ["settings", "datastore"]);
});

test("Export All cannot silently omit failed DataStore reads or save a partial file", async () => {
    const f = fixture(); f.io.failRead = "datastore";
    await assert.rejects(f.api.exportSettings(), /Synthetic read failure/);
    await f.api.downloadSettingsBackup();
    assert.equal(f.io.saved.length, 0);
    assert.equal(f.io.toasts.at(-1)?.type, "failure");
});

test("JSON backups reject unsupported DataStore values and duplicate identities", async () => {
    for (const entries of [
        [["key", new Map([["a", 1]])]], [["key", new Date(0)]], [["key", new Uint8Array([1])]],
        [["key", undefined]], [["key", 1n]], [["key", Infinity]],
        [[new Date(0), "date key"]], [["same", 1], ["same", 2]]
    ]) {
        const f = fixture(); f.io.entries = entries;
        await assert.rejects(f.api.exportSettings({ type: "datastore" }), /cannot be restored/);
    }
});

test("the browser QuickCSS storage record cannot override the selected QuickCSS section", async () => {
    const f = fixture();
    f.io.entries = [["VencordQuickCss", "duplicate"], ["plugin", { value: true }]];
    const exported = JSON.parse(await f.api.exportSettings());
    assert.deepEqual(exported.dataStore, [["plugin", { value: true }]]);
    await f.api.importSettings(JSON.stringify({ settings: {}, quickCss: "", dataStore: f.io.entries }));
    assert.equal(f.io.css, "");
    assert.deepEqual(f.io.restored, [["plugin", { value: true }]]);
});

test("backups round-trip empty CSS, empty DataStore and nested settings without removing unrelated values", async () => {
    const f = fixture(); f.io.css = ""; f.io.entries = [];
    f.io.settings.plugins.Existing.value = 0;
    const backup = await f.api.exportSettings({ type: "all", minify: true });
    f.io.css = "old";
    await f.api.importSettings(backup);
    assert.equal(f.io.css, ""); assert.deepEqual(f.io.restored, []);
    assert.equal(f.plain.plugins.Existing.value, 0);
    await f.api.importSettings(JSON.stringify({ settings: { plugins: { Existing: { nested: { added: false } }, New: { enabled: false } } } }), "plugins");
    assert.deepEqual(f.plain.plugins.Existing.nested, { keep: true, added: false });
    assert.equal(f.plain.plugins.Existing.enabled, true);
    assert.deepEqual(f.plain.themeLinks, ["keep"]);
    await f.api.importSettings('{"quickCss":""}', "css");
    assert.equal(f.io.css, "");
});

test("invalid backup roots and selected sections fail before any write", async () => {
    for (const value of [
        null, [], "text", 1, {}, { settings: null }, { settings: [] },
        { settings: { plugins: [] } }, { settings: { plugins: { Example: null } } },
        { settings: { plugins: { Example: { enabled: "false" } } } },
        { settings: {}, quickCss: 0 }, { settings: {}, dataStore: {} },
        { settings: {}, dataStore: [[null, "value"]] }, { settings: {}, dataStore: [["one"]] },
        { settings: {}, dataStore: [["same", 1], ["same", 2]] }
    ]) {
        const f = fixture();
        await assert.rejects(f.api.importSettings(JSON.stringify(value)));
        assert.deepEqual(f.io.writes, []);
    }
    const f = fixture();
    await assert.rejects(f.api.importSettings("not JSON"), /not valid JSON/);
    await assert.rejects(f.api.importSettings('{"quickCss":null}', "css"), /missing or invalid/);
    await f.api.importSettings('{"settings":null,"quickCss":"selected"}', "css");
    assert.equal(f.io.css, "selected", "unselected sections are not imported");
});

test("settings imports await storage, preserve failed state, reject overlapping imports and permit retry", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>();
    const previous = structuredClone(f.plain);
    const patch = JSON.stringify({ settings: { plugins: { Existing: { value: 2 } } } });
    f.io.beforeSettings = gate.promise; f.io.failWrite = "settings";
    const first = f.api.importSettings(patch, "plugins");
    assert.deepEqual(f.plain, previous);
    await assert.rejects(f.api.importSettings(patch, "plugins"), /current import/);
    const failure = assert.rejects(first, /could not be saved/);
    gate.resolve(); await failure;
    assert.deepEqual(f.plain, previous); assert.deepEqual(f.io.settings, previous);
    f.io.failWrite = undefined;
    await f.api.importSettings(patch, "plugins");
    assert.equal(f.plain.plugins.Existing.value, 2);
});

test("imports report which earlier sections committed before a later storage failure", async () => {
    const f = fixture(); f.io.failWrite = "css";
    await assert.rejects(f.api.importSettings(JSON.stringify({ settings: { themeLinks: [] }, quickCss: "new", dataStore: [] })), /after saving settings/);
    assert.deepEqual(f.io.settings.themeLinks, []);
    assert.deepEqual(f.plain.themeLinks, []);
    assert.equal(f.io.css, "body {}"); assert.equal(f.io.restored, undefined);
    f.io.failWrite = "datastore";
    await assert.rejects(f.api.importSettings(JSON.stringify({ settings: {}, quickCss: "new", dataStore: [] })), /settings and QuickCSS/);
    assert.equal(f.io.css, "new");
});

test("both backup pickers contain failures, honor cancellation and reject invalid UTF-8", async () => {
    for (const desktop of [false, true]) {
        const f = fixture(desktop);
        await f.api.uploadSettingsBackup(); assert.equal(f.io.toasts.length, 0);
        f.io.pickerError = new Error("Synthetic picker failure");
        await f.api.uploadSettingsBackup(); assert.equal(f.io.toasts.at(-1)?.type, "failure");
        f.io.pickerError = undefined;
        f.io.file = new File([new Uint8Array([0xff])], "invalid.json");
        await f.api.uploadSettingsBackup(); assert.equal(f.io.toasts.at(-1)?.type, "failure");
        assert.deepEqual(f.io.writes, []);
        f.io.file = new File(['{"quickCss":""}'], "valid.json");
        await f.api.uploadSettingsBackup("css");
        assert.equal(f.io.css, ""); assert.equal(f.io.toasts.at(-1)?.type, "success");
    }
});

test("native backup save waits for completion and contains rejected saves", async () => {
    const f = fixture(true), gate = Promise.withResolvers<void>();
    f.io.beforeSave = gate.promise; f.io.failWrite = "save";
    let settled = false;
    const saving = f.api.downloadSettingsBackup("plugins").then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false);
    gate.resolve(); await saving;
    assert.equal(f.io.saved.length, 0); assert.equal(f.io.toasts.at(-1)?.type, "failure");
    f.io.failWrite = undefined;
    await f.api.downloadSettingsBackup("plugins");
    assert.deepEqual(JSON.parse(new TextDecoder().decode(f.io.saved[0])), { settings: f.io.settings });
});
