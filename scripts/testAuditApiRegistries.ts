/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function loadApi(name: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
    const logged: unknown[][] = [];
    const React = {
        Fragment: "fragment",
        createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } })
    };
    const dependencies = {
        "@components/ErrorBoundary": { default: "boundary" },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { logged.push(args); } } },
        ...mocks
    };
    const path = `src/api/${name}`;
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, jsx: JsxEmit.React }
    });
    const api = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, React, ...globals,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(Object.hasOwn(dependencies, name), name);
            return dependencies[name];
        }
    });
    return { api, logged };
}

test("surface subscriptions cannot strand registrations when another subscriber throws", () => {
    const effects: Array<() => void> = [];
    let healthyUpdates = 0;
    const updaters = [() => { throw new Error("old surface"); }, () => healthyUpdates++];
    const { api, logged } = loadApi("SurfaceClasses.ts", {
        "@utils/react": { useForceUpdater: () => updaters.shift() },
        "@webpack/common": { useEffect: (effect: () => () => void) => effects.push(effect()) }
    });
    api._useSurfaceProps("sidebar");
    api._useSurfaceProps("sidebar");
    api._trackSurfaceInstance("sidebar", { forceUpdate() { throw new Error("unmounted class"); } });
    const dispose = api.addSurfacePropsProvider("sidebar", () => ({ "data-fixture": "enabled" }));
    assert.equal(typeof dispose, "function");
    assert.equal(healthyUpdates, 1);
    assert.equal(api._getSurfaceProps("sidebar")["data-fixture"], "enabled");
    dispose();
    assert.equal(healthyUpdates, 2);
    assert.equal(api._getSurfaceProps("sidebar")["data-fixture"], undefined);
    dispose();
    assert.equal(healthyUpdates, 2, "repeated disposal does not notify again");
    for (const cleanup of effects) cleanup();
    api.notifySurfaceClassesChanged("sidebar");
    assert.equal(healthyUpdates, 2, "unmounted hooks no longer receive notifications");
    assert.ok(logged.length >= 4);
});

test("surface composition preserves ref cleanup and continues after a failed plugin callback", () => {
    const { api } = loadApi("SurfaceClasses.ts", { "@utils/react": {}, "@webpack/common": {} });
    const events: string[] = [];
    api.addSurfacePropsProvider("sidebar", () => ({
        ref: () => () => { events.push("first cleanup"); throw new Error("cleanup failed"); },
        onFocusCapture: () => { throw new Error("handler failed"); }
    }));
    api.addSurfacePropsProvider("sidebar", () => ({
        ref: (node: unknown) => { events.push(node ? "second mount" : "second unmount"); },
        onFocusCapture: () => events.push("second focus"),
        "data-fixture": "ok",
        className: "ignored"
    }));
    const props = api._getSurfaceProps("sidebar");
    assert.equal(props.className, undefined);
    assert.equal(props["data-fixture"], "ok");
    const cleanup = props.ref({});
    props.onFocusCapture({});
    cleanup();
    assert.deepEqual(events, ["second mount", "second focus", "first cleanup", "second unmount"]);
});

test("a malformed surface provider does not block later providers", () => {
    const { api, logged } = loadApi("SurfaceClasses.ts", { "@utils/react": {}, "@webpack/common": {} });
    api.addSurfacePropsProvider("sidebar", () => ({ get style() { throw new Error("style unavailable"); } }));
    api.addSurfacePropsProvider("sidebar", () => ({ "data-fixture": "retained" }));
    assert.equal(api._getSurfaceProps("sidebar")["data-fixture"], "retained");
    api._getSurfaceProps("sidebar");
    assert.equal(logged.length, 1, "persistent failures are logged once per provider");
});

