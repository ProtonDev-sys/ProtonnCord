/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
const tick = () => new Promise(resolve => setImmediate(resolve));

function load(file: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}, expose = "") {
    const imports: Record<string, unknown> = {
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@api/Settings": { migratePluginSetting() {}, migratePluginSettings() {}, definePluginSettings: (defs: any) => ({ store: Object.fromEntries(Object.entries(defs).map(([key, value]: [string, any]) => [key, value.default])) }) },
        "@utils/Logger": { Logger: class { error() {} } },
        ...mocks
    };
    return loadTestModule(file, imports, { React, Promise, console, URL, AbortSignal, Blob, ...globals }, expose);
}

test("FindReply remounts after channel replacement and repeated stop/start", async () => {
    const roots: any[] = [];
    const containers = [0, 1].map(() => ({ appendChild(element: any) { element.parentElement = this; } }));
    let container = containers[0];
    const target = { id: "1", channel_id: "channel", timestamp: "2026-01-01", author: { id: "author" } };
    const replies = [2, 3].map(id => ({ id: String(id), channel_id: "channel", timestamp: `2026-01-0${id}`, messageReference: { message_id: "1" } }));
    const plugin = load("src/equicordplugins/findReply/index.tsx", {
        "./ReplyNavigator": {}, "@api/Styles": { enableStyle() {}, disableStyle() {} },
        "@webpack": { findByPropsLazy: () => ({ jumpToMessage() {} }) },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({}) }, MessageStore: { getMessages: () => ({ _array: replies }) },
            Toasts: { show() {}, genId() {}, Type: {} },
            createRoot() { const root = { stopped: false, render() { assert.equal(this.stopped, false); }, unmount() { this.stopped = true; } }; roots.push(root); return root; }
        }
    }, {
        document: { querySelector: () => container, createElement: () => ({ parentElement: null, remove() { this.parentElement = null; } }) }
    }).default;
    await plugin.messagePopoverButton.render(target).onClick();
    container = containers[1];
    await plugin.messagePopoverButton.render(target).onClick();
    assert.equal(roots.length, 2);
    assert.equal(roots[0].stopped, true);
    plugin.stop();
    plugin.stop();
    plugin.start();
    await plugin.messagePopoverButton.render(target).onClick();
    assert.equal(roots.length, 3);
    assert.equal(roots[1].stopped, true);
    plugin.stop();
});

test("FindReply ignores obsolete paginator positions", () => {
    const jumps: unknown[] = [];
    const ui = load("src/equicordplugins/findReply/ReplyNavigator.tsx", {
        "@components/ErrorBoundary": {}, "@plugins/reviewDB/components/ReviewModal": { Paginator: "paginator", requirePaginator() {} },
        "@webpack": { findComponentByCodeLazy: () => "close", findCssClassesLazy: () => ({}) },
        "@webpack/common": { React: { ...React, useEffect() {} }, useRef: () => ({ current: null }), useState: (value: unknown) => [value, () => {}] },
        "./index": { jumper: { jumpToMessage: (args: unknown) => jumps.push(args) } }
    }).default({ replies: [{ id: "reply", channel_id: "channel" }] });
    const changePage = ui.props.children[0].props.children[0].props.onPageChange;
    [0, -1, 2, 1.5, NaN].forEach(changePage);
    assert.equal(jumps.length, 0);
    changePage(1);
    assert.equal(jumps.length, 1);
});

test("FollowVoiceUser forgets a followed friend after an account change", () => {
    let account = "first";
    const selected: string[] = [];
    const plugin = load("src/equicordplugins/followVoiceUser/index.tsx", {
        "@components/Notice": {}, "@webpack": { findByPropsLazy: () => ({ selectVoiceChannel: (channel: string) => selected.push(channel) }) },
        "@webpack/common": {
            React: { ...React, useState: (initial: unknown) => [initial, () => {}] }, Menu: { MenuCheckboxItem: "checkbox" },
            UserStore: { getCurrentUser: () => ({ id: account }) }, RelationshipStore: { isFriend: () => true },
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "initial" }) }
        }
    }).default;
    const menu: any[] = [];
    plugin.contextMenus["user-context"](menu, { user: { id: "friend" } });
    menu[1].props.action();
    assert.deepEqual(selected, ["initial"]);
    account = "second";
    plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "friend", channelId: "next" }] });
    account = "first";
    plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "friend", channelId: "later" }] });
    assert.deepEqual(selected, ["initial"]);
});

