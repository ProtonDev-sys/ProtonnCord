/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function load(path: string, mocks: Record<string, any>, globals: Record<string, unknown> = {}) {
    const modules = { "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {}, ReporterTestable: {}, makeRange: () => [] }, ...mocks };
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", { exports: {}, Blob, URL, AbortController, AbortSignal, ...globals, require: (name: string) => modules[name] });
}

function clipboardFixture() {
    const events: unknown[] = [];
    const toasts: string[] = [];
    let copy: () => Promise<void> = async () => undefined;
    const selection = { isCollapsed: false, anchorNode: {}, anchorOffset: 0, focusNode: {}, focusOffset: 3, toString: () => "cut" };
    const document = { getSelection: () => selection, activeElement: {}, createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: (callback: (value: Blob | null) => void) => callback(null) }) };
    let fetchResponse: () => Promise<any> = async () => ({ ok: true, blob: async () => new Blob(["fixture"], { type: "image/webp" }) });
    let closed = 0;
    let clipboardWrites = 0;
    const plugin = load("src/plugins/webContextMenus.web/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@utils/clipboard": { copyToClipboard: () => copy() }, "@utils/web": {},
        "@webpack": { filters: { byCode() {} }, mapMangledModuleLazy: () => ({}) },
        "@webpack/common": { SelectedChannelStore: { getChannelId: () => "channel" },
            ComponentDispatch: { dispatch: (...args: unknown[]) => events.push(args) },
            showToast: (text: string) => toasts.push(text), Toasts: { Type: {} } }
    }, { IS_VESKTOP: false, IS_EQUIBOP: false, window: {}, document,
        fetch: () => fetchResponse(), createImageBitmap: async () => ({ width: 1, height: 1, close: () => closed++ }),
        navigator: { clipboard: { write: async () => { clipboardWrites++; } } } }).default;
    return { plugin, events, selection, document, toasts, setCopy(value: typeof copy) { copy = value; },
        setFetch(value: typeof fetchResponse) { fetchResponse = value; }, getClosed: () => closed, getWrites: () => clipboardWrites };
}

test("cut never removes text after clipboard failure or a changed selection", async () => {
    const fixture = clipboardFixture();
    fixture.setCopy(async () => { throw new Error("permission denied"); });
    await fixture.plugin.cut();
    assert.equal(fixture.events.length, 0);
    let resolve!: () => void;
    fixture.setCopy(() => new Promise(done => { resolve = done; }));
    const pending = fixture.plugin.cut();
    fixture.selection.focusOffset = 4;
    resolve();
    await pending;
    assert.equal(fixture.events.length, 0);
    fixture.setCopy(async () => undefined);
    await fixture.plugin.cut();
    assert.equal(fixture.events.length, 1);
});

test("image conversion releases its bitmap and reports a null canvas export", async () => {
    const fixture = clipboardFixture();
    await fixture.plugin.copyImage("https://media.discordapp.net/image.webp?width=1");
    assert.equal(fixture.getClosed(), 1);
    assert.equal(fixture.getWrites(), 0);
    assert.equal(fixture.toasts[0], "Failed to copy image");
});

test("stopped image copies cannot write a late PNG to the clipboard", async () => {
    const fixture = clipboardFixture();
    let resolve!: (value: unknown) => void;
    fixture.setFetch(() => new Promise(done => { resolve = done; }));
    const pending = fixture.plugin.copyImage("https://cdn.discordapp.com/image.png");
    fixture.plugin.stop();
    resolve({ ok: true, blob: async () => new Blob(["fixture"], { type: "image/png" }) });
    await pending;
    assert.equal(fixture.getWrites(), 0);
});

