/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build, type Plugin } from "esbuild";

import { openExternalInBrowser } from "../browser/externalLinks";
import { getThemeInfo } from "../src/main/themes";
import { getThemeMetadataHttpsUrl, parseExternalHttpsUrl } from "../src/shared/externalUrls";

interface OpenCall {
    features?: string;
    target?: string;
    url?: string | URL;
}

interface BrowserNative {
    native: {
        openExternal(value: unknown): Promise<void>;
    };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === "object" && value !== null;
}

function getBrowserNative(value: unknown): BrowserNative {
    assert.ok(isRecord(value));
    const native = value.native;
    assert.ok(isRecord(native));
    const openExternal = native.openExternal;
    if (typeof openExternal !== "function") assert.fail("browser native openExternal is unavailable");
    return {
        native: {
            async openExternal(value) {
                await Reflect.apply(openExternal, native, [value]);
            }
        }
    };
}

const validUrl = "HTTPS://EXAMPLE.COM:443/a/../theme?q=hello world#details";
const canonicalUrl = "https://example.com/theme?q=hello%20world#details";
assert.equal(parseExternalHttpsUrl(validUrl), canonicalUrl);
assert.equal(parseExternalHttpsUrl("https://example.com"), "https://example.com/");

const unsafeUrls: unknown[] = [
    "javascript:document.title='owned'",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///C:/Windows/System32/calc.exe",
    "http://example.com/theme.css",
    "https://user@example.com/theme.css",
    "https://user:password@example.com/theme.css",
    "/relative/theme.css",
    "//example.com/theme.css",
    "https://",
    "https://exa mple.com/theme.css",
    "https://example.com:99999/theme.css",
    "https://example.com./theme.css",
    " https://example.com/theme.css",
    "https://example.com/theme.css ",
    "https://example.com/\nowned",
    "https://example.com/\u0000owned",
    "https://example.com/\u2028owned",
    "https://example.com\\@evil.example/theme.css",
    `https://example.com/${"a".repeat(10_000)}`,
    "",
    null,
    undefined,
    123,
    { toString: () => "https://example.com/theme.css" }
];

for (const value of unsafeUrls) {
    assert.equal(parseExternalHttpsUrl(value), null, `${String(value)} must not be an external HTTPS URL`);
}

const safeMetadata = `/**
 * @name Safe metadata
 * @website ${validUrl}
 * @source https://SOURCE.example:443/a/../source.css
 * @donate https://DONATE.example:443/support
 */
body { color: red; }
`;
assert.equal(getThemeMetadataHttpsUrl(safeMetadata, "website"), canonicalUrl);
assert.equal(getThemeMetadataHttpsUrl(safeMetadata, "source"), "https://source.example/source.css");
assert.equal(getThemeMetadataHttpsUrl(safeMetadata, "donate"), "https://donate.example/support");

const hostileMetadata = `/**
 * @name Hostile metadata
 * @website javascript:alert(1)
 * @source data:text/html,<script>alert(1)</script>
 * @donate file:///C:/Windows/System32/calc.exe
 */
body { color: red; }
`;
for (const field of ["website", "source", "donate"] as const) {
    assert.equal(getThemeMetadataHttpsUrl(hostileMetadata, field), null, `unsafe @${field} metadata must be rejected`);
}

const safeTheme = getThemeInfo(safeMetadata, "safe.css");
assert.equal(safeTheme.website, canonicalUrl);
assert.equal(safeTheme.source, "https://source.example/source.css");
assert.equal(safeTheme.donate, "https://donate.example/support");

const hostileTheme = getThemeInfo(hostileMetadata, "hostile.css");
assert.equal(hostileTheme.website, undefined);
assert.equal(hostileTheme.source, undefined);
assert.equal(hostileTheme.donate, undefined);

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreWindow(): void {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
}

function installWindow(open: (url?: string | URL, target?: string, features?: string) => unknown): Record<PropertyKey, unknown> {
    const fakeWindow = { open };
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: fakeWindow,
        writable: true
    });
    return fakeWindow;
}

