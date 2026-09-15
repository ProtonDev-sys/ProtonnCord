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

import { evaluateExpression } from "../src/equicordplugins/commandPalette/commands/calculator/evaluator";

const base = "src/equicordplugins/commandPalette/";
const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
const flush = () => new Promise(resolve => setImmediate(resolve));
const silentLogger = { Logger: class { error() {} } };

function load(file: string, overrides: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const mocks = {
        "@utils/Logger": silentLogger,
        "@utils/constants": { EquicordDevs: {}, IS_MAC: false },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@utils/css": { classNameFactory: () => () => "" },
        ...overrides
    };
    const code = transpileModule(readFileSync(base + file, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, Promise, console, structuredClone, AbortController,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, `Unexpected import: ${name}`);
            return mocks[name];
        },
        ...globals
    });
}

function hooksHarness() {
    const slots: any[] = [];
    let cursor = 0;
    let pending: (() => void)[] = [];
    const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
    const useState = (initial: unknown) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    };
    const useEffect = (effect: () => unknown, deps?: unknown[]) => {
        const index = cursor++;
        const previous = slots[index];
        if (same(previous?.deps, deps)) return;
        pending.push(() => {
            previous?.cleanup?.();
            slots[index] = { kind: "effect", deps, cleanup: effect() };
        });
    };
    return {
        api: {
            useState, useEffect, useLayoutEffect: useEffect,
            useRef(initial: unknown) { return useState({ current: initial })[0]; },
            useMemo(factory: () => unknown, deps: unknown[]) {
                const index = cursor++;
                if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: factory() };
                return slots[index].value;
            }
        },
        render<T>(component: () => T): T {
            cursor = 0;
            pending = [];
            const result = component();
            for (const effect of pending) effect();
            return result;
        },
        unmount() {
            for (const slot of slots) if (slot?.kind === "effect") slot.cleanup?.();
        }
    };
}

test("calculator follows exponent precedence and accepts signed decimals and whitespace", () => {
    for (const [expression, expected] of [
        ["-2^2", -4], ["(-2)^2", 4], ["2^-2", 0.25], ["2^3^2", 512],
        [".5 + +2.", 2.5], ["2\t+\n3", 5], ["100 + 20%", 120],
        ["20% of 200", 40], ["10 % 3", 1], ["sqrt(9) + ln(1)", 3]
    ] as const) assert.equal(evaluateExpression(expression)?.value, expected, expression);
    for (const input of ["1/0", "sqrt(-1)", "unknown(2)", "2 +", "2..3+1"]) assert.equal(evaluateExpression(input), null, input);
});

test("palette startup waits for stored commands and cannot install callbacks after stop", async () => {
    const pending: (() => void)[] = [];
    let installed = 0;
    let registered = 0;
    let handler: (event: any) => boolean;
    const errors: unknown[] = [];
    const plugin = load("index.tsx", {
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "./api/registry": { clearRegistry() {}, getCommandById: () => ({ actions: [{ run: () => Promise.reject(new Error("action failed")) }] }) },
        "./commands": { registerBuiltinCommands: () => registered++ },
        "./commands/custom": { loadCustomCommands: async () => {} },
        "./settings": { settings: { store: { hotkey: ["ctrl", "p"] } }, DEFAULT_HOTKEY: ["ctrl", "p"] },
        "./state/aliases": { loadAliases: async () => {} },
        "./state/pins": { loadPins: async () => {} },
        "./state/frecency": { loadFrecency: () => new Promise<void>(resolve => pending.push(resolve)), recordUse() {} },
        "./state/hotkeys": { loadHotkeys: async () => {}, getAllHotkeys: () => ({ command: ["ctrl", "k"] }) },
        "./ui/keyboard": {
            comboFromEvent: (event: any) => event.combo,
            comboEquals: (a: string[], b: string[]) => a.join() === b.join(), isEditableTarget: () => false,
            installKeyboardListeners: () => installed++, removeKeyboardListeners() {},
            setGlobalKeyHandler: (next: typeof handler) => { handler = next; }
        },
        "./ui/openPalette": { closePalette() {}, openPalette() {}, togglePalette() {} }
    }).default;
    const staleStart = plugin.start();
    assert.equal(installed, 0);
    plugin.stop();
    pending.shift()!();
    await staleStart;
    assert.equal(registered, 0);
    const currentStart = plugin.start();
    pending.shift()!();
    await currentStart;
    assert.equal(registered, 1);
    assert.equal(installed, 1);
    assert.equal(handler!({ combo: ["ctrl", "k"] }), true);
    await flush();
    assert.equal(errors.length, 1, "asynchronous global-hotkey failures are observed");
});

