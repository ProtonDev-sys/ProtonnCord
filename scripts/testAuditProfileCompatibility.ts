/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordProfileComponents } from "./fixtures/discordProfileComponents";
import { loadTestModule } from "./utils/loadTestModule";
import { elements as descendants } from "./utils/discordClientFixture";

type Capture = typeof discordProfileComponents[number];
type Element = { type: unknown; props: any; };
const jsx = (type: unknown, props: any): Element => ({ type, props });
const React = { createElement: (type: unknown, props: any, ...children: unknown[]) => jsx(type, { ...props, children }) };
const css = new Proxy({}, { get: (_, key) => String(key) });
const sections = { ACTIVITY: "ACTIVITY", WIDGETS: "WIDGETS", WISHLIST: "WISHLIST", MUTUAL_FRIENDS: "MUTUAL_FRIENDS", MUTUAL_GUILDS: "MUTUAL_GUILDS" };
const savedSettings = Object.freeze({ store: Object.freeze({ enabled: true, profileSongsLimit: 3, baseUrl: "https://decor.invalid", unknown: "preserve" }) });

function hooks() {
    let cursor = 0;
    const slots: any[] = [];
    const effects: (() => void)[] = [];
    return {
        begin() { cursor = 0; },
        flush() { effects.splice(0).forEach(effect => effect()); },
        useState(initial: any) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
            return [slots[index], (next: unknown) => { slots[index] = next; }];
        },
        useRef(initial: unknown) { return slots[cursor++] ??= { current: initial }; },
        useEffect(effect: () => void, dependencies: unknown[]) {
            const index = cursor++;
            if (!slots[index] || dependencies.some((value, i) => value !== slots[index][i])) effects.push(effect);
            slots[index] = dependencies;
        }
    };
}

function loadPlugins() {
    const actions: unknown[][] = [];
    const owner = { id: "owner", bot: false };
    const user = { id: "profile", bot: false };
    const group = (id: string, recipients: string[], isGroupDM = true) => ({ id, recipients, name: id, isGroupDM: () => isGroupDM });
    const groups = [group("shared", [user.id]), group("another", ["another-user"]), group("direct", [user.id], false)];
    const common = {
        UserStore: { getCurrentUser: () => owner, getUser: (id: string) => ({ id }) },
        ChannelStore: { getSortedPrivateChannels: () => groups },
        RelationshipStore: { getNickname: () => undefined },
        IconUtils: { getChannelIconURL: () => "fixture-icon" },
        Avatar: "avatar", Clickable: "group-link", ScrollerThin: "scroller",
        useStateFromStores: (_stores: unknown, get: () => unknown) => get()
    };
    const base = {
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } }
    };
    function load(file: string, imports: Record<string, unknown>) {
        return loadTestModule(file, { ...base, ...imports }, {
            React, fetch: () => assert.fail("rendering fixtures must not make network requests")
        }).default;
    }
    const decor = load("src/plugins/decor/index.tsx", {
        "@utils/misc": {}, "@webpack/common": common,
        "./lib/constants": {}, "./lib/stores/AuthorizationStore": {}, "./lib/stores/CurrentUserDecorationsStore": {},
        "./lib/stores/UsersDecorationsStore": {}, "./settings": { settings: savedSettings },
        "./ui/components": {}, "./ui/components/DecorSection": { __esModule: true, default: "decor-section" }
    });
    const mutual = load("src/plugins/mutualGroupDMs/index.tsx", {
        "@components/BaseText": { BaseText: "text" }, "@utils/guards": { isNonNullish: (value: unknown) => value != null },
        "@utils/Logger": { Logger: class { error(error: unknown) { assert.fail(String(error)); } } },
        "@webpack": {
            findCssClassesLazy: () => css,
            findByPropsLazy: (name: string) => name === "selectPrivateChannel"
                ? { selectPrivateChannel: (id: string) => actions.push(["open-group", id]) }
                : { getName: (member: { id: string; }) => member.id }
        },
        "@webpack/common": common
    });
    const song = load("src/equicordplugins/songSpotlight.desktop/index.tsx", {
        "./lib/stores/AuthorizationStore": {}, "./lib/stores/SongStore": {},
        "./settings": { __esModule: true, default: savedSettings },
        "./ui/songs/ProfileSongs": {}, "./ui/songs/WidgetSongs": { __esModule: true, default: (props: unknown) => jsx("song-content", props) }
    });
    return { plugins: { decor, mutual, song }, owner, user, groups, actions };
}