test("FontLoader uses the chosen escaped family in code blocks and removes its styles on stop", async () => {
    const elements: any[] = [];
    const store = { selectedFont: "Chosen Font", applyOnCodeBlocks: true };
    const plugin = load("src/equicordplugins/fontLoader/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }), migratePluginSetting() {} },
        "@components/Card": {}, "@components/Heading": {}, "@components/Paragraph": {}, "@shared/debounce": {}, "@utils/margins": {}, "@utils/misc": {}, "@webpack/common": {}
    }, {
        CSS: { escape: (value: string) => value.replaceAll(" ", "\\ ") },
        document: { createElement: (tag: string) => ({ tag, removed: false, remove() { this.removed = true; } }), head: { appendChild: (element: any) => elements.push(element) } }
    }).default;
    await plugin.start();
    assert.match(elements.find(element => element.tag === "style").textContent, /--font-code: Chosen\\ Font, monospace/);
    plugin.stop();
    assert.ok(elements.every(element => element.removed));
});

test("FrequentQuickSwitcher tolerates unhydrated preferences and matches channel names without case sensitivity", () => {
    let value: unknown;
    const channels = { a: { name: "General" }, b: { name: "GENERAL-help" }, c: {} };
    const plugin = load("src/equicordplugins/frequentQuickSwitcher/index.tsx", {
        "@webpack/common": { ChannelStore: { getChannel: (id: string) => channels[id] }, UserSettingsActionCreators: { FrecencyUserSettingsActionCreators: { getCurrentValue: () => value } } }
    }).default;
    assert.equal(plugin.generateSearchResults("general").length, 0);
    value = { guildAndChannelFrecency: { guildAndChannels: { a: { totalUses: 1 }, b: { totalUses: 5 }, c: { totalUses: 10 }, missing: { totalUses: 99 } } } };
    assert.deepEqual(Array.from(plugin.generateSearchResults("GENERAL"), (result: any) => result.record.name), ["GENERAL-help", "General"]);
});

