/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { registerPluginNatives } from "../src/main/pluginNativeRegistry";
import { IpcEvents } from "../src/shared/IpcEvents";
import { isDiscordRendererOrigin } from "../src/shared/rendererOrigin";
import { createSettingsPersistence } from "../src/shared/settingsPersistence";
import { loadTestModule } from "./utils/loadTestModule";

type Handler = (event: any, ...args: any[]) => any;

const ipcEvents = {
    GET_PLUGIN_IPC_METHOD_MAP: IpcEvents.GET_PLUGIN_IPC_METHOD_MAP,
    GET_QUICK_CSS: IpcEvents.GET_QUICK_CSS,
    SET_QUICK_CSS: IpcEvents.SET_QUICK_CSS,
    GET_MONACO_THEME: IpcEvents.GET_MONACO_THEME,
    MONACO_CLOSE: IpcEvents.MONACO_CLOSE,
    MONACO_CLOSE_ACK: IpcEvents.MONACO_CLOSE_ACK,
    INIT_FILE_WATCHERS: IpcEvents.INIT_FILE_WATCHERS,
    PRELOAD_GET_RENDERER_JS: IpcEvents.PRELOAD_GET_RENDERER_JS,
};

function caller(origin = "https://discord.com", url = `${origin}/channels/@me`) {
    const senderFrame = { origin, url };
    return { senderFrame, sender: { mainFrame: senderFrame, isDestroyed: () => false }, returnValue: undefined as unknown };
}

function fixture() {
    const handles = new Map<string, Handler>();
    const listeners = new Map<string, Handler>();
    const boundary = loadTestModule<typeof import("../src/main/ipc")>("src/main/ipc.ts", {
        "@shared/IpcEvents": { IpcEvents: ipcEvents }, "@shared/rendererOrigin": { isDiscordRendererOrigin },
        electron: { ipcMain: {
            handle(channel: string, handler: Handler) { handles.set(channel, handler); },
            on(channel: string, handler: Handler) { listeners.set(channel, handler); },
        } },
    }, {});
    let loads = 0;
    loadTestModule("src/main/ipcPlugins.ts", {
        "@shared/IpcEvents": { IpcEvents: ipcEvents }, "./ipc": boundary, "./pluginNativeRegistry": { registerPluginNatives },
        "~pluginNatives": { __esModule: true, default: { Fixture: {
            eager: false, methods: ["read"], load() { loads++; return { read: (event: unknown, value: unknown) => [event, value] }; },
        } } },
    }, {});
    const invoke = (channel: string, event: unknown, ...args: unknown[]) => handles.get(channel)!(event, ...args);
    const sync = (channel: string, event: ReturnType<typeof caller>) => {
        event.returnValue = undefined;
        listeners.get(channel)!(event);
        return event.returnValue;
    };
    return { ...boundary, handles, invoke, sync, loads: () => loads };
}

test("all native methods reject foreign, opaque, child, destroyed and detached frames before loading a plugin", () => {
    const f = fixture();
    const child = caller(); child.sender.mainFrame = { ...child.senderFrame };
    const destroyed = caller(); destroyed.sender.isDestroyed = () => true;
    const detached = caller(); Object.defineProperty(detached, "senderFrame", { get() { throw new Error("Frame is gone"); } });
    const rejected = [
        caller("https://attacker.example"), caller("null", "https://discord.com/channels/@me"),
        caller("https://attacker.example", "https://discord.com/channels/@me"),
        caller("https://discord.com:444"), caller("https://discord.com.attacker.example"),
        caller("http://discord.com"), child, destroyed, detached,
    ];
    for (const event of rejected) {
        assert.throws(() => f.invoke("VencordPluginNative_Fixture_read", event, "secret"), /Untrusted/);
        assert.equal(f.sync(IpcEvents.GET_PLUGIN_IPC_METHOD_MAP, event), null, "sync rejection must reply without throwing");
    }
    assert.equal(f.loads(), 0);
    for (const host of ["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com", "ptb.discordapp.com", "canary.discordapp.com"]) {
        const event = caller(`https://${host}`);
        const map = f.sync(IpcEvents.GET_PLUGIN_IPC_METHOD_MAP, event) as Record<string, Record<string, string>>;
        const result = f.invoke(map.Fixture.read, event, "value");
        assert.equal(result[0], event, "native argument validation still receives the original event");
        assert.equal(result[1], "value");
    }
    assert.equal(f.loads(), 1);
    assert.doesNotThrow(() => f.invoke("VencordPluginNative_Fixture_read", caller("https://discord.com", "about:blank")));
});

