/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { composeSecureForwardText, secureForwardEmbedText, secureForwardImageEmbeds, secureForwardRoute } from "../src/equicordplugins/secureMessaging.desktop/forwarding";
import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordForwardingSource } from "./fixtures/discordForwarding";
import { loadTestModule } from "./utils/loadTestModule";

const tick = () => new Promise(resolve => setImmediate(resolve));
const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, expose = "") {
    return loadTestModule(file, imports, { React, URL, Set, File, AbortController, Uint8Array, console, ...globals }, expose);
}
const questPath = "src/equicordplugins/questify/";
const statuses = ["UNCLAIMED", "CLAIMED", "IGNORED", "EXPIRED"];

test("Questify version migration preserves preferences and unknown data on repeated loading", () => {
    const enums = new Proxy({}, { get: (_target, property) => property });
    const defs = load(questPath + "settings/def.ts", { "@vencord/discord-types/enums": { QuestRewardType: enums, QuestTaskType: enums } }, { IS_DISCORD_DESKTOP: true });
    for (const migrationVersion of [undefined, 0, 1, 9]) {
        const data: Record<string, unknown> = { enabled: false, isFavorite: true, questButtonDisplay: "never", questButtonBadgeColor: 0, questOrder: ["EXPIRED", "CLAIMED", "UNCLAIMED", "IGNORED"], newQuestAlertSound: null, unknown: { keep: [1, "value"] }, ...(migrationVersion !== undefined ? { migrationVersion } : {}) };
        const before = structuredClone(data);
        let changes = 0;
        const plugins = { Questify: data };
        const imports = {
            "@api/Settings": { PlainSettings: { plugins }, SettingsStore: { markAsChanged() { changes++; } }, definePluginSettings: (value: unknown) => value },
            "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } }, "@utils/types": { OptionType: {} },
            "../components/questButtonSettings": {}, "../components/questFeaturesSetting": {}, "../components/questNotificationsSetting": {},
            "../components/questTilesSetting": {}, "../components/reorderQuestsSetting": {}, "./def": defs
        };
        load(questPath + "settings/store.ts", imports);
        assert.equal(plugins.Questify, data, "retain existing namespace identity");
        assert.deepEqual(data, { ...before, migrationVersion: migrationVersion || 1 });
        load(questPath + "settings/store.ts", imports);
        assert.equal(changes, migrationVersion ? 0 : 1);
    }
});

test("Questify status sorting and settings keep each category exactly once", () => {
    const store = { questOrder: ["EXPIRED", "EXPIRED", "invalid", "CLAIMED"] };
    const defs = { defaultQuestOrder: statuses, defaultUnclaimedSubsort: "Expiring ASC", defaultClaimedSubsort: "Claimed DESC", defaultIgnoredSubsort: "Recent DESC", defaultExpiredSubsort: "Expiring DESC" };
    const access = { getQuestifySettings: () => store, useQuestifySettings: () => store };
    const tiles = load(questPath + "utils/questTiles.ts", {
        "../settings/access": access, "../settings/def": defs, "../settings/ignoredQuests": { getIgnoredQuestIDs: () => [] },
        "./questState": { getQuestStatus: (quest: { status: string; }) => quest.status, QuestStatus: { Claimed: "CLAIMED", Unclaimed: "UNCLAIMED", Ignored: "IGNORED", Expired: "EXPIRED" } },
        "./ui": { q: (value: string) => value }
    });
    const quests = statuses.map((status, id) => ({ id, status, config: { startsAt: 0, expiresAt: 1 } }));
    assert.deepEqual(Array.from(tiles.sortQuests(quests), (quest: any) => quest.status), ["EXPIRED", "CLAIMED", "UNCLAIMED", "IGNORED"]);
    assert.deepEqual(quests.map(quest => quest.status), statuses);
    const controls = load(questPath + "components/reorderQuestsSetting.tsx", {
        "../settings/access": access, "../settings/def": defs, "../settings/rerender": {}, "./shared": {}
    }, {}, "\nexport { sanitizeQuestOrder };\n");
    assert.deepEqual(Array.from(controls.sanitizeQuestOrder(store.questOrder)), ["EXPIRED", "CLAIMED", "UNCLAIMED", "IGNORED"]);
});

