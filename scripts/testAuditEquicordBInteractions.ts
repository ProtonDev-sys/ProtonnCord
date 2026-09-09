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

import { parseDragifyPayload, parseFromStrings } from "../src/equicordplugins/dragify/utils";

const React = {
    createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    useRef: (current: unknown) => ({ current }),
    useState: (value: unknown) => [value, () => {}]
};

function load(file: string, overrides: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const mocks: Record<string, unknown> = {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@vencord/discord-types/enums": { ChannelType: {} },
        ...overrides
    };
    const code = transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, Promise, console: { error() {} },
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, `Unexpected import: ${name}`);
            return mocks[name];
        },
        ...globals
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

test("custom color writes preserve unknown records, serialize updates and recover after failed persistence", async () => {
    let stored: Record<string, any> = { original: "000000", future: { opaque: true } };
    let fail = false;
    const api = load("src/equicordplugins/customUserColors/index.tsx", {
        "@api/DataStore": { get: async () => stored, async set(_key: string, next: typeof stored) { if (fail) throw new Error("unavailable"); stored = next; } },
        "@api/Settings": { definePluginSettings: () => ({ store: {} }), Settings: { plugins: { CustomUserColors: { enabled: true } } } },
        "@webpack": { extractAndLoadChunksLazy: () => () => Promise.resolve() },
        "@webpack/common": {}, "./SetColorModal": {}
    });
    await api.default.start();
    await Promise.all([api.updateCustomColor("one", "123456"), api.updateCustomColor("two", "abcdef")]);
    assert.equal(stored.original, "000000");
    assert.equal(stored.future.opaque, true);
    assert.equal(stored.one, "123456");
    assert.equal(stored.two, "abcdef");
    fail = true;
    await assert.rejects(api.updateCustomColor("original"), /unavailable/);
    assert.equal(api.getCustomColorString("original", true), "#000000");
    assert.equal(api.getCustomColorString("future", true), undefined, "opaque records remain stored but are not used as CSS");
    fail = false;
    await api.updateCustomColor("one");
    assert.equal(stored.one, undefined);
    const untouched = { colorString: "#ff0000", colorStrings: { primaryColor: "#ff0000", secondaryColor: "#00ff00" } };
    assert.equal(api.default.wrapMessageColorProps(untouched, {}), untouched, "users without custom colors retain the original role gradient");
    assert.equal(api.default.colorInReplyingTo({}), undefined);
});

test("black custom colors remain black and modal persistence failures leave the editor open", async () => {
    let closed = 0;
    let updates = 0;
    let toasted = 0;
    const pending = deferred<void>();
    const component = load("src/equicordplugins/customUserColors/SetColorModal.tsx", {
        "@components/Heading": {}, "@utils/margins": { Margins: {} },
        "@webpack/common": { React, useState: React.useState, showToast: () => toasted++, ColorPicker: "ColorPicker", Modal: "Modal" },
        "./index": { colors: { user: "000000" }, updateCustomColor: async (_id: string, color: string) => {
            updates++;
            assert.equal(color, "000000");
            await pending.promise;
            throw new Error("disk full");
        } }
    }).SetColorModal;
    const view = component({ id: "user", modalProps: { onClose: () => closed++ } });
    const first = view.props.actions[0].onClick();
    const second = view.props.actions[0].onClick();
    assert.equal(updates, 1, "repeated submission does not queue duplicate writes");
    pending.resolve();
    await Promise.all([first, second]);
    assert.equal(closed, 0);
    assert.equal(toasted, 1);
});

test("attachment downloads avoid collisions with generated names and release URLs even when clicking fails", async () => {
    const names: string[] = [];
    const revoked: string[] = [];
    let serial = 0;
    const plugin = load("src/equicordplugins/downloadAllAttachments/index.tsx", {
        "@components/Icons": {}, "@utils/misc": { pluralise: () => "attachments" },
        "@webpack/common": { ChannelStore: { getChannel: () => ({}) }, showToast() {}, Toasts: { Type: {} } }
    }, {
        fetch: async () => ({ ok: true, blob: async () => ({}) }),
        URL: { createObjectURL: () => `blob:${++serial}`, revokeObjectURL: (url: string) => revoked.push(url) },
        document: { createElement: () => ({ download: "", click() { names.push(this.download); if (names.length === 2) throw new Error("blocked"); } }) }
    }).default;
    const attachments = ["x.txt", "x.txt", "x_1.txt", "X.TXT"].map(filename => ({ filename, proxy_url: "mock" }));
    await plugin.messagePopoverButton.render({ attachments, channel_id: "channel" }).onClick();
    assert.equal(new Set(names.map(name => name.toLowerCase())).size, 4);
    assert.equal(revoked.length, 4);
});

