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

import { composeSecureForwardText, secureForwardRoute } from "../src/equicordplugins/secureMessaging.desktop/forwarding";

const tick = () => new Promise(resolve => setImmediate(resolve));
const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, expose = "") {
    const code = transpileModule(readFileSync(file, "utf8") + expose, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, URL, Set, File, AbortController, Uint8Array, console,
        require(name: string) {
            if (name.includes(".css")) return {};
            assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
            return imports[name];
        }, ...globals
    });
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
    const state = { userId: USER, ready: true, protection: "enabled", delayDecrypt: false, delayProtection: false };
    let resumeDecrypt: ((value: unknown) => void) | undefined;
    let resumeProtection: ((value: unknown) => void) | undefined;
    const sends: any[] = [];
    const nativeSends: string[] = [];
    const toasts: string[] = [];
    const securePlugin = { started: true, getScreenCaptureProtectionStatus: () => state.ready ? "ready" : "hidden" };
    const actions = {
        sendForward: async (_message: unknown, destination: string) => { nativeSends.push(destination); },
        sendForwards: async (_message: unknown, destinations: string[]) => { nativeSends.push(...destinations); }
    };
    const original = actions.sendForward;
    const plugin = load("src/equicordplugins/secureMessagingForwarding.desktop/index.ts", {
        "@api/PluginManager": { plugins: { SecureMessaging: securePlugin } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/discord": { sendMessage: async (...args: unknown[]) => { sends.push(args); } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@vencord/discord-types/enums": { CloudUploadPlatform: {} },
        "@webpack": { waitFor: (_props: unknown, callback: (value: unknown) => void) => callback(actions) },
        "@webpack/common": {
            ChannelStore: { getChannel: (id: string) => id === SOURCE ? { id, guild_id: "555555555555555555" } : { id, recipients: ["666666666666666666"], isDM: () => true } },
            UserStore: { getCurrentUser: () => ({ id: state.userId }), getUser: () => undefined },
            GuildRoleStore: {}, Constants: {}, RestAPI: {},
            showToast: (text: string) => toasts.push(text), Toasts: { Type: {} }
        },
        "../secureMessaging.desktop/attachmentCache": {},
        "../secureMessaging.desktop/attachments": { MAX_ATTACHMENT_BYTES: 500 * 1024 * 1024, MAX_ATTACHMENT_COUNT: 10 },
        "../secureMessaging.desktop/decryptCache": { decryptCachedMessage: async () => state.delayDecrypt ? new Promise(resolve => { resumeDecrypt = resolve; }) : { status: "decrypted", plaintext: "private fixture text", stickers: [] } },
        "../secureMessaging.desktop/forwarding": { composeSecureForwardText, secureForwardRoute },
        "../secureMessaging.desktop/protocol": { isEncryptedMessage: (content: string) => content === "encrypted-fixture" }
    }, {
        VencordNative: { pluginHelpers: { SecureMessaging: { getConversation: async () => state.delayProtection ? new Promise(resolve => { resumeProtection = resolve; }) : { status: state.protection } } } }
    }).default;
    plugin.start();
    const message = { content: "encrypted-fixture", channel_id: SOURCE, attachments: [], embeds: [], author: { username: "fixture" } };
    return {
        plugin, state, message, actions, sends, nativeSends, toasts, original, securePlugin,
        finishDecrypt: () => { assert.ok(resumeDecrypt); resumeDecrypt({ status: "decrypted", plaintext: "private fixture text", stickers: [] }); },
        finishProtection: () => { assert.ok(resumeProtection); resumeProtection({ status: state.protection }); }
    };
}

test("secure forwards retain protected-copy and ordinary-forward routes", async () => {
    const fixture = forwardingFixture();
    await fixture.actions.sendForward(fixture.message, DESTINATION);
    assert.equal(fixture.sends.length, 1);
    assert.match(fixture.sends[0][1].content, /private fixture text/);
    assert.equal(fixture.nativeSends.length, 0);
    fixture.state.protection = "disabled";
    await fixture.actions.sendForward(fixture.message, DESTINATION);
    assert.equal(fixture.sends.length, 1, "protected-to-ordinary stays blocked");
    await fixture.actions.sendForward({ ...fixture.message, content: "ordinary" }, DESTINATION);
    assert.deepEqual(fixture.nativeSends, [DESTINATION]);
    fixture.plugin.stop();
    assert.equal(fixture.actions.sendForward, fixture.original);
});

test("secure forwards cancel when account, runtime or protection changes during preparation", async () => {
    for (const change of ["account", "stop", "hidden", "unprotected"]) {
        const fixture = forwardingFixture();
        fixture.state.delayDecrypt = true;
        const operation = fixture.actions.sendForward(fixture.message, DESTINATION);
        await tick();
        if (change === "account") fixture.state.userId = "777777777777777777";
        if (change === "stop") fixture.plugin.stop();
        if (change === "hidden") fixture.state.ready = false;
        if (change === "unprotected") fixture.state.protection = "disabled";
        fixture.finishDecrypt();
        await operation;
        assert.equal(fixture.sends.length, 0, change);
        assert.equal(fixture.nativeSends.length, 0, change);
        assert.ok(fixture.toasts.some(text => /cancelled|no longer ready/.test(text)));
        fixture.plugin.stop();
    }
});

test("multi-destination forwards stop after lifecycle cancellation without native fallback", async () => {
    const fixture = forwardingFixture();
    fixture.state.delayDecrypt = true;
    const operation = fixture.actions.sendForwards(fixture.message, [DESTINATION, SECOND_DESTINATION]);
    await tick();
    fixture.plugin.stop();
    fixture.finishDecrypt();
    await operation;
    assert.equal(fixture.sends.length, 0);
    assert.equal(fixture.nativeSends.length, 0);
});

test("account changes during protection inspection cancel before decrypting or forwarding", async () => {
    const fixture = forwardingFixture();
    fixture.state.delayProtection = true;
    const operation = fixture.actions.sendForward(fixture.message, DESTINATION);
    await tick();
    fixture.state.userId = "777777777777777777";
    fixture.finishProtection();
    await operation;
    assert.equal(fixture.sends.length, 0);
    assert.equal(fixture.nativeSends.length, 0);
    fixture.plugin.stop();
});