test("Questify stop invalidates pending webpack startup without executing completion mechanisms", async () => {
    let ready!: () => void;
    const onceReady = new Promise<void>(resolve => { ready = resolve; });
    const settings = { enabled: true, disableQuestsEverything: false };
    let starts = 0;
    let notices = 0;
    const plugin = load(questPath + "index.tsx", {
        "@api/AudioPlayer": {}, "@api/ServerList": { addServerListElement() {}, removeServerListElement() {}, ServerListRenderPosition: {} },
        "@api/Settings": { PlainSettings: { plugins: { Questify: settings } }, Settings: { plugins: { Questify: settings } } },
        "@components/index": { ErrorBoundary: { wrap: (value: unknown) => value } }, "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, StartAt: {} },
        "@webpack": { findComponentByCodeLazy() {}, onceReady }, "@webpack/common": {},
        "./components/questButton": {}, "./components/questTileContextMenu": {},
        "./settings/access": { getQuestifySettings: () => settings },
        "./settings/fetching": { startAutoFetchingQuests() { starts++; }, stopAutoFetchingQuests() {}, resetQuestsToResume() {} },
        "./settings/ignoredQuests": {}, "./settings/notices": { showPendingQuestifyNotice() { notices++; } },
        "./settings/rerender": {}, "./settings/restartTracking": { initializeRestartTracking() {}, disposeRestartTracking() {} },
        "./settings/store": {}, "./state": {},
        "./utils/completion": { stopAllAutoCompletes() {} },
        "./utils/fetching": { fetchAndDispatchQuests() {} }, "./utils/filtering": {}, "./utils/logging": { QL: { info() {} } },
        "./utils/questState": {}, "./utils/questTiles": {}, "./utils/ui": { QUEST_PAGE: "/quest-home" }
    }, { window: { location: { pathname: "/channels/@me" } } }).default;
    plugin.start();
    plugin.stop();
    ready();
    await tick();
    assert.equal(starts, 0);
    assert.equal(notices, 0);
    plugin.start();
    await tick();
    assert.equal(starts, 1);
    plugin.stop();
});