test("palette persistence ignores obsolete loads, orders writes and observes write failure", async () => {
    let resolveRead: (value: object) => void;
    let finishFirstWrite: () => void;
    const writes: unknown[] = [];
    const errors: unknown[] = [];
    const api = load("state/persist.ts", {
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "../api/registry": { notifyPaletteChange() {} },
        "@api/DataStore": {
            get: () => new Promise(resolve => { resolveRead = resolve; }),
            set(_key: string, value: unknown) {
                writes.push(value);
                return writes.length === 1 ? new Promise<void>(resolve => { finishFirstWrite = resolve; }) : Promise.reject(new Error("disk unavailable"));
            }
        }
    });
    const persisted = api.createPersistedValue("test", {});
    const firstLoad = persisted.load();
    assert.equal(persisted.load(), firstLoad, "simultaneous readers share the request");
    await flush();
    persisted.set({ current: 1 });
    persisted.set({ current: 2 });
    await flush();
    assert.equal(writes.length, 1);
    resolveRead!({ obsolete: true });
    await firstLoad;
    assert.deepEqual(persisted.get(), { current: 2 });
    finishFirstWrite!();
    await flush();
    assert.deepEqual(writes, [{ current: 1 }, { current: 2 }]);
    assert.equal(errors.length, 1);
});

test("bad palette observers and predicates do not hide unrelated commands", () => {
    const api = load("api/registry.ts", {});
    let notified = 0;
    api.subscribePalette(() => { throw new Error("observer failed"); });
    api.subscribePalette(() => notified++);
    api.registerCommands("test", [
        { id: "bad", predicate() { throw new Error("predicate failed"); } },
        { id: "hidden", predicate: () => false }, { id: "visible" }
    ]);
    assert.equal(notified, 1);
    assert.deepEqual(Array.from(api.getVisibleCommands(), (command: any) => command.id), ["visible"]);
    api.unregisterOwner("test");
    assert.equal(notified, 2);
    assert.equal(api.getVisibleCommands().length, 0);
});

test("a form cannot submit twice before rendering and catches validation failures", async () => {
    const hooks = hooksHarness();
    const pending: (() => void)[] = [];
    let sends = 0;
    const spec: any = { fields: [], submit: () => { sends++; return new Promise<void>(resolve => pending.push(resolve)); } };
    const api = load("ui/pages/FormPage.tsx", {
        "@webpack/common": { ...hooks.api, ChannelStore: {} },
        "../markdownPaste": {}, "../MessageMarkdownPreview": {}, "../PaletteIcon": {}
    });
    const formRef: any = { current: null };
    hooks.render(() => api.FormPage({ spec, ctx: {}, formRef }));
    formRef.current.submit();
    formRef.current.submit();
    assert.equal(sends, 1);
    pending.shift()!();
    await flush();
    spec.validate = () => { throw new Error("validation failed"); };
    formRef.current.submit();
    await flush();
    assert.equal(sends, 1);
    delete spec.validate;
    formRef.current.submit();
    assert.equal(sends, 2, "the guard releases after success or a validation error");
    pending.shift()!();
    await flush();
    hooks.unmount();
    assert.equal(formRef.current, null);
});

test("attachment previews release pending image URLs on unmount and partial allocation failure", async () => {
    for (const failSecond of [false, true]) {
        const hooks = hooksHarness();
        const active = new Set<string>();
        const images: any[] = [];
        let allocated = 0;
        const errors: unknown[] = [];
        class PreviewImage {
            onload: unknown;
            onerror: unknown;
            src = "";
            constructor() { images.push(this); }
            removeAttribute() { this.src = ""; }
        }
        const api = load("ui/MessageMarkdownPreview.tsx", {
            "@api/Commands": { generateId: () => String(allocated) },
            "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
            "@components/ErrorBoundary": {}, "@utils/react": { LazyComponent: () => "preview" },
            "@webpack": { findByCodeLazy: () => () => null }, "@webpack/common": hooks.api
        }, {
            Image: PreviewImage,
            URL: {
                createObjectURL() { allocated++; if (failSecond && allocated === 2) throw new Error("allocation failed"); const url = `blob:${allocated}`; active.add(url); return url; },
                revokeObjectURL: (url: string) => active.delete(url)
            }
        });
        hooks.render(() => api.MessageMarkdownPreview({ content: "", files: [{ type: "image/png", name: "image", size: 10 }, { type: "text/plain", name: "text", size: 10 }] }));
        if (failSecond) {
            await flush();
            assert.equal(errors.length, 1);
        } else {
            assert.equal(active.size, 2);
        }
        hooks.unmount();
        assert.equal(active.size, 0, "cleanup does not depend on the image ever finishing loading");
        assert.equal(images[0].onload, null);
        assert.equal(images[0].onerror, null);
        await flush();
    }
});

