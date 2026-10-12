/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { activityAndContactControls } from "./fixtures/discordActivityAndContactControls";
import { jsx, React } from "./utils/discordClientFixture";
import { loadTestModule } from "./utils/loadTestModule";

function apply(source: string, patch: any) {
    assert.ok(source.includes(canonicalizeMatch(patch.find)), "the real plugin finder must select the current host component");
    for (const replacement of [patch.replacement].flat()) {
        const match = canonicalizeMatch(replacement.match);
        assert.equal([...source.matchAll(new RegExp(match.source, "g"))].length, 1);
        source = source.replace(match, canonicalizeReplace(replacement.replace, "plugin"));
    }
    return source;
}

function loadPlugin(file: string, imports: Record<string, unknown>) {
    let settings: any;
    const plugin = loadTestModule(file, {
        "@api/Settings": { definePluginSettings(definitions: Record<string, any>) {
            settings = { store: Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [
                name, definition.default ?? definition.options?.find((option: any) => option.default)?.value
            ])) };
            settings.use = () => settings.store;
            return settings;
        } },
        "@components/ErrorBoundary": { __esModule: true, default: "boundary" },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        ...imports
    }, { React }).default;
    return { plugin, settings };
}

function ignoreFixture() {
    let recalculations = 0;
    return {
        ...loadPlugin("src/plugins/ignoreActivities/index.tsx", {
            "@api/UserSettings": { getUserSettingLazy: () => ({ updateSetting: () => recalculations++ }) },
            "@components/Flex": {}, "@components/Heading": {}, "@components/Paragraph": {},
            "@plugins/customRPC": { __esModule: true, default: {} }, "@utils/margins": {},
            "@webpack/common": { Tooltip: "tooltip", RunningGameStore: { getRunningGames: () => [] } }
        }),
        recalculations: () => recalculations
    };
}

function contactFixture() {
    let account = "first";
    let rejectCopy = false;
    const copied: string[] = [];
    const toasts: any[] = [];
    return {
        ...loadPlugin("src/equicordplugins/exportMessages/index.tsx", {
            "@api/Notifications": {}, "@utils/native": {}, "@utils/web": {},
            "@utils/clipboard": { copyToClipboard: async (text: string) => {
                if (rejectCopy) throw new Error("Clipboard denied");
                copied.push(text);
            } },
            "@webpack/common": { UserStore: { getCurrentUser: () => account ? { id: account } : undefined }, Menu: {},
                Toasts: { show: (toast: unknown) => toasts.push(toast), genId: () => "toast", Type: { SUCCESS: "success", FAILURE: "failure" }, Position: { BOTTOM: "bottom" } } },
            "./types": {}
        }),
        copied, toasts, account: (id: string) => account = id, rejectCopy: () => rejectCopy = true
    };
}

const hooks = { useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, useEffect() {}, useRef: () => ({ current: null }) };
const classNames = () => (...args: any[]) => args.filter(value => typeof value === "string").join(" ");
const styles = new Proxy({}, { get: (_target, key) => String(key) });

function appGlobals(promoted: boolean, developer: boolean) {
    return {
        r: { jsx, jsxs: jsx, Fragment: "fragment" }, o: { ...hooks, useState: () => [false, () => {}] },
        I: { X2: (app: any) => ({ iconURL: "app-icon", name: app.name, description: "Description" }), NO: () => promoted, fl: () => 0 },
        q: { SD: (text: string) => text }, ej: { Ay: () => "fallback" }, nC: { uS: () => developer }, M: { Hr: { NONE: 0 } },
        v: classNames, nS: styles, j: { A: "app-icon" }, O: { D: "heading" }, T: { E: "text" }, nu: { E: "promoted" },
        et: { intl: { string: () => "Promoted" }, t: { "/eVltv": "promoted" } }, tk: "fake-icon", tO: "fake-icon",
        nH: "banner", nk: "developer-badge", nN: { A: "label" }, nU: "staff-debug"
    };
}

