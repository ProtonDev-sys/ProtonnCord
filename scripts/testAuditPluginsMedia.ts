/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function loadMediaPlugin(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports.default;", { exports: {}, ...globals, require: (name: string) => mocks[name] ?? {} });
}

test("PetPet rejects invalid resource sizes before loading images or allocating canvas", async () => {
    const notices: string[] = [];
    let imageLoads = 0;
    const plugin = loadMediaPlugin("src/plugins/petpet/index.ts", {
        "@api/Settings": { migratePluginSettings() {} },
        "@api/Commands": {
            ApplicationCommandInputType: {}, ApplicationCommandOptionType: {},
            findOption: (options: Record<string, unknown>, name: string, fallback: unknown) => options[name] ?? fallback,
            sendBotMessage: (_id: string, message: { content: string; }) => notices.push(message.content)
        },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value }
    }, { Image: class { constructor() { imageLoads++; } } });
    for (const resolution of [-1, 0, 1.5, 1025, Infinity, NaN])
        await plugin.commands[0].execute({ resolution }, { channel: { id: "fixture" } });
    for (const delay of [-1, 19, 1.5, 655351, Infinity, NaN])
        await plugin.commands[0].execute({ delay }, { channel: { id: "fixture" } });
    assert.equal(imageLoads, 0);
    assert.equal(notices.length, 12);
});

function pipFixture(paused: boolean) {
    let resolvePlay: () => void;
    const clone = {
        currentTime: 0, readyState: 1, style: {}, removed: false, requests: 0,
        onloadedmetadata: null as null | (() => Promise<void>), onleavepictureinpicture: null as null | (() => void), onerror: null as null | (() => void),
        play: () => new Promise<void>(resolve => resolvePlay = resolve), pause() {},
        requestPictureInPicture: async () => { clone.requests++; },
        removeAttribute() {}, load() {}, remove: () => { clone.removed = true; }
    };
    const video = { paused, currentTime: 42, isConnected: true, plays: 0, pause() {},
        play: async () => { video.plays++; }, cloneNode: () => clone };
    const plugin = loadMediaPlugin("src/plugins/pictureInPicture/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { loop: true } }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": { Tooltip: "Tooltip" }
    }, {
        React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) },
        document: { body: { appendChild: (element: unknown) => element } }
    });
    const click = plugin.PictureInPictureButton().props.children[0]({}).props.onClick;
    return { plugin, clone, video, resolvePlay: () => resolvePlay!(),
        click: () => click({ currentTarget: { parentNode: { parentNode: { querySelector: () => video } } } }) };
}

test("PictureInPicture stop cancels a pending launch and preserves a paused original", async () => {
    const api = pipFixture(true);
    api.click();
    api.plugin.stop();
    api.resolvePlay();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(api.clone.removed, true);
    assert.equal(api.clone.requests, 0);
    assert.equal(api.video.plays, 0);
    assert.equal(api.video.currentTime, 42);
});

test("PictureInPicture cleanup restores playback only for an originally playing video", async () => {
    for (const paused of [false, true]) {
        const api = pipFixture(paused);
        api.click();
        api.resolvePlay();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(api.clone.requests, 1);
        api.clone.currentTime = 50;
        api.clone.onleavepictureinpicture!();
        api.plugin.stop();
        assert.equal(api.video.currentTime, 50);
        assert.equal(api.video.plays, paused ? 0 : 1);
        assert.equal(api.clone.removed, true);
    }
});

