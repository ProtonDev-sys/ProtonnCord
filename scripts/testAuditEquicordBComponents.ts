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

const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };

function load(file: string, overrides: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const mocks: Record<string, unknown> = {
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, StartAt: { WebpackReady: "WebpackReady" } },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        ...overrides
    };
    const code = transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, Promise, console, structuredClone,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, `Unexpected import: ${name}`);
            return mocks[name];
        },
        ...globals
    });
}

test("BetterActivities ignores pre-stop application responses after a restart", async () => {
    const pending: ((application: object) => void)[] = [];
    const api = load("src/equicordplugins/betterActivities/utils.tsx", {
        "@webpack": {
            findByPropsLazy: () => ({ fetchApplication: () => new Promise(resolve => pending.push(resolve)) }),
            findComponentByCodeLazy: () => "activity"
        },
        "@webpack/common": { ApplicationStore: { getApplication: () => undefined } },
        "./settings": { settings: { store: { renderGifs: true } } }
    });
    const activity = { application_id: "app" };
    api.getApplicationIcons([activity]);
    api.getApplicationIcons([activity]);
    assert.equal(pending.length, 1, "concurrent rendering shares the pending request");
    api.clearFetchedApplications();
    api.getApplicationIcons([activity]);
    const current = { id: "app", name: "Current", icon: "current" };
    pending[1](current);
    await Promise.resolve();
    pending[0]({ id: "app", name: "Stale", icon: "stale" });
    await Promise.resolve();
    assert.equal(api.getActivityApplication(activity), current);
    api.clearFetchedApplications();
    assert.equal(api.getActivityApplication(activity), undefined);
});

test("AutoCodeblockLanguage observes detector load failures without preventing stop cleanup", async () => {
    const errors: unknown[] = [];
    const highlighter = () => null;
    const shiki = { renderHighlighter: highlighter, name: "ShikiCodeblocks" };
    const plugin = load("src/equicordplugins/autoCodeblockLanguage.desktop/index.ts", {
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@plugins/shikiCodeblocks.desktop": { __esModule: true, default: shiki },
        "@plugins/shikiCodeblocks.desktop/utils/misc": { requireHljs: () => Promise.reject(new Error("offline")) },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    }).default;
    plugin.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.notEqual(shiki.renderHighlighter, highlighter);
    plugin.stop();
    assert.equal(typeof shiki.renderHighlighter, "function");
});

test("blocked-user queries with zero matches render an empty result while untouched lists retain their rows", () => {
    const users = { one: { username: "Alice" }, two: { username: "Bob", globalName: "Robert" } };
    const plugin = load("src/equicordplugins/betterBlockedUsers/index.tsx", {
        "@utils/discord": {},
        "@webpack/common": { React, RelationshipStore: { getBlockedIDs: () => Object.keys(users) }, UserStore: { getUser: (id: string) => users[id] } }
    }).default;
    assert.deepEqual(Array.from(plugin.getFilteredUsers("robert")), ["two"]);
    const empty = plugin.getFilteredUsers("missing");
    assert.equal(empty.length, 0);
    const replacement = plugin.patches[0].replacement[3].replace.replace("$1", "rows");
    assert.equal(runInNewContext(replacement, { searchResults: empty, rows: ["one", "two"] }), empty);
    const untouched = ["one", "two"];
    assert.equal(runInNewContext(replacement, { searchResults: null, rows: untouched }), untouched);
});

test("unavailable public server previews surface a failure toast instead of an unhandled rejection", async () => {
    const toasts: string[] = [];
    const plugin = load("src/equicordplugins/betterInvites/index.tsx", {
        "@components/Icons": {}, "@utils/discord": {}, "@utils/misc": {},
        "@webpack": { findCssClassesLazy: () => ({}), findByPropsLazy: () => ({ joinGuild: () => Promise.reject(new Error("unavailable")), transitionToGuildSync() { assert.fail("preview did not join"); } }) },
        "@webpack/common": { showToast: (message: string) => toasts.push(message), Toasts: { Type: { FAILURE: "failure" } } }
    }).default;
    assert.equal(plugin.Lurkable({ features: new Set() }), null);
    await assert.doesNotReject(plugin.Lurkable({ id: "public", features: new Set(["DISCOVERABLE"]) })());
    assert.deepEqual(toasts, ["This server preview is currently unavailable."]);
});

test("channel badges resolve rules from the channel's own guild", () => {
    const lookedUp: string[] = [];
    const plugin = load("src/equicordplugins/channelBadges/index.tsx", {
        "@webpack/common": { React, GuildStore: { getGuild(id: string) { lookedUp.push(id); return { rulesChannelId: "rules" }; } } },
        "./settings": { isEnabled: () => true, returnChannelBadge: (id: number) => ({ css: String(id), label: String(id) }), settings: { store: { oneBadgePerChannel: false } } }
    }).default;
    const result = plugin.renderChannelBadges({ id: "rules", guild_id: "channel-guild", type: 0, isPrivate: () => false, isArchivedThread: () => false, isNSFW: () => false });
    assert.deepEqual(lookedUp, ["channel-guild"]);
    assert.ok(result.props.children[0].some(badge => badge.props.title === "This channel is the server rules channel."));
});