test("favorite emoji drags do not remove unrelated entries when source or target disappeared", () => {
    let updater: (value: { emojis: string[]; }) => unknown;
    const plugin = load("src/equicordplugins/dragFavoriteEmotes/index.tsx", {
        "@utils/misc": {},
        "@webpack": { findByPropsLazy: () => ({}), findCssClassesLazy: () => ({}) },
        "@webpack/common": {
            useDrop: (factory: () => unknown) => factory(),
            UserSettingsActionCreators: { FrecencyUserSettingsActionCreators: { updateAsync: (_key: string, update: typeof updater) => { updater = update; } } }
        }
    }).default;
    assert.equal(plugin.drop().canDrop(), false);
    plugin.drop({ emoji: { id: "missing" }, category: "FAVORITES" }).drop({ id: "a" });
    const entries = { emojis: ["a", "b", "c"] };
    assert.equal(updater!(entries), false);
    assert.deepEqual(entries.emojis, ["a", "b", "c"]);
    plugin.drop({ emoji: { id: "b" }, category: "FAVORITES" }).drop({ id: "missing" });
    assert.equal(updater!(entries), false);
    assert.deepEqual(entries.emojis, ["a", "b", "c"]);
});

test("drag payloads reject malformed identifiers and non-string types without throwing", () => {
    const id = "123456789012345678";
    const stores = { ChannelStore: { getChannel: () => undefined }, GuildStore: { getGuild: () => undefined }, UserStore: { getUser: () => undefined } };
    for (const payload of [{ kind: "user", id: {} }, { kind: "user", id: "name" }, { kind: "channel", id, guildId: [] }]) {
        assert.equal(parseDragifyPayload(JSON.stringify(payload)), null);
    }
    assert.doesNotThrow(() => parseFromStrings([JSON.stringify({ id, type: {} })], stores));
    assert.deepEqual(parseDragifyPayload(JSON.stringify({ kind: "channel", id, guildId: "@me" })), { kind: "channel", id, guildId: "@me" });
});

test("pending drag text does not reach a different channel, account or a stopped plugin", async () => {
    let selected = "original";
    let account = "account";
    let inserted = 0;
    const plugin = load("src/equicordplugins/dragify/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/discord": { insertTextIntoChatInputBox: () => inserted++ },
        "@webpack/common": { SelectedChannelStore: { getChannelId: () => selected }, UserStore: { getCurrentUser: () => ({ id: account }) } },
        "./dragState": { clearDragState() {}, stopDragState() {} }, "./ghost": { unmountGhost() {} },
        "./invite": { clearInviteCache() {} }, "./targets": {}, "./utils": {}
    }, { window: { removeEventListener() {} } }).default;
    for (const scenario of ["channel", "account", "stop"]) {
        selected = "original";
        account = "account";
        const pending = deferred<string>();
        plugin.buildText = () => pending.promise;
        const drop = plugin.handleDropEntity({ kind: "guild", id: "guild" }, { id: "original" });
        if (scenario === "channel") selected = "other";
        if (scenario === "account") account = "other";
        if (scenario === "stop") plugin.stop();
        pending.resolve("https://example.invalid/invite");
        await drop;
    }
    assert.equal(inserted, 0);
    selected = "original";
    assert.equal(plugin.insertText("other", "content"), false);
});

test("invite cache ignores responses completed after stop and account changes", async () => {
    let account = "one";
    let gets = 0;
    const pending: ReturnType<typeof deferred<{ body: { code: string; }; }>>[] = [];
    const channel = { id: "channel", guild_id: "guild", isDM: () => false, isGroupDM: () => false, isMultiUserDM: () => false, isCategory: () => false, isThread: () => false };
    const api = load("src/equicordplugins/dragify/invite.ts", {
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) }, PermissionStore: { can: () => true }, PermissionsBits: {}, showToast() {}, Toasts: { Type: {} },
            RestAPI: {
                post: () => { const result = deferred<{ body: { code: string; }; }>(); pending.push(result); return result.promise; },
                get: async () => { gets++; return { body: [{ code: "fresh", max_uses: 0 }] }; }
            }
        }
    });
    const settings = { reuseExistingInvites: false, inviteTemporaryMembership: false };
    const stopped = api.createInvite("guild", channel, settings);
    api.clearInviteCache();
    pending[0].resolve({ body: { code: "stale" } });
    assert.equal(await stopped, null);
    assert.equal(await api.createInvite("guild", channel, { ...settings, reuseExistingInvites: true }), "https://discord.gg/fresh");
    account = "two";
    await api.createInvite("guild", channel, { ...settings, reuseExistingInvites: true });
    assert.equal(gets, 2, "the new account does not inherit a cached invite");
});