const USER = "111111111111111111";
const SOURCE = "222222222222222222";
const DESTINATION = "333333333333333333";
const SECOND_DESTINATION = "444444444444444444";
function forwardingFixture() {
    const state = {
        userId: USER, ready: true, protection: "enabled", sourceProtected: false,
        sourceProtection: "enabled", delayDecrypt: false, delayProtection: false,
        protectionByChannel: {} as Record<string, string>, sendFailure: false,
    };
    const pendingDecrypt: Array<(value: unknown) => void> = [];
    const pendingProtection: Array<(value: unknown) => void> = [];
    const sends: any[] = [];
    const nativeSends: string[] = [];
    const nativeMessages: Array<{ destination: string; body: { content: string; }; options: any; }> = [];
    const toasts: string[] = [];
    const getChannel = (id: string) => id === SOURCE && !state.sourceProtected
        ? { id, guild_id: "555555555555555555" }
        : { id, recipients: ["666666666666666666"], isDM: () => true };
    const channelProtection = (channel: string) => state.protectionByChannel[channel] ?? state.protection;
    const securePlugin = {
        started: true,
        getScreenCaptureProtectionStatus: () => state.ready ? "ready" : "hidden",
        sendEncryptedForward: async (destination: string, content: string, uploads: unknown[], stickerIds: string[]) => {
            if (state.sendFailure) throw new Error("fixture encrypted send failed");
            sends.push([destination, { content }, false, { uploads, stickerIds }]);
        },
    };
    const plugin = load("src/equicordplugins/secureMessagingForwarding.desktop/index.ts", {
        "@api/PluginManager": { plugins: { SecureMessaging: securePlugin } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@vencord/discord-types/enums": { CloudUploadPlatform: {} },
        "@webpack/common": {
            ChannelStore: { getChannel },
            UserStore: { getCurrentUser: () => ({ id: state.userId }), getUser: () => undefined },
            GuildRoleStore: {}, Constants: {}, RestAPI: {},
            showToast: (text: string) => toasts.push(text), Toasts: { Type: {} }
        },
        "../secureMessaging.desktop/attachmentCache": {},
        "../secureMessaging.desktop/attachments": { MAX_ATTACHMENT_BYTES: 500 * 1024 * 1024, MAX_ATTACHMENT_COUNT: 10 },
        "../secureMessaging.desktop/decryptCache": { decryptCachedMessage: async () => state.delayDecrypt ? new Promise(resolve => { pendingDecrypt.push(resolve); }) : { status: "decrypted", plaintext: "private fixture text", stickers: [] } },
        "../secureMessaging.desktop/forwarding": { composeSecureForwardText, secureForwardEmbedText, secureForwardImageEmbeds, secureForwardRoute },
        "../secureMessaging.desktop/protocol": { isEncryptedMessage: (content: string) => content === "encrypted-fixture" }
    }, {
        VencordNative: { pluginHelpers: { SecureMessaging: {
            getChannelProtection: async (_user: string, channel: string) => ({ status: channel === SOURCE && state.sourceProtected || !["disabled", "unconfigured"].includes(channelProtection(channel)) ? "protected" : channelProtection(channel) }),
            getConversation: async (_user: string, snapshot: { channelId: string; }) => state.delayProtection ? new Promise(resolve => { pendingProtection.push(resolve); }) : { status: snapshot.channelId === SOURCE ? state.sourceProtection : channelProtection(snapshot.channelId) },
        } } }
    }).default;
    plugin.start();
    const patch = plugin.patches.find((candidate: any) => discordForwardingSource.includes(candidate.find));
    assert.ok(patch, "the forwarding patch must find the captured private module");
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    const source = replacements.reduce((current: string, replacement: any) => {
        const next = current.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, "plugin"));
        assert.notEqual(next, current, "each replacement must apply as it does in WebpackPatcher");
        return next;
    }, discordForwardingSource);
    const { actions, moduleExports, forwardModal } = runInNewContext(`${source};({actions:H,moduleExports:n,forwardModal:ek})`, {
        plugin, n: {},
        t: { d: (exports: object, definitions: Record<string, () => unknown>) => {
            for (const [name, get] of Object.entries(definitions)) Object.defineProperty(exports, name, { enumerable: true, get });
        } },
        R: { A: { getChannel } }, T: { VL: "777777777777777777" }, P: { S: { FORWARD: 1 } },
        O: { Ay: { parse: (_channel: unknown, content: string) => ({ content }) } },
        D: { A: { sendMessage: async (destination: string, body: { content: string; }, _wait: boolean, options: any) => {
            nativeSends.push(destination);
            nativeMessages.push({ destination, body, options });
        } } },
        L: { Ay: (content: string) => [false, content] }, N: { UI: (flags: number, bit: number) => flags | bit },
        G: { pr7: { SUPPRESS_NOTIFICATIONS: 1 } }, W: { Hx: { FORWARDING: "forwarding" } },
        U: { lP: () => false }, V: { A: {} }, M: () => Promise.allSettled.bind(Promise),
    });
    const message = { id: "888888888888888888", content: "encrypted-fixture", channel_id: SOURCE, attachments: [], embeds: [], author: { id: "999999999999999999", username: "fixture" } };
    return {
        plugin, state, message, actions, moduleExports, forwardModal, sends, nativeSends, nativeMessages, toasts, securePlugin,
        finishDecrypt: () => {
            assert.ok(pendingDecrypt.length);
            for (const resume of pendingDecrypt.splice(0)) resume({ status: "decrypted", plaintext: "private fixture text", stickers: [] });
        },
        finishProtection: () => {
            assert.ok(pendingProtection.length);
            for (const resume of pendingProtection.splice(0)) resume({ status: state.protection });
        }
    };
}

test("secure forwards retain protected-copy and ordinary-forward routes", async () => {
    const fixture = forwardingFixture();
    await fixture.actions.sendForward(fixture.message, DESTINATION);
    assert.equal(fixture.sends.length, 1);
    assert.match(fixture.sends[0][1].content, /private fixture text/);
    assert.equal(fixture.nativeSends.length, 0);
    fixture.state.protection = "disabled";
    await assert.rejects(fixture.actions.sendForward(fixture.message, DESTINATION), /Protected messages/);
    assert.equal(fixture.sends.length, 1, "protected-to-ordinary stays blocked");
    await fixture.actions.sendForward({ ...fixture.message, content: "ordinary" }, DESTINATION);
    assert.deepEqual(fixture.nativeSends, [DESTINATION]);
    fixture.plugin.stop();
});