test("the Discord audio shim observes restart, persistent update, preload and play failures", async () => {
    const errors: unknown[] = [];
    const plugin = load("src/equicordplugins/_api/audioPlayer.ts", {
        "@api/AudioPlayer": {
            AudioType: { DISCORD: "discord" }, audioProcessorFunctions: {}, identifyAudioType: () => "discord", playAudio() {},
            handleAudioError: (_player: unknown, error: unknown) => errors.push(error)
        }
    }).default;
    const failure = new Error("audio unavailable");
    const player = {
        persistent: true, preload: true, _audio: null as Promise<unknown> | null,
        ensureAudio: () => Promise.reject(failure), destroyAudio() {},
        preprocessDataCurrent: { audio: "same", volume: 0.5, speed: 1 },
        preprocessDataOriginal: { audio: "same", volume: 0.25, speed: 2 }
    };
    plugin.stopAudio(player, true);
    plugin.handlePlayPromise(player, Promise.reject(failure));
    player._audio = Promise.reject(failure);
    plugin.stopAudio(player);
    plugin.processAudio(player);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 5, "restart, play, stop, volume and speed failures are observed");
    const beforeBuild = errors.length;
    player._audio = null;
    plugin.buildPlayer(player, { persistent: true, preload: true }, "fresh", null, 1, "default");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, beforeBuild + 2, "persistent initialization and explicit preload failures are observed");
});

test("local blocking filters activity cards without removing members from shared Discord data", () => {
    const store = { hideVc: true, hideBlockedUsers: true };
    const plugin = load("src/equicordplugins/clientSideBlock/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/Paragraph": {},
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack/common": {
            React: { ...React, cloneElement: (card: any, props: object) => ({ ...card, props: { ...card.props, ...props } }) },
            RelationshipStore: { isBlocked: (id: string) => id === "blocked" }
        }
    }).default;
    const voiceChannel = Object.freeze({ members: Object.freeze([{ id: "blocked" }, { id: "visible" }]) });
    const party = Object.freeze({ voiceChannels: Object.freeze([voiceChannel]), applicationStreams: [], priorityMembers: [], partiedMembers: [] });
    const card = Object.freeze({ key: "channel-voice", props: Object.freeze({ party }) });
    const filtered = plugin.activeNowView([card]);
    assert.equal(filtered.length, 1);
    assert.notEqual(filtered[0], card);
    assert.deepEqual(Array.from(filtered[0].props.party.voiceChannels[0].members, (member: any) => member.id), ["visible"]);
    assert.equal(party.voiceChannels[0].members.length, 2, "source data remains available when filtering is disabled");
    store.hideVc = false;
    assert.equal(plugin.activeNowView([card])[0], card);
});

test("CollapsibleUI retains cleanup after partial starts, avoids duplicate providers and ends drags on blur", () => {
    const settingsModule = load("src/equicordplugins/collapsibleUi/settings.ts", {
        "@utils/types": { OptionType: {} },
        "@api/Settings": { definePluginSettings(definitions: Record<string, { default: unknown; }>) {
            const store = Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [key, definition.default]));
            return { store, plain: store };
        } }
    });
    const providers = new Map<string, () => any>();
    const listeners = new Map<string, (event?: any) => void>();
    let fail = true;
    let cancelledFrames = 0;
    const events = (prefix: string) => ({
        addEventListener: (name: string, handler: () => void) => listeners.set(prefix + name, handler),
        removeEventListener: (name: string) => listeners.delete(prefix + name)
    });
    const plugin = load("src/equicordplugins/collapsibleUi/index.tsx", {
        "@api/HeaderBar": {},
        "@api/SurfaceClasses": {
            notifySurfaceClassesChanged() {},
            addSurfacePropsProvider(surface: string, provider: () => any) {
                if (fail && surface === "membersList") throw new Error("registration failed");
                assert.equal(providers.has(surface), false, "providers do not accumulate across starts");
                providers.set(surface, provider);
                return () => providers.delete(surface);
            }
        },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } },
        "@utils/misc": {}, "@webpack/common": {}, "./settings": settingsModule, "./style.css?managed": {}
    }, {
        document: events("document:"), window: { ...events("window:"), innerWidth: 1000, innerHeight: 800 },
        requestAnimationFrame: () => 1, cancelAnimationFrame: () => cancelledFrames++
    }).default;
    const previousWrapper = React.createElement("protected-chat-buttons", {}, "button");
    const wrapped = plugin.chatBarButtonWrapper.wrapper(previousWrapper);
    assert.equal(wrapped.props.buttons, previousWrapper, "earlier wrappers remain intact inside the collapsible row");
    assert.equal(plugin.chatBarButtonWrapper.wrapper(null), null);
    assert.throws(() => plugin.start(), /registration failed/);
    assert.equal(providers.size, 2);
    plugin.stop();
    assert.equal(providers.size, 0);
    fail = false;
    plugin.start();
    plugin.start();
    assert.equal(providers.size, 8);
    settingsModule.settings.store.detachUserArea = true;
    const userArea = providers.get("userArea")!();
    userArea.onMouseDownCapture({ button: 0, clientX: 25, clientY: 25, nativeEvent: { composedPath: () => [] }, currentTarget: { getBoundingClientRect: () => ({ left: 20, top: 20, width: 312, height: 88 }) } });
    listeners.get("document:mousemove")!({ clientX: 205, clientY: 305 });
    listeners.get("window:blur")!();
    assert.equal(settingsModule.settings.store.detachedUserAreaX, 200);
    assert.equal(settingsModule.settings.store.detachedUserAreaY, 300);
    assert.equal(listeners.size, 0);
    assert.equal(cancelledFrames, 1);
    plugin.stop();
    assert.equal(providers.size, 0);
});
