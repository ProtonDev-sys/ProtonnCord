/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";

const { outputText } = transpileModule(readFileSync("src/plugins/_api/messagePopover.ts", "utf8"), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
});
const plugin = runInNewContext(`${outputText}\nexports.default;`, {
    exports: {},
    require(name: string) {
        if (name === "@utils/constants") return { Devs: {} };
        assert.equal(name, "@utils/types");
        return { __esModule: true, default: (definition: unknown) => definition };
    }
});
const replacement = plugin.patches[0].replacement;
const match = canonicalizeMatch(replacement.match);

interface Element {
    type: unknown;
    props: { label?: string; message?: object; children?: Array<Element | null>; };
}

function leaves(element: Element | null): Element[] {
    if (!element) return [];
    return element.props.children ? Array.from(element.props.children).flatMap(leaves) : [element];
}

for (const button of ["B", "nt.qv"]) {
    for (const canReact of [true, false]) {
        test(`message popovers preserve native and plugin buttons with ${button} and reactions ${canReact ? "allowed" : "disabled"}`, () => {
            // Reduced from Discord's toolbar: native action, quick reactions and divider,
            // add-reaction popout, then the remaining native actions.
            const source = `function(u,n){return(0,a.jsxs)("toolbar",{children:[!0?(0,a.jsx)(${button},{label:"before"}):null,u?(0,a.jsxs)(a.Fragment,{children:[(0,a.jsxs)(a.Fragment,{children:[(0,a.jsx)(nu,{message:n}),(0,a.jsx)(nt.$$,{})]}),(0,a.jsx)(ni,{togglePopout:D,message:n})]}):null,(0,a.jsx)(${button},{label:"after"})]})}`;
            const captures = match.exec(source);
            assert.ok(captures, "the toolbar patch must match the host component expression");
            assert.equal(captures[2], button);
            assert.equal(captures[3], "u");
            assert.equal(captures[4], "n");
            const patched = source.replace(match, replacement.replace);
            assert.equal(patched.split("_buildPopoverElements(").length - 1, 1);

            const component = {};
            const message = { id: "message" };
            const pluginButton: Element = { type: "plugin", props: {} };
            let builds = 0;
            const jsx = (type: unknown, props: Element["props"]): Element => ({ type, props });
            const globals = {
                a: { jsx, jsxs: jsx, Fragment: "fragment" },
                B: component, nt: { qv: component, $$: "divider" },
                nu: "quick-reactions", ni: "add-reaction", D() { },
                Vencord: { Api: { MessagePopover: {
                    _buildPopoverElements(receivedComponent: unknown, receivedMessage: unknown) {
                        assert.equal(receivedComponent, component);
                        assert.equal(receivedMessage, message);
                        builds++;
                        return pluginButton;
                    }
                } } }
            };
            const original = leaves(runInNewContext(`(${source})`, globals)(canReact, message));
            const actual = leaves(runInNewContext(`(${patched})`, globals)(canReact, message));
            assert.equal(builds, 1, "plugin buttons must remain available without reaction permission");
            assert.deepEqual(actual.filter(element => element !== pluginButton), original);
            assert.deepEqual(actual.map(element => element.props.label ?? element.type), canReact
                ? ["before", "quick-reactions", "divider", "plugin", "add-reaction", "after"]
                : ["before", "plugin", "after"]);
        });
    }
}
