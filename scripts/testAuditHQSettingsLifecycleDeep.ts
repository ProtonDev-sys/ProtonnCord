import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const base = "src/equicordplugins/questify/";
const jsx = (type: unknown, props: any) => ({ type, props });
const shared = new Proxy({}, { get: (_target, key) => key });

function loadModule(file: string, imports: Record<string, any>, globals: Record<string, any> = {}, expose = "exports") {
    const compiled = transpileModule(readFileSync(path.join(root, base, file), "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
    }).outputText;
    return runInNewContext(compiled + "\n" + expose + ";", {
        exports: {}, ...globals,
        require(name: string) {
            if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
            if (Object.hasOwn(imports, name)) return imports[name];
            throw new Error("Unexpected settings import: " + name);
        }
    });
}

function elements(tree: any): any[] {
    if (Array.isArray(tree)) return tree.flatMap(elements);
    if (!tree || typeof tree !== "object" || !tree.props) return [];
    return [tree, ...elements(tree.props.children)];
}

function ignoredHarness() {
    let assignments = 0;
    let renders = 0;
    let saved = ["saved", "excluded"];
    const ignored = Object.defineProperty({}, "questIDs", {
        get: () => saved,
        set(value) { assignments++; saved = value; },
    });
    const settings: any = { ignoredQuestIDs: ignored, questButtonIncludedTypes: {}, questButtonBadgeCount: 0 };
    const store = { quests: new Map(), excludedQuests: new Map() };
    const api = loadModule("settings/ignoredQuests.ts", {
        "@webpack/common": { QuestStore: store },
        "../utils/questState": { countIncludedUnclaimedQuests: () => 3, getQuestStatus: () => "unclaimed", QuestStatus: { Unclaimed: "unclaimed" } },
        "./access": { getQuestifySettings: () => settings },
        "./def": { ignoredQuestIDsKey: "questIDs" },
        "./rerender": { rerenderQuests() { renders++; } },
    });
    return { api, settings, store, get saved() { return saved; }, get assignments() { return assignments; }, get renders() { return renders; } };
}

function lifecycleHarness() {
    let nextTimer = 0;
    let reloads = 0;
    const timers = new Map<number, () => void>();
    const alerts: any[] = [];
    const listeners = new Map<string, () => void>();
    const globals = {
        setTimeout(callback: () => void) { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout(handle: number) { timers.delete(handle); },
    };
    const api = loadModule("settings/restartTracking.ts", {
        "@api/Settings": { SettingsStore: {
            addChangeListener(key: string, callback: () => void) { listeners.set(key, callback); },
            removeChangeListener(key: string, callback: () => void) { assert.equal(listeners.get(key), callback); listeners.delete(key); },
        } },
        "@utils/native": { reload: async () => { reloads++; } },
        "../utils/ui": { Alerts: { show: (alert: any) => alerts.push(alert) } },
    }, globals);
    const initialize = () => api.initializeRestartTracking({ pluginName: "Questify", def: { display: { restartNeeded: true }, plain: {} } });
    return { api, globals, timers, alerts, listeners, initialize, get reloads() { return reloads; }, flush() {
        for (const [handle, callback] of Array.from(timers)) { timers.delete(handle); callback(); }
    } };
}

function noticeHarness(lifecycle = lifecycleHarness()) {
    const settings: any = { enabled: true, allowChangingDangerousSettings: false, acknowledgedNotices: { unrelated: true } };
    const modals: any[] = [];
    const api = loadModule("settings/notices.tsx", {
        "@webpack/common": { Modal: "Modal", openModal: (render: any) => modals.push(render) },
        "./access": { getQuestifySettings: () => settings },
        "./dangerous": { resetDangerousSettings: () => { throw new Error("Dangerous setting changes forbidden in this suite"); } },
        "./restartTracking": lifecycle.api,
    }, {}, "({ ...exports, runNoticeAction, oneTimeNotices })");
    return { api, settings, modals, lifecycle };
}

function audioHarness() {
    let playingSound: string | null = null;
    const active = { current: null as any };
    const cleanups: (() => void)[] = [];
    const players: any[] = [];
    const settings = { disableQuestsEverything: false, questFetchInterval: 0 };
    const api = loadModule("components/questNotificationsSetting.tsx", {
        "@api/AudioPlayer": { defaultAudioNames: () => ["first", "second"], createAudioPlayer(sound: string, options: any) {
            const player = { sound, options, stops: 0, plays: 0, stop() { this.stops++; }, play() { this.plays++; } };
            players.push(player);
            return player;
        } },
        "@webpack/common": {
            useRef: () => active, useState: () => [playingSound, (sound: string | null) => { playingSound = sound; }],
            useMemo: (callback: () => unknown) => callback(),
            useEffect(callback: () => void | (() => void)) { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); },
        },
        "../settings/access": { getQuestifySettings: () => settings, useQuestifySettings: () => settings },
        "../settings/fetching": { startAutoFetchingQuests: () => { throw new Error("Fetching forbidden in preview regressions"); } },
        "../utils/ui": { q: (...names: string[]) => names.join(" ") }, "./shared": shared,
    });
    const render = () => elements(api.QuestNotificationsSetting()).find(element => typeof element.props.onPreview === "function").props;
    return { render, active, players, cleanups, settings, get playingSound() { return playingSound; } };
}