test("QuickCSS access belongs to the registered document and cannot reach settings, updates or plugins", () => {
    const f = fixture();
    const editor = caller("null", "data:text/html;base64,ZWRpdG9y");
    const editorChannels = [IpcEvents.GET_QUICK_CSS, IpcEvents.SET_QUICK_CSS, IpcEvents.GET_MONACO_THEME, IpcEvents.MONACO_CLOSE_ACK];
    const privileged = [IpcEvents.GET_SETTINGS, IpcEvents.SET_SETTINGS, IpcEvents.UPDATE, IpcEvents.BUILD, IpcEvents.CSP_REMOVE_OVERRIDE];
    let calls = 0;
    for (const channel of [...editorChannels, ...privileged]) f.ipcMain.handle(channel, () => ++calls);
    f.registerQuickCssEditor(editor.sender as any, editor.senderFrame.url);
    for (const channel of editorChannels) f.invoke(channel, editor);
    assert.equal(calls, 4);
    for (const channel of [...privileged, "VencordPluginNative_Fixture_read"]) assert.throws(() => f.invoke(channel, editor), /Untrusted/);
    assert.equal(f.sync(IpcEvents.GET_PLUGIN_IPC_METHOD_MAP, editor), null);
    const impostor = caller("null", editor.senderFrame.url);
    for (const channel of editorChannels) assert.throws(() => f.invoke(channel, impostor), /Untrusted/);
    editor.senderFrame.url = "data:text/html,other-document";
    for (const channel of editorChannels) assert.throws(() => f.invoke(channel, editor), /Untrusted/);
    assert.equal(calls, 4);
});

test("preload exposes the bridge only to trusted main frames and keeps the host preload running", async () => {
    for (const desktop of [true, false]) {
        for (const origin of ["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com", "https://attacker.example", "null"]) {
            for (const mainFrame of [true, false]) {
                const exposed = new Map<string, unknown>();
                let hostLoads = 0;
                let injections = 0;
                const invokeCalls: string[] = [];
                const native = loadTestModule("src/VencordNative.ts", {
                    "@shared/IpcEvents": { IpcEvents: ipcEvents }, "@shared/settingsPersistence": { createSettingsPersistence },
                    "electron/renderer": { ipcRenderer: { sendSync: () => null } },
                }, {});
                assert.equal(Object.keys(native.default.pluginHelpers).length, 0, "a denied map also supports editor preload startup");
                const dependencies = {
                    "@shared/IpcEvents": { IpcEvents: ipcEvents }, "@shared/rendererOrigin": { isDiscordRendererOrigin },
                    "./VencordNative": { ...native, __esModule: true,
                        invoke: async (channel: string) => { invokeCalls.push(channel); }, sendSync: () => "renderer fixture" },
                    "electron/renderer": { ipcRenderer: { on() {} },
                        contextBridge: { exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value) },
                        webFrame: { async executeJavaScript() { injections++; } } },
                };
                loadTestModule("src/preload.ts", {}, {
                    IS_DISCORD_DESKTOP: desktop, process: { isMainFrame: mainFrame, env: { DISCORD_PRELOAD: "host-preload" } },
                    window: { origin }, location: { protocol: origin === "null" ? "data:" : "https:" },
                    require(name: string) {
                        if (name === "host-preload") { hostLoads++; return {}; }
                        assert.ok(Object.hasOwn(dependencies, name), name);
                        return dependencies[name];
                    },
                }, "", { mockImports: false });
                const trusted = mainFrame && isDiscordRendererOrigin(origin);
                assert.deepEqual([...exposed.keys()], trusted ? ["VencordNative"]
                    : mainFrame && origin === "null" ? ["setCss", "onCssClosing", "getCurrentCss", "getTheme"] : []);
                assert.equal(injections, Number(desktop && trusted));
                assert.equal(hostLoads, Number(desktop && origin !== "null"));
                assert.deepEqual(invokeCalls, trusted ? [IpcEvents.INIT_FILE_WATCHERS] : []);
            }
        }
    }
});

test("main-process IPC registrations use the guarded facade", () => {
    const files = readdirSync("src/main", { recursive: true }) as string[];
    for (const file of files.filter(file => file.endsWith(".ts") && file !== "ipc.ts")) {
        const source = readFileSync(join("src/main", file), "utf8");
        assert.doesNotMatch(source, /import\s*\{[^}]*\bipcMain\b[^}]*\}\s*from\s*["']electron["']/s, file);
    }
});
