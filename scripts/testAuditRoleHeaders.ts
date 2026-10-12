/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordRoleGroupSource } from "./fixtures/discordRoleGroup";
import { loadTestModule } from "./utils/loadTestModule";

function fixture() {
    const jsx = (type: unknown, props: object) => ({ type, props });
    const React = {
        createElement: (type: unknown, props: object, ...children: unknown[]) =>
            jsx(type, { ...props, children: children.length === 1 ? children[0] : children })
    };
    const imports = {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }), Settings: {} },
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Icons": {}, "@utils/clipboard": {}, "@utils/guards": {}, "@utils/misc": {},
        "@equicordplugins/customUserColors": {},
        "@utils/constants": { Devs: {} }, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/discord": {}, "@utils/Logger": { Logger: class {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, makeRange: () => [], OptionType: {} },
        "@webpack": { findByPropsLazy: () => ({}), findByCodeLazy: () => () => {}, findCssClassesLazy: () => ({}) },
        "@webpack/common": { GuildRoleStore: { getRole: (_guild: string, id: string) => id === "role" ? { colorString: "#123456" } : undefined } },
    };
    const clickable = loadTestModule("src/equicordplugins/clickableRoles/index.tsx", imports, { React }).default;
    const color = loadTestModule("src/plugins/roleColorEverywhere/index.tsx", imports, { React }).default;
    const context = loadTestModule("src/plugins/betterRoleContext/index.tsx", imports, { React }).default;
    const patches = {
        clickable: clickable.patches[1].replacement,
        color: color.patches.find((patch: any) => patch.find === 'tutorialId:"whos-online').replacement[0],
        context: context.patches[0].replacement
    };
    function render(order: Array<keyof typeof patches>) {
        // Keep an adjacent memo in the declaration: a wrapper must not capture
        // another component when Discord combines declarations with a comma.
        let source = "let " + discordRoleGroupSource + ',adjacent=s.memo(function(){return "unchanged"});({role:em,adjacent})';
        for (const name of order) {
            const patch = patches[name];
            const match = canonicalizeMatch(patch.match);
            assert.equal(source.match(new RegExp(match.source, "g"))?.length, 1, name + " must select only the role header");
            source = source.replace(match, canonicalizeReplace(patch.replace, name));
        }
        let memoCount = 0;
        const components = runInNewContext(source, {
            clickable, color, context, l: { jsx, jsxs: jsx }, s: { memo: (component: unknown) => { memoCount++; return component; } },
            G: { Xx: () => ({ icon: "role-icon" }) }, eo: { clD: { UNKNOWN: "unknown" } },
            ec: { lL: "group", k1: "placeholder", UT: "icon" }, k: { A: "heading" }, U: { A: "role-icon" },
            z: { t: { Uaqbke: "member-label" }, intl: { formatToPlainString: (_key: string, { title, count }: any) => title + ": " + count } }
        });
        assert.equal(memoCount, 2, "both original memo boundaries are retained");
        assert.equal(components.adjacent(), "unchanged");
        return components.role;
    }
    return { render, context };
}

test("role colors preserve Discord's accessible label, hidden visual span, icon and count", () => {
    const role = fixture().render(["color"]);
    const rendered = role({ id: "role", label: "Moderators", count: 4, guildId: "guild" });
    assert.equal(rendered.props["aria-label"], "Moderators: 4");
    assert.equal(rendered.props.children[0].type, "role-icon");
    const visual = rendered.props.children[1];
    assert.equal(visual.props["aria-hidden"], true);
    const colored = visual.props.children[0];
    assert.equal(colored.props.style.color, "#123456");
    assert.deepEqual(Array.from(colored.props.children), ["Moderators", " — ", 4]);
});

test("role color, context menu and click wrappers compose in all orders without losing menu arguments", () => {
    const orders = [
        ["context", "color", "clickable"], ["context", "clickable", "color"],
        ["color", "context", "clickable"], ["color", "clickable", "context"],
        ["clickable", "context", "color"], ["clickable", "color", "context"]
    ] as const;
    for (const order of orders) {
        const { render, context } = fixture();
        const calls: unknown[][] = [];
        context.openRoleContextMenu = (...args: unknown[]) => calls.push(args);
        const props = { id: "role", label: "Moderators", count: 4, guildId: "guild" };
        const rendered = render([...order])(props).props.children;
        assert.equal(rendered.props["aria-label"], "Moderators: 4");
        assert.equal(rendered.props.children[0].type, "role-icon");
        const span = rendered.props.children[1];
        assert.equal(span.props["aria-hidden"], true);
        assert.equal(span.props.children[0].props.style.color, "#123456");
        const event = { type: "contextmenu" };
        span.props.onContextMenu(event);
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], event);
        assert.equal(calls[0][1], props);
    }
});

test("clickable and colored role headers compose in either patch order without capturing a neighbor", () => {
    for (const order of [["clickable", "color"], ["color", "clickable"]] as const) {
        const role = fixture().render([...order]);
        const rendered = role({ id: "role", label: "Moderators", count: 4, guildId: "guild" });
        assert.equal(rendered.props.roleId, "role");
        assert.equal(rendered.props.guildId, "guild");
        assert.equal(rendered.props.children.props["aria-label"], "Moderators: 4");
        assert.equal(role({ id: "online", label: "Online", count: 9, guildId: "guild" }).type, "heading",
            "ordinary online/offline groups remain noninteractive");
        assert.equal(role({ id: "unknown", guildId: "guild" }).props.className, "group",
            "the loading placeholder remains intact");
    }
});