function patchSource(source: string, plugins: Record<string, any>, enabled: string[]) {
    let count = 0;
    for (const name of enabled) for (const patch of plugins[name].patches) {
        const find = canonicalizeMatch(patch.find);
        if (typeof find === "string" ? !source.includes(find) : !find.test(source)) continue;
        for (const replacement of Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement]) {
            const next = source.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, `plugins.${name}`));
            assert.notEqual(next, source, `${name}: the captured profile must match ${replacement.match}`);
            source = next;
            count++;
        }
    }
    assert.ok(count >= enabled.length, "each enabled profile plugin must patch the real host code");
    return source;
}

function fixture(capture: Capture, enabled: string[]) {
    const pluginFixture = loadPlugins();
    const state = {
        hidePersonalInformation: false, premium: false, hasUnsavedChanges: false, shouldLogExposure: false,
        widgets: false, connectedGames: [] as unknown[], wishlist: false, newWishlistItems: false, allowMutuals: true,
        errors: { avatar: ["avatar-error"], avatar_decoration_sku_id: ["decoration-error"] }
    };
    const analytics: any[] = [];
    const guardActions: string[] = [];
    const modules: Record<number, unknown> = {
        477900: { jsx, jsxs: jsx, Fragment: "fragment" },
        17928: { bG: (_stores: unknown, get: () => unknown) => get() },
        351906: { A: state }, 158045: { Ay: { canUsePremiumProfileCustomization: () => state.premium } },
        23722: { A: (callback: unknown) => callback }, 836602: { A: { getErrors: () => state.errors } },
        660183: { intl: { string: (key: unknown) => key, formatToPlainString: (_key: unknown, values: any) => values.tabName }, t: css },
        866665: { m: "tooltip" }, 408278: { K: "collapse-button" }, 890377: { V: "collapse-icon" }, 288490: css,
        183555: { NJ: () => ({ trackUserProfileAction: (event: unknown) => analytics.push(event) }) },
        116331: { A: () => ({ shouldLogExposure: state.shouldLogExposure, hasNewWishlistItems: state.newWishlistItems }) },
        713348: { A() {} }, 131058: css, 695904: { kM: "exposure" }, 364522: { Ip: "scroller" },
        761508: { V: Object.assign(() => {}, { Item: "tab-item", Panel: "tab-panel" }) },
        61881: { A: { hasUnsavedChanges: () => state.hasUnsavedChanges } },
        207803: { VQ: () => guardActions.push("unsaved-widgets") },
        518477: { RP: sections }, 827258: { A: "new-content-dot" },
        707554: { F: "accessible-content", H: "accessible-heading" }, 140735: { A: "hidden-heading" },
        913453: { A: () => ({ mutualFriendsCount: 2, mutualGuilds: ["guild"] }) },
        732188: { A: () => state.allowMutuals }, 667049: { A: () => state.connectedGames },
        419341: { A: () => state.wishlist }, 837531: { A: (count: number) => `${count} Friends` },
        186272: { A: (count: number) => `${count} Guilds` }
    };
    function evaluate(source: string) {
        const react = hooks();
        const components = runInNewContext(`${source}\n({${Object.entries(capture.components).map(([name, binding]) => `${name}:${binding}`).join(",")}})`, {
            plugins: pluginFixture.plugins,
            ...Object.fromEntries(Object.entries(capture.imports).map(([name, id]) => [name, id === 582128 ? react : modules[id] ?? {}])),
            ...Object.fromEntries(capture.locals.map(name => [name, `local-${name}`])),
            [capture.variant === "stable" ? "sC" : "sy"]: () => state.widgets
        });
        return Object.fromEntries(Object.entries(components).map(([name, render]) => [name, (props: unknown) => {
            react.begin();
            const tree = (render as Function)(props);
            react.flush();
            return tree;
        }]));
    }
    return { ...pluginFixture, state, analytics, guardActions, original: evaluate(capture.source), patched: evaluate(patchSource(capture.source, pluginFixture.plugins, enabled)) };
}

