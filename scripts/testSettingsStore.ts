/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

import { SettingsStore, SYM_GET_RAW_TARGET, SYM_IS_PROXY } from "../src/shared/SettingsStore";

test("nested references stay stable and unwrap on assignment", () => {
    const settings = new SettingsStore({ first: { value: 1 }, second: { value: 2 } });
    assert.equal(settings.store.first, settings.store.first);
    assert.equal(settings.store.first[SYM_IS_PROXY], true);
    assert.equal(settings.store.first[SYM_GET_RAW_TARGET], settings.plain.first);
    settings.store.second = settings.store.first;
    assert.equal(settings.plain.second, settings.plain.first);
    assert.equal(settings.store.second, settings.store.second);
    assert.notEqual(settings.store.first, settings.store.second);
});

test("aliased objects keep independent notification paths", () => {
    const shared = { value: 0 };
    const settings = new SettingsStore({ first: shared, second: shared });
    const paths: string[] = [];
    settings.addGlobalChangeListener((_, path) => paths.push(path));
    const first = settings.store.first;
    const second = settings.store.second;
    first.value = 1;
    second.value = 2;
    first.value = 3;
    assert.deepEqual(paths, ["first.value", "second.value", "first.value"]);
    assert.equal(settings.plain.first.value, 3);
});

test("settings from another realm retain nested notifications", () => {
    const raw: { nested: { value: number; }; } = runInNewContext("({ nested: { value: 1 } })");
    const settings = new SettingsStore(raw);
    const events: string[] = [];
    settings.addGlobalChangeListener((_, path) => events.push(path));
    settings.store.nested.value = 2;
    assert.deepEqual(events, ["nested.value"]);
    assert.equal(settings.store.nested, settings.store.nested);
});

test("plugin nested writes notify the setting, exact path, and matching prefixes", () => {
    const settings = new SettingsStore({ plugins: { Fixture: { preferences: { color: "red" } } } });
    const events: unknown[] = [];
    settings.addGlobalChangeListener((_, path) => events.push(["global", path]));
    settings.addChangeListener("plugins.Fixture.preferences", value => events.push(["setting", value.color]));
    settings.addChangeListener("plugins.Fixture.preferences.color", value => events.push(["exact", value]));
    settings.addPrefixChangeListener("plugins.Fixture", (value, path) => events.push(["prefix", value, path]));
    settings.store.plugins.Fixture.preferences.color = "blue";
    assert.deepEqual(events, [
        ["global", "plugins.Fixture.preferences"], ["setting", "blue"], ["exact", "blue"],
        ["prefix", "blue", "plugins.Fixture.preferences.color"]
    ]);
});

test("no-op writes and absent deletes do not notify", () => {
    const settings = new SettingsStore<{ value: number; optional?: string; }>({ value: NaN });
    const events: string[] = [];
    settings.addGlobalChangeListener((_, path) => events.push(path));
    settings.store.value = NaN;
    delete settings.store.optional;
    assert.deepEqual(events, []);
    settings.store.optional = "present";
    delete settings.store.optional;
    assert.deepEqual(events, ["optional", "optional"]);
});

test("replacing branches and roots detaches stale references", () => {
    const settings = new SettingsStore({ nested: { value: 1 } });
    const events: string[] = [];
    settings.addGlobalChangeListener((_, path) => events.push(path));
    const original = settings.store.nested;
    settings.store.nested = { value: 2 };
    original.value = 50;
    assert.deepEqual(events, ["nested"]);
    assert.equal(settings.plain.nested.value, 2);
    const priorRoot = settings.store;
    settings.setData({ nested: { value: 3 } }, "nested.value");
    priorRoot.nested.value = 100;
    assert.equal(settings.plain.nested.value, 3);
    assert.deepEqual(events, ["nested", ""]);
});

test("truncating a settings array releases cached removed values", async () => {
    const source = new URL("../src/shared/SettingsStore.ts", import.meta.url).href;
    const fixture = `
        import assert from "node:assert/strict";
        import { SettingsStore } from ${JSON.stringify(source)};
        const settings = new SettingsStore({ items: [{ value: 1 }, { value: 2 }] });
        const retained = settings.store.items[0];
        const removed = new WeakRef(settings.store.items[1]);
        settings.store.items.length = 1;
        assert.equal(settings.store.items[0], retained);
        for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise(setImmediate);
            globalThis.gc();
            if (removed.deref() === undefined) break;
        }
        assert.equal(removed.deref(), undefined, "a surviving settings array must not retain removed child proxies");
        assert.equal(settings.store.items.length, 1);
    `;
    await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", fixture]);
});

