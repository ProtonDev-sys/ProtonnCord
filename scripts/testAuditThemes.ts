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

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
    const settings = {
        themeLinks: [] as string[], enabledThemeLinks: [] as string[], enabledThemes: ["local.css"],
        pinnedThemes: ["local.css"], themeNames: { "local.css": "Keep name" } as Record<string, string>,
        themeActivationModes: { "local.css": "dark" } as Record<string, string>, enableOnlineThemes: true
    };
    const hooks: { value?: any; dependencies?: unknown[]; cleanup?: () => void; }[] = [];
    const effects: (() => void)[] = [];
    const listeners = new Map<string, Function>();
    const requests: { link: string; signal: AbortSignal; response: ReturnType<typeof Promise.withResolvers<Response>>; }[] = [];
    const toasts: string[] = [];
    let cursor = 0;
    let stateWrites = 0;
    let deleteFails = true;
    let localRead = async () => [{ fileName: "local.css", name: "Local" }];
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const mocks: Record<string, unknown> = {
        "@api/Settings": { Settings: settings, useSettings: () => settings },
        "@components/settings/tabs/BaseTab": { SettingsTab: "tab", wrapTab: (component: unknown) => component },
        "@main/themes": { getThemeInfo: (css: string, fileName: string) => ({ fileName, name: css || fileName }) },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/discord": {}, "@utils/margins": { Margins: {} },
        "@utils/misc": { classes: (...names: unknown[]) => names.filter(Boolean).join(" ") },
        "@utils/web": {},
        "./OnlineThemes": { OnlineThemesSection: "online-settings" },
        "./QuickActions": { QuickActionsSection: "quick-actions" },
        "./ThemeCard": { ThemeCard: "theme-card" },
        "@webpack/common": {
            React, Select: "select", TextInput: "input", showToast: (message: string) => toasts.push(message), Toasts: { Type: { FAILURE: "failure", SUCCESS: "success" } },
            useRef(initial: unknown) { const index = cursor++; hooks[index] ??= { value: { current: initial } }; return hooks[index].value; },
            useState(initial: unknown) {
                const index = cursor++;
                hooks[index] ??= { value: initial };
                return [hooks[index].value, (value: any) => { stateWrites++; hooks[index].value = typeof value === "function" ? value(hooks[index].value) : value; }];
            },
            useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
                const index = cursor++;
                const previous = hooks[index];
                if (previous?.dependencies?.length === dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies![i]))) return;
                hooks[index] = { dependencies };
                effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = effect() || undefined; });
            }
        }
    };
    for (const name of ["Divider", "Heading", "Link", "Paragraph"]) mocks[`@components/${name}`] = { [name]: name.toLowerCase() };
    const code = transpileModule(readFileSync("src/components/settings/tabs/themes/index.tsx", "utf8"), {
        fileName: "themes.tsx", compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const module = runInNewContext(code + "\nexports;", {
        exports: {}, IS_WEB: true, IS_USERSCRIPT: false, IS_DISCORD_DESKTOP: false, AbortController,
        window: { addEventListener: (name: string, listener: Function) => listeners.set(name, listener), removeEventListener: (name: string) => listeners.delete(name) },
        VencordNative: { themes: {
            getThemesList: () => localRead(), uploadTheme: async () => undefined,
            deleteTheme: async () => { if (deleteFails) throw new Error("Delete failed"); }
        } },
        fetch(link: string, options: { signal: AbortSignal; }) {
            const response = Promise.withResolvers<Response>();
            requests.push({ link, signal: options.signal, response });
            return response.promise;
        },
        require(name: string) { if (name.endsWith(".css")) return {}; assert.ok(name in mocks, name); return mocks[name]; }
    });
    const render = () => {
        cursor = 0;
        const tree = module.default();
        for (const effect of effects.splice(0)) effect();
        return tree;
    };
    return {
        settings, render, requests, toasts, listeners, close: () => hooks.forEach(hook => hook.cleanup?.()),
        allowDelete: () => { deleteFails = false; }, setLocalRead: (read: typeof localRead) => { localRead = read; }, stateWrites: () => stateWrites
    };
}

function find(tree: any, type: string): any[] {
    if (Array.isArray(tree)) return tree.flatMap(child => find(child, type));
    if (!tree || typeof tree !== "object") return [];
    return [...(tree.type === type ? [tree] : []), ...find(tree.props?.children, type)];
}

test("failed local deletion preserves saved theme choices; successful deletion clears them", async () => {
    const f = fixture();
    f.render(); await settle();
    let card = find(f.render(), "theme-card")[0];
    await card.props.onDelete();
    assert.deepEqual(f.settings.enabledThemes, ["local.css"]);
    assert.deepEqual(f.settings.pinnedThemes, ["local.css"]);
    assert.equal(f.settings.themeNames["local.css"], "Keep name");
    assert.equal(f.settings.themeActivationModes["local.css"], "dark");
    assert.equal(f.toasts.length, 1);
    f.allowDelete();
    card = find(f.render(), "theme-card")[0];
    await card.props.onDelete();
    assert.equal(f.settings.enabledThemes.length, 0);
    assert.equal(f.settings.pinnedThemes.length, 0);
    assert.equal("local.css" in f.settings.themeNames, false);
    assert.equal("local.css" in f.settings.themeActivationModes, false);
    f.close();
});

test("replaced theme metadata requests cannot restore deleted links or infer stale modes", async () => {
    const f = fixture();
    f.settings.themeLinks = ["https://themes.invalid/old.css"];
    f.render();
    f.settings.themeLinks = ["https://themes.invalid/new.css"];
    f.render();
    assert.equal(f.requests[0].signal.aborted, true);
    f.requests[1].response.resolve(new Response("Current")); await settle();
    f.requests[0].response.resolve(new Response("@dark {}")); await settle();
    const links = find(f.render(), "theme-card").map(card => card.props.themeLink).filter(Boolean);
    assert.deepEqual(links, ["https://themes.invalid/new.css"]);
    assert.equal("https://themes.invalid/old.css" in f.settings.themeActivationModes, false);
    f.close();
});

test("disabled online themes retain selection and remain manageable without metadata requests", async () => {
    const f = fixture();
    const link = "https://themes.invalid/theme.css";
    f.settings.themeLinks = [link]; f.settings.enabledThemeLinks = [link]; f.settings.enableOnlineThemes = false;
    f.render(); await settle();
    let tree = f.render();
    assert.equal(f.requests.length, 0);
    assert.equal(find(tree, "theme-card").find(card => card.props.themeLink === link).props.disabled, true);
    find(tree, "online-settings")[0].props.setEnableOnlineThemes(true);
    f.render();
    f.requests[0].response.resolve(new Response("Theme")); await settle();
    tree = f.render();
    find(tree, "online-settings")[0].props.setEnableOnlineThemes(false);
    assert.deepEqual(f.settings.enabledThemeLinks, [link]);
    f.close();
});

test("metadata failures leave removable cards and closing ignores late local reads", async () => {
    const f = fixture();
    f.settings.themeLinks = ["https://themes.invalid/unavailable.css"];
    const local = Promise.withResolvers<{ fileName: string; name: string; }[]>();
    f.setLocalRead(() => local.promise);
    f.render();
    f.requests[0].response.resolve(new Response("", { status: 503 })); await settle();
    const writes = f.stateWrites();
    f.close();
    local.resolve([{ fileName: "late.css", name: "Late" }]); await settle();
    assert.equal(f.stateWrites(), writes);
    assert.equal(f.listeners.size, 0);
    const other = fixture();
    other.settings.themeLinks = ["https://themes.invalid/unavailable.css"];
    other.render(); other.requests[0].response.resolve(new Response("", { status: 503 })); await settle();
    const card = find(other.render(), "theme-card").find(card => card.props.themeLink);
    assert.match(card.props.theme.description, /Could not load/);
    card.props.onDelete();
    assert.equal(other.settings.themeLinks.length, 0);
    other.close();
});

test("theme drag handling leaves unrelated file drops untouched", async () => {
    const f = fixture();
    f.render(); await settle();
    let prevented = 0;
    await f.listeners.get("drop")!({ preventDefault: () => prevented++, dataTransfer: { files: [{ name: "message.txt" }] } });
    assert.equal(prevented, 0);
    await f.listeners.get("drop")!({ preventDefault: () => prevented++, dataTransfer: { files: [{ name: "theme.css", text: async () => "body {}" }] } });
    assert.equal(prevented, 1);
    f.close();
});