test("Discord's private forward actions retain the modal's settled-result contract", async () => {
    const fixture = forwardingFixture();
    assert.deepEqual(Object.keys(fixture.moduleExports), ["ForwardModal"], "sender actions are not webpack exports");
    const success = await fixture.moduleExports.ForwardModal(fixture.message, [DESTINATION, SECOND_DESTINATION], {}, "forward note");
    assert.deepEqual(Array.from(success.results, (result: any) => result.status), ["fulfilled", "fulfilled"]);
    assert.equal(success.hasError, false);
    assert.equal(fixture.sends.length, 2);
    assert.equal(fixture.nativeSends.length, 0);
    fixture.state.sendFailure = true;
    const failure = await fixture.forwardModal(fixture.message, [DESTINATION, SECOND_DESTINATION]);
    assert.deepEqual(Array.from(failure.results, (result: any) => result.status), ["rejected", "rejected"]);
    assert.match(failure.results[0].reason.message, /encrypted send failed/);
    assert.equal(failure.hasError, true);
    assert.deepEqual(Array.from(failure.failedDestinations), [DESTINATION, SECOND_DESTINATION]);
    assert.equal(fixture.nativeSends.length, 0, "failed secure sends cannot become successful native forwards");
    fixture.plugin.stop();
});

test("private forwarding preserves original arguments, selected embeds and an encrypted note", async () => {
    const fixture = forwardingFixture();
    const message = { ...fixture.message, content: "unselected message", embeds: [{ url: "https://example.com/excluded" }, { url: "https://example.com/selected" }] };
    const options = { onlyEmbedIndices: [1], onlyAttachmentIds: [], withMessage: "my forward note" };
    const calls: unknown[][] = [];
    const route = fixture.plugin.tryForward.bind(fixture.plugin);
    fixture.plugin.tryForward = (...args: unknown[]) => { calls.push(args); return route(...args); };
    await fixture.actions.sendForward(message, DESTINATION, options);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], message);
    assert.equal(calls[0][1], DESTINATION);
    assert.equal(calls[0][2], options, "the private sender forwards its options without a lossy snapshot");
    assert.match(fixture.sends[0][1].content, /my forward note/);
    assert.match(fixture.sends[0][1].content, /https:\/\/example\.com\/selected/);
    assert.doesNotMatch(fixture.sends[0][1].content, /example\.com\/excluded|unselected message/);
    assert.equal(fixture.nativeSends.length, 0);
    fixture.plugin.stop();
});

test("mixed destinations keep ordinary native references and report blocked destinations to the modal", async () => {
    const fixture = forwardingFixture();
    fixture.state.protectionByChannel[SECOND_DESTINATION] = "unconfigured";
    const message = { ...fixture.message, content: "ordinary" };
    const selection = { onlyAttachmentIds: [], onlyEmbedIndices: [1] };
    const options = { ...selection, withMessage: "ordinary note" };
    const ordinary = await fixture.actions.sendForwards(message, [SECOND_DESTINATION], options);
    assert.equal(ordinary[0].status, "fulfilled");
    assert.deepEqual(fixture.nativeSends, [SECOND_DESTINATION, SECOND_DESTINATION]);
    const first = fixture.nativeMessages[0];
    assert.deepEqual(JSON.parse(JSON.stringify(first.options)), {
        messageReference: {
            guild_id: "555555555555555555", channel_id: SOURCE, message_id: message.id, type: 1,
            forward_only: { attachment_ids: [], embed_indices: [1] },
        },
        location: "forwarding", eagerDispatch: false, flags: 0,
    });
    assert.equal(first.body.content, "");
    assert.equal(fixture.nativeMessages[1].body.content, "ordinary note");
    assert.equal(fixture.nativeMessages[1].options.messageReference, undefined);
    fixture.nativeSends.length = 0;
    const mixed = await fixture.forwardModal(message, [DESTINATION, SECOND_DESTINATION], {}, "mixed note");
    assert.deepEqual(Array.from(mixed.results, (entry: any) => entry.status), ["fulfilled", "fulfilled"]);
    assert.equal(mixed.hasError, false);
    assert.equal(fixture.sends.length, 1);
    assert.match(fixture.sends[0][1].content, /mixed note/);
    assert.deepEqual(fixture.nativeSends, [SECOND_DESTINATION, SECOND_DESTINATION]);
    fixture.nativeSends.length = 0;
    const result = await fixture.forwardModal(fixture.message, [DESTINATION, SECOND_DESTINATION]);
    assert.deepEqual(Array.from(result.results, (entry: any) => entry.status), ["fulfilled", "rejected"]);
    assert.equal(result.hasError, true);
    assert.deepEqual(Array.from(result.failedDestinations), [SECOND_DESTINATION]);
    assert.equal(fixture.sends.length, 2);
    assert.equal(fixture.nativeSends.length, 0);
    fixture.plugin.stop();
});