test("nonauthoritative empty and partial stores preserve saved ignored IDs without assignments", () => {
    const harness = ignoredHarness();
    const original = harness.saved;
    harness.api.validateIgnoredQuests();
    harness.store.quests.set("other", { id: "other" });
    harness.api.validateIgnoredQuests();
    assert.equal(harness.saved, original);
    assert.equal(harness.assignments, 0);
    assert.equal(harness.settings.questButtonBadgeCount, 3);
    assert.equal(harness.renders, 2);
});

test("explicit snapshots prune once while retaining excluded IDs", () => {
    const harness = ignoredHarness();
    harness.store.excludedQuests.set("excluded", { id: "excluded" });
    harness.api.validateIgnoredQuests([{ id: "saved" }]);
    assert.equal(harness.assignments, 0);
    harness.api.validateIgnoredQuests([]);
    assert.deepEqual(Array.from(harness.saved), ["excluded"]);
    assert.equal(harness.assignments, 1);
    harness.api.validateIgnoredQuests([]);
    assert.equal(harness.assignments, 1);
});

test("explicit validation deduplicates saved IDs without repeated assignments", () => {
    const harness = ignoredHarness();
    harness.settings.ignoredQuestIDs.questIDs = ["saved", "saved"];
    harness.api.validateIgnoredQuests([{ id: "saved" }]);
    harness.api.validateIgnoredQuests([{ id: "saved" }]);
    assert.deepEqual(Array.from(harness.saved), ["saved"]);
    assert.equal(harness.assignments, 2);
});

test("explicit ignore edits survive unloaded data and repeated no-op edits do not rewrite settings", () => {
    const harness = ignoredHarness();
    harness.api.addIgnoredQuest("new");
    harness.api.addIgnoredQuest("new");
    harness.api.removeIgnoredQuest("absent");
    assert.deepEqual(Array.from(harness.saved), ["saved", "excluded", "new"]);
    assert.equal(harness.assignments, 1);
    harness.api.resetIgnoredQuests();
    harness.api.resetIgnoredQuests();
    assert.equal(harness.assignments, 2);
});

test("included-type UI edits preserve unloaded ignored IDs and skip identical assignments", () => {
    const harness = ignoredHarness();
    let changes = 0;
    let types: Record<string, boolean> = {};
    Object.defineProperty(harness.settings, "questButtonIncludedTypes", { get: () => types, set(value) { changes++; types = value; } });
    const enums = new Proxy({}, { get: (_target, key) => key });
    const api = loadModule("components/questButtonSettings.tsx", {
        "@vencord/discord-types/enums": { QuestRewardType: enums, QuestTaskType: enums }, "..": { enabledOnStartup: false },
        "../settings/access": { getQuestifySettings: () => harness.settings, useQuestifySettings: () => harness.settings },
        "../settings/fetching": { startAutoFetchingQuests: () => { throw new Error("Fetching forbidden in filter regressions"); } },
        "../settings/ignoredQuests": harness.api, "../utils/ui": {}, "./questButton": {}, "./shared": shared,
    });
    const render = () => elements(api.QuestButtonSetting()).find(element => element.props.label === "Included Reward Types:").props;
    render().onSelectionChange(["IN_GAME"]);
    render().onSelectionChange(["IN_GAME"]);
    assert.deepEqual(Array.from(harness.saved), ["saved", "excluded"]);
    assert.equal(harness.assignments, 0);
    assert.equal(changes, 1);
});

test("current audio preview error clears and stops only its own player", () => {
    const harness = audioHarness();
    harness.render().onPreview("first");
    const [player] = harness.players;
    assert.equal(harness.playingSound, "first");
    player.options.onError(new Error("offline failure"));
    assert.equal(harness.active.current, null);
    assert.equal(harness.playingSound, null);
    assert.equal(player.stops, 1);
    player.options.onEnded();
    assert.equal(player.stops, 1);
});

