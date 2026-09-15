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
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {}, StartAt: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => (...names: string[]) => names.join(" ") },
        "@api/Settings": { definePluginSettings: (defs: any) => ({ store: Object.fromEntries(Object.entries(defs).map(([key, value]: [string, any]) => [key, value.default])) }) },
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        ...mocks
    };
    return loadTestModule(file, imports, { React, Promise, console, URL, Blob, File, ...globals }, expose);
}

test("GitHub API validation keeps valid metadata, sorts a copy, and confines names to path segments", async () => {
    const low = { id: 1, name: "low", html_url: "https://github.com/user/low", stargazers_count: 1, futureMetadata: { keep: true } };
    const high = { id: 2, name: "high", html_url: "https://github.com/user/high", stargazers_count: 5 };
    const data = [low, high, { ...high, html_url: "javascript:void(0)" }];
    const urls: string[] = [];
    const api = load("src/equicordplugins/githubRepos/githubApi.ts", {}, {
        fetch: async (url: string) => { urls.push(url); return { ok: true, json: async () => data }; }
    });
    const repos = await api.fetchReposByUsername("user/name?extra");
    assert.deepEqual(Array.from(repos, (repo: any) => repo.id), [2, 1]);
    assert.equal(repos[1], low);
    assert.equal(data[0], low, "sorting does not rewrite response metadata");
    assert.match(urls[0], /users\/user%2Fname%3Fextra\/repos/);
});

test("GitHub profile tab renders its loading state and discards results after profile unmount", async () => {
    let effect: (() => (() => void)) | undefined;
    let finish: ((info: unknown) => void) | undefined;
    let repoCalls = 0;
    const updates: unknown[] = [];
    const component = load("src/equicordplugins/githubRepos/components/ProfileTabComponent.tsx", {
        "@components/BaseText": { BaseText: "text" },
        "@equicordplugins/githubRepos/githubApi": { fetchUserInfo: () => new Promise(resolve => { finish = resolve; }), fetchReposByUserId() { repoCalls++; } },
        "@equicordplugins/githubRepos/utils": { PERSONAL_GROUP_KEY: "personal", sortGroups: (groups: unknown) => groups },
        "@webpack/common": {
            React, useState: (value: unknown) => [value, (next: unknown) => updates.push(next)], useEffect: (callback: any) => { effect = callback; },
            UserProfileStore: {}, useStateFromStores: () => ({ id: "github", name: "profile" })
        },
        "..": { cl: (value: string) => value, settings: { use: () => ({ showStars: true, showLanguage: true }) } },
        "./RepoCard": {}, "./RepoSubTabs": {}
    }).ProfileTabComponent;
    const rendered = component({ id: "first" });
    assert.equal(rendered.type, "text");
    assert.equal(rendered.props.className, "loading");
    const cleanup = effect!();
    cleanup();
    const before = updates.length;
    finish!({ username: "first" });
    await tick();
    assert.equal(updates.length, before);
    assert.equal(repoCalls, 0);
});

test("GitHub language colors do not inherit prototype entries", () => {
    const api = load("src/equicordplugins/githubRepos/colors.ts");
    assert.equal(api.getLanguageColor("constructor"), "#858585");
    assert.equal(api.getLanguageColor(null), "#858585");
    assert.equal(api.getLanguageColor("TypeScript"), "#3178c6");
});

test("IgnoreCalls keeps call updates separate by channel and forgets them after account changes", () => {
    let account = "self";
    const dispatched: any[] = [];
    let plugin: any;
    plugin = load("src/equicordplugins/ignoreCalls/index.tsx", {
        "@components/Button": {}, "@components/ErrorBoundary": {}, "@webpack": { findComponentByCodeLazy: () => "icon" },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) },
            FluxDispatcher: { dispatch(event: any) { dispatched.push(event); plugin.flux.CALL_UPDATE(event); } }
        }
    }).default;
    plugin.settings.store.permanentlyIgnoredUsers = "a, b";
    plugin.flux.CALL_UPDATE({ channelId: "a", ringing: ["self", "friend-a"], messageId: "call-a", region: "region-a" });
    plugin.flux.CALL_UPDATE({ channelId: "b", ringing: ["self", "friend-b"], messageId: "call-b", region: "region-b" });
    plugin.renderIgnore({ id: "a" });
    assert.equal(dispatched[0].messageId, "call-a");
    assert.deepEqual(Array.from(dispatched[0].ringing), ["friend-a"]);
    plugin.renderIgnore({ id: "a" });
    assert.equal(dispatched.length, 1, "an already dismissed call does not dispatch again during render");
    account = "other";
    plugin.renderIgnore({ id: "b" });
    assert.equal(dispatched.length, 1);
    plugin.stop();
    assert.equal(plugin.settings.store.permanentlyIgnoredUsers, "a, b");
});

