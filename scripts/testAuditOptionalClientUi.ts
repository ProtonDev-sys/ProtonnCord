/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { librarySource, nameplateSource, questsSource, statusSource } from "./fixtures/discordOptionalUi";
import { loadTestModule } from "./utils/loadTestModule";

function plugins() {
    const imports = {
        "@api/Settings": {
            definePluginSettings: (schema: Record<string, any>) => ({ store: Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, value.default])) }),
            migratePluginSetting() {}
        },
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@components/Divider": {}, "@components/Heading": {}, "@components/Notice": {},
        "@components/ErrorBoundary": {}, "@plugins/decor": { __esModule: true, default: { name: "Decor" } },
        "@utils/constants": { EquicordDevs: {} }, "@utils/index": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/lazy": { proxyLazy: () => ({}) },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {}, StartAt: {} },
        "@webpack": { findComponentByCodeLazy: () => () => {}, extractAndLoadChunksLazy: () => () => {} },
        "@webpack/common": {}
    };
    return {
        declutter: loadTestModule("src/equicordplugins/declutter/index.tsx", imports, {}).default,
        status: loadTestModule("src/equicordplugins/statusPresets/index.tsx", imports, {}).default
    };
}

function apply(source: string, replacement: any) {
    const match = canonicalizeMatch(replacement.match);
    assert.equal([...source.matchAll(new RegExp(match.source, "g"))].length, 1, "the patch must select exactly one current host expression");
    return source.replace(match, canonicalizeReplace(replacement.replace, "plugin"));
}

const jsx = (type: unknown, props: any, key?: string) => ({ type, props, key });

test("Declutter independently hides current quest and library links while preserving other navigation", () => {
    const { declutter } = plugins();
    const replacements = declutter.patches.find((patch: any) => patch.find === 'tutorialId:"direct-messages"').replacement.slice(2, 4);
    const source = '["friends",' + librarySource + "," + questsSource + ',"other"]';
    for (const removeQuestsAboveDms of [false, true]) for (const removeLibraryAboveDms of [false, true]) {
        Object.assign(declutter.settings.store, { removeQuestsAboveDms, removeLibraryAboveDms });
        let patched = source;
        for (const replacement of replacements) if (replacement.predicate()) patched = apply(patched, replacement);
        const items = runInNewContext(patched, {
            w: { jsx }, yr: "library", L3: "quests", r: "/quests",
            K: { BVt: { APPLICATION_LIBRARY: "/library", QUEST_HOME: "/quests" } }
        });
        assert.equal(items.length, 4);
        assert.equal(items[0], "friends");
        assert.equal(items[3], "other");
        assert.equal(items[1]?.key, removeLibraryAboveDms ? undefined : "library");
        assert.equal(items[2]?.key, removeQuestsAboveDms ? undefined : "quests");
        if (!removeLibraryAboveDms) {
            assert.equal(items[1].props.selected, false);
            assert.equal(items[1].props.hideGameUpdateProgressIndicator, false);
        }
        if (!removeQuestsAboveDms) assert.equal(items[2].props.selected, true);
    }
});

test("Declutter removes ordinary nameplates and preserves both native preview render paths", () => {
    const { declutter } = plugins();
    const replacement = declutter.patches.find((patch: any) => patch.find === ".MINI_PREVIEW,[").replacement;
    const patched = apply(nameplateSource, replacement);
    let hooks = 0;
    const globals = {
        i: { jsx }, h: "nameplate-image", s: () => () => "nameplate-class",
        u: { _: () => ({ background: "background", maskImage: "mask" }) }, d: { i: () => true },
        r: { useRef: (current: unknown) => { hooks++; return { current }; }, useEffect: () => { hooks++; } },
        E: {}, _: { u: { ACCOUNT: "account", PREVIEW: "preview", MINI_PREVIEW: "mini_preview", CHANNEL: "channel" } }
    };
    const original = runInNewContext("(" + nameplateSource + ")", globals);
    const component = runInNewContext("(" + patched + ")", globals);
    const nameplate = { id: "fixture" };
    for (const placement of ["account", "channel", "profile"]) {
        assert.equal(component({ nameplate, placement }), null);
        assert.equal(hooks, 0, "hidden nameplates must not run host effects");
    }
    for (const placement of ["preview", "mini_preview"]) {
        const props = { nameplate, placement, hovered: true, selected: true };
        const expected = original(props);
        const rendered = component(props);
        assert.equal(JSON.stringify(rendered), JSON.stringify(expected));
        assert.equal(rendered.props["aria-hidden"], true);
        assert.equal(rendered.props.children.props.nameplate, nameplate);
        assert.equal(rendered.props.children.props.loop, true);
    }
});

test("StatusPresets adds its menu beside custom status and preserves the following optional wallet entry", () => {
    const { status: plugin } = plugins();
    const patched = apply(statusSource, plugin.patches[1].replacement);
    const preset = { type: "presets" };
    plugin.render = () => preset;
    const onClose = () => {};
    const ref = { current: null };
    for (const q of [false, true]) {
        const items = runInNewContext(patched, { plugin, i: { jsx }, t_: "custom-status", nd: "wallet", n: onClose, m: ref, k: "scroller", Q: true, q });
        assert.equal(items.length, 3);
        assert.equal(items[0].type, "custom-status");
        assert.equal(items[0].props.onClose, onClose);
        assert.equal(items[0].props.popoutContainerRef, ref);
        assert.equal(items[1], preset);
        if (q) {
            assert.equal(items[2].type, "wallet");
            assert.equal(items[2].props.popoutContainerRef, ref);
            assert.equal(items[2].props.onCloseAccountPopout, onClose);
            assert.equal(items[2].props.shouldScrollIntoView, true);
        } else assert.equal(items[2], false);
    }
});
