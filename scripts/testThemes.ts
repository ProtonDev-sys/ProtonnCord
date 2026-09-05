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
import { createSourceFile, forEachChild, isFunctionDeclaration, JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync("src/api/Themes.ts", "utf8");

function loadThemeModule(path: string, mocks: Record<string, object> = {}, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, ...globals,
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
}

function clientThemeFixture(urls = ["fixture.css"]) {
    const styles = new Map<string, { textContent: string; remove(): void; }>();
    const requests: { signal: AbortSignal; result: ReturnType<typeof Promise.withResolvers<Response>>; }[] = [];
    const warnings: unknown[] = [];
    const colors = loadThemeModule("src/plugins/clientTheme/utils/colorUtils.ts");
    const api = loadThemeModule("src/plugins/clientTheme/utils/styleUtils.ts", {
        "./colorUtils": colors,
        "@api/Styles": {},
        "@utils/css": { createAndAppendStyle(id: string) {
            const style = { textContent: "", remove: () => { styles.delete(id); } }; styles.set(id, style); return style;
        } },
        "@utils/Logger": { Logger: class { warn(...args: unknown[]) { warnings.push(args); } } }
    }, {
        AbortController,
        document: { querySelectorAll: () => urls.map(href => ({ href })) },
        fetch: (_url: string, { signal }: { signal: AbortSignal; }) => {
            const result = Promise.withResolvers<Response>(); requests.push({ signal, result }); return result.promise;
        }
    });
    return { api, styles, requests, warnings, colors };
}

const CLIENT_THEME_CSS = ":root{--neutral-2-hsl:220 5% 98%;--neutral-69-hsl:220 5% 20%;--neutral-50-hsl:220 5% 50%;}";

test("ClientTheme ignores disabled color changes and cancels stopped or superseded styles", async () => {
    const { api, styles, requests } = clientThemeFixture();
    api.createOrUpdateThemeColorVars("ff0000");
    assert.equal(styles.size, 0);
    const old = api.startClientTheme("ff0000");
    api.disableClientTheme();
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(styles.size, 0);
    const current = api.startClientTheme("00ff00");
    requests[1].result.resolve(new Response(CLIENT_THEME_CSS));
    await current;
    const active = styles.get("vc-clientTheme-overrides");
    assert.ok(active);
    assert.match(active.textContent, /--neutral-50-hsl:.*\+ 30\.00%/);
    requests[0].result.resolve(new Response(CLIENT_THEME_CSS.replace("50%;", "60%;")));
    await old;
    assert.equal(styles.get("vc-clientTheme-overrides"), active);
    const obsolete = api.startClientTheme("0000ff");
    const latest = api.startClientTheme("ffffff");
    assert.equal(requests[2].signal.aborted, true);
    requests[3].result.resolve(new Response(CLIENT_THEME_CSS));
    await latest;
    const latestCss = active.textContent;
    requests[2].result.resolve(new Response(CLIENT_THEME_CSS.replace("50%;", "60%;")));
    await obsolete;
    assert.equal(active.textContent, latestCss);
    api.disableClientTheme();
    assert.equal(styles.size, 0);
});

test("ClientTheme tolerates an unrelated stylesheet failure and rejects missing base colors", async () => {
    const good = clientThemeFixture(["missing.css", "colors.css"]);
    const pending = good.api.startClientTheme("invalid");
    good.requests[0].result.resolve(new Response("Not found", { status: 404 }));
    good.requests[1].result.resolve(new Response(CLIENT_THEME_CSS));
    await pending;
    assert.ok(good.styles.has("vc-clientTheme-overrides"));
    assert.equal(good.warnings.length, 1);
    assert.doesNotMatch(good.styles.get("vc-clientTheme-vars")?.textContent ?? "", /NaN/);
    const missing = clientThemeFixture();
    const incomplete = missing.api.startClientTheme("313338");
    missing.requests[0].result.resolve(new Response("body { color: red; }"));
    await incomplete;
    assert.equal(missing.styles.has("vc-clientTheme-overrides"), false);
    assert.equal(missing.warnings.length, 1);
});

test("ClientTheme color conversion handles primaries, grayscale and invalid imported values", () => {
    const colors = loadThemeModule("src/plugins/clientTheme/utils/colorUtils.ts");
    for (const [hex, hue, saturation, lightness] of [["ff0000", 0, 100, 50], ["00ff00", 120, 100, 50], ["0000ff", 240, 100, 50], ["ffffff", 0, 0, 100], ["000000", 0, 0, 0]] as const) {
        const value = colors.hexToHSL(hex);
        assert.deepEqual([value.hue, value.saturation, value.lightness], [hue, saturation, lightness]);
    }
    assert.equal(colors.relativeLuminance("000000"), 0);
    assert.equal(colors.relativeLuminance("ffffff"), 1);
    assert.equal(colors.relativeLuminance("ff0000"), 0.2126);
    for (const value of [null, undefined, 0, "", "#123456", "ffff", "invalid"])
        assert.equal(colors.normalizeHexColor(value), "313338");
    assert.equal(colors.normalizeHexColor("Aa00fF"), "Aa00fF");
});

test("ClientTheme settings subscribe to color changes and send lowercase theme values", () => {
    const colors = loadThemeModule("src/plugins/clientTheme/utils/colorUtils.ts");
    const store = { color: "000000" };
    const keys: string[][] = [];
    const themes: string[] = [];
    const themeStore = { theme: "light" };
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const settings = loadThemeModule("src/plugins/clientTheme/components/Settings.tsx", {
        "..": { settings: { store, use: (names: string[]) => { keys.push(names); return store; } } },
        "@plugins/clientTheme/utils/colorUtils": colors,
        "@components/ErrorCard": { ErrorCard: "warning" },
        "@components/Heading": { HeadingPrimary: "h1", HeadingSecondary: "h2" },
        "@components/Paragraph": { Paragraph: "p" },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/margins": { Margins: {} },
        "@webpack": { findByCodeLazy: () => ({ theme }: { theme: string; }) => themes.push(theme) },
        "@webpack/common": { Button: Object.assign(() => null, { Colors: {} }), ColorPicker: "picker", ThemeStore: themeStore, ClientThemesBackgroundStore: {}, useStateFromStores: (_stores: unknown[], read: () => unknown) => read() }
    }, { React });
    const render = () => settings.ThemeSettingsComponent();
    const first = render();
    first.props.children[1].props.children[3].props.children[0].props.onClick();
    assert.equal(themes[0], "dark");
    store.color = "ffffff";
    themeStore.theme = "dark";
    const second = render();
    assert.equal(second.props.children[0].props.children[1].props.color, 0xffffff);
    second.props.children[1].props.children[3].props.children[0].props.onClick();
    assert.equal(themes[1], "light");
    assert.equal(keys[0], keys[1]);
    assert.deepEqual(Array.from(keys[0]), ["color"]);
});

function fixture() {
    const settings = {
        enabledThemeLinks: [] as string[], enabledThemes: [] as string[], useQuickCss: true,
        themeActivationModes: {} as Record<string, "always" | "light" | "dark">
    };
    const styles = new Map<string, { textContent: string; disabled: boolean; }>();
    const blobs = new Map<string, Blob>();
    const errors: unknown[][] = [];
    const quickCss = Promise.withResolvers<string>();
    const listeners: ((css: string) => void)[] = [];
    const themeData = new Map<string, Promise<string | undefined>>();
    let urlCount = 0;
    const mocks: Record<string, object> = {
        "@api/Settings": { Settings: settings },
        "@utils/css": {
            createAndAppendStyle(id: string) {
                let text = "";
                const style = {
                    disabled: false,
                    get textContent() { return text; },
                    set textContent(value: string) { text = value; this.disabled = false; }
                };
                styles.set(id, style);
                return style;
            }
        },
        "@utils/guards": { isNonNullish: (value: unknown) => value != null },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@webpack/common": {},
        "@webpack/common/stores": { ThemeStore: { theme: "dark" } },
        "./Styles": {}
    };
    const api = {} as { initThemes(): Promise<void>; toggle(enabled: boolean): Promise<void>; };
    runInNewContext(transpileModule(source + "\nexport { initThemes, toggle };", {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText, {
        exports: api, IS_WEB: true, IS_USERSCRIPT: false, Blob,
        document: { addEventListener() { } },
        URL: {
            createObjectURL(blob: Blob) { const url = `blob:fixture-${++urlCount}`; blobs.set(url, blob); return url; },
            revokeObjectURL(url: string) { blobs.delete(url); }
        },
        VencordNative: {
            themes: { getThemeData: (name: string) => themeData.get(name) ?? Promise.resolve(undefined) },
            quickCss: { get: () => quickCss.promise, addChangeListener: (listener: (css: string) => void) => listeners.push(listener) }
        },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return { api, settings, styles, blobs, errors, themeData, quickCss, listeners };
}

test("overlapping theme loads preserve current URLs and only commit the latest selection", async () => {
    const { api, settings, styles, blobs, themeData } = fixture();
    settings.enabledThemes = ["initial"];
    themeData.set("initial", Promise.resolve("initial {}"));
    await api.initThemes();
    const previousUrl = [...blobs.keys()][0];
    const slow = Promise.withResolvers<string>();
    themeData.set("slow", slow.promise);
    settings.enabledThemes = ["slow"];
    const obsolete = api.initThemes();
    assert.ok(blobs.has(previousUrl), "active styles survive while replacement data is loading");
    settings.enabledThemes = ["latest"];
    themeData.set("latest", Promise.resolve("latest {}"));
    await api.initThemes();
    const currentCss = styles.get("vencord-themes")?.textContent;
    assert.equal(blobs.has(previousUrl), false);
    slow.resolve("obsolete {}");
    await obsolete;
    assert.equal(styles.get("vencord-themes")?.textContent, currentCss);
    assert.equal(blobs.size, 1);
    assert.equal(await [...blobs.values()][0].text(), "latest {}");
    settings.enabledThemes = [];
    await api.initThemes();
    assert.equal(blobs.size, 0);
});

test("failed theme reads retain the active style and do not leak partial results", async () => {
    const { api, settings, styles, blobs, errors, themeData } = fixture();
    settings.enabledThemes = ["initial"];
    themeData.set("initial", Promise.resolve("initial {}"));
    await api.initThemes();
    const currentCss = styles.get("vencord-themes")?.textContent;
    const failure = Promise.withResolvers<string>();
    settings.enabledThemes = ["good", "bad"];
    themeData.set("good", Promise.resolve("new {}"));
    themeData.set("bad", failure.promise);
    const pending = api.initThemes();
    failure.reject(new Error("Read failed"));
    await pending;
    assert.equal(styles.get("vencord-themes")?.textContent, currentCss);
    assert.equal(blobs.size, 1);
    assert.equal(await [...blobs.values()][0].text(), "initial {}");
    assert.equal(errors.length, 1);
});

test("initial QuickCSS reading cannot undo a disable toggle", async () => {
    const { api, settings, styles, quickCss } = fixture();
    const pending = api.toggle(true);
    settings.useQuickCss = false;
    await api.toggle(false);
    quickCss.resolve("body {}");
    await pending;
    assert.equal(styles.get("vencord-custom-css")?.disabled, true);
});

test("a QuickCSS edit arriving before the initial read retains the newer content", async () => {
    const { api, styles, quickCss, listeners } = fixture();
    const pending = api.toggle(true);
    listeners[0]("new {}");
    quickCss.resolve("old {}");
    await pending;
    assert.equal(styles.get("vencord-custom-css")?.textContent, "new {}");
});

test("legacy theme prefixes retain activation behavior and allow explicit overrides", async () => {
    const { api, settings, styles } = fixture();
    settings.enabledThemeLinks = ["@light https://example.com/light.css", "@dark https://example.com/dark.css"];
    await api.initThemes();
    assert.equal(styles.get("vencord-themes")?.textContent, '@import url("https://example.com/dark.css");');
    settings.themeActivationModes[settings.enabledThemeLinks[0]] = "always";
    await api.initThemes();
    assert.ok(styles.get("vencord-themes")?.textContent.includes("https://example.com/light.css"));
});

function readFunction(path: string, name: string) {
    const source = createSourceFile(path, readFileSync(path, "utf8"), ScriptTarget.Latest, true);
    const declaration = forEachChild(source, function visit(node): string | undefined {
        if (isFunctionDeclaration(node) && node.body && node.name?.text === name) return node.getText(source);
        return forEachChild(node, visit);
    });
    assert.ok(declaration, name);
    return declaration.replace(/^export /, "");
}

test("theme URL validation follows edits and ignores obsolete responses", async () => {
    const code = readFunction("src/utils/react.tsx", "useAwaiter")
        + readFunction("src/components/settings/tabs/themes/OnlineThemes.tsx", "Validator");
    const requests = new Map<string, ReturnType<typeof Promise.withResolvers<Response>>>();
    const validity: boolean[] = [];
    let cleanup: (() => void) | undefined;
    let dependencies: unknown[] | undefined;
    const validate = runInNewContext(transpileModule(code + "\nValidator;", {
        compilerOptions: { target: ScriptTarget.ES2022, jsx: JsxEmit.React }, fileName: "fixture.tsx"
    }).outputText, {
        Paragraph: "p", React: { createElement() { } },
        useState: (value: unknown) => [value, () => { }],
        useEffect(effect: () => () => void, deps: unknown[]) {
            if (dependencies && deps.every((value, i) => value === dependencies?.[i])) return;
            cleanup?.();
            dependencies = deps;
            cleanup = effect();
        },
        fetch(link: string) {
            const request = Promise.withResolvers<Response>();
            requests.set(link, request);
            return request.promise;
        }
    });
    const onValidate = (value: boolean) => validity.push(value);
    validate({ link: "first", onValidate });
    validate({ link: "second", onValidate });
    assert.equal(requests.size, 2);
    requests.get("second")?.resolve(new Response(null, { status: 404 }));
    await setImmediate();
    assert.deepEqual(validity, [false]);
    requests.get("first")?.resolve(new Response(null, { headers: { "Content-Type": "text/css" } }));
    await setImmediate();
    assert.deepEqual(validity, [false], "an older successful request cannot approve the current URL");
    validate({ link: "third", onValidate });
    requests.get("third")?.resolve(new Response(null, { headers: { "Content-Type": "text/css" } }));
    await setImmediate();
    assert.deepEqual(validity, [false, true]);
    cleanup?.();
});

test("explicit always-on activation survives metadata inference", () => {
    const path = "src/components/settings/tabs/themes/index.tsx";
    const code = ["setThemeActivationMode", "inferAndStoreThemeActivationMode", "inferThemeActivationMode"]
        .map(name => readFunction(path, name)).join("\n");
    const settings = { themeActivationModes: {} as Record<string, string> };
    const api = runInNewContext(transpileModule(code + "\n({ setThemeActivationMode, inferAndStoreThemeActivationMode });", {
        compilerOptions: { target: ScriptTarget.ES2022 }
    }).outputText, { settings, Settings: settings });
    api.setThemeActivationMode("theme", "always");
    api.inferAndStoreThemeActivationMode("theme", "/* metadata */\n@dark {}");
    assert.equal(settings.themeActivationModes.theme, "always");
});

test("theme uploads finish all files and refresh once when a file read fails", async () => {
    const code = readFunction("src/components/settings/tabs/themes/index.tsx", "doUploadThemes");
    const uploaded: string[] = [];
    let refreshes = 0;
    let failures = 0;
    const upload = runInNewContext(transpileModule(code + "\ndoUploadThemes;", {
        compilerOptions: { target: ScriptTarget.ES2022 }
    }).outputText, {
        VencordNative: { themes: { uploadTheme: async (name: string) => uploaded.push(name) } },
        refreshLocalThemes: async () => { refreshes++; },
        showToast: () => failures++, Toasts: { Type: { FAILURE: "failure" } }
    });
    await upload([
        { name: "good.css", text: async () => "body {}" },
        { name: "bad.css", text: async () => { throw new Error("Read failed"); } },
        { name: "ignored.txt", text: async () => assert.fail("non-CSS files must be skipped") }
    ]);
    assert.deepEqual(uploaded, ["good.css"]);
    assert.equal(refreshes, 1);
    assert.equal(failures, 1);
});
