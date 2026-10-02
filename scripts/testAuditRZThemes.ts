/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const root = "src/equicordplugins/";
const React = {
    createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    useMemo: (fn: () => unknown) => fn()
};
function load(file: string, imports: Record<string, unknown> = {}, globals: Record<string, unknown> = {}, expose = "") {
    return loadTestModule(root + file, {
        "@components/Button": { Button: "button" },
        "@components/Paragraph": { Paragraph: "paragraph" },
        "@components/Heading": {},
        "@utils/margins": { Margins: {} },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack": { findComponentByCodeLazy: () => "component", findByPropsLazy: () => ({}), findCssClassesLazy: () => ({}) },
        ...imports
    }, { React, URL, TextDecoder, Uint8Array, Buffer, ...globals }, expose);
}
function nodes(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== "object") return [];
    return [node, ...nodes(node.props?.children)];
}
const url = "https://themes.equicord.org/api/one";
const theme = { id: "one", name: "Theme", description: "", content: "", likes: 12, tags: [], author: { discord_name: "Author" } };

test("RZ6-02 and RZ6-07: removal clears activation and cards pass catalog likes", () => {
    const Settings = {
        themeLinks: [url, "other"], enabledThemeLinks: [url, "other"], pinnedThemes: [url, "other"],
        themeNames: { [url]: "Name", other: "Keep" }, themeActivationModes: { [url]: "dark", other: "light" }
    };
    const api = load("themeLibrary/components/ThemeCard.tsx", {
        "@api/Commands": {}, "@api/Settings": { Settings }, "@components/Card": { Card: "card" },
        "@shared/externalUrls": {}, "@webpack/common": { React, Parser: { parse: (x: unknown) => x }, UserStore: {} },
        "./LikesComponent": { LikesComponent: "likes" }, "./ThemeInfoModal": {}, "./ThemeTab": { apiUrl: "https://themes.equicord.org/api" }
    });
    const tree = api.ThemeCard({ theme, themeLinks: Settings.themeLinks, setThemeLinks: (links: string[]) => { Settings.themeLinks = links; } });
    assert.equal(nodes(tree).find(n => n.type === "likes").props.fallbackLikes, 12);
    nodes(tree).find(n => n.props?.children?.includes("Remove Theme")).props.onClick();
    assert.deepEqual(Array.from(Settings.enabledThemeLinks), ["other"]);
    assert.deepEqual(Array.from(Settings.themeLinks), ["other"]);
    assert.deepEqual(Array.from(Settings.pinnedThemes), ["other"]);
    assert.equal(Settings.themeNames.other, "Keep");
    assert.equal(Object.hasOwn(Settings.themeNames, url), false);
    assert.equal(Settings.themeActivationModes.other, "light");
    assert.equal(Object.hasOwn(Settings.themeActivationModes, url), false);
});

test("RZ6-07: unavailable likes use catalog counts while authoritative zero wins", () => {
    for (const payload of [undefined, { likes: [{ themeId: "one", likes: 0 }] }]) {
        const api = load("themeLibrary/components/LikesComponent.tsx", {
            "@components/margins": { Margins: {} }, "@equicordplugins/themeLibrary/utils/auth": {},
            "@equicordplugins/themeLibrary/utils/Icons": { LikeIcon: () => "icon" }, "./ThemeTab": {},
            "@webpack/common": { useEffect() {}, useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, () => {}] }
        });
        const tree = api.LikesComponent({ themeId: "one", likedThemes: payload, fallbackLikes: 12 });
        assert.equal(tree.props.children.at(-1), payload ? 0 : 12);
    }
});

test("RZ6-09: failed overwrite remains open; successful retry closes", async () => {
    let conflict: any;
    let closed = 0;
    let fail = true;
    const notices: unknown[] = [];
    const api = load("themeLibrary/components/ThemeInfoModal.tsx", {
        "@components/CodeBlock": {}, "@components/Heart": {}, "@equicordplugins/themeLibrary/utils/Icons": {},
        "@shared/externalUrls": { getThemeMetadataHttpsUrl: () => null }, "@utils/clipboard": {}, "@utils/discord": {},
        "./ThemeTab": { logger: { error() {} } },
        "@webpack/common": { React, Modal: "modal", Button: { Colors: {}, Looks: {} }, Parser: {},
            Toasts: { Type: { SUCCESS: "success", FAILURE: "failure" } }, showToast: (...args: unknown[]) => notices.push(args),
            openModal: (fn: Function) => { conflict = fn({ onClose: () => { closed++; } }); } }
    }, { window: { atob: () => "" }, VencordNative: { pluginHelpers: { ThemeLibrary: {
        themeExists: async () => true, downloadTheme: async () => { if (fail) throw new Error("offline failure"); }
    } } } });
    const tree = api.ThemeInfoModal({ theme, author: { username: "Author" }, onClose() {} });
    await tree.props.actions[1].onClick();
    await conflict.props.actions[0].onClick();
    assert.equal(closed, 0);
    assert.equal((notices.at(-1) as unknown[])[1], "failure");
    fail = false;
    await conflict.props.actions[0].onClick();
    assert.equal(closed, 1);
});

