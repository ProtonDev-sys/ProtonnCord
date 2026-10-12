/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { activeNow } from "./fixtures/discordActiveNow";
import { jsx, React } from "./utils/discordClientFixture";
import { loadTestModule } from "./utils/loadTestModule";

function pluginFixture() {
    const settings: any = { store: {} };
    const accessibility = { useReducedMotion: false, displayNameStylesEnabled: true };
    const streamerMode = { enabled: false };
    let settingsHooks = 0;
    const plugin = loadTestModule("src/plugins/showMeYourName/index.tsx", {
        "@api/ContextMenu": {}, "@api/index": { DataStore: {} },
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@api/Settings": { migratePluginSetting() {}, definePluginSettings(definitions: Record<string, any>) {
            Object.assign(settings.store, Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, value.default])));
            settings.use = () => { settingsHooks++; return settings.store; };
            return settings;
        } },
        "@components/Button": {}, "@components/Heading": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } },
        "@plugins/ircColors": { __esModule: true, default: {} }, "@plugins/mentionAvatars": { __esModule: true, default: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/index": { classNameFactory: () => () => "" },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { findByCodeLazy: () => (text: string) => text, findByPropsLazy: () => ({}), findComponentByCodeLazy: () => "Name" },
        "@webpack/common": { AccessibilityStore: accessibility, StreamerModeStore: streamerMode,
            RelationshipStore: { getNickname: () => undefined }, GuildMemberStore: { getMember: () => undefined } }
    }, { React, getComputedStyle: () => ({ getPropertyValue: () => "#ffffff" }), document: { documentElement: {} } }).default;
    settings.store.includedNames = "{user}";
    const patch = plugin.patches.find((patch: any) => Array.isArray(patch.replacement)
        && patch.replacement.some((replacement: any) => replacement.replace.includes("smynHovered")));
    assert.ok(patch);
    return { plugin, patch, settings: settings.store, accessibility, streamerMode, hooks: () => settingsHooks };
}

function apply(source: string, replacements: any[]) {
    for (const replacement of replacements) {
        source = source.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, "plugin"));
    }
    return source;
}

function party(size = 1) {
    const users = Array.from({ length: size }, (_, index) => Object.freeze({
        id: "user-" + index, username: "Username-" + index, globalName: "Display-" + index,
        displayNameStyles: Object.freeze({ colors: [0xffffff], fontId: 1, effectId: 1 })
    }));
    return Object.freeze({
        priorityMembers: users.slice(0, 2).map(user => Object.freeze({ user })),
        partiedMembers: Object.freeze(users), guildContext: Object.freeze({ id: "guild" }),
        currentActivities: [], voiceChannels: [], applicationStreams: []
    });
}

