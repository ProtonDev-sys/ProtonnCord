/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const React = {
    createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } })
};
function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, expose = "") {
    return loadTestModule("src/equicordplugins/" + file, imports, {
        React, Uint8Array, ArrayBuffer, URL, URLSearchParams, AbortController, AbortSignal, Error, Intl, Date,
        console: { error() {}, warn() {} }, ...globals
    }, expose);
}
function hooks() {
    const values: any[] = [];
    const effects: { deps?: unknown[]; cleanup?: Function; }[] = [];
    let cursor = 0;
    let pending: Function[] = [];
    const api = {
        useState(initial: any) {
            const slot = cursor++;
            if (!(slot in values)) values[slot] = typeof initial === "function" ? initial() : initial;
            return [values[slot], (value: any) => { values[slot] = typeof value === "function" ? value(values[slot]) : value; }];
        },
        useRef(initial: any) { return api.useState({ current: initial })[0]; },
        useEffect(callback: Function, deps?: unknown[]) {
            const slot = cursor++;
            const old = effects[slot];
            if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps?.[i]))) {
                pending.push(() => {
                    old?.cleanup?.();
                    effects[slot] = { deps, cleanup: callback() };
                });
            }
        },
        useMemo(callback: Function) { return callback(); }
    };
    return {
        api, values,
        render(callback: Function) {
            cursor = 0;
            const result = callback();
            const run = pending;
            pending = [];
            run.forEach(effect => effect());
            return result;
        },
        unmount() { effects.forEach(effect => effect.cleanup?.()); }
    };
}
const types = { __esModule: true, default: (value: unknown) => value, OptionType: {} };
const boundary = { __esModule: true, default: { wrap: (value: unknown) => value } };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("RZ7-01 attachment collapse/expand retries a failed ZIP and retains successful caching", async () => {
    let requests = 0;
    const utils = load("zipPreview/utils.ts", {
        "@utils/web": {},
        "./archive": { MAX_ZIP_BYTES: 1024, inspectZipArchive: () => ({ entries: [{ path: "ok.txt", uncompressedSize: 1 }] }) }
    }, {
        VencordNative: undefined,
        fetch: async () => {
            requests++;
            if (requests === 1) throw new Error("temporary offline failure");
            return { ok: true, headers: { get: () => "0" }, arrayBuffer: async () => new ArrayBuffer(0) };
        }
    });
    const h = hooks();
    const component = load("zipPreview/components.tsx", {
        "@components/CodeBlock": {}, "@components/ErrorBoundary": boundary, "@components/Icons": {},
        "@utils/css": { classNameFactory: () => (...names: string[]) => names.join(" ") },
        "@utils/discord": {}, "@webpack/common": h.api, "./utils": utils
    }, { requestAnimationFrame: (callback: Function) => { callback(); return 1; }, cancelAnimationFrame() {}, clearTimeout() {}, window: { setTimeout: () => 1 } });
    const render = () => h.render(() => component.ZipPreviewInline({ fileName: "test.zip", url: "https://example.invalid/test.zip" }));
    const toggle = () => render().props.children[1].props.onClick({ preventDefault() {}, stopPropagation() {} });
    render();
    toggle();
    await tick();
    assert.equal(h.values[0].status, "rejected");
    toggle();
    toggle();
    await tick();
    assert.equal(requests, 2);
    assert.equal(h.values[0].status, "resolved");
    assert.equal(h.values[0].result.entries[0].path, "ok.txt");
    assert.equal(utils.getCachedZip("https://example.invalid/test.zip").status, "resolved");
    h.unmount();
});

test("RZ7-03 mounted timestamps refresh after local save/delete and database changes, and unsubscribe", async () => {
    const h = hooks();
    const db: Record<string, unknown> = {};
    const index = load("timezones/index.tsx", {
        "@api/DataStore": {}, "@api/Settings": {
            definePluginSettings: () => ({ store: { useDatabase: true, preferDatabaseOverLocal: false, showTimezoneInfo: true, showLocalTimezone: true } }),
            migratePluginSetting() {}
        },
        "@components/ErrorBoundary": boundary, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": types, "@webpack": { findCssClassesLazy: () => ({}), findByPropsLazy: () => ({ getLocale: () => "en-US" }) },
        "@webpack/common": h.api, "./database": db, "./TimezoneModal": {}
    }, {}, "\nexport { TimestampComponent, timezoneListeners };");
    const database = load("timezones/database.tsx", { ".": index, "@utils/index": {}, "@webpack/common": {} }, {
        fetch: async () => ({ ok: true, json: async () => ({ user: { timezone: "Asia/Tokyo" } }) })
    });
    Object.assign(db, database);
    const modal = load("timezones/TimezoneModal.tsx", {
        ".": index, "./database": db, "@api/DataStore": { set: async () => {} },
        "@components/Heading": {}, "@utils/margins": {}, "@webpack/common": {}
    });
    const render = () => h.render(() => index.TimestampComponent({ userId: "user", type: "message", timestamp: "2026-01-01T12:00:00Z" }));
    const label = () => render().props.children({}).props.children;
    render();
    await modal.setUserTimezone("user", "Europe/London");
    assert.match(label(), /12:00 PM GMT/);
    await modal.setUserTimezone("user", "America/New_York");
    assert.match(label(), /7:00 AM EST/);
    await modal.setUserTimezone("user", null);
    assert.equal(render(), null);
    await database.setUserDatabaseTimezone("user", "Europe/London");
    assert.match(label(), /12:00 PM GMT/);
    await database.loadDatabaseTimezones();
    assert.match(label(), /9:00 PM GMT\+9/);
    await database.setUserDatabaseTimezone("user", null);
    assert.equal(render(), null);
    assert.equal(index.timezoneListeners.size, 1);
    h.unmount();
    assert.equal(index.timezoneListeners.size, 0);
});

