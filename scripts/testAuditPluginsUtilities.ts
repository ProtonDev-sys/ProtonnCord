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

function loadPlugin(path: string, mocks: Record<string, object> = {}, globals: Record<string, unknown> = {}) {
    const modules = {
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: { SELECT: "select" } },
        "@utils/constants": { Devs: {} },
        ...mocks
    };
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports.default;", {
        exports: {}, ...globals, require: (name: string) => modules[name]
    });
}

test("avatar theme URLs change only the size query parameter and remain valid CSS strings", () => {
    const plugin = loadPlugin("src/plugins/themeAttributes/index.ts", {
        "@utils/Logger": { Logger: class { error() {} } }, "@webpack/common": {}
    }, { URL, document: { baseURI: "https://discord.com/channels/@me" } });
    const styles = plugin.getAvatarStyles("https://cdn.example.test/avatar123?format=webp&quality=80");
    assert.equal(styles["--avatar-url-128"], 'url("https://cdn.example.test/avatar123?format=webp&quality=80&size=128")');
    assert.equal(Object.keys(plugin.getAvatarStyles("data:image/png;base64,fixture")).length, 0);
    assert.equal(Object.keys(plugin.getAvatarStyles(null)).length, 0);
});

test("streamer mode restores the preceding state and matches the exact stream owner", () => {
    for (const initial of [false, true]) {
        const store = { enabled: initial };
        const events: any[] = [];
        const plugin = loadPlugin("src/plugins/streamerModeOnStream/index.ts", { "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "123" }) }, StreamerModeStore: store,
            FluxDispatcher: { dispatch: (event: any) => { events.push(event); store.enabled = event.value; } }
        } });
        plugin.flux.STREAM_CREATE({ streamKey: "guild:channel:9123" });
        assert.equal(events.length, 0);
        plugin.flux.STREAM_CREATE({ streamKey: "guild:channel:123" });
        assert.equal(store.enabled, true);
        plugin.flux.STREAM_CREATE({ streamKey: "guild:other:123" });
        plugin.flux.STREAM_DELETE({ streamKey: "guild:channel:123" });
        assert.equal(store.enabled, true);
        plugin.flux.STREAM_DELETE({ streamKey: "guild:other:123" });
        assert.equal(store.enabled, initial);
    }
});

test("friend sort preserves host text and ordering when receipt dates are unavailable", () => {
    const plugin = loadPlugin("src/plugins/sortFriendRequests/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({}), migratePluginSettings() {} },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/css": { classNameFactory: () => () => "" },
        "@webpack/common": { RelationshipStore: { getSince: () => undefined } }
    });
    assert.equal(plugin.wrapSort(() => "host-order", { type: 3, user: { id: "fixture" } }), "host-order");
    assert.equal(plugin.makeSubtext({ id: "fixture" }, "host-text"), "host-text");
});

test("GIF alt text tolerates missing sources and retains provided descriptions", () => {
    const plugin = loadPlugin("src/plugins/betterGifAltText/index.ts");
    assert.equal(plugin.altify({}), "GIF");
    assert.equal(plugin.altify({ src: 123 }), "GIF");
    assert.equal(plugin.altify({ alt: "A dancing cat", src: "cat.gif" }), "A dancing cat");
    assert.equal(plugin.altify({ contentType: "image/png", alt: "PNG" }), "PNG");
});

test("role message colors reject invalid imported intensity and preserve zero and full color", () => {
    let saturation = 30;
    const plugin = loadPlugin("src/plugins/roleColorEverywhere/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ use: () => ({ messageSaturation: saturation }) }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } },
        "@equicordplugins/customUserColors": {},
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {}, makeRange: () => [] },
        "@webpack": { findByCodeLazy: () => () => ({ colorString: "#abcdef" }) },
        "@webpack/common": {}
    });
    for (const value of [NaN, Infinity, -1, 101]) {
        saturation = value;
        assert.match(plugin.useMessageColorsStyle({}).color, /#abcdef 30%/);
    }
    saturation = 100;
    assert.match(plugin.useMessageColorsStyle({}).color, /#abcdef 100%/);
    saturation = 0;
    assert.equal(plugin.useMessageColorsStyle({}), null);
    saturation = 30;
    assert.equal(plugin.useMessageColorsStyle({ state: "SEND_FAILED" }), undefined);
});

test("timestamp shortcuts preserve tomorrow's local clock time and malformed input", () => {
    const now = new Date(2026, 2, 28, 20, 0, 0).getTime();
    class FixtureDate extends Date {
        constructor(value?: string | number) { super(value === undefined ? now : value); }
        static now() { return now; }
    }
    const plugin = loadPlugin("src/plugins/sendTimestamps/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { replaceMessageContents: true } }) },
        "@api/ChatButtons": {}, "@components/Heading": {}, "@components/Paragraph": {},
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {},
        "@utils/margins": {}, "@webpack/common": {}, "./styles.css": {}
    }, { Date: FixtureDate });
    const expected = new Date(2026, 2, 29, 9, 0, 0).getTime() / 1000;
    const message = { content: "Meet at `9:00` or `99:99`." };
    plugin.onBeforeMessageSend(null, message);
    assert.equal(message.content, `Meet at <t:${expected}:t> or \`99:99\`.`);
});