function hostFixture(fixture: (typeof activeNow)[keyof typeof activeNow]) {
    const events: string[] = [];
    const states: unknown[] = [];
    let cursor = 0;
    const ref = { current: null as unknown };
    const hooks = {
        useRef: () => ref, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(),
        useState(initial: unknown) {
            const id = cursor++;
            if (!(id in states)) states[id] = initial;
            return [states[id], (value: unknown) => { states[id] = value; events.push("state:" + value); }];
        }
    };
    const Header = Object.assign(() => {}, { Icon: Object.assign(() => {}, { Src: { MULTIPLE: "multiple" } }) });
    const Card = Object.assign(() => {}, { Header });
    const onGameClick = () => events.push("game");
    const modules: Record<number, any> = {
        477900: { jsx, jsxs: jsx }, 652215: { HAw: { NOW_PLAYING_CARD_HOVERED: "hovered" } },
        582128: hooks, 174459: { default: { track: () => events.push("analytics") }, isGameApplicationType: () => true },
        660183: { intl: { string: (key: unknown) => key, format: (_key: unknown, args: any) =>
            args.user1 + " and " + args.user2 + (args.extras ? " plus " + args.extras : "") }, t: { sau5tt: "Playing", l7clOK: "Quest", o6FLcF: "Sponsored" } },
        427262: { Ay: { getName: (user: any) => user.globalName } }, 922016: { Y: "popout" },
        190107: { rE: { QUEST_INSTRUCTIONS: "quest-instructions" } }, 462887: { M: () => true }, 736653: { DP: () => "dark" },
        738822: { uF: { ACTIVITY_PANEL: "activity-panel" } }, 77870: { sb: () => true }, 710969: { gO: () => false },
        657792: { R: "quest-ref" }, 270045: { C: "quest-controls" }, 765379: { A: () => false },
        609425: { A: () => ({ fontId: 1 }) }, 73392: { a: () => "native-font" },
        409626: { GameProfileSources: { QuestActivityPanel: "quest", FriendsActivityFeed: "friends" } },
        692969: { A: () => onGameClick }, 291749: { fY: { GAME_TILE: "tile" }, tW: () => ({ url: "quest-icon" }) },
        792620: { I6: () => false, _3: () => ["quest-app"] }, 438879: { MP: "card", dJ: "quest-card" }
    };
    const globals: Record<string, any> = Object.fromEntries(Object.entries(fixture.bindings)
        .filter(([, id]) => id in modules).map(([name, id]) => [name, modules[id]]));
    Object.assign(globals, {
        [fixture.locals.Card]: Card, [fixture.locals.Header]: "header", [fixture.locals.Body]: "body",
        [fixture.locals.Popout]: "popout-content", [fixture.locals.isInteractive]: (event: any) => event.interactive,
        [fixture.locals.throttle]: () => (fn: unknown) => fn, [fixture.locals.delay]: 500,
        [fixture.locals.assert]: () => assert.ok
    });
    return { globals, events, states, ref, onGameClick, reset: () => cursor = 0 };
}

function comparable(value: any): string {
    return JSON.stringify(value, (key, child) => key === "smynHovered" ? undefined : typeof child === "function" ? "[function]" : child);
}

function nativeCard(rendered: any, quest: boolean, props: any, ref: any) {
    return quest
        ? rendered.props.children.props.children(ref).props.children(props)
        : rendered.props.children(props, { isShown: true });
}

function cardHeader(card: any, quest: boolean) {
    return quest ? card.props.children[0] : card.props.children.props.children[0];
}