function without(value: any, omitted: unknown): any {
    if (Array.isArray(value)) return value.filter(item => item !== omitted).map(item => without(item, omitted));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, without(child, omitted)]));
    return typeof value === "function" ? "[function]" : value;
}

const sections = { ONLINE: "ONLINE", ALL: "ALL", PENDING: "PENDING", SUGGESTIONS: "SUGGESTIONS", ADD_FRIEND: "ADD_FRIEND" };
const relationships = { FRIEND: 1, PENDING_INCOMING: 3, PENDING_OUTGOING: 4, BLOCKED: 2 };

function friendsGlobals(fixture: typeof activityAndContactControls.stable | typeof activityAndContactControls.canary, label: string) {
    const transitions: unknown[] = [];
    const tabbar = Object.assign(() => {}, { Item: "tab-item", Panel: "tab-panel" });
    const navigation = Object.assign(() => {}, { Icon: "navigation-icon", Title: "navigation-title", Divider: "navigation-divider" });
    let nextId = 0;
    const modules: Record<number, any> = {
        477900: { jsx, jsxs: jsx }, 582128: hooks, 652215: { m3P: sections, eA$: relationships },
        806163: { zy: () => ({ search: "" }), W6: () => ({}) }, 363195: { A: { theme: "dark" } },
        17928: { bG: (_stores: unknown, fn: () => unknown) => fn(), cf: (_stores: unknown, fn: () => unknown) => fn() },
        912309: { kX: () => 2 }, 595623: { Ay: { getState: () => ({
            section: sections.ALL, rows: { getRelationshipCounts: () => ({ 1: 2, 2: 0, 3: 2, 4: 0 }), filter: () => ["online"] }
        }) } }, 586774: { A: { getSuggestionCount: () => 0 } }, 915089: { GV: () => "heading-" + ++nextId },
        660183: { intl: { string: (key: string) => key === "friends-label" ? label : key, formatToPlainString: (_key: string, args: unknown) => JSON.stringify(args) },
            t: { TdEu5X: "friends-label", b9w3bO: "Online", PfjFjR: "All", p6IHGE: "Pending", OAC0Z4: "pending-count", j0wbE5: "Add Friend" } },
        812993: { hV: "badge" }, 726249: { HI: "impression" }, 43990: { N: "theme-provider" }, 742589: { A: navigation },
        214947: { $: "friends-icon" }, 761508: { V: tabbar }, 711950: { A: { transitionToSection: (...args: unknown[]) => transitions.push(args) } },
        415017: styles
    };
    const globals: Record<string, unknown> = Object.fromEntries(Object.entries(fixture.friendsBindings).filter(([, id]) => id in modules).map(([name, id]) => [name, modules[id]]));
    globals[fixture.friendsLocals.classNames] = classNames;
    for (const key of ["sidebar", "addFriend", "list", "toolbar"] as const) globals[fixture.friendsLocals[key]] = key;
    return { globals, transitions, tabbar };
}