test("GIF alt text excludes URL parameters and strips only a GIF extension", () => {
    const plugin = loadPlugin("src/plugins/betterGifAltText/index.ts");
    assert.equal(plugin.altify({ src: "https://example.test/cat-wave12.GIF?width=100#preview" }), "GIF - cat wave");
    assert.equal(plugin.altify({ src: "https://example.test/notgif" }), "GIF - notgif");
    assert.equal(plugin.altify({ src: "https://example.test/hello%20world.gif" }), "GIF - hello world");
    assert.equal(plugin.altify({ src: "https://example.test/bad%ZZ.gif" }), "GIF - bad%ZZ");
});

test("AutoDND restores a playing session but discards restoration state when stopped", async () => {
    const listeners = new Set<() => void>();
    let status = "online";
    const statusSettings = {
        getSetting: () => status,
        updateSetting: async (next: string) => { status = next; for (const notify of listeners) notify(); }
    };
    const plugin = loadPlugin("src/plugins/autoDndWhilePlaying.discordDesktop/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: { statusToSet: "dnd" } }) },
        "@api/UserSettings": { getUserSettingLazy: () => statusSettings },
        "@webpack/common": { UserSettingsProtoStore: {
            addChangeListener: (listener: () => void) => listeners.add(listener),
            removeChangeListener: (listener: () => void) => listeners.delete(listener)
        } }
    });
    plugin.start();
    await plugin.flux.RUNNING_GAMES_CHANGE({ games: [{}] });
    assert.equal(status, "dnd");
    await plugin.flux.RUNNING_GAMES_CHANGE({ games: [] });
    assert.equal(status, "online");
    await plugin.flux.RUNNING_GAMES_CHANGE({ games: [{}] });
    plugin.stop();
    assert.equal(listeners.size, 0);
    status = "idle";
    plugin.start();
    await plugin.flux.RUNNING_GAMES_CHANGE({ games: [] });
    assert.equal(status, "idle");
    await plugin.flux.RUNNING_GAMES_CHANGE({ games: [{}] });
    await statusSettings.updateSetting("invisible");
    await plugin.flux.RUNNING_GAMES_CHANGE({ games: [] });
    assert.equal(status, "invisible");
    plugin.stop();
});

test("NSFW blur uses its default for invalid imported values and stops style updates after disable", () => {
    const style = { textContent: "", removed: false, remove() { this.removed = true; } };
    let definitions: Record<string, { default: unknown; onChange(): void; isValid(value: unknown): boolean; }>;
    const store = { blurAmount: 4 as unknown };
    const plugin = loadPlugin("src/plugins/blurNsfw/index.ts", {
        "@api/Settings": { definePluginSettings: (def: typeof definitions) => {
            definitions = def;
            return { def, store };
        } },
        "@api/Styles": {},
        "@utils/css": { createAndAppendStyle: () => style }
    });
    plugin.start();
    assert.match(style.textContent, /blur\(4px\)/);
    for (const value of [Infinity, -Infinity, NaN, -1, "20", null, undefined]) {
        store.blurAmount = value;
        definitions!.blurAmount.onChange();
        assert.equal(definitions!.blurAmount.isValid(value), false);
        assert.match(style.textContent, /blur\(10px\)/);
    }
    store.blurAmount = 0;
    definitions!.blurAmount.onChange();
    assert.match(style.textContent, /blur\(0px\)/);
    const lastStyle = style.textContent;
    plugin.stop();
    store.blurAmount = 7;
    definitions!.blurAmount.onChange();
    assert.equal(style.removed, true);
    assert.equal(style.textContent, lastStyle);
});

test("crash recovery continues when storage throws or rejects and observes updater failures", async () => {
    for (const synchronous of [false, true]) {
        const errors: unknown[] = [];
        const timers: (() => void)[] = [];
        let states = 0;
        const plugin = loadPlugin("src/plugins/crashHandler/index.ts", {
            "@api/index": { DataStore: { del: () => {
                if (synchronous) throw new Error("storage unavailable");
                return Promise.reject(new Error("storage unavailable"));
            } } },
            "@api/Notifications": {},
            "@api/Settings": { definePluginSettings: () => ({ store: { attemptToPreventCrashes: false } }) },
            "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
            "@utils/updater": { maybePromptToUpdate: () => Promise.reject(new Error("offline")) },
            "@webpack": { findByPropsLazy: () => ({}) },
            "@webpack/common": {}
        }, {
            IS_DEV: false,
            setTimeout: (callback: () => void, delay: number) => { if (delay === 1) timers.push(callback); },
            setImmediate: (callback: () => void) => callback()
        });
        plugin.handleCrash({ setState: () => states++ }, {});
        assert.equal(states, 1);
        assert.equal(timers.length, 1);
        timers[0]();
        await setImmediate();
        assert.equal(errors.length, 2);
    }
});

