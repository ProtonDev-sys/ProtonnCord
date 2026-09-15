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

function load(path: string, mocks: Record<string, any>, globals: Record<string, unknown> = {}) {
    const modules = {
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {}, ReporterTestable: {} },
        ...mocks
    };
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", { exports: {}, ...globals, require: (name: string) => modules[name] });
}

const React = { Fragment: "fragment", createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) };

function typingFixture() {
    let calls = 0;
    const plugin = load("src/plugins/typingTweaks/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { amITyping: false } }), migratePluginToSettings() {} },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/discord": {},
        "@utils/guards": { isNonNullish: (value: unknown) => value != null },
        "@utils/Logger": { Logger: class { error() {} } }, "./style.css?managed": {},
        "@equicordplugins/customUserColors": {},
        "@webpack/common": { React, AuthenticationStore: { getId: () => "self" },
            TypingStore: { getTypingUsers: () => ({ self: 1, friend: 1, blocked: 1, missing: 1 }) },
            RelationshipStore: { isBlockedOrIgnored: (id: string) => id === "blocked" },
            UserStore: { getUser: (id: string) => id === "missing" ? undefined : { id } },
            useStateFromStores: (_stores: unknown, callback: () => unknown) => { calls++; return callback(); }
        }
    }).default;
    return { plugin, getCalls: () => calls };
}

test("typing summaries show two named users followed by the remaining count", () => {
    const { plugin } = typingFixture();
    const result = plugin.buildSeveralUsers({ users: [1, 2, 3, 4, 5].map(id => ({ id })), count: 3 });
    assert.equal(result.children[0].length, 2);
    assert.equal(result.children[2], 3);
});

test("typing hooks run with absent channels and exclude blocked, missing and own users", () => {
    const { plugin, getCalls } = typingFixture();
    assert.equal(plugin.useTypingUsers(undefined).length, 0);
    assert.equal(getCalls(), 2);
    assert.equal(plugin.useTypingUsers({ id: "channel" })[0].id, "friend");
    assert.equal(plugin.useTypingUsers({ id: "channel" }).length, 1);
    const children = [null, "typing", React.createElement("strong", null)];
    assert.equal(plugin.renderTypingUsers({ children, users: [] })[2], children[2]);
});

test("message pronouns use the supplied message channel and preserve explicit global mode", () => {
    let rawPronouns: unknown = "She/Her\r\n";
    const module = load("src/plugins/userMessagesPronouns/utils.ts", {
        "./settings": { PronounsFormat: { Lowercase: "LOWERCASE" }, settings: { use: () => ({ pronounsFormat: "LOWERCASE" }) } },
        "@webpack/common": {
            SelectedChannelStore: { getChannelId: () => "selected" },
            ChannelStore: { getChannel: (id: string) => id === "missing" ? undefined : { getGuildId: () => id } },
            UserProfileStore: { getUserProfile: () => ({ pronouns: "They/Them" }), getGuildMemberProfile: (_id: string, guild: string) => ({ pronouns: guild === "message" ? rawPronouns : "He/Him" }) },
            useStateFromStores: (_stores: unknown, callback: () => unknown) => callback()
        }
    });
    assert.equal(module.useFormattedPronouns("user", false, "message"), "she/her");
    assert.equal(module.useFormattedPronouns("user", true, "message"), "they/them");
    assert.equal(module.useFormattedPronouns("user", false, "missing"), "they/them");
    rawPronouns = 3;
    assert.equal(module.useFormattedPronouns("user", false, "message"), undefined);
});

test("USRBG discards stopped requests, validates catalogs and honors voice background settings", async () => {
    const requests: Array<{ resolve: (value: unknown) => void; signal: AbortSignal; }> = [];
    const settings = { voiceBackground: false };
    const plugin = load("src/plugins/usrbg/index.tsx", {
        "./styles.css": {}, "@components/Button": {}, "@utils/css": { classNameFactory: () => () => "" },
        "@api/Settings": { definePluginSettings: () => ({ store: settings }) }
    }, { URL, AbortController, AbortSignal, fetch: (_url: string, options: { signal: AbortSignal; }) => new Promise(resolve => requests.push({ resolve, signal: options.signal })) }).default;
    const catalog = { endpoint: "https://images.example.test", bucket: "banners", prefix: "", users: { "123": "version" } };
    const first = plugin.start();
    plugin.stop();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ ok: true, json: async () => catalog });
    await first;
    assert.equal(plugin.data, null);
    const second = plugin.start();
    requests[1].resolve({ ok: true, json: async () => catalog });
    await second;
    assert.equal(plugin.userHasBackground("123"), true);
    assert.equal(plugin.userHasBackground("toString"), false);
    assert.equal(plugin.getVoiceBackgroundStyles({ className: "tile", participantUserId: "123" }), undefined);
    settings.voiceBackground = true;
    assert.equal(plugin.getVoiceBackgroundStyles({ participantUserId: "123" }), undefined);
    assert.match(plugin.getVoiceBackgroundStyles({ className: "tile", participantUserId: "123" }).backgroundImage, /^url\("https:/);
    const third = plugin.start();
    requests[2].resolve({ ok: true, json: async () => ({ ...catalog, endpoint: "javascript:invalid" }) });
    await third;
    assert.equal(plugin.data, null);
});

