/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { keybindSettings } from "./fixtures/discordWebKeybinds";
import { evaluate, jsx, pluginPatches, React, sourceNode } from "./utils/discordClientFixture";

const pluginPath = "src/plugins/webPWA.browser/index.tsx";

test("WebPWA restores the browser keybind instructions and keeps native settings and same-origin shortcut actions", () => {
    const messages: unknown[][] = [];
    const origin = "https://discord.com";
    const render = sourceNode(pluginPath, node => ts.isPropertyAssignment(node) && node.name.getText() === "renderKeybindsButton");
    const plugin = evaluate("({" + render + "})", {
        React, window: { location: { origin }, postMessage: (...args: unknown[]) => messages.push(args) }
    });
    const replacement = pluginPatches(pluginPath, { IS_USERSCRIPT: false })[2].replacement;
    assert.equal(replacement.predicate(), true);
    const match = canonicalizeMatch(replacement.match);
    assert.equal([...keybindSettings.matchAll(new RegExp(match.source, "g"))].length, 1);
    const source = keybindSettings.replace(match, canonicalizeReplace(replacement.replace, "plugin"));
    const globals = {
        S: { jsx }, sQ: "native-keybinds", iJ: { w: "notice" },
        U: { intl: { format: () => "Original browser download notice" }, t: { mPi3F3: "browser-notice" } },
        I: { X7G: { DOWNLOAD: "https://discord.com/download" } }
    };
    const native = runInNewContext("(" + source + ")", { ...globals, nf: { Av: true }, plugin })();
    assert.equal(native.type, "native-keybinds");
    assert.equal(Object.keys(native.props).length, 0);
    assert.deepEqual(messages, []);
    const browser = runInNewContext("(" + source + ")", { ...globals, nf: { Av: false }, plugin })();
    assert.equal(browser.type, "notice");
    assert.equal(browser.props.type, "info");
    assert.equal(browser.props.role, "static");
    assert.deepEqual(Object.keys(browser.props).sort(), ["message", "role", "type"], "the old notice must not leak into an unused property");
    assert.equal(browser.props.message.type, "div");
    const link = browser.props.message.props.children.find((child: any) => child?.type === "a");
    assert.ok(link, "the extension shortcuts action must be rendered inside the visible notice message");
    assert.deepEqual(messages, [], "rendering must not open extension settings");
    link.props.onClick();
    assert.equal(messages.length, 1);
    assert.equal(JSON.stringify(messages[0]), JSON.stringify([{ type: "OPEN_SHORTCUTS" }, origin]));
    assert.equal(pluginPatches(pluginPath, { IS_USERSCRIPT: true })[2].replacement.predicate(), false);
});
