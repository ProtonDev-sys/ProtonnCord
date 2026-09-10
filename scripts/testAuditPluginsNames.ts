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
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture() {
    const writes: { update(value: unknown): unknown; resolve(): void; reject(error: Error): void; }[] = [];
    const reads: ((value: unknown) => void)[] = [];
    let stored: any = { existing: "Fixture" };
    const store: Record<string, any> = {};
    const accessibility = { useReducedMotion: false };
    const modules: Record<string, any> = {
        "./style.css": {}, "@api/ContextMenu": {},
        "@api/index": { DataStore: {
            get: () => new Promise(resolve => reads.push(resolve)),
            update: (_key: string, update: (value: unknown) => unknown) => new Promise<void>((resolve, reject) => writes.push({ update, resolve, reject }))
        } },
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@api/Settings": { migratePluginSetting() {}, definePluginSettings: (definitions: Record<string, { default?: unknown; }>) => {
            Object.assign(store, Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, value.default])));
            return { store, use: () => store };
        } },
        "@components/Button": {}, "@components/Heading": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } },
        "@plugins/ircColors": { __esModule: true, default: {} }, "@plugins/mentionAvatars": { __esModule: true, default: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/index": { classNameFactory: () => () => "" },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { findByCodeLazy: () => (text: string) => text, findByPropsLazy: () => ({}), findComponentByCodeLazy: () => "Name" },
        "@webpack/common": { AccessibilityStore: accessibility, RelationshipStore: { getNickname: () => undefined },
            StreamerModeStore: { enabled: false }, GuildMemberStore: { getMember: () => undefined } }
    };
    const path = "src/plugins/showMeYourName/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), { fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const result = runInNewContext(code + "\n({plugin: exports.default, getProcessedNames, saveCustomNickname, nicknames: () => customNicknames});", {
        exports: {}, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; },
        getComputedStyle: () => ({ getPropertyValue: () => "#ffffff" }),
        React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) },
        document: { documentElement: {}, createElement: () => ({ style: {}, getContext: () => ({}) }) }
    });
    return { ...result, store, accessibility, writes, reads,
        save: () => { const write = writes.shift()!; stored = write.update(stored); write.resolve(); }, stored: () => stored };
}

test("ShowMeYourName formats bot discriminators without mutating the shared user record", () => {
    const f = fixture();
    const bot = Object.freeze({ id: "bot", username: "Fixture Bot", globalName: "Original display", bot: true, discriminator: "1234" });
    const result = f.getProcessedNames(bot, true, true, false, false, false);
    assert.equal(result.username, "Fixture Bot#1234");
    assert.equal(result.display, "Fixture Bot");
    assert.equal(bot.globalName, "Original display");
    f.accessibility.useReducedMotion = true;
    assert.equal(f.plugin.shouldAnimateNameEffects(true, true), false);
});

test("ShowMeYourName voice formatting follows its voice setting independently of reactions", () => {
    const f = fixture();
    const user = { id: "fixture", username: "Fixture", globalName: "Fixture" };
    f.store.reactions = false;
    f.store.voiceChannels = true;
    assert.equal(f.plugin.getTypingMemberListProfilesReactionsVoiceNameText({ user, type: "voiceChannel" }), "Fixture");
    f.store.reactions = true;
    f.store.voiceChannels = false;
    assert.equal(f.plugin.getTypingMemberListProfilesReactionsVoiceNameText({ user, type: "voiceChannel" }), null);
});

test("ShowMeYourName serializes nickname commits and retains committed state on failures", async () => {
    const f = fixture();
    const first = f.saveCustomNickname("one", "One");
    const second = f.saveCustomNickname("two", "Two");
    await setImmediate();
    assert.equal(f.writes.length, 1);
    assert.equal(f.nicknames().one, undefined);
    f.save();
    assert.equal(await first, true);
    await setImmediate();
    f.save();
    assert.equal(await second, true);
    assert.equal(f.nicknames().existing, "Fixture");
    assert.equal(f.nicknames().one, "One");
    assert.equal(f.nicknames().two, "Two");
    const failed = f.saveCustomNickname("one", "");
    await setImmediate();
    f.writes.shift()!.reject(new Error("Storage unavailable"));
    assert.equal(await failed, false);
    assert.equal(f.nicknames().one, "One");
    assert.equal(f.stored().one, "One");
});

test("ShowMeYourName rejects a startup read completed after stop", async () => {
    const f = fixture();
    const start = f.plugin.start();
    await setImmediate();
    f.plugin.stop();
    f.reads[0]({ delayed: "Delayed" });
    await start;
    assert.equal(f.nicknames().delayed, undefined);
});
