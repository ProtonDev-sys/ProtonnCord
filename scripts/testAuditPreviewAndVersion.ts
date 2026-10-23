/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { livePreviewSource, previewSource, versionFooters } from "./fixtures/discordPreviewAndVersion";
import { declaration, evaluate, jsx, pluginPatches, React, sourceNode } from "./utils/discordClientFixture";

const autoPath = "src/equicordplugins/autoCodeblockLanguage.desktop/index.ts";
const shikiPath = "src/plugins/shikiCodeblocks.desktop/index.tsx";
const settingsPath = "src/plugins/_core/settings.tsx";

function apply(source: string, patch: any, name: string) {
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    for (const replacement of replacements) {
        const match = canonicalizeMatch(replacement.match);
        assert.equal([...source.matchAll(new RegExp(match.source, "g"))].length, 1, "exactly one host expression must match");
        source = source.replace(match, canonicalizeReplace(replacement.replace, name));
    }
    return source;
}

const classNames = () => (base: string, flags: Record<string, boolean>) => [base, ...Object.keys(flags).filter(key => flags[key])].join(" ");
const previewGenerations = [
    { name: "initial capture", source: previewSource, globals: { r: { jsx }, e_: { d: "native-preview" }, eE: { Xb: "preview", Zw: "wrap" }, l: classNames } },
    { name: "live capture", source: livePreviewSource, globals: { a: { jsx }, eh: { d: "native-preview" }, em: { Xb: "preview", Zw: "wrap" }, r: classNames } }
];

function previewPlugins() {
    const calls: unknown[][] = [];
    const auto = { resolveLanguage(language: string | undefined, text: string) { calls.push([language, text]); return language || "typescript"; } };
    const shiki = { name: "ShikiCodeblocks", renderHighlighter: (args: unknown) => jsx("shiki-preview", args) };
    const autoPatch = pluginPatches(autoPath, { isPluginEnabled: () => false, shikiCodeblocks: shiki })[1];
    const shikiPatch = pluginPatches(shikiPath)[1];
    return { auto, shiki, autoPatch, shikiPatch, calls };
}

for (const preview of previewGenerations) {
    test(preview.name + ": code previews detect language without mutating frozen React props and preserve native wrapping", () => {
        const { auto, autoPatch, calls } = previewPlugins();
        const render = runInNewContext('"use strict";(' + apply(preview.source, autoPatch, "auto") + ")", { ...preview.globals, auto });
        for (const language of [undefined, "rust"]) for (const wordWrap of [false, true]) {
            const props = Object.freeze({ text: "const answer = 42;", language, wordWrap });
            const rendered = render(props);
            assert.equal(rendered.type, "native-preview");
            assert.equal(rendered.props.language, language || "typescript");
            assert.equal(rendered.props.text, props.text);
            assert.equal(rendered.props.className, wordWrap ? "preview wrap" : "preview");
            assert.equal(props.language, language);
        }
        assert.equal(calls.length, 4);
        assert.deepEqual(calls[0], [undefined, "const answer = 42;"]);
    });

    test(preview.name + ": preview patches compose in both reporter orders while the real Shiki wrapper handles detection", () => {
        for (const order of [["auto", "shiki"], ["shiki", "auto"]]) {
            const { auto, shiki, autoPatch, shikiPatch, calls } = previewPlugins();
            let source = preview.source;
            for (const name of order) source = apply(source, name === "auto" ? autoPatch : shikiPatch, name);
            declaration(autoPath, "installShikiWrapper", { originalShikiRender: null, shikiCodeblocks: shiki, resolveLanguage: auto.resolveLanguage })();
            const render = runInNewContext('"use strict";(' + source + ")", { auto, shiki });
            const props = Object.freeze({ text: "const answer = 42;", language: undefined, wordWrap: true });
            const rendered = render(props);
            assert.equal(rendered.type, "shiki-preview");
            assert.equal(rendered.props.lang, "typescript");
            assert.equal(rendered.props.content, props.text);
            assert.equal(props.language, undefined);
            assert.equal(calls.length, 1, "the native preview path must not run after Shiki renders");
        }
        const [native, previewPatch] = pluginPatches(autoPath, { isPluginEnabled: () => true, shikiCodeblocks: { name: "ShikiCodeblocks" } });
        assert.equal(native.predicate(), false);
        assert.equal(previewPatch.predicate(), false);
    });
}

