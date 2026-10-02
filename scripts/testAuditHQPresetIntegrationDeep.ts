import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

function element(type: unknown, props: object, ...children: unknown[]) {
    return { type, props: { ...props, children } };
}

function descendants(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(descendants);
    if (!node || typeof node !== "object") return [];
    return [node, ...descendants(node.props?.children)];
}

function load(path: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    return loadTestModule(`src/equicordplugins/profileSets/${path}`, imports, { setTimeout, clearTimeout, ...globals });
}

test("preset save retains one captured profile instead of rereading a newer avatar", async () => {
    let finish!: (value: unknown) => void;
    const saved: any[] = [];
    let laterAvatarReads = 0;
    const actions = load("utils/actions.ts", {
        "./profile": { getCurrentProfile: () => new Promise(resolve => { finish = resolve; }) },
        "./storage": { getPresetScope: () => "scope", addPreset: (preset: unknown) => saved.push(preset), savePresetsData: async () => true },
        "@webpack/common": { UserProfileSettingsStore: { getPendingChanges: () => { laterAvatarReads++; return { pendingAvatar: "new-avatar" }; } } }
    });
    const operation = actions.savePreset("captured", "main");
    finish({ avatarDataUrl: "captured-avatar", bio: "captured-bio" });
    assert.equal(await operation, true);
    assert.equal(saved[0].avatarDataUrl, "captured-avatar");
    assert.equal(saved[0].bio, "captured-bio");
    assert.equal(laterAvatarReads, 0);
});

test("oversized preset imports are rejected before reading or mutating saved data", async () => {
    let input: any;
    let reads = 0;
    let writes = 0;
    const toasts: string[] = [];
    const actions = load("utils/actions.ts", {
        "./profile": {},
        "./storage": { getPresetScope: () => "scope", replaceAllPresets: () => { writes++; } },
        "@webpack/common": { showToast: (message: string) => toasts.push(message), Toasts: { Type: { FAILURE: "failure" } } }
    }, { document: { createElement: () => (input = { click() {} }) } });
    await actions.importPresets(() => {}, async () => "override", "main");
    await input.onchange({ currentTarget: { files: [{ size: 32 * 1024 * 1024 + 1, text: async () => { reads++; return "[]"; } }] } });
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.equal(toasts.length, 1);
});

test("partial profile presets preserve omitted text fields while explicit clears still apply", async () => {
    const dispatched: any[] = [];
    const profile = load("utils/profile.ts", {
        "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => ({}), updateSetting() {} }) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "alice", avatar: "data:image/png,fixture", globalName: "saved-name" }) },
            UserProfileStore: { getUserProfile: () => ({ bio: "saved-bio", pronouns: "saved-pronouns" }) },
            UserProfileSettingsStore: { getPendingChanges: () => ({}) },
            FluxDispatcher: { dispatch: (value: unknown) => dispatched.push(value) }
        }
    });
    await profile.loadPresetAsPending({ name: "partial", timestamp: 1 });
    assert.equal(dispatched.some(value => "pendingBio" in value || "pendingPronouns" in value || "pendingGlobalName" in value), false);
    await profile.loadPresetAsPending({ name: "clear", timestamp: 2, bio: null, pronouns: null, globalName: null });
    assert.equal(dispatched.some(value => value.pendingBio === ""), true);
    assert.equal(dispatched.some(value => value.pendingPronouns === ""), true);
    assert.equal(dispatched.some(value => "pendingGlobalName" in value && value.pendingGlobalName === null), true);
});

test("preset rename commits once on Enter and never commits after Escape followed by blur", () => {
    for (const key of ["Enter", "Escape"]) {
        const writes: unknown[] = [];
        let stateIndex = 0;
        const component = load("components/presetList.tsx", {
            "@utils/misc": { classes: () => "" },
            "@webpack/common": { React: {
                createElement: element,
                useState: () => [stateIndex++ === 0 ? 0 : "renamed", () => {}],
                useRef: (initial: unknown) => ({ current: initial })
            }, TextInput: "input" },
            "..": { cl: () => "" },
            "../utils/actions": { renamePreset: (...args: unknown[]) => writes.push(args) }
        });
        const presets = [{ name: "original", timestamp: 1 }];
        const input = descendants(component.PresetList({ presets, allPresets: presets, avatarSize: 20, selectedPreset: -1, section: "main", currentPage: 1, onUpdate() {} }))
            .find(node => node.type === "input");
        input.props.onKeyDown({ key, stopPropagation() {} });
        input.props.onBlur();
        assert.equal(writes.length, key === "Enter" ? 1 : 0);
    }
});

test("preset manager reloads for account changes and exposes a retry after failed hydration", async () => {
    let account = "alice";
    const effects: { callback: () => void, dependencies: any[]; }[] = [];
    const states: any[] = [];
    let stateIndex = 0;
    const userStore = { getCurrentUser: () => ({ id: account }) };
    const component = load("components/presetManager.tsx", {
        "@components/Button": { Button: "button" }, "@components/Heading": { Heading: "heading" },
        "@utils/misc": { classes: () => "" },
        "@webpack/common": {
            React: {
                createElement: element,
                useState: (initial: unknown) => {
                    const index = stateIndex++;
                    if (!(index in states)) states[index] = initial;
                    return [states[index], (value: unknown) => { states[index] = value; }];
                },
                useReducer: () => [0, () => {}], useRef: (initial: unknown) => ({ current: initial }),
                useEffect: (callback: () => void, dependencies: any[]) => effects.push({ callback, dependencies })
            },
            UserStore: userStore, SelectedGuildStore: { getLastSelectedGuildId: () => null, getGuildId: () => null },
            useStateFromStores: (_stores: unknown[], getter: () => unknown) => getter()
        },
        "../index": { cl: () => "", settings: { use: () => ({ avatarSize: 20 }) } },
        "../utils/actions": {}, "../utils/profile": { cancelPendingPresetLoad() {} },
        "../utils/storage": { presets: [], loadPresets: async () => {}, getPresetScope: () => null },
        "./confirmModal": {}, "./presetList": {}
    });
    component.PresetManager({});
    assert.equal(effects[0].dependencies.includes("alice"), true);
    effects[0].callback();
    await new Promise(resolve => setImmediate(resolve));
    stateIndex = 0;
    const rendered = component.PresetManager({});
    const alert = descendants(rendered).find(node => node.props?.role === "alert");
    assert.ok(alert);
    assert.equal(descendants(alert).some(node => node.type === "button" && typeof node.props.onClick === "function"), true);
    account = "bob";
    stateIndex = 0;
    component.PresetManager({});
    assert.equal(effects[4].dependencies.includes("bob"), true);
});