function previewFixture() {
    const revoked: string[] = [];
    const images: { width: number; height: number; onload?: () => void; onerror?: () => void; }[] = [];
    const previews: { content: string; }[] = [];
    const timers = new Map<number, () => void>();
    let timerId = 0;
    let draft = "Clicked draft";
    let account = "first";
    const plugin = loadMediaPlugin("src/plugins/previewMessage/index.tsx", {
        "@api/ChatButtons": { ChatBarButton: "Button" },
        "@api/Commands": { generateId: () => "attachment", sendBotMessage: (_channel: string, data: { content: string; }) => {
            previews.push(data); return { id: "preview" };
        } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, StartAt: {} },
        "@webpack/common": {
            DraftStore: { getDraft: () => draft }, DraftType: {},
            UserStore: { getCurrentUser: () => ({ id: account }) },
            UploadAttachmentStore: { getUploads: () => [{ isImage: true, filename: "image.png", item: { file: {} }, getSize: () => 10 }] },
            useStateFromStores: (_stores: unknown, getter: () => unknown) => getter(),
            showToast() {}, Toasts: { Type: {} }
        }
    }, {
        React: { createElement: (type: unknown, props: object) => ({ type, props }) },
        Image: class { width = 64; height = 64; constructor() { images.push(this); } },
        URL: { createObjectURL: () => "blob:fixture", revokeObjectURL: (url: string) => revoked.push(url) },
        window: { setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
            clearTimeout: (id: number) => timers.delete(id) }
    });
    plugin.start();
    const click = () => plugin.chatBarButton.render({ isAnyChat: true, isEmpty: false, type: { attachments: true }, channel: { id: "channel" } }).props.onClick();
    return { plugin, click, images, previews, revoked, timers, setDraft: (value: string) => draft = value, setAccount: (value: string) => account = value };
}

test("message previews release pending object URLs and cannot publish after stop or an account change", async () => {
    for (const stop of [true, false]) {
        const api = previewFixture();
        const pending = api.click();
        if (stop) api.plugin.stop();
        else api.setAccount("second");
        api.images[0].onload!();
        await pending;
        assert.equal(api.previews.length, 0);
        assert.deepEqual(api.revoked, ["blob:fixture"]);
        api.plugin.stop();
    }
});

test("message previews keep the draft snapshot and revoke completed attachment URLs on logout", async () => {
    const api = previewFixture();
    const pending = api.click();
    api.setDraft("Changed while loading");
    api.images[0].onload!();
    await pending;
    assert.equal(api.previews[0].content, "Clicked draft");
    assert.equal(api.timers.size, 1);
    api.plugin.flux.LOGOUT();
    assert.deepEqual(api.revoked, ["blob:fixture"]);
    assert.equal(api.timers.size, 0);
    api.plugin.stop();
});

function loadDearrow() {
    const requests: { signal: AbortSignal; resolve(body: unknown): void; }[] = [];
    const store = { replaceElements: 0, dearrowByDefault: true };
    const mocks: Record<string, object> = {
        "./styles.css": {},
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/ErrorBoundary": {}, "@webpack/common": {},
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} }
    };
    const path = "src/plugins/dearrow/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const plugin = runInNewContext(code + "\nexports.default;", {
        exports: {}, AbortController, AbortSignal,
        require: (name: string) => mocks[name],
        fetch: (_url: string, options: { signal: AbortSignal; }) => new Promise(resolve => requests.push({
            signal: options.signal, resolve: body => resolve({ ok: true, json: async () => body })
        }))
    });
    plugin.start();
    return { plugin, store, requests };
}

function embed() {
    return { rawTitle: "Original", provider: { name: "YouTube" }, video: { url: "https://www.youtube.com/embed/abcdefghijk" }, thumbnail: { proxyURL: "original.png" } };
}

function component() {
    return { props: { embed: embed() }, updates: 0, forceUpdate() { this.updates++; } };
}

const branding = { titles: [{ title: "Clear >title", votes: 1 }], thumbnails: [{ votes: 1, timestamp: 42 }] };

test("Dearrow stop aborts lookups and cannot mutate an embed after restart", async () => {
    const { plugin, requests } = loadDearrow();
    const target = component();
    const pending = plugin.embedDidMount.call(target);
    plugin.stop();
    assert.equal(requests[0].signal.aborted, true);
    plugin.start();
    requests[0].resolve(branding);
    await pending;
    assert.equal(target.props.embed.rawTitle, "Original");
    assert.equal(target.updates, 0);
    plugin.stop();
});

