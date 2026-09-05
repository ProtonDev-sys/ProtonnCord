/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function loadComponent(path: string, hooks: Record<string, unknown> = {}) {
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const mocks: Record<string, object> = {
        "@webpack/common": { React, ...hooks },
        "@components/BaseText": { BaseText: "div" },
        "@utils/css": { classNameFactory: (prefix: string) => (...names: string[]) => names.map(name => prefix + name).join(" ") },
        "@utils/misc": { classes: (...names: unknown[]) => names.filter(Boolean).join(" ") }
    };
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, React,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

test("disabled links have no destination and suppress click callbacks", () => {
    const { Link } = loadComponent("src/components/Link.tsx");
    let clicked = 0;
    let prevented = 0;
    const props = { href: "https://example.com", onClick: () => clicked++ };
    const disabled = Link({ ...props, disabled: true });
    assert.equal(disabled.props.href, undefined);
    disabled.props.onClick({ preventDefault: () => prevented++ });
    assert.equal(clicked, 0);
    assert.equal(prevented, 1);
    const enabled = Link(props);
    assert.equal(enabled.props.href, props.href);
    enabled.props.onClick();
    assert.equal(clicked, 1);
});

test("grid layout props stay in styles instead of leaking to the DOM", () => {
    const { Grid } = loadComponent("src/components/Grid.tsx");
    const { props } = Grid({ columns: 3, gap: "8px", inline: true, id: "grid", style: { gap: "12px" } });
    assert.equal(props.id, "grid");
    for (const key of ["columns", "gap", "inline"]) assert.equal(key in props, false);
    assert.equal(props.style.display, "inline-grid");
    assert.equal(props.style.gap, "12px");
    assert.equal(props.style.gridTemplateColumns, "repeat(3, 1fr)");
});

test("legacy text colors do not mutate a shared or frozen style object", () => {
    const { TextCompat } = loadComponent("src/components/BaseText.tsx");
    const style = Object.freeze({ color: "original", margin: 4 });
    const result = TextCompat({ style, color: "text-muted", children: "text" });
    assert.equal(style.color, "original");
    assert.equal(result.props.style.color, "var(--text-muted, var(--text-default))");
    assert.equal(result.props.style.margin, 4);
    assert.notEqual(result.props.style, style);
});

for (const action of ["Enter", "Escape", "blur"]) {
    test(`editable text uses the current value and handles ${action} once`, () => {
        let editing = false;
        const { EditableText } = loadComponent("src/components/settings/EditableText.tsx", {
            useState: () => [editing, (value: boolean) => { editing = value; }]
        });
        const changes: string[] = [];
        const onChange = (value: string) => changes.push(value);
        EditableText({ value: "old", onChange });
        EditableText({ value: "current", onChange }).props.onClick();
        const input = EditableText({ value: "current", onChange });
        assert.equal(input.props.defaultValue, "current");
        assert.equal(input.props.autoFocus, true);
        const target = { value: "edited", blur: () => input.props.onBlur({ currentTarget: target }) };
        if (action === "blur") target.blur();
        else {
            let prevented = false;
            input.props.onKeyDown({ key: action, currentTarget: target, preventDefault() { prevented = true; } });
            assert.equal(prevented, true, "editing keys must not submit a surrounding form");
        }
        assert.deepEqual(changes, action === "Escape" ? [] : ["edited"]);
        assert.equal(editing, false);
    });
}
