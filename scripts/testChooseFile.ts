/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { chooseFile } from "../src/utils/web";

for (const action of ["select", "empty", "cancel"] as const) {
    test(`chooseFile settles after ${action} and removes its input`, async t => {
        const selected = new File(["fixture"], "fixture.txt", { type: "text/plain" });
        const input = {
            type: "", style: { display: "" }, accept: "",
            files: action === "select" ? [selected] : [],
            onchange: undefined as (() => void) | undefined,
            oncancel: undefined as (() => void) | undefined,
            click: t.mock.fn(),
            remove: t.mock.fn()
        };
        const body = { appendChild: t.mock.fn(), removeChild: t.mock.fn() };
        const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
        Object.defineProperty(globalThis, "document", {
            configurable: true,
            value: { createElement: () => input, body }
        });
        t.after(() => {
            if (previous) Object.defineProperty(globalThis, "document", previous);
            else Reflect.deleteProperty(globalThis, "document");
        });

        let result: File | null | undefined;
        const pending = chooseFile("text/plain").then(file => { result = file; });
        await setImmediate();
        assert.equal(input.type, "file");
        assert.equal(input.accept, "text/plain");
        assert.equal(input.click.mock.callCount(), 1);
        assert.equal(body.appendChild.mock.calls[0].arguments[0], input);
        assert.equal(body.removeChild.mock.callCount(), 0);
        assert.equal(input.remove.mock.callCount(), 0);
        assert.equal(result, undefined);

        const onComplete = input[action === "cancel" ? "oncancel" : "onchange"];
        assert.ok(onComplete);
        onComplete();
        await pending;
        assert.equal(result, action === "select" ? selected : null);
        assert.equal(input.remove.mock.callCount(), 1);
        await setImmediate();
        assert.equal(body.removeChild.mock.callCount(), 0);
    });
}