test("Dearrow ignores an obsolete embed and applies a shared embed at most once", async () => {
    const { plugin, requests } = loadDearrow();
    const target = component();
    const obsolete = target.props.embed;
    const first = plugin.embedDidMount.call(target);
    target.props.embed = embed();
    requests[0].resolve(branding);
    await first;
    assert.equal(obsolete.rawTitle, "Original");
    const second = plugin.embedDidMount.call(target);
    const third = plugin.embedDidMount.call(target);
    requests[1].resolve(branding);
    await second;
    requests[2].resolve({ ...branding, titles: [{ title: "Late", votes: 1 }] });
    await third;
    assert.equal(target.props.embed.rawTitle, "Clear title");
    assert.equal(target.updates, 1);
    plugin.stop();
});

test("Dearrow validates selected replacements and preserves opt-in behavior", async () => {
    const { plugin, requests, store } = loadDearrow();
    const target = component();
    const invalid = plugin.embedDidMount.call(target);
    requests[0].resolve({ titles: [{ title: 3, votes: 1 }], thumbnails: [{ votes: 1, timestamp: -1 }] });
    await invalid;
    assert.equal(target.updates, 0);
    store.replaceElements = 1;
    const excluded = plugin.embedDidMount.call(target);
    requests[1].resolve({ titles: [], thumbnails: branding.thumbnails });
    await excluded;
    assert.equal(target.updates, 0);
    store.dearrowByDefault = false;
    const optedOut = plugin.embedDidMount.call(target);
    requests[2].resolve(branding);
    await optedOut;
    assert.equal(target.props.embed.rawTitle, "Original");
    assert.equal(target.props.embed.thumbnail.proxyURL, "original.png");
    assert.equal((target.props.embed as any).dearrow.oldTitle, "Clear title");
    assert.equal((target.props.embed as any).dearrow.enabled, false);
    plugin.stop();
});

function loadExpressionCloner(outcome: "success" | "error" | "abort" = "success") {
    const requests: { url: string; signal: AbortSignal; }[] = [];
    const uploads: unknown[] = [];
    const mocks: Record<string, object> = {
        "@api/Settings": { migratePluginSettings() {} },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@vencord/discord-types/enums": { StickerFormatType: { PNG: 1, APNG: 2, LOTTIE: 3, GIF: 4 } },
        "@webpack": { findByCodeLazy: () => (data: unknown) => uploads.push(data) },
        "@webpack/common": {
            React: { createElement: (type: unknown, props: unknown) => ({ type, props }) },
            Menu: { MenuItem: "MenuItem" }
        }
    };
    const path = "src/plugins/expressionCloner/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const api = runInNewContext(code + "\n({isGifUrl, cloneEmoji, messageContextMenuPatch});", {
        exports: {}, URL, AbortSignal,
        location: { protocol: "https:" },
        window: { GLOBAL_ENV: { CDN_HOST: "cdn.example.invalid" } },
        require: (name: string) => mocks[name] ?? {},
        fetch: async (url: string, options: { signal: AbortSignal; }) => {
            requests.push({ url, signal: options.signal });
            return { ok: true, blob: async () => ({ size: 128 }) };
        },
        FileReader: class {
            result = "data:image/png;base64,aGVsbG8=";
            error = new Error("Image read failed");
            onload?: () => void;
            onerror?: () => void;
            onabort?: () => void;
            readAsDataURL() {
                if (outcome === "error") this.onerror?.();
                else if (outcome === "abort") this.onabort?.();
                else this.onload?.();
            }
        }
    });
    return { api, requests, uploads };
}

