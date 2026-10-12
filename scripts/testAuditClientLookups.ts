import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordChannelRouterSource, discordFocusLockSource, discordGuildlessSource, discordHeaderBarSource, discordProfileExportsSource, discordSearchBarSource, discordSettingsExportsSource, discordSwitchSource } from "./fixtures/discordClientLookups";
import { declaration, evaluate, filters, findComponent, host, jsx, React, sourceNode } from "./utils/discordClientFixture";

test("ChannelRouter resolves the channel action and preserves routing and voice-chat behavior", () => {
    const routes: unknown[][] = [];
    const preloads: unknown[][] = [];
    const chats: unknown[][] = [];
    const channel = { id: "voice", guild_id: "guild", isGuildVocal: () => true };
    const exports = host(discordChannelRouterSource, {
        284009: (condition: boolean, message: string) => assert.ok(condition, message),
        652215: { BVt: { CHANNEL: (...args: unknown[]) => args } },
        734057: { A: { getChannel: (id: string) => id === channel.id ? channel : null } },
        367513: { A: { updateChatOpen: (...args: unknown[]) => chats.push(args) } },
        976860: { pX: (...args: unknown[]) => routes.push(args) },
        377480: { A: (...args: unknown[]) => preloads.push(args) },
        162199: { j: (value: any) => value.guild_id }
    });
    const router = declaration("src/webpack/common/utils.ts", "ChannelRouter", {
        filters,
        mapMangledModuleLazy: (_code: string, mappers: Record<string, Function>) => Object.fromEntries(Object.entries(mappers).map(([key, filter]) => {
            const matches = Object.values(exports).filter(value => filter(value));
            assert.equal(matches.length, 1, key);
            return [key, matches[0]];
        }))
    });
    router.transitionToChannel("missing");
    assert.equal(routes.length, 0);
    router.transitionToChannel("voice", { openTextInVoiceIfVoiceChannel: true });
    assert.deepEqual(preloads, [["guild", "voice"]]);
    assert.deepEqual(chats, [["voice", true]]);
    assert.deepEqual(Array.from(routes[0][0] as unknown[]), ["guild", "voice"]);
    const thread = { id: "thread", parent_id: "parent", guild_id: "guild" };
    router.transitionToThread(thread);
    assert.deepEqual(Array.from(routes[1][0] as unknown[]), ["guild", "thread"]);
    assert.throws(() => router.transitionToThread({ ...thread, parent_id: null }), /Thread must have a parent ID/);
});

test("settings and profile lookups use the current public open actions without retired close/key exports", () => {
    const calls: unknown[] = [];
    const open = (...args: unknown[]) => calls.push(args);
    const settings = host(`function(e,t,n){${discordSettingsExportsSource}}`, {}, { A: open });
    const profile = host(`function(e,t,n){${discordProfileExportsSource}}`, {}, { I: open });
    const settingsWait = sourceNode("src/webpack/common/utils.ts", node => ts.isExpressionStatement(node) && node.getText().startsWith("waitFor(") && node.getText().includes("SettingsRouter = m"));
    const router = evaluate(`${settingsWait}\nSettingsRouter;`, {
        SettingsRouter: undefined,
        waitFor: (props: string | string[], callback: Function) => {
            if (filters.byProps(...(Array.isArray(props) ? props : [props]))(settings)) callback(settings);
        }
    });
    assert.equal(router, settings);
    const actions = declaration("src/webpack/common/utils.ts", "UserProfileActions", {
        findByPropsLazy: (...props: string[]) => filters.byProps(...props)(profile) ? profile : undefined
    });
    assert.equal(actions, profile);
    router.openUserSettings("Account");
    const request = { userId: "user", guildId: "guild" };
    actions.openUserProfileModal(request);
    assert.deepEqual(calls, [["Account"], [request]]);
});