test("DM forms cancel before sending if the account changes while resolving the channel", async () => {
    let currentUser = "sender";
    let recipient: any = { username: "Recipient" };
    let resolveChannel: (id: string) => void;
    let sent = 0;
    const toasts: string[] = [];
    const api = load("commands/sendDm.tsx", {
        "@utils/discord": {
            openPrivateChannel: () => new Promise<string>(resolve => { resolveChannel = resolve; }),
            sendMessage: async () => { sent++; recipient = undefined; }
        },
        "@utils/misc": {}, "@vencord/discord-types/enums": {}, "../search/ranker": {}, "../ui/icons": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: currentUser }), getUser: () => recipient }, showToast: (message: string) => toasts.push(message), Toasts: { Type: { SUCCESS: "success" } } }
    });
    const { spec } = api.sendDmCommand.page();
    const firstSend = spec.submit({ recipient: "recipient", message: "test" }, { close() {} });
    currentUser = "different-account";
    resolveChannel!("channel");
    await assert.rejects(firstSend, /account changed/);
    assert.equal(sent, 0);
    const secondSend = spec.submit({ recipient: "recipient", message: "test" }, { close() {} });
    resolveChannel!("channel");
    await secondSend;
    assert.equal(sent, 1);
    assert.deepEqual(toasts, ["Message sent to Recipient."]);
});

function findElement(node: any, type: string): any {
    if (node?.type === type) return node;
    for (const child of Array.isArray(node) ? node : node?.props?.children ?? []) {
        const result = findElement(child, type);
        if (result) return result;
    }
}

test("list pages refresh after retained actions and contain synchronous provider errors", async () => {
    const hooks = hooksHarness();
    let enabled = false;
    const errors: unknown[] = [];
    const page = {
        title: "Test", spec: { type: "list", items(query: string) {
            if (query) throw new Error("items failed");
            return [{ id: "toggle", label: enabled ? "Enabled" : "Disabled", actions: [{ id: "toggle", keepOpen: true, run: () => { enabled = !enabled; } }] }];
        } }
    };
    const api = load("ui/Palette.tsx", {
        "@utils/discord": {}, "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@webpack/common": hooks.api,
        "../api/registry": { subscribePalette: () => () => {} }, "../commands/calculator/evaluator": {}, "../search/ranker": { fuzzyScore: () => 1 },
        "../settings": { settings: { store: { closeAfterExecute: true } } }, "../state/aliases": {}, "../state/frecency": {}, "../state/hotkeys": {}, "../state/pins": {},
        "./ActionBar": {}, "./ActionsPanel": {}, "./icons": {}, "./keyboard": { setPaletteKeyHandler() {} },
        "./pages/DetailPage": {}, "./pages/FormPage": {}, "./PaletteIcon": {},
        "./ResultsList": { ResultsList: "results", flattenSections: (sections: any[]) => sections.flatMap(section => section.items) }
    });
    const render = () => hooks.render(() => api.Palette({ initialPage: page, onClose() { assert.fail("retained actions keep the palette open"); } }));
    render();
    await flush();
    let result = findElement(render(), "results");
    assert.equal(result.props.sections[0].items[0].label, "Disabled");
    result.props.onRun(result.props.sections[0].items[0]);
    await flush();
    render();
    await flush();
    result = findElement(render(), "results");
    assert.equal(result.props.sections[0].items[0].label, "Enabled");
    findElement(render(), "input").props.onChange({ target: { value: "bad query" } });
    render();
    await flush();
    assert.equal(errors.length, 1);
    assert.equal(findElement(render(), "results").props.sections.length, 0);
    hooks.unmount();
});