test("notices queued before the host module is ready retain order and dismiss normally", () => {
    let ready: (module: object) => void = () => assert.fail("not registered");
    const shown: unknown[][] = [];
    const { api } = loadApi("Notices.tsx", {
        "@utils/react": { isPrimitiveReactNode: () => true },
        "@webpack": { waitFor: (_filter: unknown, callback: typeof ready) => { ready = callback; } }
    });
    api.showNotice("first", "ok", () => { });
    api.showNotice("second", "ok", () => { });
    api.popNotice();
    assert.equal(api.noticesQueue.length, 2);
    ready({ show: (...args: unknown[]) => shown.push(args), dismiss: () => api.nextNotice() });
    assert.equal(shown[0][1], "first");
    assert.equal(shown[0][4], "ProtonnCordNotice");
    api.popNotice();
    assert.equal(shown[1][1], "second");
    api.popNotice();
    assert.equal(api.currentNotice, null);
    assert.equal(api.noticesQueue.length, 0);
});

test("server list component keys survive insertion, reordering and removal of other plugins", () => {
    const { api } = loadApi("ServerList.tsx");
    const first = () => null;
    const second = () => null;
    api.addServerListElement(0, first, 1);
    const firstKey = api.renderAll(0)[0].props.key;
    api.addServerListElement(0, second, 2);
    assert.equal(api.renderAll(0)[1].props.key, firstKey);
    api.addServerListElement(0, first, 3);
    assert.equal(api.renderAll(0)[0].props.key, firstKey);
    api.removeServerListElement(0, second);
    assert.equal(api.renderAll(0)[0].props.key, firstKey);
});

test("popover factories own separate component lifetimes and never run in the registry render", () => {
    let invoked = 0;
    const { api } = loadApi("MessagePopover.tsx", {
        "./Settings": { useSettings: () => ({ uiElements: { messagePopoverButtons: {} } }) }
    });
    const factory = () => { invoked++; return { label: "first" }; };
    api.addMessagePopoverButton("fixture", factory, () => null);
    const parent = api._buildPopoverElements("button", { id: "message" });
    const renderButton = () => parent.type(parent.props).props.children[0][0].props.children[0];
    const first = renderButton();
    assert.equal(invoked, 0, "registry rendering must not execute plugin hooks");
    assert.equal(first.type(first.props).props.label, "first");
    assert.equal(invoked, 1);
    assert.equal(renderButton().type, first.type, "a stable factory preserves its component state");
    api.addMessagePopoverButton("fixture", () => ({ label: "replacement" }), () => null);
    assert.notEqual(renderButton().type, first.type, "replacing a factory creates a new hook lifetime");
});

test("disabled global badges stay lazy and a failed badge does not remove healthy badges", () => {
    const plugins = { get GlobalBadges() { return assert.fail("disabled plugin was loaded"); } };
    const { api, logged } = loadApi("Badges.ts", {
        "~plugins": { __esModule: true, default: plugins },
        "@plugins/_api/badges": { __esModule: true, default: { getDonorBadges: () => [], getEquicordDonorBadges: () => [] } },
        "./PluginManager": { isPluginEnabled: () => false }
    });
    api.addProfileBadge({ id: "failing", shouldShow: () => { throw new Error("unavailable"); } });
    api.addProfileBadge({ id: "healthy" });
    const badges = api._getBadges({ userId: "user", guildId: "guild" });
    assert.deepEqual(Array.from(badges, (badge: { id: string; }) => badge.id), ["healthy"]);
    assert.equal(logged.length, 1);
});

test("chat bar wrappers preserve priority and continue with the last valid content after failure", () => {
    const { api, logged } = loadApi("ChatButtons.tsx", {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/misc": {},
        "@webpack": { findCssClassesLazy: () => ({}) },
        "@webpack/common": {},
        "./ContextMenu": { addContextMenuPatch() { } },
        "./Settings": {}
    });
    api.addChatBarButtonWrapper("outer", (content: unknown) => ({ outer: content }), 1);
    api.addChatBarButtonWrapper("inner", (content: unknown) => ({ inner: content }), -1);
    api.addChatBarButtonWrapper("failing", () => { throw new Error("wrapper failed"); }, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(api._wrapButtons("buttons"))), { outer: { inner: "buttons" } });
    assert.equal(logged.length, 1);
    api.removeChatBarButtonWrapper("outer");
    assert.deepEqual(JSON.parse(JSON.stringify(api._wrapButtons("buttons"))), { inner: "buttons" });
});