test("FocusLock selects the public wrapper and passes its container and children to the current host hook", () => {
    const locks: unknown[][] = [];
    const exports = host(discordFocusLockSource, {
        582128: { useRef: (current: unknown) => ({ current }), useLayoutEffect() {}, useMemo: (get: Function) => get() },
        557361: { Ay: (...args: unknown[]) => locks.push(args) }
    }, { document: {} });
    const Component = declaration("src/webpack/common/components.ts", "FocusLock", {
        filters,
        waitForComponent: (_name: string, filter: Function) => {
            const matches = Object.values(exports).filter(value => filter(value));
            assert.equal(matches.length, 1);
            return matches[0];
        }
    });
    const ref = { current: null };
    const children = { fixture: "settings modal" };
    assert.equal(Component({ containerRef: ref, children }), children);
    assert.equal(locks[0][0], ref);
});

test("the file picker resolves the public search input with controlled query, autofocus, clear, and ref props", () => {
    const changes: string[] = [];
    const exports = host(discordSearchBarSource, {
        477900: { jsx }, 7689: { MagnifyingGlassIcon: "search-icon" },
        460890: { G9: () => ({ i18n: { SEARCH: "Search" } }) }, 95477: { k: "input" }
    });
    const SearchBar = declaration("src/equicordplugins/favouriteAnything/components.tsx", "ManaSearchBar", { findComponentByCodeLazy: findComponent(exports) });
    const ref = { current: null };
    const node = SearchBar({ query: "image", autoFocus: true, ref, placeholder: "Search files", onChange: (value: string) => changes.push(value), onClear: () => changes.push("") });
    assert.equal(node.type, "input");
    assert.equal(node.props.value, "image");
    assert.equal(node.props.autoFocus, true);
    assert.equal(node.props.inputRef, ref);
    assert.equal(node.props.placeholder, "Search files");
    assert.equal(node.props.clearable, true);
    node.props.onChange("audio"); node.props.onClear();
    assert.deepEqual(changes, ["audio", ""]);
    assert.equal(SearchBar({}).props.placeholder, "Search");
    assert.equal(SearchBar({}).props.clearable, false);
});

test("Questify switches retain labels, accessibility IDs, disabled state and the host icon preference", () => {
    let iconPreference = true;
    const exports = host(discordSwitchSource, {
        477900: { jsx }, 582128: { useContext: () => ({ switchIconsEnabled: iconPreference }) },
        452027: { D: "form-control" }, 489718: { I: "switch" }
    });
    const Switch = declaration("src/equicordplugins/questify/components/shared.tsx", "SwitchWithLabel", { findComponentByCodeLazy: findComponent(exports) });
    const onChange = () => {};
    for (iconPreference of [true, false]) {
        const wrapper = Switch({ checked: true, disabled: true, label: "Quest setting", description: "Details", onChange });
        const control = wrapper.type(wrapper.props);
        assert.equal(control.props.label, "Quest setting");
        assert.equal(control.props.description, "Details");
        const input = control.props.children({ controlId: "control", describedById: "description", labelId: "label" });
        assert.equal(input.props.hasIcon, iconPreference);
        assert.equal(input.props.checked, true);
        assert.equal(input.props.disabled, true);
        assert.equal(input.props.onChange, onChange);
        assert.equal(input.props.labelledBy, "label");
        assert.equal(input.props.describedBy, "description");
    }
    assert.equal(Switch({ hasIcon: true }).props.hasIcon, true);
});