for (const [channel, fixture] of Object.entries(activeNow)) {
    test(channel + ": the Active Now patch targets the current component and both card variants", () => {
        const { patch } = pluginFixture();
        let source = fixture.header + ";" + fixture.card;
        assert.ok(source.includes(canonicalizeMatch(patch.find)));
        const counts: number[] = [];
        for (const replacement of patch.replacement) {
            const regex = canonicalizeMatch(replacement.match);
            counts.push([...source.matchAll(new RegExp(regex.source, "g"))].length);
            source = source.replace(regex, canonicalizeReplace(replacement.replace, "plugin"));
        }
        assert.deepEqual(counts, [1, 1, 1, 2]);
    });

    test(channel + ": current titles preserve grouped names, privacy, accessibility and settings hooks", () => {
        const f = pluginFixture();
        const h = hostFixture(fixture);
        const original = runInNewContext("(" + fixture.header + ")", h.globals);
        const patched = runInNewContext("(" + apply(fixture.header, [f.patch.replacement[0]]) + ")", { ...h.globals, plugin: f.plugin });
        const contextCalls: unknown[][] = [];
        for (const size of [1, 2, 4, 1]) {
            const props = Object.freeze({ party: party(size), onUserContextMenu: (...args: unknown[]) => contextCalls.push(args), smynHovered: true });
            const native = original(props);
            const beforeHooks = f.hooks();
            const rendered = patched(props);
            assert.equal(f.hooks() - beforeHooks, 1, "changing group size must not change settings hook order");
            assert.equal(comparable({ ...rendered.props, title: null }), comparable({ ...native.props, title: null }));
            if (size === 1) {
                assert.equal(rendered.props.title.props.name, "Username-0");
                assert.equal(rendered.props.title.props.animate, true);
            } else assert.equal(rendered.props.title, native.props.title, "grouped activity must name everyone");
            rendered.props.onContextMenu("event");
            assert.equal(contextCalls.at(-1)?.[1], props.party.priorityMembers[0].user);
            assert.equal(rendered.props.onSubtitleClick, h.onGameClick);
        }
        const props = Object.freeze({ party: party(), onUserContextMenu() {}, smynHovered: true });
        f.accessibility.useReducedMotion = true;
        assert.equal(patched(props).props.title.props.animate, false);
        f.accessibility.displayNameStylesEnabled = false;
        assert.equal(patched(props).props.title, "Username-0");
        f.streamerMode.enabled = true;
        f.settings.truncateAllNamesWithStreamerMode = true;
        assert.equal(patched(props).props.title, "U...");
        f.settings.memberList = false;
        assert.equal(patched(props).props.title, original(props).props.title);
        f.settings.memberList = true;
        f.accessibility.displayNameStylesEnabled = true;
        f.accessibility.useReducedMotion = false;
        f.settings.styleActiveNow = false;
        f.settings.alwaysAnimateEffects = false;
        const staticTitle = patched({ ...props, smynHovered: false }).props.title;
        assert.equal(staticTitle.props.showStaticEffect, false);
        assert.equal(staticTitle.props.animate, false);
    });

    for (const quest of [false, true]) test(channel + ": " + (quest ? "quest" : "regular") + " card forwards hover and preserves native controls", () => {
        const { plugin, patch } = pluginFixture();
        const h = hostFixture(fixture);
        const original = runInNewContext("(" + fixture.card + ")", h.globals);
        const patched = runInNewContext("(" + apply(fixture.card, patch.replacement.slice(1)) + ")", { ...h.globals, plugin });
        const nativeEvents: string[] = [];
        const originalProps = Object.freeze({
            onMouseLeave: () => nativeEvents.push("leave"), onMouseDown: () => nativeEvents.push("down"),
            onClick: () => nativeEvents.push("click"), onKeyDown: () => nativeEvents.push("key"),
            onKeyPress: () => nativeEvents.push("keypress"), "data-native": "preserved"
        });
        const props = Object.freeze({ party: party(), quest: quest ? Object.freeze({ id: "quest", userStatus: null }) : undefined,
            onUserContextMenu() {}, onChannelContextMenu() {}, hasStaffQuestActivityPanelOverride: false });
        const questRef = { current: null as unknown };
        const render = () => { h.reset(); return nativeCard(patched(props), quest, originalProps, questRef); };
        const native = nativeCard(original(props), quest, originalProps, questRef);
        const first = render();
        assert.equal(comparable(first), comparable(native));
        assert.equal(cardHeader(first, quest).props.smynHovered, false);
        assert.equal(first.props["aria-haspopup"], "menu");
        first.props.onMouseEnter({});
        assert.deepEqual(h.events.slice(-2), ["analytics", "state:true"]);
        assert.equal(cardHeader(render(), quest).props.smynHovered, true);
        first.props.onMouseLeave({});
        assert.deepEqual(nativeEvents, ["leave"]);
        assert.equal(cardHeader(render(), quest).props.smynHovered, false);
        if (quest) {
            const node = {};
            first.props.ref(node);
            assert.equal(questRef.current, node);
            function exercise(card: any) {
                nativeEvents.length = 0;
                const event = { stopPropagation: () => nativeEvents.push("stop"), preventDefault: () => nativeEvents.push("prevent"), key: "Enter", interactive: false };
                card.props.onMouseDown(event);
                card.props.onClick(event);
                card.props.onKeyDown(event);
                card.props.onKeyPress(event);
                card.props.onClick({ ...event, interactive: true });
                return [...nativeEvents];
            }
            assert.deepEqual(exercise(first), exercise(native), "quest disclosure and keyboard handlers must keep their behavior");
        } else {
            assert.equal(first.props.ref, h.ref);
            assert.equal(first.props.onClick, originalProps.onClick);
            assert.equal(first.props.onKeyDown, originalProps.onKeyDown);
        }
    });
}