function pwaFixture() {
    const waits: Array<() => void> = [];
    const badges: Array<number | undefined> = [];
    const themeCallbacks = new Set<() => void>();
    const appended: any[] = [];
    let messageListener!: (event: any) => void;
    let listenerOptions!: { signal: AbortSignal; };
    const store = { addChangeListener() {}, removeChangeListener() {} };
    const window = { GLOBAL_ENV: { WEBAPP_ENDPOINT: "//discord.com" }, location: { origin: "https://discord.com" },
        addEventListener: (_name: string, listener: typeof messageListener, options: typeof listenerOptions) => { messageListener = listener; listenerOptions = options; } };
    const plugin = load("src/plugins/webPWA.browser/index.tsx", {
        "./styles.css?managed": {}, "@utils/misc": { sleep: () => new Promise<void>(resolve => waits.push(resolve)) },
        "@api/Themes": { addThemeChangeListener: (callback: () => void) => themeCallbacks.add(callback), removeThemeChangeListener: (callback: () => void) => themeCallbacks.delete(callback) },
        "@webpack": { findStoreLazy: () => ({ ...store, getTotalMentionCount: () => 0, hasAnyUnread: () => true }) },
        "@webpack/common": { ThemeStore: store, NotificationSettingsStore: { ...store, getDisableUnreadBadge: () => false },
            RelationshipStore: { ...store, getPendingCount: () => 0 } }
    }, { window, IS_USERSCRIPT: false,
        navigator: { setAppBadge: (value?: number) => { badges.push(value); return Promise.resolve(); } },
        document: { body: {}, querySelector: () => ({ href: "https://cdn.example.test/icon.png" }),
            head: { appendChild: (value: unknown) => appended.push(value) },
            createElement: (tag: string) => tag === "link" ? { remove() {} } : { getContext: () => ({ fillRect() {}, getImageData: () => ({ data: new Uint8Array([0, 0, 0, 255]) }) }) },
        },
        getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
        URL: { createObjectURL: () => "blob:fixture", revokeObjectURL() {} }
    }).default;
    return { plugin, waits, badges, appended, themeCallbacks, window, listener: (event: any) => messageListener(event), getSignal: () => listenerOptions.signal };
}

test("PWA keybinds require the same window and origin and use an abortable listener", () => {
    const fixture = pwaFixture();
    let triggered = 0;
    fixture.plugin.flux.KEYBINDS_REGISTER_GLOBAL_KEYBIND_ACTIONS({ keybinds: { toggle: { onTrigger: () => triggered++ } } });
    fixture.plugin.start();
    const data = { type: "vencord:keybinds", meta: "toggle" };
    fixture.listener({ data, source: {}, origin: "https://discord.com" });
    fixture.listener({ data, source: fixture.window, origin: "https://unrelated.example.test" });
    assert.equal(triggered, 0);
    fixture.listener({ data, source: fixture.window, origin: "https://discord.com" });
    assert.equal(triggered, 1);
    const signal = fixture.getSignal();
    fixture.plugin.stop();
    assert.equal(signal.aborted, true);
});

test("PWA manifests coalesce theme updates and cannot reappear after stop", async () => {
    const fixture = pwaFixture();
    fixture.plugin.start();
    fixture.plugin.stop();
    fixture.waits.shift()!();
    await setImmediate();
    assert.equal(fixture.appended.length, 0);
    fixture.plugin.start();
    for (const callback of fixture.themeCallbacks) callback();
    fixture.waits.shift()!();
    fixture.waits.shift()!();
    await setImmediate();
    assert.equal(fixture.appended.length, 1);
    assert.equal(fixture.badges[0], undefined);
    assert.equal(fixture.badges[1], 0);
});