test("channel toolbar buttons preserve tooltip placement, badges and disabled click semantics", () => {
    const exports = host(discordHeaderBarSource, {
        477900: { jsx, jsxs: jsx, Fragment: "fragment" }, 582128: { useMemo: (get: Function) => get() },
        503698: (...args: any[]) => args.flatMap(arg => typeof arg === "object" ? Object.keys(arg).filter(key => arg[key]) : arg).filter(Boolean).join(" "),
        939249: { D: "clickable" }, 866665: { m: "tooltip" },
        573435: { Ay: Object.assign("mask", { Masks: { HEADER_BAR_BADGE_TOP: "top", HEADER_BAR_BADGE_BOTTOM: "bottom" } }) },
        114640: { wH: "selected" }
    });
    const HeaderBarIcon = declaration("src/api/HeaderBar.tsx", "HeaderBarIcon", { findComponentByCodeLazy: findComponent(exports) });
    const Button = declaration("src/api/HeaderBar.tsx", "ChannelToolbarButton", { React, HeaderBarIcon });
    const onClick = () => {};
    const onContextMenu = () => {};
    for (const disabled of [false, true]) {
        const element = Button({ icon: "icon", tooltip: "Open", position: "left", selected: true, disabled, showBadge: true, badgePosition: "bottom", onClick, onContextMenu });
        const tooltip = element.type(element.props);
        const clickable = tooltip.props.children;
        assert.equal(tooltip.props.position, "left");
        assert.equal(clickable.props["aria-label"], "Open");
        assert.equal(clickable.props.onClick, disabled ? undefined : onClick);
        assert.equal(clickable.props.onContextMenu, disabled ? undefined : onContextMenu);
        assert.equal(clickable.props.tabIndex, disabled ? -1 : 0);
        assert.match(clickable.props.className, /selected/);
        const badge = clickable.props.children[0];
        assert.equal(badge.props.badge.position, "bottom");
        assert.equal(badge.props.badge.type, "important");
        const badgeRenderer = badge.type(badge.props);
        assert.equal(badgeRenderer.type(badgeRenderer.props).props.children[0].props.mask, "bottom");
    }
    const element = Button({ icon: "icon", tooltip: null, onClick });
    const tooltip = element.type(element.props);
    assert.equal(tooltip.props.shouldShow, false);
    assert.equal(tooltip.props.children.props.children[0].props.badge, undefined);
});

test("Questify exports the current guildless button and preserves mouse actions, ref, selection and badge props", () => {
    const patchSource = sourceNode("src/equicordplugins/questify/index.tsx", node => ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText() === "find" && ts.isStringLiteral(property.initializer) && property.initializer.text === '=\"DOWNLOAD_APPS\";function'));
    const patch = evaluate(`const patch=${patchSource};patch;`, {});
    const patched = discordGuildlessSource.replace(canonicalizeMatch(patch.replacement.match), canonicalizeReplace(patch.replacement.replace, "plugin"));
    assert.notEqual(patched, discordGuildlessSource, "the public export patch must match the current React ref signature");
    const exports = host(patched, { 93776: {} }, {
        rg() {}, a: { jsx, jsxs: jsx }, s: { useState: () => [false, () => {}] }, _: { Vd: () => ({ role: "treeitem" }) },
        F: { c: "container" }, k: { A: "pill" }, M: { Q: "mask" }, tO: { D: "clickable" }, o: () => () => "button"
    });
    const Button = declaration("src/equicordplugins/questify/components/questButton.tsx", "GuildlessServerListItemComponent", { findComponentByCodeLazy: findComponent(exports) });
    const ref = { current: null };
    const onPress = () => {};
    const badge = { count: 2 };
    const node = Button({ ref, id: "quests", tooltip: "Quests", icon: "icon", selected: true, showPill: false, lowerBadge: badge, lowerBadgeSize: { width: 18 }, onClick: onPress, onMouseDown: onPress, onContextMenu: onPress });
    assert.equal(node.props.children[0], null);
    const mask = node.props.children[1].props.children;
    assert.equal(mask.props.lowerBadge, badge);
    assert.equal(mask.props.lowerBadgeSize.width, 18);
    const button = mask.props.children;
    assert.equal(button.props.innerRef, ref);
    assert.equal(button.props["aria-selected"], true);
    assert.equal(button.props["aria-label"], "Quests");
    assert.equal(button.props.onClick, onPress);
    assert.equal(button.props.onMouseDown, onPress);
    assert.equal(button.props.onContextMenu, onPress);
});
