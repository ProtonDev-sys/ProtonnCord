/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { messageReactions, typingIndicator } from "./fixtures/discordChatControls";
import { applyPatch, declaration, jsx, pluginPatches } from "./utils/discordClientFixture";

function elements(value: any): any[] {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap(elements);
    return [value, ...elements(value.props?.children)];
}

test("SilentTyping hides current visual and accessible typing indicators while preserving slowmode and native hook order", () => {
    const path = "src/plugins/silentTyping/index.tsx";
    const patch = pluginPatches(path).find((patch: any) => patch.find === "activityInviteEducationActivity:");
    const source = applyPatch(typingIndicator, patch);
    let hide = false;
    const hooks: string[] = [];
    const plugin = { shouldHideChatBarTypingIndicators: declaration(path, "shouldHideChatBarTypingIndicators", {
        settings: { use(keys: string[]) { assert.deepEqual(Array.from(keys), ["hideChatBoxTypingIndicators"]); hooks.push("settings"); return { hideChatBoxTypingIndicators: hide }; } }
    }) };
    const render = runInNewContext(`(${source})`, {
        plugin, n: { jsx, jsxs: jsx, Fragment: "fragment" },
        s: { useRef: () => { hooks.push("ref"); return { current: null }; }, useState: () => { hooks.push("state"); return [false, () => {}]; }, useCallback: (fn: Function) => { hooks.push("callback"); return fn; } },
        F: { v: () => true }, I: { g: () => hooks.push("resize") }, a: () => () => "outer",
        H: { IW: "outer", Il: "text-channel", y5: "typing", Qq: "typing-text", y4: "announcement" },
        W: { intl: { format: (_key: unknown, names: object) => Object.values(names).join(", ") }, t: {} },
        T: { A: "legacy-invite" }, _: "slowmode", Z: "activity-education", z: "typing-dots", c: { n: "typing-dots" }
    });
    const users = Object.freeze(["Alice", "Bob"]);
    const channel = Object.freeze({ id: "channel", rateLimitPerUser: 10 });
    const props = Object.freeze({ typingUsers: users, channel, isFocused: true, isInTextChannel: true });
    let visible = elements(render(props));
    assert.equal(visible.find(node => node.props.className === "typing").props.children.length, 3);
    assert.equal(visible.find(node => node.props["aria-live"] === "polite").props.children, "Alice, Bob");
    const expectedHooks = hooks.splice(0);
    assert.equal(expectedHooks[0], "settings");
    hide = true;
    const hidden = elements(render(props));
    assert.equal(hidden.find(node => node.props.className === "typing").props.children.length, 0);
    assert.equal(hidden.find(node => node.props["aria-live"] === "polite").props.children, "");
    assert.equal(hidden.find(node => node.type === "slowmode").props.channel, channel);
    assert.deepEqual(hooks.splice(0), expectedHooks, "toggling visibility must not change hook order");
    assert.equal(elements(render({ ...props, renderSlowmode: false })).some(node => node.type === "slowmode"), false);
    const activity = Object.freeze({ id: "activity" });
    const empty = { typingUsers: [], channel: { ...channel, rateLimitPerUser: 0 }, activityInviteEducationActivity: activity };
    assert.equal(elements(render(empty)).find(node => node.type === "activity-education").props.activity, activity);
    assert.equal(elements(render({ ...empty, shouldShowLegacyGameInviteCreationBanner: true })).some(node => node.type === "legacy-invite"), true);
    hide = false;
    visible = elements(render(props));
    assert.equal(visible.find(node => node.props["aria-live"] === "polite").props.children, "Alice, Bob");
    assert.deepEqual(users, ["Alice", "Bob"]);
    assert.equal(props.channel, channel);
});

test("ShowAllMessageButtons restores optional quick reactions while preserving reaction permissions, picker props and separator", () => {
    const settings = { store: { noQuickReacts: false } };
    const patch = pluginPatches("src/plugins/showAllMessageButtons/index.ts", { settings })[0];
    const replacement = patch.replacement.find((entry: any) => String(entry.match).includes("null:"));
    const source = applyPatch(messageReactions, { replacement });
    const channel = Object.freeze({ id: "channel" }), message = Object.freeze({ id: "message" });
    const toggle = () => {}, picker = () => {};
    const globals = { a: { jsx, jsxs: jsx, Fragment: "fragment" }, nh: "quick-reactions", nt: { $$: "separator" }, ns: "picker", t: channel, n: message, D: toggle, nA: picker, I: true, T: true };
    for (const canReact of [false, true]) for (const expanded of [false, true]) {
        const result = runInNewContext(`(${source})`, { ...globals, h: canReact, E: expanded });
        if (!canReact) { assert.equal(result, null, "the native permission guard must remain authoritative"); continue; }
        const nodes = elements(result);
        assert.equal(nodes.filter(node => node.type === "quick-reactions").length, 1);
        assert.equal(nodes.filter(node => node.type === "separator").length, 1);
        const control = nodes.find(node => node.type === "picker");
        assert.equal(control.props.togglePopout, toggle);
        assert.equal(control.props.renderEmojiPicker, picker);
        assert.equal(control.props.shouldShow, true);
        assert.equal(control.props.isFocused, true);
        assert.equal(control.props.channel, channel);
        assert.equal(control.props.message, message);
    }
    assert.equal(replacement.predicate(), true);
    settings.store.noQuickReacts = true;
    assert.equal(replacement.predicate(), false);
    const native = runInNewContext(`(${messageReactions})`, { ...globals, h: true, E: true });
    assert.equal(elements(native).some(node => node.type === "quick-reactions"), false);
    assert.equal(elements(native).filter(node => node.type === "picker").length, 1);
});