test("CustomIdle retains disabled and long timeouts while rejecting invalid imports", () => {
    let definitions: Record<string, { default: unknown; isValid(value: unknown): boolean; }>;
    const store = { idleTimeout: 0 as unknown };
    const plugin = loadPlugin("src/plugins/customIdle/index.ts", {
        "@api/Settings": { definePluginSettings: (def: typeof definitions) => {
            definitions = def;
            return { def, store };
        } },
        "@api/Notices": {}, "@webpack/common": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {}, makeRange: () => [] }
    });
    assert.equal(plugin.getIdleTimeout(), Infinity);
    store.idleTimeout = 120;
    assert.equal(plugin.getIdleTimeout(), 7_200_000);
    for (const value of [Infinity, -Infinity, NaN, -1, "0", null, undefined]) {
        store.idleTimeout = value;
        assert.equal(definitions!.idleTimeout.isValid(value), false);
        assert.equal(plugin.getIdleTimeout(), 600_000);
    }
});

test("AutoMod notification exceptions use the actual suppression flag", () => {
    const plugin = loadPlugin("src/plugins/noBlockedMessages/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: { allowAutoModMessages: true, disableNotifications: true } }), migratePluginSetting() {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/Logger": {}, "@equicordplugins/blockKeywords": {}, "@webpack/common": {}
    });
    plugin.isReplyToSuppressed = () => ({ suppressed: false, hide: false });
    plugin.isSuppressed = () => ({ suppressed: false, hide: false });
    assert.equal(plugin.disableNotification({ type: 24 }), false);
    plugin.isSuppressed = () => ({ suppressed: true, hide: true });
    assert.equal(plugin.disableNotification({ type: 24 }), true);
});

test("reply mention lists match whole IDs and observe changed user and role lists", () => {
    const store = { userList: "123456789012345678", roleList: "223456789012345678", shouldPingListed: true, inverseShiftReply: false };
    const plugin = loadPlugin("src/plugins/noReplyMention/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@webpack/common": { ChannelStore: { getChannel: () => ({ guild_id: "guild" }) },
            GuildMemberStore: { getMember: () => ({ roles: ["22345678901234567"] }) } }
    });
    const message = { author: { id: "12345678901234567" }, channel_id: "channel" };
    assert.equal(plugin.shouldMention(message, false), false);
    store.userList += "\n12345678901234567, other";
    assert.equal(plugin.shouldMention(message, false), true);
    assert.equal(plugin.shouldMention(message, true), false);
    store.userList = "";
    store.roleList = "other, 22345678901234567";
    assert.equal(plugin.shouldMention(message, false), true);
    store.roleList = "";
    assert.equal(plugin.shouldMention(message, false), false);
});

test("notification volume and quick reaction grids normalize invalid numeric imports", () => {
    const store = { notificationVolume: 0 as unknown, rows: 2 as unknown, columns: 4 as unknown, reactionCount: 5 as unknown };
    const mocks = {
        "@api/Settings": { definePluginSettings: () => ({ store }), migratePluginSettings() {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {}, makeRange: () => [] }
    };
    const volume = loadPlugin("src/plugins/notificationVolume/index.ts", mocks);
    const reactions = loadPlugin("src/plugins/moreQuickReactions/index.ts", mocks);
    assert.equal(volume.notificationVolume, 0);
    for (const value of [NaN, Infinity, -Infinity, "20", null, undefined]) {
        store.notificationVolume = store.rows = store.columns = store.reactionCount = value;
        assert.equal(volume.notificationVolume, 100);
        assert.equal(reactions.getMaxQuickReactions(), 8);
        assert.equal(reactions.reactionCount, 5);
    }
    store.notificationVolume = 150;
    store.rows = 100;
    store.columns = 100;
    store.reactionCount = 0;
    assert.equal(volume.notificationVolume, 100);
    assert.equal(reactions.getMaxQuickReactions(), 192);
    assert.equal(reactions.reactionCount, 0);
});

test("ReactErrorDecoder discards stopped loads and validates fetched message templates", async () => {
    const requests: ((value: unknown) => void)[] = [];
    const plugin = loadPlugin("src/plugins/reactErrorDecoder/index.ts", {
        "@webpack/common": { React: { version: "fixture" } }
    }, {
        AbortSignal: { timeout: (ms: number) => { assert.equal(ms, 10000); return {}; } },
        fetch: () => new Promise(resolve => requests.push(resolve)), console: { error() {} }
    });
    const old = plugin.start();
    plugin.stop();
    requests.shift()!({ ok: true, json: async () => ({ 1: "Old %s" }) });
    await old;
    assert.equal(plugin.decodeError(1, "value"), undefined);
    const current = plugin.start();
    requests.shift()!({ ok: true, json: async () => ({ 1: "Current %s", 2: 123 }) });
    await current;
    assert.equal(plugin.decodeError(1, "value"), "Current value");
    assert.equal(plugin.decodeError(2), undefined);
});
