/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { chooseFile, saveFile } from "../src/utils/web";

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

test("chooseFile removes its input if opening the picker throws", async t => {
    const failure = new Error("picker unavailable");
    const input = { type: "", accept: "", style: {}, click() { throw failure; }, remove: t.mock.fn() };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => input, body: { appendChild() {} } } });
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, "document", previous);
        else Reflect.deleteProperty(globalThis, "document");
    });
    await assert.rejects(chooseFile("text/plain"), error => error === failure);
    assert.equal(input.remove.mock.callCount(), 1);
});

test("saveFile releases the original object URL and temporary anchor even when clicking throws", async t => {
    const revoked: string[] = [];
    t.mock.method(URL, "createObjectURL", () => "blob:fixture");
    t.mock.method(URL, "revokeObjectURL", url => { revoked.push(url); });
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, "document", previous);
        else Reflect.deleteProperty(globalThis, "document");
    });
    for (const fails of [false, true]) {
        const failure = new Error("download unavailable");
        const anchor = {
            href: "", download: "", remove: t.mock.fn(),
            click() { this.href = "changed"; if (fails) throw failure; }
        };
        Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => anchor, body: { appendChild() {} } } });
        const save = () => saveFile(new File(["fixture"], "fixture.txt"));
        if (fails) assert.throws(save, error => error === failure);
        else save();
        assert.equal(anchor.remove.mock.callCount(), 0, "download gets one turn to consume the URL");
        await setImmediate();
        assert.equal(anchor.remove.mock.callCount(), 1);
        assert.equal(anchor.download, "fixture.txt");
    }
    assert.deepEqual(revoked, ["blob:fixture", "blob:fixture"]);
});
