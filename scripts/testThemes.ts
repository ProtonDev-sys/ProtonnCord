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