test("GifMaker native media requests reject unsafe destinations before fetch and disable redirects", async () => {
    const calls: any[] = [];
    const api = load("src/equicordplugins/gifMaker/native.ts", {}, { fetch: async (...args: unknown[]) => { calls.push(args); return { ok: true, blob: async () => new Blob(["gif"], { type: "image/gif" }) }; } });
    for (const url of [null, "http://cdn.discordapp.com/a", "https://user:pass@cdn.discordapp.com/a", "https://cdn.discordapp.com:8443/a", "https://example.org/a"]) {
        await assert.rejects(api.fetchMedia(null, url), /Invalid URL/);
    }
    assert.equal(calls.length, 0);
    const result = await api.fetchMedia(null, "https://cdn.discordapp.com/a");
    assert.equal(result.type, "image/gif");
    assert.equal(calls[0][1].redirect, "error");
    assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test("GifMaker font downloads can retry after failure and cannot install after resource cleanup", async () => {
    let fetches = 0;
    const finish: ((value: unknown) => void)[] = [];
    const added: unknown[] = [];
    const api = load("src/equicordplugins/gifMaker/fonts.ts", {}, {
        fetch: () => { fetches++; return new Promise(resolve => finish.push(resolve)); },
        document: { fonts: { add: (font: unknown) => added.push(font), delete() {} } },
        CSSStyleSheet: class { cssRules = []; replaceSync() {} }
    });
    const first = api.loadGoogleFont("Example");
    assert.equal(api.loadGoogleFont("Example"), first);
    finish[0]({ ok: false });
    await first;
    const second = api.loadGoogleFont("Example");
    assert.equal(fetches, 2);
    api.clearFontResources();
    finish[1]({ ok: true, text: async () => "font-face" });
    await second;
    assert.equal(added.length, 0);
    const catalog = api.fetchAllGoogleFonts();
    finish[2]({ ok: false });
    assert.equal((await catalog).length, 0);
    const retry = api.fetchAllGoogleFonts();
    assert.equal(fetches, 4);
    finish[3]({ ok: true, json: async () => [null, []] });
    await retry;
});

test("GifMaker revokes media URLs when image or video decoding fails", async () => {
    const revoked: string[] = [];
    const images: any[] = [];
    const videos: any[] = [];
    const api = load("src/equicordplugins/gifMaker/utils/encoder.ts", {
        "@utils/misc": {}, gifenc: {}, "gifuct-js": {}, "../captions": {}, "../captions/caption": {}, "../fonts": {}
    }, {
        VencordNative: { pluginHelpers: { gifMaker: { fetchMedia: async () => ({ data: new ArrayBuffer(1), type: "image/gif" }) } } },
        URL: class extends URL {
            static createObjectURL() { return "blob:media"; }
            static revokeObjectURL(url: string) { revoked.push(url); }
        },
        Image: class { constructor() { images.push(this); } },
        document: { createElement() { const video = { events: {}, addEventListener(event: string, handler: () => void) { this.events[event] = handler; }, load() {} }; videos.push(video); return video; } }
    });
    const image = api.loadImage("https://cdn.discordapp.com/image.gif");
    await tick();
    images[0].onerror();
    await assert.rejects(image, /Failed to load image/);
    const video = api.loadVideo("https://cdn.discordapp.com/video.mp4");
    await tick();
    videos[0].events.error();
    await assert.rejects(video, /Video load failed/);
    assert.deepEqual(revoked, ["blob:media", "blob:media"]);
});

test("GifMaker discards pending preview results after modal unmount", async () => {
    const effects: (() => void | (() => void))[] = [];
    const stateUpdates: unknown[] = [];
    let timer: (() => void) | undefined;
    let finish: ((blob: Blob) => void) | undefined;
    let urls = 0;
    const hooks = {
        ...React,
        useState: (value: unknown) => [typeof value === "function" ? value() : value, (next: unknown) => stateUpdates.push(next)],
        useRef: (value: unknown) => ({ current: value }), useEffect: (effect: () => void) => effects.push(effect)
    };
    const { auditModal } = load("src/equicordplugins/gifMaker/index.tsx", {
        "@components/Button": {}, "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {}, "@utils/margins": { Margins: {} }, "@utils/web": {},
        "@webpack/common": { ...hooks, React: hooks }, "./captions": { CAPTIONS: [] }, "./fonts": {},
        "./types": { DEFAULT_OPTIONS: { width: 32, height: 32, captionMode: "none", captionText: "", fontFamily: "Arial", captionSize: 40 } },
        "./utils/contextMenu": { getInitialSize: () => [32, 32] },
        "./utils/encoder": { createGif: () => new Promise(resolve => { finish = resolve; }) }, "./utils/gifPicker": {}
    }, {
        setTimeout: (callback: () => void) => { timer = callback; return 1; }, clearTimeout() {},
        URL: { createObjectURL() { urls++; return "blob:preview"; }, revokeObjectURL() {} }
    }, "\nexport const auditModal = GifMakerModal;");
    auditModal({ url: "https://cdn.discordapp.com/a", isVideo: false, sourceWidth: 32, sourceHeight: 32 });
    const cleanups = effects.map(effect => effect());
    timer!();
    cleanups.forEach(cleanup => cleanup?.());
    const updatesBeforeResolve = stateUpdates.length;
    finish!(new Blob(["gif"]));
    await tick();
    assert.equal(stateUpdates.length, updatesBeforeResolve);
    assert.equal(urls, 0);
});

test("GifMaker ignores malformed picker URLs and accepts attachments without proxy URLs", () => {
    const picker = load("src/equicordplugins/gifMaker/utils/gifPicker.ts");
    assert.deepEqual(Array.from(picker.orderCandidateUrls("https://", new Set(["https://", "https://cdn.discordapp.com/a.gif"]))), ["https://cdn.discordapp.com/a.gif"]);
    const media = load("src/equicordplugins/gifMaker/utils/contextMenu.ts", { "@webpack/common": {}, "../types": {} });
    assert.equal(media.getMediaInfo({ attachment: { url: "https://cdn.discordapp.com/a.gif", content_type: "image/gif" } }).url, "https://cdn.discordapp.com/a.gif");
});