function overlayFixture() {
    const sockets: any[] = [];
    const settings = { webSocketPort: 42070, preferUDP: false, dmNotifications: false, groupDmNotifications: false,
        serverNotifications: true, botNotifications: true, pingColor: "#123456", channelPingColor: "#123456" };
    let fetchResponse: () => Promise<any> = async () => ({ ok: true, blob: async () => new Blob(["fixture"]) });
    class Socket {
        static OPEN = 1;
        readyState = 0;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        sent: string[] = [];
        constructor(public url: string) { sockets.push(this); }
        open() { this.readyState = 1; this.onopen?.(); }
        close() { this.readyState = 3; this.onclose?.(); }
        send(value: string) { this.sent.push(value); }
    }
    const plugin = load("src/plugins/xsOverlay/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: settings }) },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack": { findLazy: () => ({ DM: 1, GROUP_DM: 3 }), findByCodeLazy: () => () => true },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) }, GuildRoleStore: {}, GuildStore: { getGuild: () => ({ name: "Server" }) },
            ChannelStore: { getChannel: (id: string) => ({ id, type: id === "dm" ? 1 : id === "group" ? 3 : 0, guild_id: id === "server" ? "guild" : undefined, name: "Channel", rawRecipients: [] }) } }
    }, { IS_WEB: true, WebSocket: Socket, setTimeout, clearTimeout,
        VencordNative: { pluginHelpers: { XSOverlay: {} } }, fetch: () => fetchResponse(),
        FileReader: class { result = "data:image/png;base64,fixture"; onload?: () => void; readAsDataURL() { this.onload?.(); } }
    }).default;
    const message = (channel: string, avatar: string | null = null) => ({ channel_id: channel, content: "Fixture", author: { id: "other", username: "Other", avatar },
        embeds: [], attachments: [], mentions: [], mention_roles: [] });
    return { plugin, sockets, settings, message, setFetch(value: typeof fetchResponse) { fetchResponse = value; } };
}

test("XSOverlay honors separate DM and group opt-outs while server notifications stay enabled", async () => {
    const fixture = overlayFixture();
    const started = fixture.plugin.start();
    fixture.sockets[0].open();
    await started;
    fixture.plugin.flux.MESSAGE_CREATE({ message: fixture.message("dm") });
    fixture.plugin.flux.MESSAGE_CREATE({ message: fixture.message("group") });
    fixture.plugin.flux.MESSAGE_CREATE({ message: fixture.message("server") });
    await setImmediate();
    assert.equal(fixture.sockets[0].sent.length, 1);
    const payload = JSON.parse(JSON.parse(fixture.sockets[0].sent[0]).jsonData);
    assert.equal(payload.useBase64Icon, false);
});

test("XSOverlay shares one reconnect attempt for simultaneous notifications", async () => {
    const fixture = overlayFixture();
    const started = fixture.plugin.start();
    fixture.sockets[0].open();
    await started;
    fixture.sockets[0].close();
    fixture.plugin.flux.MESSAGE_CREATE({ message: fixture.message("server") });
    fixture.plugin.flux.MESSAGE_CREATE({ message: fixture.message("server") });
    await setImmediate();
    assert.equal(fixture.sockets.length, 2);
    fixture.sockets[1].open();
    await setImmediate();
    assert.equal(fixture.sockets[1].sent.length, 2);
});

test("XSOverlay discards avatar completion after stop without reconnecting", async () => {
    const fixture = overlayFixture();
    const started = fixture.plugin.start();
    fixture.sockets[0].open();
    await started;
    let resolve!: (value: unknown) => void;
    fixture.setFetch(() => new Promise(done => { resolve = done; }));
    fixture.plugin.flux.MESSAGE_CREATE({ message: fixture.message("server", "avatar") });
    await fixture.plugin.stop();
    resolve({ ok: true, blob: async () => new Blob(["fixture"]) });
    await setImmediate();
    assert.equal(fixture.sockets.length, 1);
    assert.equal(fixture.sockets[0].sent.length, 0);
});

test("XSOverlay UDP sends preserve caller data and propagate callback failures", async () => {
    let errorHandler: unknown;
    let body = "";
    const module = load("src/plugins/xsOverlay/native.ts", {
        dgram: { createSocket: () => ({ on: (_event: string, handler: unknown) => { errorHandler = handler; }, close() {},
            send: (value: string, _port: number, _host: string, callback: (error: Error) => void) => { body = value; callback(new Error("fixture failure")); } }) }
    });
    const data = { type: 1, content: "Fixture" };
    await assert.rejects(module.sendToOverlay(null, data), /fixture failure/);
    assert.equal(Object.hasOwn(data, "messageType"), false);
    assert.equal(JSON.parse(body).messageType, 1);
    assert.equal(typeof errorHandler, "function");
    module.closeSocket();
});