for (const capture of discordProfileComponents) {
    test(`${capture.variant}: Decor follows the host editor privacy, loading and permission states`, () => {
        const f = fixture(capture, ["decor"]);
        for (const hidePersonalInformation of [false, true]) for (const premium of [false, true]) for (const isLoading of [false, true]) for (const isEditingDisabled of [false, true]) for (const selectedGuildId of [undefined, "guild"]) {
            Object.assign(f.state, { hidePersonalInformation, premium });
            const props = { user: f.owner, isLoading, isEditingDisabled, selectedGuildId, onSelectGuildId() {} };
            const original = descendants(f.original.editor(props));
            const patched = descendants(f.patched.editor(props));
            const decorations = patched.filter(node => node.type === "decor-section");
            assert.equal(decorations.length, hidePersonalInformation ? 0 : 1);
            if (decorations.length) assert.equal(decorations[0].props.disabled, isLoading || isEditingDisabled || selectedGuildId != null && !premium);
            const beforeAvatar = original.find(node => node.props?.avatarDecorationErrorMessage);
            const afterAvatar = patched.find(node => node.props?.avatarDecorationErrorMessage);
            assert.equal(JSON.stringify(afterAvatar), JSON.stringify(beforeAvatar));
            assert.equal(patched.filter(node => node.props?.bannerErrorMessage).length, original.filter(node => node.props?.bannerErrorMessage).length);
        }
        assert.equal(f.plugins.decor.settings, savedSettings);
    });

    test(`${capture.variant}: mutual groups are available on the first render and select only existing shared chats`, () => {
        const f = fixture(capture, ["mutual"]);
        const items = [{ text: "Activity", section: "ACTIVITY" }];
        let closes = 0;
        const props = { user: f.user, currentUser: f.owner, items, initialSection: "MUTUAL_GDMS", onClose() { closes++; } };
        const first = f.patched.tabs(props);
        assert.equal(descendants(first).find(node => node.type === "tab-panel")?.props.id, "MUTUAL_GDMS");
        assert.deepEqual(items.map(item => item.section), ["ACTIVITY", "MUTUAL_GDMS"]);
        f.patched.tabs(props);
        assert.equal(items.filter(item => item.section === "MUTUAL_GDMS").length, 1);
        const links = descendants(first).filter(node => node.type === "group-link");
        assert.equal(links.length, 1);
        links[0].props.onClick();
        assert.equal(closes, 1);
        assert.deepEqual(f.actions, [["open-group", "shared"]]);
        assert.deepEqual(Array.from(f.plugins.mutual.getMutualGroupDms(f.user.id), (channel: any) => channel.id), ["shared"]);
    });

    test(`${capture.variant}: mutual tabs do not appear on bot or current-user profiles`, () => {
        const f = fixture(capture, ["mutual"]);
        for (const user of [{ ...f.user, bot: true }, f.owner]) {
            const items = [{ text: "Activity", section: "ACTIVITY" }];
            const props = { user, currentUser: f.owner, items, initialSection: "ACTIVITY", onClose() {} };
            const tree = f.patched.tabs(props);
            assert.equal(items.length, 1);
            assert.equal(descendants(tree).some(node => node.type === "group-link"), false);
        }
        assert.deepEqual(f.actions, []);
    });

    test(`${capture.variant}: Song Spotlight preserves existing tab visibility and routes only its own section`, () => {
        const f = fixture(capture, ["song"]);
        for (const self of [false, true]) for (const allowMutuals of [false, true]) for (const wishlist of [false, true]) for (const widgets of [false, true]) {
            Object.assign(f.state, { allowMutuals, wishlist, widgets, newWishlistItems: wishlist });
            const props = { user: self ? f.owner : f.user, currentUser: f.owner };
            const before = f.original.items(props);
            const after = f.patched.items(props);
            assert.equal(after.filter((item: any) => item.section === "SONG_SPOTLIGHT").length, 1);
            assert.equal(JSON.stringify(after.filter((item: any) => item.section !== "SONG_SPOTLIGHT")), JSON.stringify(before));
            for (const section of [...Object.values(sections), "unknown"]) {
                const contentProps = { ...props, section, guildId: "guild", channelId: "channel", displayProfile: { restricted: true } };
                assert.equal(JSON.stringify(f.patched.content(contentProps)), JSON.stringify(f.original.content(contentProps)));
            }
            const songs = f.patched.content({ ...props, section: "SONG_SPOTLIGHT" });
            assert.equal(songs.type, "song-content");
            assert.equal(songs.props.user, props.user);
        }
        assert.equal(f.plugins.song.settings, savedSettings);
    });

    test(`${capture.variant}: combined tabs retain the unsaved-widget guard and new-content accessibility`, () => {
        const f = fixture(capture, ["decor", "mutual", "song"]);
        Object.assign(f.state, { widgets: true, wishlist: true, newWishlistItems: true, hasUnsavedChanges: true, shouldLogExposure: true });
        const items = f.patched.items({ user: f.user, currentUser: f.owner });
        const props = { user: f.user, currentUser: f.owner, items, initialSection: "WIDGETS", onClose() {} };
        let tree = f.patched.tabs(props);
        const tabBar = descendants(tree).find(node => node.props?.onItemSelect);
        assert.ok(tabBar);
        assert.equal(tabBar.props.className, "vc-mutual-gdms-modal-v2-tab-bar");
        tabBar.props.onItemSelect("SONG_SPOTLIGHT");
        assert.deepEqual(f.guardActions, ["unsaved-widgets"]);
        tree = f.patched.tabs(props);
        assert.equal(descendants(tree).find(node => node.type === "tab-panel")?.props.id, "WIDGETS");
        f.state.hasUnsavedChanges = false;
        tabBar.props.onItemSelect("SONG_SPOTLIGHT");
        tree = f.patched.tabs(props);
        assert.equal(descendants(tree).find(node => node.type === "tab-panel")?.props.id, "SONG_SPOTLIGHT");
        const content = descendants(tree).find(node => node.props?.section === "SONG_SPOTLIGHT");
        assert.ok(content);
        assert.equal(f.patched.content(content.props).type, "song-content");
        assert.equal(f.analytics.filter(event => event.action === "VIEW_NEW_CONTENT_TAB_BADGE").length, 1);
        const wishlist = descendants(tree).find(node => node.type === "tab-item" && node.props.id === "WISHLIST");
        assert.ok(wishlist);
        assert.equal(wishlist.props["aria-label"], items.find((item: any) => item.section === "WISHLIST").text);
        assert.equal(descendants(wishlist).filter(node => node.type === "new-content-dot").length, 1);
    });
}