test("InRole uses the message guild and gives separate entries to distinct mentioned roles", () => {
    const shown: any[] = [];
    const members = [{ userId: "member", roles: ["1"] }];
    const roles = { "1": { id: "1", name: "One" }, "2": { id: "2", name: "Two" } };
    const plugin = load("src/equicordplugins/inRole/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {} },
        "@api/UserSettings": { getUserSettingLazy: () => ({ updateSetting: async () => {} }) },
        "@components/Icons": {}, "@components/Paragraph": {}, "@utils/discord": { getCurrentGuild: () => ({ id: "wrong" }) },
        "@webpack/common": {
            Menu: { MenuItem: "item" }, ChannelStore: { getChannel: () => ({ id: "message-channel", guild_id: "message-guild" }) },
            GuildRoleStore: { getRole(guild: string, id: string) { assert.equal(guild, "message-guild"); return roles[id]; } },
            GuildMemberStore: { getMembers(guild: string) { assert.equal(guild, "message-guild"); return members; } }
        },
        "./RoleMembersModal": { showInRoleModal: (...args: unknown[]) => shown.push(args) }
    }).default;
    const menu: any[] = [];
    plugin.contextMenus.message(menu, { message: { channel_id: "message-channel", content: "<@&1> <@&2> <@&1>" } });
    const items = menu[0].props.children[0];
    assert.equal(items.length, 2);
    items[0].props.action();
    assert.equal(shown[0][2], "message-channel");
    assert.equal(shown[0][0][0], members[0]);
});

test("InstantScreenshare does not replace missing saved sources or mutate source inventory", async () => {
    const sources = Object.freeze([{ id: "screen:0", name: "Main screen" }]);
    const toasts: unknown[] = [];
    const api = load("src/equicordplugins/instantScreenshare/utils.tsx", {
        "@components/Heading": {}, "@components/margins": {}, "@components/Paragraph": {},
        "@webpack": { findByCodeLazy: () => async () => sources, findByPropsLazy: () => ({ getVideoDevices: () => ({ camera: { id: "camera", name: "Camera" } }) }) },
        "@webpack/common": { MediaEngineStore: { getMediaEngine: () => ({}) }, showToast: (text: string) => toasts.push(text), Toasts: { Type: {} } }
    });
    api.settings.store.streamMedia = "missing-window";
    api.settings.store.includeVideoDevices = true;
    assert.equal(await api.getCurrentMedia(), null);
    assert.equal(api.settings.store.streamMedia, "missing-window");
    assert.equal(sources.length, 1);
    api.settings.store.streamMedia = "camera";
    assert.equal((await api.getCurrentMedia()).id, "camera");
    assert.equal(toasts.length, 1);
});

test("InstantScreenshare cancels pending starts on disconnect, account change and stop", async () => {
    for (const reason of ["disconnect", "account", "stop"]) {
        let account = "self";
        let channel: string | null = "voice";
        let finish: ((source: unknown) => void) | undefined;
        const starts: unknown[] = [];
        const plugin = load("src/equicordplugins/instantScreenshare/index.tsx", {
            "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => true }) },
            "@components/Heading": {}, "@components/Paragraph": {},
            "@webpack": { findByCodeLazy: (code: string) => code.includes("STREAM_START") ? (...args: unknown[]) => starts.push(args) : () => {} },
            "./utils": { settings: { store: { toolboxManagement: true, instantScreenshare: true } }, getCurrentMedia: () => new Promise(resolve => { finish = resolve; }) },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: account }) }, SelectedChannelStore: { getVoiceChannelId: () => channel },
                ChannelStore: { getChannel: () => ({ isDM: () => true, isGroupDM: () => false }) },
                ApplicationStreamingSettingsStore: { getState: () => ({ soundshareEnabled: true }) },
                showToast() {}, Toasts: { Type: {} }
            }
        }).default;
        plugin.start();
        const pending = plugin.autoStartStream();
        if (reason === "disconnect") channel = null;
        if (reason === "account") account = "other";
        if (reason === "stop") plugin.stop();
        finish!({ id: "window:1", name: "Chosen window" });
        await pending;
        assert.equal(starts.length, 0, reason);
    }
});