test("stale audio end/error callbacks cannot clear a newer preview", () => {
    const harness = audioHarness();
    harness.render().onPreview("first");
    harness.render().onPreview("second");
    const [oldPlayer, newPlayer] = harness.players;
    oldPlayer.options.onError(new Error("late failure"));
    oldPlayer.options.onEnded();
    assert.equal(harness.active.current, newPlayer);
    assert.equal(harness.playingSound, "second");
    assert.equal(newPlayer.stops, 0);
    harness.cleanups[0]();
    newPlayer.options.onError(new Error("after unmount"));
    assert.equal(harness.active.current, null);
    assert.equal(newPlayer.stops, 1);
});

test("inactive dangerous warning remains pending without settings mutations", () => {
    const harness = noticeHarness();
    const original = harness.settings.acknowledgedNotices;
    harness.api.showPendingQuestifyNotice();
    assert.equal(harness.settings.acknowledgedNotices, original);
    assert.equal(harness.modals.length, 0);
    harness.settings.allowChangingDangerousSettings = true;
    harness.api.showPendingQuestifyNotice();
    assert.equal(harness.modals.length, 1);
    assert.equal(harness.settings.acknowledgedNotices, original);
});

test("disabled plugin does not acknowledge a pending warning", () => {
    const harness = noticeHarness();
    harness.settings.enabled = false;
    harness.settings.allowChangingDangerousSettings = true;
    harness.api.showPendingQuestifyNotice();
    assert.equal(harness.modals.length, 0);
    assert.equal(harness.settings.acknowledgedNotices["quest-ban-warning-2026-08-07"], undefined);
});

test("restart decline schedules once and disposal cancels listeners and callbacks", () => {
    const harness = lifecycleHarness();
    harness.initialize();
    harness.initialize();
    assert.equal(harness.listeners.size, 1);
    harness.api.setRestartDirty(true);
    let declined = 0;
    harness.api.promptToRestartIfDirty({ onDecline: () => { declined++; } });
    harness.alerts[0].onCancel();
    harness.alerts[0].onCloseCallback();
    assert.equal(harness.timers.size, 1);
    const late = Array.from(harness.timers.values())[0];
    harness.api.disposeRestartTracking();
    harness.initialize();
    late();
    harness.flush();
    assert.equal(declined, 0);
    assert.equal(harness.timers.size, 0);
    harness.api.disposeRestartTracking();
    assert.equal(harness.listeners.size, 0);
});

test("stale restart dialogs cannot enqueue declines into a restarted lifecycle", () => {
    const harness = lifecycleHarness();
    harness.initialize();
    harness.api.setRestartDirty(true);
    harness.api.promptToRestartIfDirty({ onDecline: () => assert.fail("stale decline") });
    harness.api.disposeRestartTracking();
    harness.initialize();
    harness.alerts[0].onCancel();
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.reloads, 0);
});

test("notice follow-up is cancelled on disposal and cannot open another modal", () => {
    const harness = noticeHarness();
    harness.lifecycle.initialize();
    harness.settings.allowChangingDangerousSettings = true;
    harness.api.runNoticeAction({ id: "other" }, { text: "Dismiss" }, () => {});
    assert.equal(harness.lifecycle.timers.size, 1);
    const late = Array.from(harness.lifecycle.timers.values())[0];
    harness.lifecycle.api.disposeRestartTracking();
    harness.lifecycle.initialize();
    late();
    assert.equal(harness.modals.length, 0);
});

test("closing a notice during disposal does not enqueue follow-up UI work", () => {
    const harness = noticeHarness();
    harness.lifecycle.initialize();
    harness.api.runNoticeAction({ id: "other" }, { text: "Dismiss" }, () => harness.lifecycle.api.disposeRestartTracking());
    assert.equal(harness.lifecycle.timers.size, 0);
    assert.equal(harness.modals.length, 0);
});

test("active lifecycle callbacks still run, remove timers, and decline only once", () => {
    const harness = lifecycleHarness();
    harness.initialize();
    harness.api.setRestartDirty(true);
    let declined = 0;
    harness.api.promptToRestartIfDirty({ onDecline: () => { declined++; } });
    harness.alerts[0].onCancel();
    harness.alerts[0].onCloseCallback();
    harness.flush();
    assert.equal(declined, 1);
    assert.equal(harness.timers.size, 0);
    harness.api.disposeRestartTracking();
    harness.api.deferSettingsCallback(() => assert.fail("disposed callback"));
    assert.equal(harness.timers.size, 0);
});