function testBrowserOpener(): void {
    const calls: OpenCall[] = [];
    const openedWindow = { opener: { discord: true } };
    installWindow((url, target, features) => {
        calls.push({ features, target, url });
        return openedWindow;
    });

    for (const value of unsafeUrls) {
        assert.equal(openExternalInBrowser(value), false, `${String(value)} must not open a browser window`);
    }
    assert.equal(calls.length, 0, "unsafe external URLs must be rejected before window.open");

    assert.equal(openExternalInBrowser(validUrl), true);
    assert.deepEqual(calls, [{
        features: "noopener,noreferrer",
        target: "_blank",
        url: canonicalUrl
    }]);
    assert.equal(openedWindow.opener, null, "the opened page must not retain its Discord opener");

    installWindow(() => {
        throw new Error("popup failure");
    });
    assert.equal(openExternalInBrowser("https://example.com/safe"), false,
        "a failed browser open must not be reported as successful");
}

const browserStubRuntime: Plugin = {
    name: "external-url-browser-stub-runtime",
    setup(bundle) {
        bundle.onResolve({ filter: /^file:\/\/monacoWin\.html\?minify$/ }, () => ({
            namespace: "external-url-test",
            path: "monaco"
        }));
        bundle.onResolve({ filter: /^@api\/DataStore$/ }, () => ({ namespace: "external-url-test", path: "data-store" }));
        bundle.onResolve({ filter: /^@main\/themes$/ }, () => ({ path: path.resolve("src/main/themes/index.ts") }));
        bundle.onResolve({ filter: /^@shared\/debounce$/ }, () => ({ namespace: "external-url-test", path: "debounce" }));
        bundle.onResolve({ filter: /^@shared\/externalUrls$/ }, () => ({ path: path.resolve("src/shared/externalUrls.ts") }));
        bundle.onResolve({ filter: /^@utils\/discord$/ }, () => ({ namespace: "external-url-test", path: "discord" }));
        bundle.onResolve({ filter: /^@utils\/localStorage$/ }, () => ({ namespace: "external-url-test", path: "local-storage" }));
        bundle.onResolve({ filter: /^@utils\/web$/ }, () => ({ namespace: "external-url-test", path: "web" }));
        bundle.onResolve({ filter: /^@utils\/web-metadata$/ }, () => ({ namespace: "external-url-test", path: "web-metadata" }));

        bundle.onLoad({ filter: /^monaco$/, namespace: "external-url-test" }, () => ({
            contents: "export default '<html></html>';",
            loader: "js"
        }));
        bundle.onLoad({ filter: /^data-store$/, namespace: "external-url-test" }, () => ({
            contents: `
                export const createStore = () => ({});
                export const set = async () => undefined;
                export const del = async () => undefined;
                export const get = async () => undefined;
                export const entries = async () => [];
            `,
            loader: "js"
        }));
        bundle.onLoad({ filter: /^debounce$/, namespace: "external-url-test" }, () => ({
            contents: "export const debounce = callback => callback;",
            loader: "js"
        }));
        bundle.onLoad({ filter: /^discord$/, namespace: "external-url-test" }, () => ({
            contents: "export const getTheme = () => 0; export const Theme = { Light: 0 };",
            loader: "js"
        }));
        bundle.onLoad({ filter: /^local-storage$/, namespace: "external-url-test" }, () => ({
            contents: "export const localStorage = { getItem: () => null, setItem: () => undefined };",
            loader: "js"
        }));
        bundle.onLoad({ filter: /^web$/, namespace: "external-url-test" }, () => ({
            contents: "export const getStylusWebStoreUrl = () => 'https://example.com/stylus';",
            loader: "js"
        }));
        bundle.onLoad({ filter: /^web-metadata$/, namespace: "external-url-test" }, () => ({
            contents: `
                export const EXTENSION_BASE_URL = "https://example.com/extension/";
                export const RENDERER_CSS_URL = "https://example.com/renderer.css";
                export const metaReady = Promise.resolve();
            `,
            loader: "js"
        }));
    }
};

