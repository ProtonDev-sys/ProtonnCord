import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createSourceFile, JsxEmit, ScriptTarget } from "typescript";

import { loadTestModule } from "./utils/loadTestModule";

function loadModule<T>(path: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, extraSource = ""): T {
    const exports = {};
    loadTestModule(new URL(`../${path}`, import.meta.url), imports, {
        exports, URL, URLSearchParams, AbortSignal, console,
        require(name: string) {
            assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name} in ${path}`);
            return imports[name];
        },
        ...globals
    }, extraSource, { compilerOptions: { jsx: JsxEmit.ReactJSX }, mockImports: false });
    return exports as T;
}

const definePlugin = { __esModule: true, default: (plugin: unknown) => plugin };
const constants = { Devs: new Proxy({}, { get: () => ({}) }), EquicordDevs: new Proxy({}, { get: () => ({}) }) };
const jsxRuntime = {
    jsx: (type: unknown, props: unknown) => ({ type, props }),
    jsxs: (type: unknown, props: unknown) => ({ type, props })
};
const definePluginSettings = (definitions: Record<string, { default?: unknown; }>) => ({
    store: Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, definition.default]))
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function linkedMessageFixture() {
    const requests: ReturnType<typeof deferred<{ body: { id: string; channel_id: string; }[]; }>>[] = [];
    const api = loadModule<{
        fetchMessage(channelId: string, messageId: string): Promise<unknown>;
        clearMessageCache(): void;
        messageCache: Map<string, unknown>;
    }>("src/plugins/messageLinkEmbeds/index.tsx", {
        "react/jsx-runtime": {},
        "@api/Settings": { definePluginSettings },
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@api/MessageAccessories": {}, "@api/MessageUpdater": {}, "@components/BaseText": {},
        "@utils/constants.js": constants,
        "@utils/Queue": { Queue: class {} },
        "@utils/types": { ...definePlugin, OptionType: {} },
        "@webpack": { findComponentLazy() {}, findComponentByCodeLazy() {}, findCssClassesLazy() {} },
        "@webpack/common": {
            AuthenticationStore: { getId: () => "account" },
            RestAPI: { get() {
                const request = deferred<{ body: { id: string; channel_id: string; }[]; }>();
                requests.push(request);
                return request.promise;
            } },
            Constants: { Endpoints: { MESSAGES: (id: string) => id } },
            MessageStore: { getMessages: () => ({ receiveMessage: (message: unknown) => ({ get: () => message }) }) }
        }
    }, {}, "\nexports.fetchMessage = fetchMessage; exports.messageCache = messageCache; exports.clearMessageCache = clearMessageCache;");
    return { ...api, requests };
}

test("linked message failures and mismatched responses allow retry", async () => {
    const fixture = linkedMessageFixture();
    const failed = fixture.fetchMessage("channel", "message");
    fixture.requests[0].reject(new Error("Offline"));
    assert.equal(await failed, undefined);
    assert.equal(fixture.messageCache.size, 0);
    const mismatched = fixture.fetchMessage("channel", "message");
    fixture.requests[1].resolve({ body: [{ id: "other", channel_id: "channel" }] });
    assert.equal(await mismatched, undefined);
    assert.equal(fixture.messageCache.size, 0);
    const retried = fixture.fetchMessage("channel", "message");
    const message = { id: "message", channel_id: "channel" };
    fixture.requests[2].resolve({ body: [message] });
    assert.equal(await retried, message);
    assert.equal(await fixture.fetchMessage("channel", "message"), message);
    assert.equal(fixture.requests.length, 3);
});

test("old linked message cleanup preserves a newer pending request", async () => {
    const fixture = linkedMessageFixture();
    const oldRequest = fixture.fetchMessage("channel", "message");
    fixture.clearMessageCache();
    const newRequest = fixture.fetchMessage("channel", "message");
    fixture.requests[0].reject(new Error("Offline"));
    assert.equal(await oldRequest, undefined);
    assert.equal(fixture.messageCache.size, 1);
    const message = { id: "message", channel_id: "channel" };
    fixture.requests[1].resolve({ body: [message] });
    assert.equal(await newRequest, message);
    assert.equal(fixture.messageCache.size, 1);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test("every tracked plugin TypeScript source parses", () => {
    const paths = execFileSync("git", ["ls-files", "src/plugins/**"], { encoding: "utf8" }).trim().split("\n");
    assert.ok(paths.length > 0);
    for (const path of paths.filter(path => /\.tsx?$/.test(path))) {
        const source = createSourceFile(path, readFileSync(path, "utf8"), ScriptTarget.Latest, true);
        const diagnostics = (source as typeof source & { parseDiagnostics: unknown[]; }).parseDiagnostics;
        assert.equal(diagnostics.length, 0, `Parse errors in ${path}`);
    }
});

function youtubeFixture(enabled = true) {
    const app = new EventEmitter();
    const errors: unknown[] = [];
    loadModule("src/plugins/youtubeAdblock.desktop/native.ts", {
        "@main/settings": { RendererSettings: { store: { plugins: { YoutubeAdblock: { enabled } } } } },
        electron: { app },
        "file://adguard.js?minify": { __esModule: true, default: "fixture-adguard" }
    }, { console: { error: (...args: unknown[]) => errors.push(args) } });
    const webContents = new EventEmitter();
    app.emit("browser-window-created", {}, { webContents });
    type Frame = EventEmitter & {
        url: string; parent?: Frame; calls: number; executeJavaScript(source: string): Promise<void>;
    };
    function frame(url: string, parent?: Frame, rejects = false): Frame {
        return Object.assign(new EventEmitter(), {
            url, parent, calls: 0,
            executeJavaScript(source: string) {
                assert.equal(source, "fixture-adguard");
                this.calls++;
                return rejects ? Promise.reject(new Error("Frame was destroyed")) : Promise.resolve();
            }
        });
    }
    const ready = (target: Frame) => {
        webContents.emit("frame-created", {}, { frame: target });
        target.emit("dom-ready");
    };
    return { frame, ready, errors };
}

test("YouTube injection matches HTTPS embed origins and paths, not arbitrary URL text", async () => {
    const fixture = youtubeFixture();
    for (const [url, expected] of [
        ["https://www.youtube.com/embed/video", 1],
        ["https://youtube.com/embed/video?autoplay=1", 1],
        ["https://www.youtube.com/watch?v=video", 0],
        ["https://example.org/embed/video", 0],
        ["https://example.org/?url=youtube.com/embed/video", 0],
        ["http://www.youtube.com/embed/video", 0],
        ["https://www.youtube.com:8443/embed/video", 0],
        ["https://user@www.youtube.com/embed/video", 0],
        ["about:blank", 0]
    ] as const) {
        const target = fixture.frame(url);
        fixture.ready(target);
        assert.equal(target.calls, expected, url);
    }
    await flush();
    assert.equal(fixture.errors.length, 0);
});

test("YouTube parent injection remains supported and handles a destroyed frame", async () => {
    const fixture = youtubeFixture();
    const parent = fixture.frame("https://www.youtube.com/embed/video", undefined, true);
    const child = fixture.frame("about:blank", parent);
    fixture.ready(child);
    await flush();
    assert.equal(child.calls, 0);
    assert.equal(parent.calls, 1);
    assert.equal(fixture.errors.length, 1);
    const disabled = youtubeFixture(false);
    const target = disabled.frame("https://www.youtube.com/embed/video");
    disabled.ready(target);
    assert.equal(target.calls, 0);
});

interface SummariesPlugin {
    start(): Promise<void>;
    stop(): void;
    flux: { CONVERSATION_SUMMARY_UPDATE(data: unknown): Promise<void> | undefined; };
}

function summariesFixture(saved: Record<string, unknown[]>) {
    const completion = deferred<void>();
    const host: Record<string, unknown> = {};
    const persisted: unknown[] = [];
    const plugin = loadModule<{ default: SummariesPlugin; }>("src/plugins/seeSummaries/index.tsx", {
        "@api/DataStore": {
            update(_key: string, update: (value: unknown) => unknown) {
                persisted.push(update(saved));
                return completion.promise;
            }
        },
        "@api/Settings": { definePluginSettings },
        "@utils/constants": constants,
        "@utils/discord": { hasGuildFeature: () => false },
        "@utils/types": { ...definePlugin, OptionType: {} },
        "@webpack": { findByPropsLazy: () => ({ allSummaries: () => host }) },
        "@webpack/common": {}
    }).default;
    return { plugin, host, persisted, completion };
}

test("Summaries restore only after storage commits, preserving retained data", async () => {
    const retained = { id: "retained", time: Date.now() };
    const fixture = summariesFixture({ channel: [retained, { id: "expired", time: 0 }], empty: [] });
    const starting = fixture.plugin.start();
    assert.deepEqual(fixture.host, {});
    fixture.completion.resolve();
    await starting;
    assert.deepEqual(fixture.host, { channel: [retained] });
    assert.equal(fixture.persisted.length, 1);
});

for (const outcome of ["stop", "failure"] as const) {
    test(`Summaries do not publish restoration after ${outcome}`, async () => {
        const fixture = summariesFixture({ channel: [{ time: Date.now() }] });
        const starting = fixture.plugin.start();
        if (outcome === "stop") {
            fixture.plugin.stop();
            fixture.completion.resolve();
            await starting;
        } else {
            const failure = new Error("Storage transaction aborted");
            fixture.completion.reject(failure);
            await assert.rejects(starting, error => error === failure);
        }
        assert.deepEqual(fixture.host, {});
    });
}

test("Summaries Flux handler returns storage rejection to the lifecycle wrapper", async () => {
    const fixture = summariesFixture({});
    const pending = fixture.plugin.flux.CONVERSATION_SUMMARY_UPDATE({
        channel_id: "channel", summaries: [{ id: "summary", people: [] }]
    });
    assert.ok(pending);
    const failure = new Error("Storage unavailable");
    fixture.completion.reject(failure);
    await assert.rejects(pending, error => error === failure);
});

interface TenorPlugin {
    start(): Promise<void>; stop(): void;
    handleSearchFetch(query: string): void;
    handleSuggestionsFetch(query: string): Promise<void>;
    handleTrendingFetch(): Promise<void>;
    handleGifSelect(id: string, query: string): void;
    handleTrendingGifsFetch(): void;
    tenorIntegrationSearch(integration: string, query: string): void;
}

function tenorFixture(format = "tinywebm") {
    const actions: Array<{ type: string; items?: unknown[]; }> = [];
    const requests: Array<{ url: URL; response: ReturnType<typeof deferred<{ ok: boolean; json(): Promise<unknown>; }>>; }> = [];
    const plugin = loadModule<{ default: TenorPlugin; }>("src/plugins/tenorGifSearch/index.tsx", {
        "@utils/constants": constants,
        "@utils/types": definePlugin,
        "@webpack": { findStoreLazy: () => ({ getSelectedFormat: () => format }) },
        "@webpack/common": { LocaleStore: { locale: "en-US" }, FluxDispatcher: { dispatch: (action: typeof actions[number]) => actions.push(action) } }
    }, {
        fetch(url: string, options: { signal: AbortSignal; }) {
            assert.ok(options.signal instanceof AbortSignal);
            const response = deferred<{ ok: boolean; json(): Promise<unknown>; }>();
            requests.push({ url: new URL(url), response });
            return response.promise;
        }
    }).default;
    const respond = (index: number, data: unknown) => requests[index].response.resolve({ ok: true, json: async () => data });
    const start = async () => {
        const starting = plugin.start();
        respond(requests.length - 1, { tags: [] });
        await starting;
    };
    return { plugin, requests, actions, respond, start };
}

test("Tenor suggestion and share failures are handled without unhandled rejections", async () => {
    const fixture = tenorFixture();
    await fixture.start();
    const suggestions = fixture.plugin.handleSuggestionsFetch("cats");
    fixture.requests[1].response.reject(new Error("Suggestions offline"));
    await suggestions;
    assert.equal(fixture.actions[0].type, "GIF_PICKER_SUGGESTIONS_SUCCESS");
    assert.equal(fixture.actions[0].items?.length, 0);
    fixture.plugin.handleGifSelect("gif", "cats");
    fixture.requests[2].response.reject(new Error("Share tracking offline"));
    await flush();
});

for (const outcome of ["success", "failure"] as const) {
    test(`Tenor ignores late ${outcome} responses across stop and restart`, async () => {
        const fixture = tenorFixture();
        await fixture.start();
        fixture.plugin.handleSearchFetch("cats");
        fixture.plugin.handleTrendingGifsFetch();
        fixture.plugin.tenorIntegrationSearch("tenor", "cats");
        const suggestions = fixture.plugin.handleSuggestionsFetch("cats");
        const trending = fixture.plugin.handleTrendingFetch();
        const dispatched = fixture.actions.length;
        fixture.plugin.stop();
        await fixture.start();
        for (let index = 1; index <= 5; index++) {
            if (outcome === "success") fixture.respond(index, { results: [], tags: [] });
            else fixture.requests[index].response.reject(new Error("Offline"));
        }
        await Promise.all([suggestions, trending]);
        await flush();
        assert.equal(fixture.actions.length, dispatched);
        fixture.plugin.stop();
        const requested = fixture.requests.length;
        fixture.plugin.handleSearchFetch("dogs");
        fixture.plugin.handleGifSelect("gif", "dogs");
        assert.equal(fixture.requests.length, requested);
    });
}

test("Tenor successful searches retain their result mapping", async () => {
    for (const format of ["tinywebm", "tinywebp"]) {
        const fixture = tenorFixture(format);
        await fixture.start();
        const item = {
            id: "gif", title: "Cat", itemurl: "https://tenor.com/view/cat",
            media: [{ gif: { url: "https://example.org/cat.gif" }, [format === "tinywebp" ? "webp" : format]: {
                url: "https://example.org/cat.webm", dims: [100, 80], preview: "https://example.org/cat.png"
            } }]
        };
        fixture.plugin.handleSearchFetch("cats");
        fixture.respond(1, { results: [item] });
        await flush();
        assert.equal(fixture.actions[0].type, "GIF_PICKER_QUERY_SUCCESS");
        assert.equal(fixture.actions[0].items?.length, 1);
        fixture.plugin.handleSearchFetch("ordered");
        fixture.respond(2, { results: [item, { ...item, id: "second" }, item] });
        await flush();
        assert.deepEqual(Array.from(fixture.actions[1].items ?? [], (value: any) => value.id), ["gif", "second"]);
    }
});

test("Dearrow unmount aborts every component request and preserves the host lifecycle", async () => {
    const requests: { signal: AbortSignal; response: ReturnType<typeof deferred<any>>; }[] = [];
    const { default: plugin } = loadModule<any>("src/plugins/dearrow/index.tsx", {
        "./styles.css": {}, "react/jsx-runtime": jsxRuntime,
        "@api/Settings": { definePluginSettings }, "@components/ErrorBoundary": {},
        "@utils/constants": constants, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { ...definePlugin, OptionType: {} }, "@webpack/common": {}
    }, { AbortController, fetch: (_url: string, options: { signal: AbortSignal; }) => {
        const response = deferred<any>();
        requests.push({ signal: options.signal, response });
        return response.promise;
    } });
    plugin.start();
    const target = {
        props: { embed: { rawTitle: "Original", provider: { name: "YouTube" },
            video: { url: "https://www.youtube.com/embed/abcdefghijk" }, thumbnail: { proxyURL: "original.png" } } },
        updates: 0, unmounts: 0,
        forceUpdate() { this.updates++; },
        componentWillUnmount() { this.unmounts++; }
    };
    const first = plugin.embedDidMount.call(target);
    const second = plugin.embedDidMount.call(target);
    target.componentWillUnmount();
    assert.equal(target.unmounts, 1);
    assert.ok(requests.every(request => request.signal.aborted));
    for (const request of requests) request.response.resolve({ ok: true, json: async () => ({ titles: [{ title: "Late", votes: 1 }] }) });
    await Promise.all([first, second]);
    assert.equal(target.updates, 0);
    assert.equal(target.props.embed.rawTitle, "Original");
    plugin.stop();
});

test("implicit relationship stop removes only owned synthetic entries from their original stores", async () => {
    let relationships = new Map<string, number>([["friend", 1], ["preexisting", 5]]);
    let affinities = ["friend", "preexisting", "added", "promoted"];
    let emissions = 0;
    const { default: plugin } = loadModule<any>("src/plugins/implicitRelationships/index.ts", {
        "@api/Settings": { definePluginSettings }, "@utils/constants": constants,
        "@utils/Logger": { Logger: class { error() {} } }, "@utils/types": { ...definePlugin, OptionType: {} },
        "@webpack/common": {
            Constants: { FriendsSections: {} }, FluxDispatcher: {},
            UserAffinitiesStore: { getUserAffinities: () => affinities.map(otherUserId => ({ otherUserId })) },
            RelationshipStore: {
                getMutableRelationships: () => relationships,
                getRelationshipType: (id: string) => relationships.get(id), emitChange: () => emissions++
            }, UserStore: { getUser: () => ({}) }
        }
    });
    plugin.start();
    await plugin.fetchImplicitRelationships();
    const original = relationships;
    original.set("promoted", 1);
    relationships = new Map([["added", 5]]);
    affinities = ["added", "new-account"];
    await plugin.fetchImplicitRelationships();
    const beforeStop = emissions;
    plugin.stop();
    assert.equal(original.has("added"), false);
    assert.equal(original.get("friend"), 1);
    assert.equal(original.get("promoted"), 1);
    assert.equal(original.get("preexisting"), 5);
    assert.equal(relationships.get("added"), 5);
    assert.equal(relationships.has("new-account"), false);
    assert.equal(emissions, beforeStop + 1);
    plugin.stop();
    assert.equal(emissions, beforeStop + 1);
});

function renameFixture(initial: { name: string; isNew: boolean; } | undefined = { name: "Old", isNew: true }) {
    let account = "first";
    let notifications = 0;
    let closed = 0;
    let stateIndex = 0;
    const savedSessionsCache = new Map(initial ? [["session", initial]] : []);
    const writes: ReturnType<typeof deferred<void>>[] = [];
    const toasts: unknown[] = [];
    const api = loadModule<any>("src/plugins/betterSessions/components/RenameModal.tsx", {
        "react/jsx-runtime": jsxRuntime, "@components/Button": {}, "@components/Heading": {},
        "@plugins/betterSessions/utils": {
            getDataKey: () => account, getDefaultName: () => "Device", isSessionCacheCurrent: () => true,
            savedSessionsCache, notifySessionNames: () => notifications++,
            saveSessionsToDataStore: () => {
                notifications++;
                const write = deferred<void>();
                writes.push(write);
                return write.promise;
            }
        }, "@utils/Logger": { Logger: class { error() {} } },
        "@webpack/common": {
            React: {
                useState: () => [stateIndex++ === 0 ? account : "New", () => {}],
                useRef: (current: unknown) => ({ current })
            }, Toasts: { genId: () => "toast", Type: { FAILURE: 1 }, show: (toast: unknown) => toasts.push(toast) }
        }
    });
    const tree = api.RenameModal({ props: { onClose: () => closed++ }, session: { id_hash: "session", client_info: {} } });
    return { save: tree.props.actions[1].onClick as () => Promise<void>, savedSessionsCache, writes, toasts,
        setAccount: (value: string) => account = value,
        get notifications() { return notifications; }, get closed() { return closed; } };
}

test("failed session renames restore prior cache state and allow retry without duplicate saves", async () => {
    for (const initial of [{ name: "Old", isNew: true }, undefined]) {
        const fixture = renameFixture(initial);
        if (initial === undefined) fixture.savedSessionsCache.clear();
        const pending = fixture.save();
        await fixture.save();
        assert.equal(fixture.writes.length, 1);
        fixture.writes[0].reject(new Error("Storage offline"));
        await pending;
        assert.deepEqual(fixture.savedSessionsCache.get("session"), initial);
        assert.equal(fixture.notifications, 2);
        assert.equal(fixture.closed, 0);
        const retry = fixture.save();
        fixture.writes[1].resolve();
        await retry;
        assert.equal(fixture.savedSessionsCache.get("session")?.name, "New");
        assert.equal(fixture.closed, 1);
    }
});

test("session rename rollback preserves newer entries and replacement account data", async () => {
    for (const changeAccount of [false, true]) {
        const fixture = renameFixture();
        const pending = fixture.save();
        if (changeAccount) fixture.setAccount("second");
        const newer = { name: "Newer", isNew: false };
        fixture.savedSessionsCache.set("session", newer);
        fixture.writes[0].reject(new Error("Storage offline"));
        await pending;
        assert.equal(fixture.savedSessionsCache.get("session"), newer);
        assert.equal(fixture.notifications, 1);
    }
});

test("reply and edit-reply mention toggles stay hidden in private channels", async () => {
    const actions: { showMentionToggle: boolean; }[] = [];
    const api = loadModule<any>("src/plugins/messageClickActions/index.ts", {
        "@api/PluginManager": { isPluginEnabled: () => false }, "@api/Settings": { definePluginSettings },
        "@plugins/noReplyMention": {}, "@utils/constants": constants, "@utils/discord": {},
        "@utils/Logger": { Logger: class {} }, "@utils/types": { ...definePlugin, OptionType: {}, makeRange: () => [] },
        "@vencord/discord-types/enums": { MessageFlags: { EPHEMERAL: 1 } }, "./ReactEmojiSetting": {},
        "@webpack/common": {
            AuthenticationStore: { getId: () => "me" }, MessageTypeSets: { REPLYABLE: new Set([0]) },
            PermissionStore: { can: () => true }, PermissionsBits: { SEND_MESSAGES: 1 },
            FluxDispatcher: { dispatch: (action: { showMentionToggle: boolean; }) => actions.push(action) }
        }
    }, {}, "\nexports.executeAction = executeAction;");
    const message = { id: "message", author: { id: "other" }, type: 0, hasFlag: () => false };
    for (const action of ["REPLY", "EDIT_REPLY"]) {
        for (const guildId of [undefined, null, "guild"]) {
            await api.executeAction(action, message, { id: "channel", guild_id: guildId }, { shiftKey: false, preventDefault() {} });
            assert.equal(actions.at(-1)?.showMentionToggle, !!guildId);
        }
    }
});

test("SilentTyping coalesces timers by channel, expires independently, and clears on stop", () => {
    const callbacks = new Map<number, { callback: () => void; delay: number; }>();
    let nextTimer = 0;
    let rerenders = 0;
    const store = { temporaryEnableThresholdServers: 5, temporaryEnableThresholdDirectMessages: 10 };
    const api = loadModule<any>("src/plugins/silentTyping/index.tsx", {
        "react/jsx-runtime": jsxRuntime, "@api/ChatButtons": {}, "@api/ContextMenu": {},
        "@api/Commands": { ApplicationCommandOptionType: {}, ApplicationCommandInputType: {} },
        "@api/PluginManager": {}, "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/settings": {}, "@utils/constants": constants, "@utils/react": {},
        "@utils/types": { ...definePlugin, OptionType: {} }, "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "me" }) } }
    }, {
        setTimeout: (callback: () => void, delay: number) => { callbacks.set(++nextTimer, { callback, delay }); return nextTimer; },
        clearTimeout: (timer: number) => callbacks.delete(timer)
    }, "\nexports.rerenderListeners = rerenderListeners;");
    api.rerenderListeners.add(() => rerenders++);
    const message = (channelId: string, guildId?: string, authorId = "me") => api.default.flux.MESSAGE_CREATE({
        message: { channel_id: channelId, guild_id: guildId, author: { id: authorId } }
    });
    message("server-channel", "guild");
    const obsolete = callbacks.get(1)!.callback;
    message("server-channel", "guild");
    message("dm-channel");
    assert.equal(callbacks.size, 2);
    assert.equal(callbacks.get(2)?.delay, 5025);
    assert.equal(callbacks.get(3)?.delay, 10025);
    obsolete();
    assert.equal(rerenders, 3);
    const serverTimeout = callbacks.get(2)!.callback;
    callbacks.delete(2);
    serverTimeout();
    assert.equal(rerenders, 4);
    assert.equal(callbacks.size, 1);
    message("ignored", "guild", "other");
    assert.equal(callbacks.size, 1);
    const late = callbacks.get(3)!.callback;
    api.default.stop();
    assert.equal(callbacks.size, 0);
    late();
    assert.equal(rerenders, 4);
});

function fakeNitroFixture() {
    let preSend: (...args: any[]) => Promise<any> = async () => {};
    const toasts: unknown[] = [];
    const errors: unknown[] = [];
    const parsed = { frames: [], width: 1, height: 1 };
    let upload: () => Promise<void> = async () => {};
    const { default: plugin } = loadModule<any>("src/plugins/fakeNitro/index.tsx", {
        "react/jsx-runtime": jsxRuntime, "@api/MessageEvents": {
            addMessagePreSendListener: (callback: typeof preSend) => { preSend = callback; return callback; },
            addMessagePreEditListener: () => {}, removeMessagePreSendListener() {}, removeMessagePreEditListener() {}
        }, "@api/Settings": { definePluginSettings }, "@components/Paragraph": {},
        "@utils/apng": { parseAPNG: () => parsed, ApngBlendOp: {}, ApngDisposeOp: {} },
        "@utils/constants": constants, "@utils/discord": { getCurrentGuild: () => ({ id: "current" }) },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/types": { ...definePlugin, OptionType: {} },
        "@vencord/discord-types/enums": { StickerFormatType: { APNG: 2, GIF: 4 } },
        "@webpack": { findByPropsLazy: () => ({}), findByCodeLazy: () => () => false, proxyLazyWebpack: () => ({}) },
        "@webpack/common": {
            OverridePremiumTypeStore: { getState: () => ({ premiumTypeActual: 0 }) },
            StickersStore: { getStickerById: () => ({ id: "sticker", guild_id: "other", format_type: 2 }) },
            ChannelStore: { getChannel: () => ({ isPrivate: () => true }) }, PermissionsBits: {},
            DraftType: { ChannelMessage: 0 }, UploadHandler: { promptToUpload: () => upload() },
            Toasts: { genId: () => "toast", Type: { FAILURE: 1 }, show: (toast: unknown) => toasts.push(toast) }
        }, "gifenc": { GIFEncoder: () => ({ finish() {}, bytesView: () => new Uint8Array() }) }
    }, {
        fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }), File,
        document: { createElement: () => ({ getContext: () => ({ scale() {} }) }) }
    });
    plugin.start();
    return { plugin, toasts, errors, setUpload: (callback: () => Promise<void>) => upload = callback,
        send: () => preSend("channel", { content: "Original", validNonShortcutEmojis: [] }, { stickerIds: ["sticker"] }) };
}

test("FakeNitro waits for conversion and reports failures while canceling unsupported sends", async () => {
    const fixture = fakeNitroFixture();
    const conversion = deferred<void>();
    fixture.plugin.sendAnimatedSticker = () => conversion.promise;
    let settled = false;
    const pending = fixture.send().then(result => { settled = true; return result; });
    await flush();
    assert.equal(settled, false);
    conversion.reject(new Error("Invalid APNG"));
    assert.equal((await pending).cancel, true);
    assert.equal(fixture.toasts.length, 1);
    assert.equal(fixture.errors.length, 1);
    fixture.plugin.sendAnimatedSticker = async () => {};
    assert.equal((await fixture.send()).cancel, true);
    assert.equal(fixture.toasts.length, 1);
});

test("FakeNitro upload preparation rejection is handled by the send listener", async () => {
    const fixture = fakeNitroFixture();
    const upload = deferred<void>();
    fixture.setUpload(() => upload.promise);
    const pending = fixture.send();
    await flush();
    upload.reject(new Error("Upload unavailable"));
    assert.equal((await pending).cancel, true);
    assert.equal(fixture.toasts.length, 1);
    assert.equal(fixture.errors.length, 1);
});