test("RZ7-04 each artistic language follows its own enabled setting including mixed text", async () => {
    for (const [text, toki, sitelen, expected] of [
        ["toki pona", false, true, "google"], ["󱤀", true, false, "google"],
        ["toki pona 󱤀", true, false, "google"], ["toki pona", true, false, "toki"],
        ["󱤀", false, true, "toki"]
    ] as const) {
        const calls: { url: string; body?: string; }[] = [];
        const api = load("translatePlus/utils/translator.ts", {
            "@equicordplugins/translatePlus/settings": { settings: { store: { target: "en", toki, sitelen, shavian: false } } }
        }, {
            fetch: async (url: string, options?: { body?: string; }) => {
                calls.push({ url, body: options?.body });
                return { ok: true, json: async () => url.includes("raw.githubusercontent") ? { "󱤀": "a" } : url.endsWith("/toki") ? { translation: ["translated"] } : { src: "en", sentences: [{ trans: "ordinary" }] } };
            }
        });
        await api.translate(text);
        assert.equal(calls.at(-1)!.url.includes(expected === "toki" ? "/toki" : "translate.googleapis.com"), true);
        assert.equal(calls.some(call => call.url.includes("raw.githubusercontent")), sitelen && text.includes("󱤀"));
        if (sitelen && text === "󱤀") assert.equal(JSON.parse(calls.at(-1)!.body!).text, "a");
    }
});

function trivia(fetch: Function, context = 0, previous: any[] = []) {
    return load("triviaAI/utils.ts", {
        "@api/Commands": {}, "@utils/discord": {}, "@utils/Logger": { Logger: class { warn() {} } },
        "./settings": { settings: { store: { context, supportImages: true, sendImagesAsBase64: true } } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) }, MessageStore: { getMessages: () => ({ _array: previous }) } }
    }, { fetch, btoa: (value: string) => Buffer.from(value, "binary").toString("base64") });
}
function message(id: string, images = 1) {
    return {
        id, channel_id: "channel", author: { id: "other" }, content: "question", embeds: [],
        attachments: Array.from({ length: images }, (_, i) => ({ content_type: "image/png", url: "https://example.invalid/" + id + i }))
    };
}
function response(chunks: Uint8Array[], length?: number) {
    let cancelled = 0;
    let reads = 0;
    let released = 0;
    return {
        ok: true, headers: { get: (name: string) => name === "content-length" ? String(length ?? "") : "image/png" },
        body: {
            cancel: async () => { cancelled++; },
            getReader: () => ({
                read: async () => { const value = chunks[reads++]; return value ? { done: false, value } : { done: true }; },
                cancel: async () => { cancelled++; }, releaseLock: () => { released++; }
            })
        },
        get cancelled() { return cancelled; }, get reads() { return reads; }, get released() { return released; }
    };
}

test("RZ7-05 caps images across context and selected message while retaining text", async () => {
    let requests = 0;
    const prior = message("prior", 3);
    const target = message("target", 10);
    const api = trivia(async () => { requests++; return response([new Uint8Array([65])]); }, 1, [prior, target]);
    const payload = await api.getPayload(target);
    assert.equal(requests, 4);
    assert.equal(payload.length, 2);
    assert.equal(payload[1].content[0].text, "question");
    assert.equal(payload[1].content[1].image_url.url, "data:image/png;base64,QQ==");
});

test("RZ7-05 rejects oversized declared and streamed bodies and cancels without buffering the rest", async () => {
    const limit = 5 * 1024 * 1024;
    const declared = response([], limit + 1);
    const streamed = response([new Uint8Array(limit), new Uint8Array(1), new Uint8Array(1)]);
    let calls = 0;
    const api = trivia(async () => ++calls === 1 ? declared : streamed);
    const payload = await api.getPayload(message("large", 2));
    assert.equal(payload[0].content.length, 1);
    assert.equal(declared.reads, 0);
    assert.equal(declared.cancelled, 1);
    assert.equal(streamed.reads, 2);
    assert.equal(streamed.cancelled, 1);
    assert.equal(streamed.released, 1);
});

test("RZ7-05 overlapping answers admit at most two conversions and release slots", async () => {
    const releases: Function[] = [];
    let requests = 0;
    const api = trivia(() => {
        requests++;
        return new Promise(resolve => releases.push(() => resolve(response([new Uint8Array([65])]))));
    });
    const first = api.getPayload(message("one"));
    const second = api.getPayload(message("two"));
    const third = await api.getPayload(message("three"));
    assert.equal(requests, 2);
    assert.equal(third[0].content.length, 1);
    releases.splice(0).forEach(release => release());
    await Promise.all([first, second]);
    const fourth = api.getPayload(message("four"));
    assert.equal(requests, 3);
    releases.shift()!();
    await fourth;
});

test("RZ7-05 failed fetches and unavailable streams are omitted and release conversion slots", async () => {
    let requests = 0;
    const api = trivia(async () => {
        requests++;
        if (requests <= 3) throw new Error("offline fixture");
        if (requests === 4) return { ok: true, headers: { get: () => null }, body: null, arrayBuffer: () => assert.fail("unbounded fallback") };
        return response([new Uint8Array([65])]);
    });
    for (let i = 0; i < 4; i++) {
        const payload = await api.getPayload(message("failure" + i));
        assert.equal(payload[0].content.length, 1);
    }
    const recovered = await api.getPayload(message("recovered"));
    assert.equal(requests, 5);
    assert.equal(recovered[0].content.length, 2);
});