for (const [channel, fixture] of Object.entries(activityAndContactControls)) {
    test(channel + ": activity controls toggle the actual filter without changing card content or launch affordances", () => {
        const { plugin, settings, recalculations } = ignoreFixture();
        const source = apply(fixture.appCard, plugin.patches[3]);
        const application = Object.freeze({ id: "activity", name: "Example Activity" });
        for (const look of ["row", "large_banner", "medium_banner"]) for (const promoted of [false, true]) for (const developer of [false, true]) {
            const globals = appGlobals(promoted, developer);
            const props = Object.freeze({ application, look, enableVideoBanner: true, children: jsx("launch-button", { disabled: true }) });
            const native = runInNewContext("(" + fixture.appCard + ")", globals)(props);
            const actual = runInNewContext("(" + source + ")", { ...globals, plugin })(props);
            const title = actual.props.children[1].props.children[1].props.children[0];
            const toggle = title.props.children[1];
            assert.equal(toggle.type, "boundary");
            assert.equal(JSON.stringify(without(actual, toggle)), JSON.stringify(without(native, undefined)));
            const tooltip = toggle.props.children[0];
            assert.equal(tooltip.props.text, "Disable activity");
            let stopped = false;
            tooltip.props.children[0]({}).props.onClick({ stopPropagation: () => stopped = true });
            assert.equal(stopped, true, "the toggle must not launch the activity");
            assert.equal(plugin.isActivityNotIgnored({ type: 0, application_id: application.id }), false);
            assert.equal(JSON.stringify(settings.store.ignoredActivities), JSON.stringify([{ id: "activity", name: "Example Activity", type: 1 }]));
            const updated = plugin.renderToggleActivityButton(application).props.children[0];
            assert.equal(updated.props.text, "Enable activity");
            updated.props.children[0]({}).props.onClick({ stopPropagation() {} });
            assert.equal(plugin.isActivityNotIgnored({ type: 0, application_id: application.id }), true);
            assert.equal(settings.store.ignoredActivities.length, 0);
        }
        assert.equal(recalculations(), 24);
    });

    test(channel + ": contact export appears in localized Friends navigation without changing native tabs or copying during render", async () => {
        const harness = contactFixture();
        const { plugin, settings } = harness;
        settings.store.exportContacts = true;
        const patch = plugin.patches[1];
        assert.equal(patch.predicate(), true);
        const source = apply(fixture.friendsTabs, patch);
        for (const label of ["Friends", "Freunde", "Amis"]) {
            const expectedHarness = friendsGlobals(fixture, label);
            const native = runInNewContext("(" + fixture.friendsTabs + ")", expectedHarness.globals)({});
            const actualHarness = friendsGlobals(fixture, label);
            const actual = runInNewContext("(" + source + ")", { ...actualHarness.globals, plugin })({});
            const nativeNavigation = native.props.children[1].props.children("theme");
            const navigation = actual.props.children[1].props.children("theme");
            const exportButton = navigation.props.children.at(-1);
            assert.equal(exportButton.type, "boundary");
            assert.equal(JSON.stringify(without(navigation, exportButton)), JSON.stringify(without(nativeNavigation, undefined)));
            assert.equal(navigation.props.role, "navigation");
            const tabbar = navigation.props.children.find((child: any) => child.type === actualHarness.tabbar);
            assert.equal(tabbar.props["aria-label"], label);
            assert.deepEqual(Array.from(tabbar.props.children, (child: any) => child.props.id), ["ONLINE", "ALL", "PENDING", "ADD_FRIEND"]);
            tabbar.props.onItemSelect(sections.PENDING);
            assert.equal(JSON.stringify(actualHarness.transitions), JSON.stringify([[sections.PENDING, { explicit: true }]]));
            assert.deepEqual(harness.copied, [], "rendering the navigation must not read or copy contacts");
        }
        settings.store.exportContacts = false;
        assert.equal(patch.predicate(), false);
        plugin.getContacts([{ type: 1, user: { username: "Friend", discriminator: "0" } }, { type: 2, user: { username: "Blocked", discriminator: "1234" } }]);
        await plugin.addExportButton().props.children[0].props.onClick();
        assert.equal(harness.copied.length, 1);
        assert.equal(JSON.stringify(JSON.parse(harness.copied[0])), JSON.stringify({ friendsAdded: ["Friend"], blockedUsers: ["Blocked#1234"], incomingFriendRequests: [], outgoingFriendRequests: [] }));
        harness.account("second");
        await plugin.copyContactToClipboard();
        assert.equal(harness.copied.length, 1, "another account must not export the previous contact cache");
        harness.account("first");
        harness.rejectCopy();
        await plugin.copyContactToClipboard();
        assert.equal(harness.toasts.at(-1).type, "failure");
        plugin.stop();
        assert.equal(plugin.contactList, undefined);
        assert.equal(plugin.contactAccountId, undefined);
    });
}