test("readOnly prevents root replacement while allowing normal setting edits", () => {
    const settings = new SettingsStore({ value: 1 }, { readOnly: true });
    settings.store.value = 2;
    assert.equal(settings.plain.value, 2);
    assert.throws(() => settings.setData({ value: 3 }), /read-only/);
});

test("batched persisted updates notify each path once and publish the root once", () => {
    const settings = new SettingsStore({ first: 0, second: 0 });
    const events: string[] = [];
    settings.addChangeListener("first", value => events.push(`first:${value}`));
    settings.addChangeListener("second", value => events.push(`second:${value}`));
    settings.addGlobalChangeListener(() => events.push("global"));
    settings.setData({ first: 1, second: 2 }, ["first", "second", "first"]);
    assert.deepEqual(events, ["first:1", "second:2", "global"]);
});

test("lazy defaults, arrays, frozen values, and symbols remain usable", () => {
    const defaults: string[] = [];
    const data = { plugins: {} as Record<string, { values: string[]; }>, frozen: Object.freeze({ nested: Object.freeze({ value: 1 }) }) };
    const settings = new SettingsStore(data, {
        getDefaultValue({ target, key, path }) {
            if (path === "plugins") {
                defaults.push(key);
                return target[key] = { values: [] };
            }
        }
    });
    settings.store.plugins.Fixture.values.push("value");
    assert.deepEqual([...settings.store.plugins.Fixture.values], ["value"]);
    assert.equal(settings.store.plugins.Fixture.values, settings.store.plugins.Fixture.values);
    assert.deepEqual(defaults, ["Fixture"]);
    assert.equal(settings.store.frozen.nested, data.frozen.nested);
    assert.equal(JSON.stringify(settings.store), JSON.stringify(data));
});

test("removed listeners are not called by mutations or root replacement", () => {
    const settings = new SettingsStore({ nested: { value: 0 } });
    const unexpected = () => assert.fail("unsubscribed listener was called");
    settings.addGlobalChangeListener(unexpected);
    settings.addChangeListener("nested.value", unexpected);
    settings.addPrefixChangeListener("nested", unexpected);
    settings.removeGlobalChangeListener(unexpected);
    settings.removeChangeListener("nested.value", unexpected);
    settings.removePrefixChangeListener("nested", unexpected);
    settings.store.nested.value = 1;
    settings.setData({ nested: { value: 2 } }, "nested.value");
});

test("failed settings listeners cannot block persistence, exact paths, prefixes or later root updates", async t => {
    const errors = t.mock.method(console, "error", () => { });
    const settings = new SettingsStore({ plugins: { Fixture: { options: { value: 0 } } } });
    const events: string[] = [];
    const fail = () => { throw new Error("listener failed"); };
    settings.addGlobalChangeListener(fail);
    settings.addGlobalChangeListener(() => events.push("persist"));
    settings.addChangeListener("plugins.Fixture.options", fail);
    settings.addChangeListener("plugins.Fixture.options", () => events.push("setting"));
    settings.addChangeListener("plugins.Fixture.options.value", async () => { throw new Error("async listener failed"); });
    settings.addChangeListener("plugins.Fixture.options.value", () => events.push("exact"));
    settings.addPrefixChangeListener("plugins.Fixture", fail);
    settings.addPrefixChangeListener("plugins.Fixture", () => events.push("prefix"));
    assert.doesNotThrow(() => { settings.store.plugins.Fixture.options.value = 1; });
    assert.deepEqual(events, ["persist", "setting", "exact", "prefix"]);
    events.length = 0;
    assert.doesNotThrow(() => settings.setData({ plugins: { Fixture: { options: { value: 2 } } } }, "plugins.Fixture.options.value"));
    assert.deepEqual(events, ["exact", "prefix", "persist"]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(errors.mock.callCount(), 7);
});