test("ExpressionCloner rejects failed and aborted image reads and bounds image fetches", async () => {
    const emoji = { t: "Emoji", id: "123", name: "smile~1", isAnimated: false };
    for (const outcome of ["error", "abort"] as const) {
        const { api, requests, uploads } = loadExpressionCloner(outcome);
        await assert.rejects(api.cloneEmoji("guild", emoji), outcome === "error" ? /Image read failed/ : /cancelled/);
        assert.ok(requests[0].signal instanceof AbortSignal);
        assert.equal(uploads.length, 0);
    }
    const { api, uploads } = loadExpressionCloner();
    await api.cloneEmoji("guild", emoji);
    assert.deepEqual(JSON.parse(JSON.stringify(uploads)), [{ guildId: "guild", name: "smile", image: "data:image/png;base64,aGVsbG8=" }]);
});

test("ExpressionCloner handles absent menu data and invalid image URLs", () => {
    const { api } = loadExpressionCloner();
    assert.equal(api.isGifUrl(undefined), false);
    assert.equal(api.isGifUrl("bad-url"), false);
    assert.equal(api.isGifUrl("https://example.invalid/image.gif"), true);
    assert.equal(api.isGifUrl("https://example.invalid/image.webp?animated=true"), true);
    assert.equal(api.isGifUrl("https://example.invalid/image.png"), false);
    assert.doesNotThrow(() => api.messageContextMenuPatch([], { favoriteableId: "123", favoriteableType: "emoji" }));
});

function loadHideMedia() {
    const reads: { resolve(value: unknown): void; }[] = [];
    const writes: { value: string[]; resolve(): void; reject(error: Error): void; }[] = [];
    const updates: string[] = [];
    const notices: unknown[] = [];
    const mocks: Record<string, object> = {
        "@api/DataStore": {
            get: () => new Promise(resolve => reads.push({ resolve })),
            set: (_key: string, value: string[]) => new Promise<void>((resolve, reject) => writes.push({ value, resolve, reject }))
        },
        "@api/MessageUpdater": { updateMessage: (_channelId: string, id: string) => updates.push(id) },
        "@api/Settings": { migratePluginSettings() {} },
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack/common": { Toasts: { Type: {}, genId: () => "toast", show: (notice: unknown) => notices.push(notice) } }
    };
    const path = "src/plugins/hideAttachments/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const api = runInNewContext(code + "\n({plugin:exports.default,toggleHide});", {
        exports: {}, require: (name: string) => mocks[name] ?? {}
    });
    return { api, reads, writes, updates, notices };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("HideMedia preserves committed visibility after write failure and serializes toggles", async () => {
    const { api, reads, writes, updates, notices } = loadHideMedia();
    const start = api.plugin.start();
    await tick();
    reads[0].resolve(["saved", 42]);
    await start;
    assert.equal(api.plugin.shouldHide("saved"), true);
    assert.equal(api.plugin.shouldHide(42), false);
    const failed = api.toggleHide("channel", "saved");
    const next = api.toggleHide("channel", "new");
    await tick();
    assert.equal(writes.length, 1);
    assert.equal(api.plugin.shouldHide("saved"), true);
    writes[0].reject(new Error("Storage unavailable"));
    await failed;
    await tick();
    assert.deepEqual(Array.from(writes[1].value), ["saved", "new"]);
    writes[1].resolve();
    await next;
    assert.equal(api.plugin.shouldHide("new"), true);
    assert.deepEqual(updates, ["new"]);
    assert.equal(notices.length, 1);
    assert.equal(api.plugin.messagePopoverButton.render({}), null);
});

test("HideMedia does not repopulate stopped state from an older read or completed write", async () => {
    const { api, reads, writes, updates } = loadHideMedia();
    const first = api.plugin.start();
    await tick();
    api.plugin.stop();
    const second = api.plugin.start();
    await tick();
    reads[1].resolve(["fresh"]);
    await second;
    reads[0].resolve(["stale"]);
    await first;
    assert.equal(api.plugin.shouldHide("fresh"), true);
    assert.equal(api.plugin.shouldHide("stale"), false);
    const pending = api.toggleHide("channel", "new");
    await tick();
    api.plugin.stop();
    writes[0].resolve();
    await pending;
    assert.equal(api.plugin.shouldHide("new"), false);
    assert.deepEqual(updates, []);
});
