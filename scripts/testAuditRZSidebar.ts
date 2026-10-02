/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const React = {
    createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } })
};
function definePluginSettings(defs: any) {
    return { store: Object.fromEntries(Object.entries(defs).map(([key, value]: [string, any]) => [key, value.default ?? value.options?.find((option: any) => option.default)?.value])) };
}
function load(file: string, mocks: Record<string, unknown>, globals = {}, expose = "") {
    return loadTestModule("src/equicordplugins/" + file, {
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@utils/constants": { EquicordDevs: {} },
        "@api/Settings": { definePluginSettings },
        ...mocks
    }, { React, ...globals }, expose);
}

test("RZ3-04: visibility does not resume snowfall in an unfocused window", () => {
    const windowEvents = new Map<string, () => void>();
    const documentEvents = new Map<string, () => void>();
    const intervals = new Set<number>();
    let nextTimer = 0;
    let focused = true;
    let cleanup!: () => void;
    const element = () => ({ style: {}, appendChild() {}, addEventListener() {}, removeEventListener() {}, remove() {} });
    const document = {
        hidden: false, hasFocus: () => focused, createElement: element, body: element(), head: element(), getElementById: () => null,
        addEventListener: (name: string, fn: () => void) => documentEvents.set(name, fn),
        removeEventListener: (name: string) => documentEvents.delete(name)
    };
    const api = load("snowfall/index.tsx", {
        "@components/Heading": {}, "@components/Paragraph": {},
        "@webpack/common": { React: { ...React, useRef: () => ({ current: null }), useEffect: (fn: () => () => void) => { cleanup = fn(); } } }
    }, {
        document,
        window: {
            innerWidth: 1000, innerHeight: 800,
            setInterval: () => { intervals.add(++nextTimer); return nextTimer; },
            addEventListener: (name: string, fn: () => void) => windowEvents.set(name, fn),
            removeEventListener: (name: string) => windowEvents.delete(name)
        },
        clearInterval: (id: number) => intervals.delete(id)
    }, "\nexport { SnowfallManager };\n");
    api.SnowfallManager();
    assert.equal(intervals.size, 1);
    focused = false;
    windowEvents.get("blur")!();
    document.hidden = true;
    documentEvents.get("visibilitychange")!();
    document.hidden = false;
    documentEvents.get("visibilitychange")!();
    assert.equal(intervals.size, 0);
    focused = true;
    windowEvents.get("focus")!();
    documentEvents.get("visibilitychange")!();
    assert.equal(intervals.size, 1);
    document.hidden = true;
    documentEvents.get("visibilitychange")!();
    assert.equal(intervals.size, 0);
    cleanup();
    assert.equal(windowEvents.size, 0);
    assert.equal(documentEvents.size, 0);
});

function emojiFixture(initial: any[] = []) {
    let saved = initial;
    let fail = false;
    const toasts: any[] = [];
    const patches = new Map<string, any>();
    const a = { type: "emoji", id: "a", name: "same" };
    const b = { type: "emoji", id: "b", name: "same" };
    const api = load("whitelistedEmojis/index.tsx", {
        "@api/index": { DataStore: {
            get: async () => saved,
            set: async (_key: string, list: any[]) => { if (fail) throw new Error("offline storage failure"); saved = list; }
        } },
        "@api/ContextMenu": { addContextMenuPatch: (name: string, fn: any) => patches.set(name, fn), removeContextMenuPatch() {} },
        "@utils/web": {},
        "@webpack/common": {
            Menu: { MenuGroup: "group", MenuItem: "item" },
            EmojiStore: { getGuildEmoji: (id: string) => [id === "guild-a" ? a : b], getCustomEmojiById: (id: string) => ({ id, guildId: "guild-" + id }) },
            IconUtils: { getEmojiURL: ({ id }: any) => "emoji:" + id },
            Toasts: { Type: { SUCCESS: "success", FAILURE: "failure" }, Position: { BOTTOM: "bottom" }, genId: () => "toast", show: (toast: any) => toasts.push(toast) }
        }
    }, {}, "\nexport { addBulkToAllowedList, removeBulkFromAllowedList, addToAllowedList, removeFromAllowedList, importEmojis };\n");
    return { api, a, b, toasts, patches, saved: () => saved, fail: (value: boolean) => { fail = value; } };
}

test("RZ3-05: legacy records retain fields while membership and removal use emoji identity", async () => {
    const legacy = { type: "emoji", id: "a", name: "same", guildId: "guild-a", unknown: { preserved: true } };
    const unicode = { type: "emoji", id: "legacy-unicode", name: "old-alias", surrogates: "😀" };
    const f = emojiFixture([legacy, unicode]);
    await f.api.default.start();
    const renamed = { ...f.a, name: "renamed" };
    const unicodeResult = { uniqueName: "new-alias", name: "new-alias", surrogates: "😀" };
    assert.deepEqual(Array.from(f.api.default.filterEmojis([renamed, f.b, unicodeResult])), [renamed, unicodeResult]);
    await f.api.addToAllowedList(renamed);
    assert.equal(f.saved().length, 2);
    await f.api.addBulkToAllowedList([f.a, f.b, f.b]);
    assert.equal(f.saved().length, 3);
    assert.equal(f.saved()[0], legacy);
    await f.api.removeBulkFromAllowedList([f.a]);
    assert.deepEqual(Array.from(f.saved(), e => e.id), ["legacy-unicode", "b"]);
    await f.api.importEmojis(JSON.stringify({ emojis: [legacy, { ...f.b, guildId: "guild-b" }, unicode] }));
    await f.api.removeFromAllowedList(f.a);
    assert.deepEqual(Array.from(f.saved(), e => e.id), ["b", "legacy-unicode"]);
    await f.api.removeFromAllowedList({ ...unicode, name: "new-alias" });
    assert.deepEqual(Array.from(f.saved(), e => e.id), ["b"]);
});

test("RZ3-06: guild bulk actions handle rejected writes and recover on retry", async () => {
    const f = emojiFixture();
    await f.api.default.start();
    const children: any[] = [];
    f.patches.get("guild-context")(children, { guild: { id: "guild-a", name: "A" } });
    const [add, remove] = children[0].props.children;
    const tick = () => new Promise(resolve => setImmediate(resolve));
    f.fail(true);
    add.props.action();
    await tick();
    assert.equal(f.toasts.at(-1).type, "failure");
    assert.equal(f.saved().length, 0);
    assert.equal(f.api.default.filterEmojis([f.a]).length, 0);
    f.fail(false);
    add.props.action();
    await tick();
    assert.equal(f.saved().length, 1);
    assert.equal(f.api.default.filterEmojis([f.a]).length, 1);
    f.fail(true);
    remove.props.action();
    await tick();
    assert.equal(f.toasts.at(-1).type, "failure");
    assert.equal(f.saved().length, 1);
    assert.equal(f.api.default.filterEmojis([f.a]).length, 1);
    f.fail(false);
    remove.props.action();
    await tick();
    assert.equal(f.saved().length, 0);
    assert.equal(f.api.default.filterEmojis([f.a]).length, 0);
});