test("RZ6-03: Enabled filtering observes activation and the online pause switch", () => {
    for (const [enabled, online, expected] of [[false, true, 0], [true, true, 1], [true, false, 0]] as const) {
        const states: any[] = [[theme], [], undefined, { value: "", status: 1 }, false, false];
        let index = 0;
        const effects: Function[] = [];
        const subscribed: string[][] = [];
        const api = load("themeLibrary/components/ThemeTab.tsx", {
            "@api/Settings": { Settings: {}, useSettings: (keys: string[]) => {
                subscribed.push(keys);
                return { themeLinks: [url], enabledThemeLinks: enabled ? [url] : [], enableOnlineThemes: online, plugins: { ThemeLibrary: { hideWarningCard: true } } };
            } },
            "@components/ErrorCard": {}, "@components/Icons": {}, "@components/settings": { wrapTab: (x: unknown) => x },
            "@equicordplugins/themeLibrary/types": { SearchStatus: { ALL: 0, ENABLED: 1, DISABLED: 2 } },
            "@utils/misc": { classes: () => "" }, "../utils/auth": {}, "./ThemeCard": {},
            "@webpack/common": { React, useEffect: (fn: Function) => effects.push(fn), useState: () => {
                const slot = index++;
                return [states[slot], (value: unknown) => { states[slot] = value; }];
            } }
        }, {}, "\nexport { ThemeTab };");
        api.ThemeTab();
        effects[1]();
        assert.equal(states[1].length, expected);
        assert.ok(subscribed[0].includes("enabledThemeLinks"));
        assert.ok(subscribed[0].includes("enableOnlineThemes"));
    }
});

test("RZ6-01: userplugin card delegates to shared dependency and failure handling", () => {
    const settings = { plugins: { Example: { enabled: false } } };
    const states = [true, [{ name: "Example", directory: "example", remote: "" }], "", false, {}, true];
    let index = 0;
    let calls = 0;
    const api = load("userpluginInstaller.dev/components/SettingsTab.tsx", {
        "@api/Settings": { useSettings: () => settings }, "@components/BaseText": {}, "@components/Card": {},
        "@components/CheckedTextInput": {}, "@components/Icons": {}, "@components/settings": { AddonCard: "addon" },
        "@components/settings/tabs/BaseTab": { wrapTab: (x: unknown) => x },
        "@components/settings/tabs/plugins/pluginToggle": { togglePlugin: () => { calls++; return "failed"; } },
        "@utils/misc": { classes: () => "", isObjectEmpty: () => true }, "..": {},
        "../misc/constants": { cl: () => "" },
        "@webpack/common": { useEffect() {}, useState: () => [states[index++], () => {}] }
    }, { Vencord: { Settings: settings, Plugins: { plugins: { Example: { name: "Example" } } } } }, "\nexport { UserPluginsTab };");
    const card = nodes(api.UserPluginsTab()).find(n => n.type === "addon");
    card.props.setEnabled(true);
    assert.equal(calls, 1);
    assert.equal(settings.plugins.Example.enabled, false);
    card.props.setEnabled(false);
    assert.equal(calls, 1);
});

test("RZ6-01: shared toggle reports missing dependencies, startup failure and stop failure", () => {
    for (const mode of ["dependency", "start", "stop"]) {
        const Settings = { plugins: { Example: { enabled: mode === "stop", unknown: "retained" } } };
        let failures = 0;
        let starts = 0;
        const api = loadTestModule("src/components/settings/tabs/plugins/pluginToggle.ts", {
            "@api/Notices": { showNotice: () => { failures++; } },
            "@api/PluginManager": {
                isPluginEnabled: () => Settings.plugins.Example.enabled,
                pluginRequiresRestart: () => false,
                startDependenciesRecursive: () => ({ restartNeeded: false, failures: mode === "dependency" ? ["Missing"] : [] }),
                startPlugin: () => { starts++; return false; }, stopPlugin: () => false
            },
            "@api/Settings": { Settings }, "@utils/Logger": { Logger: class { error() {} } },
            "@webpack/common": { showToast: () => { failures++; }, Toasts: { Type: {}, Position: {} } },
            "~plugins": { __esModule: true, default: { Example: { started: mode === "stop" } } }
        }, {});
        assert.equal(api.togglePlugin("Example"), "failed");
        assert.equal(Settings.plugins.Example.enabled, false);
        assert.equal(Settings.plugins.Example.unknown, "retained");
        assert.equal(failures, 1);
        assert.equal(starts, mode === "start" ? 1 : 0);
    }
});