test("an error callback cannot escape its React error boundary", () => {
    class PureComponent { constructor(public props: object) { } }
    const { api, logged } = loadApi("../components/ErrorBoundary.tsx", {
        "@utils/lazyReact": { LazyComponent: (factory: () => unknown) => factory() },
        "@utils/margins": {},
        "./ErrorCard": {}
    }, { Vencord: { Webpack: { Common: { React: { PureComponent } } } } });
    const boundary = new api.default({ onError() { throw new Error("callback failed"); } });
    assert.doesNotThrow(() => boundary.componentDidCatch(new Error("render failed"), { componentStack: "fixture" }));
    assert.equal(logged.length, 2, "both the callback and original render failure remain diagnosable");
});

function stylesFixture() {
    const renderer = Promise.withResolvers<string>();
    const host = Promise.withResolvers<string>();
    const system = Promise.withResolvers<Record<string, string>>();
    const elements = new Map<string, { textContent?: string; }>();
    let rendererUpdate: (css: string) => void = () => assert.fail("not subscribed");
    let hostUpdate: (css: string) => void = () => assert.fail("not subscribed");
    const { api, logged } = loadApi("Styles.ts", {
        "@components/BaseText": { generateTextCss: () => "text" },
        "@components/margins": { generateMarginCss: () => "margin" },
        "@utils/css": { createAndAppendStyle: (id: string) => {
            const element = { textContent: "" };
            elements.set(id, element);
            return element;
        } }
    }, {
        window: {},
        document: { createElement: () => ({ style: {}, append() { } }), addEventListener() { } },
        IS_DEV: true, IS_VESKTOP: true, IS_EQUIBOP: false,
        VencordNative: {
            native: { getRendererCss: () => renderer.promise, onRendererCssUpdate: (callback: typeof rendererUpdate) => { rendererUpdate = callback; } },
            themes: { getSystemValues: () => system.promise }
        },
        VesktopNative: { app: { getRendererCss: () => host.promise, onRendererCssUpdate: (callback: typeof hostUpdate) => { hostUpdate = callback; } } }
    });
    api.initStyles();
    return { renderer, host, system, elements, logged, updateRenderer: (css: string) => rendererUpdate(css), updateHost: (css: string) => hostUpdate(css) };
}

test("initial CSS reads cannot overwrite newer renderer and host updates", async () => {
    const f = stylesFixture();
    f.updateRenderer("new renderer");
    f.updateHost("new host");
    f.renderer.resolve("old renderer");
    f.host.resolve("old host");
    f.system.resolve({ "fixture-color": "blue" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.elements.get("vencord-css-core")?.textContent, "new renderer");
    assert.equal(f.elements.get("vesktop-css-core")?.textContent, "new host");
    assert.equal(f.elements.get("vencord-os-theme-values")?.textContent, ":root{--fixture-color: blue;}");
    assert.equal(f.logged.length, 0);
});

test("failed initial CSS reads are contained and later updates remain usable", async () => {
    const f = stylesFixture();
    f.renderer.reject(new Error("renderer unavailable"));
    f.host.reject(new Error("host unavailable"));
    f.system.reject(new Error("system unavailable"));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.logged.length, 3);
    f.updateRenderer("recovered");
    assert.equal(f.elements.get("vencord-css-core")?.textContent, "recovered");
});

test("clipboard toast actions contain discarded failures while preserving rejection for awaiters", async () => {
    const failure = new Error("permission denied");
    let failing = true;
    const notices: Array<{ message: string; type: string; }> = [];
    const { api } = loadApi("../utils/discord.tsx", {
        "./clipboard": { copyToClipboard: async () => { if (failing) throw failure; } },
        "./intlHash": {},
        "./Logger": { Logger: class { error() { } } },
        "@webpack/common": { Toasts: { Type: { SUCCESS: "success", FAILURE: "failure" }, genId: () => "fixture", show: (notice: typeof notices[number]) => notices.push(notice) } }
    });
    api.copyWithToast("private fixture");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(notices[0].type, "failure");
    assert.equal(notices[0].message.includes("private fixture"), false);
    await assert.rejects(api.copyWithToast("fixture"), error => error === failure);
    failing = false;
    await api.copyWithToast("fixture", "Custom success");
    assert.deepEqual(notices.map(notice => notice.type), ["failure", "failure", "success"]);
    assert.equal(notices.at(-1)?.message, "Custom success");
});
