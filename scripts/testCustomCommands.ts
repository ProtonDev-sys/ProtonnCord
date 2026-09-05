/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { SettingsStore } from "../src/shared/SettingsStore";

type Tag = { name: string; message: string; };

function loadTags() {
    const store = new SettingsStore({ plugins: { CustomCommands: { tagsList: {} as Record<string, Tag> } } });
    const errors: unknown[][] = [];
    const sent: unknown[] = [], local: unknown[] = [], dispatched: unknown[] = [];
    const state = { reply: undefined as object | undefined, send: async () => {}, failName: "" };
    const settings = { get store() { return store.store.plugins.CustomCommands; } };
    const mocks: Record<string, object> = {
        "@api/Settings": { SettingsStore: store, definePluginSettings: () => settings, migratePluginSettings() {} },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, OptionType: {} },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/text": { makeCodeblock: (text: string) => text },
        "@utils/discord": { async sendMessage(...args: unknown[]) { sent.push(args); await state.send(); } },
        "@vencord/discord-types/enums": { ApplicationCommandInputType: { BUILT_IN: 1 }, ApplicationCommandOptionType: { STRING: 3, BOOLEAN: 5, SUB_COMMAND: 1 }, ApplicationCommandType: { CHAT_INPUT: 1 } },
        "@webpack/common": {
            FluxDispatcher: { dispatch(action: unknown) { dispatched.push(action); } },
            PendingReplyStore: { getPendingReply: () => state.reply },
            MessageActions: { getSendMessageOptionsForReply: (reply: unknown) => ({ reply }) }
        }
    };
    const cache = new Map<string, { exports: Record<string, unknown>; }>();
    function load<T extends object>(file: string): T {
        file = path.resolve(file);
        const existing = cache.get(file);
        if (existing) return existing.exports as T;
        const module = { exports: {} };
        cache.set(file, module);
        const code = transpileModule(readFileSync(file, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText;
        runInNewContext(code, {
            module, exports: module.exports, console,
            require(name: string) {
                if (name in mocks) return mocks[name];
                if (name.endsWith(".css")) return {};
                if (name === "@api/Commands") return load("src/api/Commands/index.ts");
                if (name === "./CreateTagModal") return { openCreateTagModal() {} };
                if (name === "./SettingsTagList") return { SettingsTagList() {} };
                if (name === "./commandHelpers") return {
                    findOption: (args: { name: string; value: unknown; }[], name: string, fallback: unknown) => args.find(arg => arg.name === name)?.value ?? fallback,
                    sendBotMessage: (...args: unknown[]) => local.push(args)
                };
                assert.ok(name.startsWith("."), name);
                return load(path.resolve(path.dirname(file), name === "." ? "index.ts" : name + ".ts"));
            }
        });
        return module.exports as T;
    }
    const api = load<typeof import("../src/api/Commands")>("src/api/Commands/index.ts");
    Reflect.apply(api._init, undefined, [[
        { name: "shrug", displayName: "shrug", id: "-1", options: [{}] },
        { name: "me", displayName: "me", id: "-2", options: [{}] },
        { name: "native", id: "-3" }
    ]]);
    const register = api.registerCommand;
    api.registerCommand = (command, owner) => {
        if (command.name === state.failName) { state.failName = ""; throw new Error("Registration failed"); }
        return register(command, owner);
    };
    const plugin = load<typeof import("../src/plugins/customCommands")>("src/plugins/customCommands/index.ts");
    const tags = load<typeof import("../src/plugins/customCommands/settings")>("src/plugins/customCommands/settings.ts");
    const command = (name: string) => api.commands[name];
    const execute = (name: string, args: { name: string; value: unknown; }[] = []) => Reflect.apply(command(name).execute, undefined, [args, { channel: { id: "fixture" } }]) as Promise<void>;
    return { api, plugin, tags, command, execute, state, store, errors, sent, local, dispatched };
}

test("tag arguments normalize once, preserve equals defaults and require every unfilled occurrence", async () => {
    const { plugin, tags, command, execute, local } = loadTags();
    const message = "{{Mood = a=b}} {{USER = guest}} {{user}} {{User}} {{ = ignored}}";
    assert.equal(JSON.stringify(plugin.parseTagArguments(message)), JSON.stringify([
        { name: "mood", defaultValue: "a=b" }, { name: "user", defaultValue: null }
    ]));
    plugin.default.start();
    tags.addTag({ name: "greet", message });
    assert.equal(JSON.stringify(command("greet").options?.map(option => [option.name, option.required])), JSON.stringify([["user", true], ["mood", false], ["ephemeral", false]]));
    await execute("greet", [{ name: "user", value: "Clyde" }, { name: "ephemeral", value: true }]);
    assert.equal(JSON.stringify(local), JSON.stringify([["fixture", { content: "a=b Clyde Clyde Clyde {{ = ignored}}" }]]));
    plugin.default.stop();
});

test("tag edits stay inactive until start and stop cleans the actual owned registry", () => {
    const { plugin, tags, api, store } = loadTags();
    tags.addTag({ name: "greet", message: "Hello" });
    assert.equal(Object.hasOwn(api.commands, "greet"), false);
    plugin.default.start();
    assert.ok(api.commands.greet);
    const first = api.commands.greet;
    plugin.default.start();
    assert.equal(api.commands.greet, first);
    store.setData({ plugins: { CustomCommands: { tagsList: {} } } });
    assert.equal(Object.hasOwn(api.commands, "greet"), false);
    tags.addTag({ name: "next", message: "Next" });
    plugin.default.stop();
    assert.equal(Object.hasOwn(api.commands, "next"), false);
    tags.addTag({ name: "later", message: "Later" });
    assert.equal(Object.hasOwn(api.commands, "later"), false);
});

test("tag updates reject foreign and reserved names without changing settings or commands", () => {
    const { plugin, tags, api } = loadTags();
    plugin.default.start();
    api.registerCommand({ name: "foreign", description: "Foreign", execute() {} }, "OtherPlugin");
    const foreign = api.commands.foreign;
    for (const name of ["foreign", "native", "tags", "tags create", "constructor", "__proto__", " spaced "])
        assert.throws(() => tags.addTag({ name, message: "Hello" }));
    assert.throws(() => tags.addTag({ name: "valid", message: "{{Ephemeral}}" }), /reserved/);
    assert.equal(tags.getTags().length, 0);
    assert.equal(tags.getTag("constructor"), undefined);
    assert.equal(api.commands.foreign, foreign);
    assert.ok(api.BUILT_IN.some(command => command.name === "native"));
    plugin.default.stop();
    assert.equal(api.commands.foreign, foreign);
});

test("failed tag edits and renames preserve the previous setting and registered command", () => {
    const { plugin, tags, api, state } = loadTags();
    plugin.default.start();
    tags.addTag({ name: "greet", message: "Original" });
    const previous = api.commands.greet;
    state.failName = "greet";
    assert.throws(() => tags.addTag({ name: "greet", message: "Changed" }), /Registration failed/);
    assert.equal(api.commands.greet, previous);
    assert.equal(tags.getTag("greet")?.message, "Original");
    state.failName = "renamed";
    assert.throws(() => tags.addTag({ name: "renamed", message: "Changed" }, "greet"), /Registration failed/);
    assert.equal(api.commands.greet, previous);
    assert.equal(tags.getTag("greet")?.message, "Original");
    assert.equal(Object.hasOwn(api.commands, "renamed"), false);
    tags.addTag({ name: "renamed", message: "Changed" }, "greet");
    assert.equal(Object.hasOwn(api.commands, "greet"), false);
    assert.equal(tags.getTag("greet"), undefined);
    assert.ok(api.commands.renamed);
    plugin.default.stop();
});

test("imported and nested tag changes synchronize without deleting foreign replacements", () => {
    const { plugin, tags, api, store, errors } = loadTags();
    plugin.default.start();
    tags.addTag({ name: "greet", message: "Original" });
    store.store.plugins.CustomCommands.tagsList.greet.message = "Updated";
    const updated = api.commands.greet;
    assert.ok(updated);
    store.markAsChanged();
    assert.equal(api.commands.greet, updated);
    api.unregisterCommand("greet");
    api.registerCommand({ name: "greet", description: "Replacement", execute() {} }, "OtherPlugin");
    const foreign = api.commands.greet;
    tags.removeTag("greet");
    assert.equal(api.commands.greet, foreign);
    store.setData({ plugins: { CustomCommands: { tagsList: { valid: { name: "valid", message: "Imported" }, invalid: { name: "mismatch", message: "Ignored" } } } } });
    assert.ok(api.commands.valid);
    assert.equal(Object.hasOwn(api.commands, "mismatch"), false);
    assert.equal(tags.getTags(null).length, 0);
    assert.equal(tags.getTags([]).length, 0);
    assert.equal(errors.length, 0, errors.map(args => args.map(String).join(" ")).join("; "));
    plugin.default.stop();
    assert.equal(api.commands.greet, foreign);
    assert.equal(Object.hasOwn(api.commands, "valid"), false);
});

test("local tag previews and rejected sends preserve replies, and late sends preserve replacement replies", async () => {
    const { plugin, tags, execute, state, sent, local, dispatched } = loadTags();
    plugin.default.start();
    tags.addTag({ name: "greet", message: "Hello" });
    state.reply = { id: "original" };
    await execute("greet", [{ name: "ephemeral", value: true }]);
    assert.equal(local.length, 1);
    assert.equal(sent.length, 0);
    assert.equal(dispatched.length, 0);
    state.send = async () => { throw new Error("Send rejected"); };
    await assert.rejects(execute("greet"), /Send rejected/);
    assert.equal(dispatched.length, 0);
    let finish: (() => void) | undefined;
    state.send = () => new Promise<void>(resolve => { finish = resolve; });
    const pending = execute("greet");
    state.reply = { id: "replacement" };
    finish?.();
    await pending;
    assert.equal(dispatched.length, 0);
    state.send = async () => {};
    await execute("greet");
    assert.equal(dispatched.length, 1);
    plugin.default.stop();
});


test("obsolete tag commands and stopped send completions do not act on the current UI", async () => {
    const { plugin, tags, api, execute, state, sent, local, dispatched } = loadTags();
    plugin.default.start();
    tags.addTag({ name: "greet", message: "Original" });
    const old = api.commands.greet;
    tags.addTag({ name: "greet", message: "Updated" });
    await Reflect.apply(old.execute, undefined, [[], { channel: { id: "fixture" } }]);
    assert.equal(sent.length, 0);
    state.reply = { id: "reply" };
    let finish: (() => void) | undefined;
    state.send = () => new Promise<void>(resolve => { finish = resolve; });
    const pending = execute("greet");
    const stopped = api.commands.greet;
    plugin.default.stop();
    finish?.();
    await pending;
    assert.equal(dispatched.length, 0);
    await Reflect.apply(stopped.execute, undefined, [[{ name: "ephemeral", value: true }], { channel: { id: "fixture" } }]);
    assert.equal(local.length, 0);
});