test("Decor's host disabled state reaches both actions without changing existing busy or authorization rules", () => {
    const authorization = { authorization: "owner", isAuthorized: () => true, ready: true, busy: false };
    const decorations = { selectedDecoration: { id: "decoration" }, loading: false, busy: false };
    const DecorSection = loadTestModule("src/plugins/decor/ui/components/DecorSection.tsx", {
        "@components/Button": { Button: "button" }, "@components/Flex": { Flex: "flex" }, "@components/Paragraph": { Paragraph: "paragraph" },
        "@plugins/decor/lib/stores/AuthorizationStore": { useAuthorizationStore: () => authorization },
        "@plugins/decor/lib/stores/CurrentUserDecorationsStore": { useCurrentUserDecorationsStore: () => decorations },
        "@plugins/decor/ui": { useDialogActions: () => ({}), cl: (name: string) => name },
        "@plugins/decor/ui/modals/ChangeDecorationModal": {},
        "@webpack": { findComponentByCodeLazy: () => "legacy-section" },
        "@webpack/common": { NewCustomizationSection: "new-section", useEffect() {}, useState: (value: unknown) => [value, () => {}] }
    }, { React }).default;
    for (const disabled of [false, true]) for (const busy of [false, true]) for (const useNewSection of [false, true]) {
        decorations.busy = busy;
        const tree = DecorSection({ disabled, useNewSection });
        const buttons = descendants(tree).filter(node => node.type === "button");
        assert.equal(buttons.length, 2);
        assert.deepEqual(buttons.map(button => button.props.disabled), [disabled || busy, disabled || busy]);
    }
});