test("InstantScreenshare stream events only toggle the current user's stream", async () => {
    const stopped: string[] = [];
    const plugin = load("src/equicordplugins/instantScreenshare/index.tsx", {
        "@api/UserSettings": { getUserSettingLazy: () => ({}) }, "@components/Heading": {}, "@components/Paragraph": {},
        "@webpack": { findByCodeLazy: (code: string) => code.includes("STREAM_STOP") ? (key: string) => stopped.push(key) : () => {} },
        "./utils": { settings: { store: {} }, getCurrentMedia: () => { assert.fail("stopping a stream does not enumerate sources"); } },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "self" }) }, SelectedChannelStore: { getVoiceChannelId: () => "voice" },
            ChannelStore: { getChannel: () => ({ isDM: () => true, isGroupDM: () => false }) }, WindowStore: { isFocused: () => true }
        }
    }).default;
    plugin.start();
    plugin.flux.STREAM_CREATE({ streamKey: "call:voice:self" });
    plugin.flux.STREAM_DELETE({ streamKey: "call:voice:friend" });
    await plugin.autoStartStream(false);
    assert.deepEqual(stopped, ["call:voice:self"]);
});

test("IconViewer SVG export resolves colors on a copy with the proper MIME type", async () => {
    const saved: File[] = [];
    const liveAttributes = new Map([['fill', 'var(--chosen)']]);
    const cloneAttributes = new Map(liveAttributes);
    const original = {
        cloneNode: () => ({ setAttribute: (key: string, value: string) => cloneAttributes.set(key, value), getAttribute: (key: string) => cloneAttributes.get(key), querySelectorAll: () => [], outerHTML: '<svg><title>é</title></svg>' })
    };
    const api = load("src/equicordplugins/iconViewer/components/Modals.tsx", {
        "@components/BaseText": {}, "@components/CodeBlock": {}, "@components/Flex": {}, "@components/Heading": {}, "@components/Paragraph": {}, "@components/TooltipContainer": {},
        "@utils/discord": {}, "@utils/web": { saveFile: (file: File) => saved.push(file) }, "@webpack": { findComponentByCodeLazy: () => ({}) }, "@webpack/common": {},
        "../utils": { cssColors: { 0: { name: "Chosen" } } }
    }, { getComputedStyle: () => ({ getPropertyValue: () => "#123456", color: "#abcdef" }) }, "\nexport const auditSave = saveIcon;");
    api.auditSave("Icon", original, 0, 32, "image/svg+xml");
    assert.equal(liveAttributes.get("fill"), "var(--chosen)");
    assert.equal(cloneAttributes.get("fill"), "#123456");
    assert.equal(saved[0].type, "image/svg+xml");
    assert.match(await saved[0].text(), /é/);
});

test("GuildPickerDumper rejects HTTP error bodies instead of exporting a corrupt archive", async () => {
    const toasts: string[] = [];
    const api = load("src/equicordplugins/guildPickerDumper/index.tsx", {
        "@api/ContextMenu": {}, "@utils/web": { saveFile() { assert.fail("error bodies cannot be exported"); } },
        "@webpack/common": { EmojiStore: { getGuilds: () => ({ guild: { emojis: [{ id: "1", name: "emoji" }] } }) }, showToast: (message: string) => toasts.push(message), Toasts: { Type: {} } },
        fflate: { zipSync() { assert.fail("error bodies cannot become ZIP entries"); } }
    }, {
        console: { error() {} }, window: { GLOBAL_ENV: { MEDIA_PROXY_ENDPOINT: "//cdn.discordapp.com" } },
        fetch: async () => ({ ok: false, status: 404, headers: { get: () => "text/plain" } })
    }, "\nexport const auditZip = zipGuildAssets;");
    await api.auditZip({ id: "guild", name: "Guild" }, "emojis");
    assert.equal(toasts.length, 1);
});