async function testRealBrowserNativeStub(): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), "protonncord-external-url-"));
    const bundlePath = path.join(root, "browser-native-stub.mjs");
    const calls: OpenCall[] = [];
    const openedWindows: Array<{ opener: unknown; }> = [];
    const fakeWindow = installWindow((url, target, features) => {
        calls.push({ features, target, url });
        const openedWindow = { opener: { discord: true } };
        openedWindows.push(openedWindow);
        return openedWindow;
    });

    try {
        await build({
            absWorkingDir: path.resolve("."),
            bundle: true,
            define: { IS_USERSCRIPT: "false" },
            entryPoints: ["browser/VencordNativeStub.ts"],
            format: "esm",
            outfile: bundlePath,
            platform: "browser",
            plugins: [browserStubRuntime],
            target: "chrome120"
        });
        await import(pathToFileURL(bundlePath).href);
        const native = getBrowserNative(Reflect.get(fakeWindow, "VencordNative"));

        for (const value of unsafeUrls) {
            await native.native.openExternal(value);
        }
        assert.equal(calls.length, 0, "the real browser native stub must reject every unsafe external URL");

        await native.native.openExternal(validUrl);
        assert.deepEqual(calls, [{
            features: "noopener,noreferrer",
            target: "_blank",
            url: canonicalUrl
        }]);
        assert.equal(openedWindows[0]?.opener, null, "the real browser native stub must sever opener access");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
}

function testProductionIntegration(): void {
    const browserStub = readFileSync("browser/VencordNativeStub.ts", "utf8");
    const nativeStart = browserStub.indexOf("native: {");
    const nativeEnd = browserStub.indexOf("updater:", nativeStart);
    assert.ok(nativeStart >= 0 && nativeEnd > nativeStart);
    const nativeSection = browserStub.slice(nativeStart, nativeEnd);
    assert.match(nativeSection, /openExternalInBrowser/u);
    assert.doesNotMatch(nativeSection, /\b(?:window\.)?open\s*\(/u,
        "the browser native external-link capability must not bypass the hardened opener");

    const mainThemes = readFileSync("src/main/themes/index.ts", "utf8");
    assert.match(mainThemes, /parseExternalHttpsUrl\(header\.website\)/u);
    assert.match(mainThemes, /parseExternalHttpsUrl\(header\.source\)/u);
    assert.match(mainThemes, /parseExternalHttpsUrl\(header\.donate\)/u);

    const themeCard = readFileSync("src/components/settings/tabs/themes/ThemeCard.tsx", "utf8");
    assert.match(themeCard, /parseExternalHttpsUrl\(theme\.website\)/u);
    assert.doesNotMatch(themeCard, /window\.open\(theme\.website/u);
    assert.doesNotMatch(themeCard, /href=\{theme\.website\}/u,
        "theme metadata must be validated before reaching an anchor URL context");

    const libraryCard = readFileSync("src/equicordplugins/themeLibrary/components/ThemeCard.tsx", "utf8");
    assert.match(libraryCard, /getThemeMetadataHttpsUrl\(content,\s*"source"\)/u);
    assert.doesNotMatch(libraryCard, /metadata\.match\(\/@source/u);

    const libraryModal = readFileSync("src/equicordplugins/themeLibrary/components/ThemeInfoModal.tsx", "utf8");
    assert.match(libraryModal, /getThemeMetadataHttpsUrl\(themeContent,\s*"donate"\)/u);
    assert.doesNotMatch(libraryModal, /metadata\.match\(\/@donate/u);
}

async function main(): Promise<void> {
    try {
        testBrowserOpener();
        await testRealBrowserNativeStub();
        testProductionIntegration();
        console.log("external URL boundary checks passed");
    } finally {
        restoreWindow();
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