test("RZ6-05: displayed metadata name and legacy directory exclusions both suppress notifications", async () => {
    for (const exclusion of ["Readable Plugin", "readable-plugin", "other"]) {
        let notify = 0;
        class Variable {
            stored: any;
            callback?: Function;
            constructor(value: unknown) { this.stored = value; }
            value(value?: unknown) { if (value !== undefined) { this.stored = value; this.callback?.(value, 1); } return this.stored; }
            registerCallback(fn: Function) { this.callback = fn; return 1; }
            deregisterCallback() { this.callback = undefined; }
        }
        const api = load("userpluginInstaller.dev/index.tsx", {
            "@api/Notifications": { showNotification: () => { notify++; } },
            "@api/Settings": { definePluginSettings: () => ({ store: { neverNotifyForPlugins: exclusion, notifyIfUpdate: true } }) },
            "@components/Notice": { Notice: {} }, "@plugins/_core/settings": { __esModule: true, default: { customEntries: [] } },
            "@utils/native": {}, "@webpack/common": {}, "./components/SettingsTab": {}, "./components/UserpluginInstallButton": {},
            "./VariableWithCallbacks": { VariableWithCallbacks: Variable }
        }, { VencordNative: { pluginHelpers: { UserpluginInstaller: {
            ensurePluginsDirectory: async () => {}, getUserplugins: async () => [{ name: "Readable Plugin", directory: "readable-plugin" }],
            isUpdateAvailableForPlugin: async () => true
        } } } });
        await api.default.start();
        assert.equal(notify, exclusion === "other" ? 1 : 0);
        api.default.stop();
    }
});

test("RZ6-04: native availability uses only incoming commits and refuses ahead-only updates", async () => {
    const review = load("userpluginInstaller.dev/updateReview.ts");
    const local = "a".repeat(40);
    const target = "b".repeat(40);
    assert.equal(review.createUpdateReviewPlan(local, target).logRange, local + ".." + target);
    for (const incoming of [false, true]) {
        const commands: string[][] = [];
        const api = load("userpluginInstaller.dev/native.ts", {
            "@main/settings": { NativeSettings: { store: { plugins: {} } } },
            child_process: { spawn: (_: string, args: string[]) => {
                commands.push(args);
                const proc: any = new EventEmitter();
                proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
                proc.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
                queueMicrotask(() => {
                    if (args[0] === "rev-parse") proc.stdout.emit("data", args[2].startsWith("HEAD") ? local : target);
                    if (args[0] === "log" && incoming) proc.stdout.emit("data", "Author\0bbbb\0" + target + "\0Incoming\0");
                    proc.emit("close", 0);
                });
                return proc;
            } },
            electron: {},
            fs: {
                readdirSync: () => ["index.ts"],
                readFileSync: (path: string) => path.endsWith("index.ts")
                    ? 'export default definePlugin({ name: "Example", authors: [], description: "Example description", });'
                    : ""
            },
            "fs/promises": {}, path: { basename: () => "desktop", join: (...x: string[]) => x.join("/"), resolve: (...x: string[]) => x.join("/") },
            "yaml-js": {}, "./misc/pluginValidate.txt": {}, "./misc/setGitPath.txt": {},
            "./repositorySafety": { resolveUserpluginDirectory: (_: string, name: string) => name, assertSafeExistingUserpluginDirectory: (_: string, path: string) => path },
            "./updateReview": review
        }, { __dirname: "/fixture/desktop", queueMicrotask });
        assert.equal(await api.isUpdateAvailableForPlugin(null, "plugin"), incoming);
        assert.equal(commands.find(args => args[0] === "log")?.at(-1), local + ".." + target);
        if (!incoming) {
            await assert.rejects(api.updatePlugin(null, "plugin"), reason => String(reason).includes("No incoming plugin updates"));
            assert.equal(commands.some(args => args[0] === "rebase"), false);
        }
    }
});