test("reply loads ignore stale accounts, stopped generations and mismatched channels", async () => {
    let accountId = "first";
    const requests: Array<(value: unknown) => void> = [];
    const updates: unknown[] = [];
    const plugin = load("src/plugins/validReply/index.ts", {
        "@webpack": { findByCodeLazy: () => (value: unknown) => value },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: accountId }) },
            RestAPI: { get: () => new Promise(resolve => requests.push(resolve)) },
            FluxDispatcher: { dispatch: (value: unknown) => updates.push(value) } }
    }).default;
    plugin.setReplyStore({ set: (...value: unknown[]) => updates.push(value) });
    plugin.start();
    const reply = { baseMessage: { messageReference: { channel_id: "channel", message_id: "message" } } };
    const first = plugin.fetchReply(reply);
    accountId = "second";
    requests[0]({ body: [{ id: "message", channel_id: "channel" }] });
    await first;
    assert.equal(updates.length, 0);
    const second = plugin.fetchReply(reply);
    plugin.stop();
    plugin.start();
    const current = plugin.fetchReply(reply);
    requests[1]({ body: [{ id: "message", channel_id: "channel" }] });
    await second;
    await plugin.fetchReply(reply);
    assert.equal(requests.length, 3);
    requests[2]({ body: [{ id: "message", channel_id: "wrong-channel" }] });
    await current;
    assert.equal(updates.length, 0);
    const final = plugin.fetchReply(reply);
    requests[3]({ body: [{ id: "message", channel_id: "channel" }] });
    await final;
    assert.equal(updates.length, 2);
});

test("temporarily missing narrator voices do not overwrite a saved selection", () => {
    const store = { voice: "saved-voice" };
    const module = load("src/plugins/vcNarrator/settings.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store }) }, "./VoiceSetting": {}
    }, { window: { speechSynthesis: { getVoices: () => [] } } });
    assert.equal(module.getCurrentVoice(), undefined);
    assert.equal(store.voice, "saved-voice");
    const fallback = { voiceURI: "fallback", default: true };
    assert.equal(module.getCurrentVoice([fallback]), fallback);
    assert.equal(store.voice, "saved-voice");
});

test("narrator speech bounds invalid numeric settings and preserves valid endpoints", () => {
    const spoken: any[] = [];
    const store = { volume: Infinity, rate: -1, muteMessage: "Muted", unmuteMessage: "Unmuted" };
    const plugin = load("src/plugins/vcNarrator/index.tsx", {
        "@api/Settings": { migrateSettingsFromPlugin() {} }, "@components/ErrorCard": {}, "@components/Heading": {}, "@components/Paragraph": {},
        "@utils/Logger": { Logger: class { warn() {} } }, "@utils/margins": {}, "@utils/text": {},
        "./settings": { settings: { store }, getCurrentVoice: () => undefined },
        "@webpack/common": { SelectedChannelStore: { getVoiceChannelId: () => "voice" }, ChannelStore: { getChannel: () => ({ name: "General" }) },
            VoiceStateStore: { getVoiceStateForChannel: () => ({ selfMute: false }) } }
    }, { window: {}, SpeechSynthesisUtterance: class { constructor(public text: string) {} }, speechSynthesis: { speak: (value: unknown) => spoken.push(value) } }).default;
    plugin.flux.AUDIO_TOGGLE_SELF_MUTE();
    assert.equal(spoken[0].volume, 1);
    assert.equal(spoken[0].rate, 1);
    store.volume = 0;
    store.rate = 10;
    plugin.flux.AUDIO_TOGGLE_SELF_MUTE();
    assert.equal(spoken[1].volume, 0);
    assert.equal(spoken[1].rate, 10);
});