test("public forward routing returns false only for ordinary forwards and blocks protected fallback", async () => {
    const fixture = forwardingFixture();
    const plain = { ...fixture.message, content: "ordinary" };
    assert.equal(await fixture.plugin.tryForward(plain, DESTINATION), true);
    assert.equal(fixture.sends.length, 1);
    fixture.state.protection = "unconfigured";
    assert.equal(await fixture.plugin.tryForward(plain, DESTINATION), false);
    assert.equal(fixture.nativeSends.length, 0, "the caller performs the ordinary fallback itself");
    await assert.rejects(fixture.plugin.tryForward(fixture.message, DESTINATION), /Protected messages/);
    await assert.rejects(fixture.plugin.tryForward({ ...plain, messageSnapshots: [{ message: fixture.message }] }, DESTINATION), /Protected messages/);
    fixture.securePlugin.started = false;
    assert.equal(await fixture.plugin.tryForward(plain, DESTINATION), false);
    await assert.rejects(fixture.plugin.tryForward(fixture.message, DESTINATION), /Enable Secure Messaging/);
    assert.equal(fixture.sends.length, 1);
    fixture.plugin.stop();
});

test("changed local identities and unavailable protected sources cannot fall back to native forwarding", async () => {
    const fixture = forwardingFixture();
    fixture.state.protection = "local_identity_changed";
    await assert.rejects(fixture.plugin.tryForward(fixture.message, DESTINATION), /identity changed/);
    fixture.state.protection = "enabled";
    fixture.state.sourceProtected = true;
    fixture.state.sourceProtection = "local_identity_changed";
    await assert.rejects(fixture.plugin.tryForward({ ...fixture.message, content: "ordinary" }, DESTINATION), /identity changed/);
    assert.equal(fixture.sends.length, 0);
    assert.equal(fixture.nativeSends.length, 0);
    fixture.plugin.stop();
});

test("secure forwards cancel when account, runtime or protection changes during preparation", async () => {
    for (const change of ["account", "stop", "hidden", "unprotected"]) {
        const fixture = forwardingFixture();
        fixture.state.delayDecrypt = true;
        const operation = assert.rejects(fixture.actions.sendForward(fixture.message, DESTINATION), /cancelled|no longer ready/);
        await tick();
        if (change === "account") fixture.state.userId = "777777777777777777";
        if (change === "stop") fixture.plugin.stop();
        if (change === "hidden") fixture.state.ready = false;
        if (change === "unprotected") fixture.state.protection = "disabled";
        fixture.finishDecrypt();
        await operation;
        assert.equal(fixture.sends.length, 0, change);
        assert.equal(fixture.nativeSends.length, 0, change);
        fixture.plugin.stop();
    }
});

test("multi-destination forwards reject every pending result after lifecycle cancellation without native fallback", async () => {
    const fixture = forwardingFixture();
    fixture.state.delayDecrypt = true;
    const operation = fixture.actions.sendForwards(fixture.message, [DESTINATION, SECOND_DESTINATION]);
    await tick();
    fixture.plugin.stop();
    fixture.finishDecrypt();
    const results = await operation;
    assert.deepEqual(Array.from(results, (result: any) => result.status), ["rejected", "rejected"]);
    assert.equal(fixture.sends.length, 0);
    assert.equal(fixture.nativeSends.length, 0);
});

test("account changes during protection inspection cancel before decrypting or forwarding", async () => {
    const fixture = forwardingFixture();
    fixture.state.delayProtection = true;
    const operation = assert.rejects(fixture.actions.sendForward(fixture.message, DESTINATION), /cancelled/);
    await tick();
    fixture.state.userId = "777777777777777777";
    fixture.finishProtection();
    await operation;
    assert.equal(fixture.sends.length, 0);
    assert.equal(fixture.nativeSends.length, 0);
    fixture.plugin.stop();
});