function settingsPlugin(settings: { store: { includeVencordInfoWhenCopying: boolean; }; }) {
    const methods = ["getInfoRows", "getInfoString", "makeInfoElements"].map(name => sourceNode(settingsPath, node => ts.isMethodDeclaration(node) && node.name.getText() === name));
    return evaluate("const plugin={" + methods.join(",") + ",getVersionInfo:()=>\" (fixture)\",electronVersion:\"42.test\",chromiumVersion:\"148.test\"};plugin;", {
        settings, React, gitHashShort: "abcdef0"
    });
}

function footerGlobals(channel: string, nativeHost: boolean, buildOverride: boolean) {
    return {
        window: { GLOBAL_ENV: { RELEASE_CHANNEL: channel } },
        eV: { GV: () => "copy-version" },
        eY: { A: nativeHost ? { app: { getVersion: () => "host-version", getBuildNumber: () => 123, getAppArch: () => "X64" }, os: { release: "kernel-version" } } : undefined },
        eX: { A: { getCurrentBuildOverride: () => ({ overrides: { discord_web: buildOverride ? { id: "fixture-build" } : undefined } }) } },
        eq: { A: () => "3 days ago" }, ez: () => ({ os: { toString: () => "Linux" } }), eZ: { Ay: { parsedOSRelease: [6, 8, 0] } },
        i: { jsx, jsxs: jsx, Fragment: "fragment" }, e$: { A: "copy-tooltip" }, O: { D: "version-box" }, a: { E: "text" },
        I: () => (...classes: string[]) => classes.join(" "), eQ: { vk: "box", oE: "clickable", Cr: "main", Pc: "version-code", GI: "arch" },
        K: { intl: { string: (value: unknown) => value }, t: { "9Al4Qd": "Copy version" } }, S: { A: "screen-reader" }, b: { A: "screen-reader" }
    };
}

for (const [channel, source] of Object.entries(versionFooters)) {
    test(`${channel}: settings version rows preserve the optional build suffix, native host details and copy preference`, () => {
        const settings = { store: { includeVencordInfoWhenCopying: true } };
        const plugin = settingsPlugin(settings);
        const patched = apply(source, pluginPatches(settingsPath)[0], "plugin");
        for (const nativeHost of [false, true]) for (const buildOverride of [false, true]) for (const includeInfo of [false, true]) {
            settings.store.includeVencordInfoWhenCopying = includeInfo;
            const globals = footerGlobals(channel, nativeHost, buildOverride);
            const actual = runInNewContext("(" + patched + ")", { ...globals, plugin })();
            const capitalized = channel[0].toUpperCase() + channel.slice(1);
            const expected = runInNewContext("(" + source + ")", { ...globals, window: { GLOBAL_ENV: { RELEASE_CHANNEL: capitalized } } })();
            const tooltip = actual.props.children[0];
            const originalTooltip = expected.props.children[0];
            const rows = Array.from(plugin.getInfoRows()) as string[];
            assert.equal(tooltip.props.copyValue, originalTooltip.props.copyValue + (includeInfo ? "\n" + rows.join("\n") : ""));
            assert.equal(tooltip.props.text, "Copy version");
            assert.equal(tooltip.props["aria-label"], false);
            assert.equal(tooltip.props.dataMeticulousIgnore, "true");
            assert.equal(JSON.stringify(actual.props.children[1]), JSON.stringify(expected.props.children[1]), "screen-reader text must survive");
            const onMouseEnter = () => {};
            const box = tooltip.props.children({ onMouseEnter });
            const originalBox = originalTooltip.props.children({ onMouseEnter });
            assert.equal(box.props.onMouseEnter, onMouseEnter);
            assert.equal(box.props["aria-describedby"], "copy-version");
            assert.equal(JSON.stringify(box.props.children[0]), JSON.stringify(originalBox.props.children[0]), "native version and architecture must survive");
            assert.equal(JSON.stringify(box.props.children[2]), JSON.stringify(originalBox.props.children[1]), "build override and timestamp suffix must survive");
            const info = box.props.children[1];
            assert.equal(info.length, rows.length);
            info.forEach((row: any, index: number) => {
                assert.equal(row.type, "text");
                assert.equal(row.props.tag, "span");
                assert.equal(row.props.variant, "text-xxs/normal");
                assert.equal(row.props.color, "text-muted");
                assert.equal(row.props.children.type, "span");
                assert.equal(row.props.children.props.className, "version-code");
                assert.equal(row.props.children.props.children[0], rows[index]);
            });
        }
    });
}
