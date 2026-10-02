import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { OnLoadArgs, OnLoadResult, PluginBuild } from "esbuild";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function loadModule(path: string, imports: Record<string, unknown>, globals: Record<string, unknown>, extraSource = "") {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8") + extraSource;
    const exports: Record<string, any> = {};
    runInNewContext(transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText, {
        exports, URL, AbortController, AbortSignal, Blob, Uint8Array,
        require(name: string) {
            assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`);
            return imports[name];
        },
        ...globals
    });
    return exports;
}

function trustedEvent(url = "https://discord.com/channels/@me") {
    const frame = { url };
    return { senderFrame: frame, sender: Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false }) };
}

function mediaFixture(fetch: (...args: any[]) => any) {
    return loadModule("src/equicordplugins/fileUpload/nativeNetwork.ts", {
        "@main/settings": { RendererSettings: { store: { plugins: { FileUpload: { enabled: false } } } } },
        "node:dns/promises": {}, "node:http": {}, "node:https": {}, "node:net": {}
    }, { fetch });
}

const hosts = new Set(["cdn.discordapp.com"]);
const mediaUrl = "https://cdn.discordapp.com/attachments/fixture";

function pluginSettings(overrides: Record<string, unknown> = {}) {
    return {
        definePluginSettings(definitions: Record<string, any>) {
            return { store: Object.assign(Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key,
                value.default ?? value.options?.find((option: any) => option.default)?.value])), overrides) };
        },
        migratePluginSettings() {}
    };
}

const pluginTypes = { __esModule: true, default: (value: unknown) => value, OptionType: {} };
const pluginAuthors = { Devs: {}, EquicordDevs: {} };
const cssFixture = { classNameFactory: () => (value: string) => value };
const jsxFixture = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...props as object, children } }) };
const drainTasks = () => new Promise<void>(resolve => setImmediate(resolve));

function keywordFixture(store: Record<string, any>, compilations: string[] = []) {
    return loadModule("src/equicordplugins/blockKeywords/index.tsx", {
        "./styles.css": {}, "@api/Settings": { definePluginSettings: () => ({ store, use: () => store }) },
        "@components/Card": { Card: "Card" }, "@components/Heading": { HeadingTertiary: "Heading" },
        "@components/index": {}, "@components/margins": { Margins: {} }, "@utils/constants": pluginAuthors,
        "@utils/css": cssFixture, "@utils/misc": { classes: (...names: string[]) => names.join(" ") },
        "@utils/types": pluginTypes, "@webpack/common": { React: { ...jsxFixture, useState: () => ["sample", () => {}], useMemo: (callback: () => unknown) => callback() }, TextInput: "TextInput" }
    }, { console: { error() {} }, RegExp: function (source: string, flags: string) { compilations.push(source); return new RegExp(source, flags); } }, "\nexport { compileKeyword, RegexHelper };\n");
}

test("unimplemented stream downscale control is explicitly disabled without discarding persisted values", () => {
    const store = { preventDownscale: false, unknown: "preserved" };
    const fixture = loadModule("src/equicordplugins/equibopStreamFixes.equibop/index.tsx", {
        "@api/PluginManager": {}, "@api/Settings": { definePluginSettings: (definitions: object, checks: object) => ({ store, definitions, checks }), Settings: {} },
        "@plugins/fakeNitro": { __esModule: true, default: {} }, "@utils/constants": pluginAuthors,
        "@utils/localStorage": {}, "@utils/types": pluginTypes
    }, {}).default;
    assert.equal(fixture.settings.checks.preventDownscale.disabled, true);
    assert.match(fixture.settings.definitions.preventDownscale.description, /no effect/);
    assert.equal(fixture.settings.definitions.preventDownscale.restartNeeded, false);
    assert.equal(store.preventDownscale, false);
    assert.equal(store.unknown, "preserved");
});

test("keyword regex compiler accepts only bounded fixed-width grammar before invoking the engine", () => {
    const compilations: string[] = [];
    const fixture = keywordFixture({}, compilations);
    for (const pattern of ["(sample)", "sample|other", "sample+", "sample?", "sample*", "sample{2}", "\\1", "\\k<name>", "\\u0073", "[[]"]) {
        assert.throws(() => fixture.compileKeyword(pattern, 0, true, false));
    }
    assert.equal(compilations.length, 0);
    const regex = fixture.compileKeyword("^sample[0-9]\\s.$", 0, true, false);
    assert.equal(regex.test("SAMPLE3 x"), true);
    assert.equal(regex.test("SAMPLE3 xyz"), false);
    assert.equal(fixture.compileKeyword("\\bsample\\b", 0, true, true).test("sample"), true);
    assert.equal(fixture.compileKeyword("sample\\+", 0, true, false).test("sample+"), true);
    assert.throws(() => fixture.compileKeyword("sample", 128, true, false));
    assert.throws(() => fixture.compileKeyword("a".repeat(513), 0, true, false));
    assert.equal(compilations.length, 3);
});

test("keyword helper exposes inactive patterns without mutating saved settings and stop clears matching", () => {
    const store = { blockedWords: "sample+,valid", useRegex: true, caseSensitive: false };
    const fixture = keywordFixture(store);
    fixture.default.start();
    assert.equal(fixture.containsBlockedKeywords({ content: "valid", embeds: [] }), true);
    assert.equal(fixture.containsBlockedKeywords({ content: "sample", embeds: [] }), false);
    const tree = fixture.RegexHelper();
    const warning = findElement(tree, node => node.type === "Card" && node.props.variant === "danger");
    assert.ok(warning);
    const feedback = findElement(warning, node => node.type === "span");
    assert.match(feedback.props.children[0], /fixed-width/);
    assert.equal(store.blockedWords, "sample+,valid");
    fixture.default.stop();
    assert.equal(fixture.containsBlockedKeywords({ content: "valid", embeds: [] }), false);
    store.blockedWords = "sample+";
    store.useRegex = false;
    fixture.default.start();
    assert.equal(fixture.containsBlockedKeywords({ content: "sample+ word", embeds: [] }), false);
    assert.equal(fixture.containsBlockedKeywords({ content: "sample+word", embeds: [] }), true);
});

test("keyword matching checks complete message and embed text with a bounded number of compiled patterns", () => {
    const store = { blockedWords: Array.from({ length: 129 }, (_, index) => `word${index}`).join(","), useRegex: true, caseSensitive: true };
    const compilations: string[] = [];
    const fixture = keywordFixture(store, compilations);
    fixture.default.start();
    assert.equal(compilations.length, 128);
    assert.equal(fixture.containsBlockedKeywords({ content: "ordinary text ".repeat(1000) + "word127", embeds: [] }), true);
    assert.equal(fixture.containsBlockedKeywords({ content: "none", embeds: [{ rawDescription: "word127" }] }), true);
    assert.equal(store.blockedWords.split(",").length, 129);
});

function findElement(tree: any, predicate: (node: any) => boolean): any {
    if (!tree || typeof tree !== "object") return undefined;
    if (predicate(tree)) return tree;
    const children = Array.isArray(tree) ? tree : tree.props?.children ?? [];
    for (const child of children) {
        const found = findElement(child, predicate);
        if (found) return found;
    }
}

test("repository popout stays clickable when repositories load but user metadata is unavailable", async () => {
    const states: any[] = [];
    let index = 0;
    let effect!: () => (() => void);
    let modal: any;
    const Clickable = () => {};
    const fixture = loadModule("src/equicordplugins/githubRepos/components/ProfilePopoutComponent.tsx", {
        "@components/Paragraph": {}, "@components/Span": {},
        "@equicordplugins/githubRepos/githubApi": { fetchUserInfo: async () => null, fetchReposByUserId: async () => [{ id: 1, language: "TS" }], fetchUserOrgs: async () => [] },
        "@equicordplugins/githubRepos/utils": { PERSONAL_GROUP_KEY: "personal", buildRepoGroups: () => [], getLanguageIconUrl: () => "fixture" },
        "@utils/misc": { classes: () => "fixture" }, "@webpack": { findCssClassesLazy: () => ({}) },
        "@webpack/common": {
            React: jsxFixture, Clickable, UserProfileStore: {},
            useStateFromStores: () => ({ name: "fallback-name", id: "github" }),
            useState: (initial: unknown) => { const current = index++; if (!(current in states)) states[current] = initial; return [states[current], (value: unknown) => { states[current] = value; }]; },
            useEffect: (callback: typeof effect) => { effect = callback; }, openModal: (render: (props: object) => unknown) => { modal = render({}); }
        }, "./ReposModal": { ReposModal: () => {} }
    }, {});
    fixture.ProfilePopoutComponent({ id: "user" });
    const cleanup = effect();
    await drainTasks();
    index = 0;
    const tree = fixture.ProfilePopoutComponent({ id: "user" });
    const link = findElement(tree, node => node.type === Clickable);
    assert.ok(link);
    link.props.onClick();
    assert.equal(modal.props.username, "fallback-name");
    assert.equal(modal.props.groups[0].repos.length, 1);
    cleanup();
});

test("selected-user status bypass does not create a DM for guild messages and still notifies real DMs", async () => {
    const notices: unknown[] = [];
    let isDM = false;
    const userId = "123456789012345678";
    const fixture = loadModule("src/equicordplugins/bypassStatus/index.tsx", {
        "@api/AudioPlayer": {}, "@api/index": { Notifications: { showNotification: async (value: unknown) => notices.push(value) } },
        "@api/Settings": pluginSettings({ users: userId, notificationSound: false }), "@utils/constants": pluginAuthors,
        "@utils/discord": { getCurrentChannel: () => ({ id: "other" }) }, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": pluginTypes, "@webpack/common": {
            ChannelStore: { getChannel: () => ({ name: "channel", isDM: () => isDM }) },
            MessageStore: { getMessage: () => ({ mentioned: false }) }, PresenceStore: { getStatus: () => "dnd" },
            UserStore: { getCurrentUser: () => ({ id: "self" }), getUser: () => ({ username: "author", getAvatarURL: () => undefined }) }, WindowStore: { isFocused: () => false }
        }
    }, {}).default;
    fixture.start();
    const event = { channelId: "channel", guildId: "guild", message: { id: "message", channel_id: "channel", author: { id: userId }, content: "fixture", flags: 0 } };
    await fixture.flux.MESSAGE_CREATE(event);
    assert.equal(notices.length, 0);
    isDM = true;
    await fixture.flux.MESSAGE_CREATE({ ...event, guildId: undefined });
    assert.equal(notices.length, 1);
    fixture.stop();
});

test("clip metadata normalizes known fields while preserving valid IDs and unknown saved data", async () => {
    const footer = Buffer.from([0x75, 0x75, 0x69, 0x64, 0xA1, 0xC8, 0x52, 0x99, 0x33, 0x46, 0x4D, 0xB8, 0x88, 0xF0, 0x83, 0xF5, 0x7A, 0x75, 0xA5, 0xEF]);
    const records = [null, [], { id: "stable", applicationId: "application", applicationName: "Game", users: ["user"], version: 1, extra: { preserve: true } },
        { id: {}, applicationId: 7, applicationName: [], users: [{ id: "bad" }], version: "bad", unknown: "retained" }];
    const data = Buffer.concat([Buffer.from("video"), footer, Buffer.from(JSON.stringify(records))]);
    let closes = 0;
    const fixture = loadModule("src/equicordplugins/clipUpload.desktop/native.ts", {
        "@main/utils/constants": { DATA_DIR: "fixture" }, "@main/utils/ensureSafePath": {}, "../fileUpload/nativeNetwork": {}, crypto: {}, electron: {},
        "fs/promises": { open: async () => ({ stat: async () => ({ isFile: () => true, size: data.length }),
            read: async (target: Buffer, offset: number, length: number, position: number) => ({ bytesRead: data.copy(target, offset, position, position + length) }), close: async () => { closes++; }
        }) }, path: { join: (...parts: string[]) => parts.join("/") }
    }, { Buffer }, "\nexport { parseClipMetadata };\n");
    const parsed = await fixture.parseClipMetadata("clip.mp4");
    assert.equal(closes, 1);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, "stable");
    assert.equal(parsed[0].applicationId, "application");
    assert.deepEqual(Array.from(parsed[0].users), ["user"]);
    assert.equal(parsed[0].extra.preserve, true);
    for (const key of ["id", "applicationId", "applicationName", "users", "version"]) assert.equal(parsed[1][key], undefined);
    assert.equal(parsed[1].unknown, "retained");
});

test("tab context menu uses stable IDs when the supplied tab is a cloned value", () => {
    const Menu = new Proxy({}, { get: (_target, key) => key });
    const fixture = loadModule("src/equicordplugins/channelTabs/components/ContextMenus.tsx", {
        "@components/BaseText": {}, "@components/Heading": {}, "@components/Paragraph": {},
        "@equicordplugins/channelTabs/util": { bookmarkFolderColors: {}, openedTabs: [{ id: 1 }, { id: 2 }], hasClosedTabs: () => false, settings: { use: () => ({}) } },
        "@utils/discord": {}, "@utils/margins": {},
        "@webpack/common": { Menu, ChannelStore: { getChannel() {} }, useState: (initial: unknown) => [initial, () => {}] }
    }, { React: jsxFixture });
    const first = fixture.TabContextMenu({ tab: { id: 1, channelId: "first" } });
    assert.equal(findElement(first, node => node.props?.id === "close-left-tabs").props.disabled, true);
    assert.equal(findElement(first, node => node.props?.id === "close-right-tabs").props.disabled, false);
    const last = fixture.TabContextMenu({ tab: { id: 2, channelId: "last" } });
    assert.equal(findElement(last, node => node.props?.id === "close-right-tabs").props.disabled, true);
});

test("collection delete refreshes after persistence and reports a failed delete without refreshing", async () => {
    let resolveDelete!: () => void;
    let rejectDelete!: (error: Error) => void;
    let refreshes = 0;
    const notices: string[] = [];
    const Menu = new Proxy({}, { get: (_target, key) => key });
    const fixture = loadModule("src/equicordplugins/gifCollections/components/contextMenus.tsx", {
        "@api/ContextMenu": {}, "@utils/clipboard": {},
        "@webpack/common": { Menu, showToast: (message: string) => notices.push(message), Toasts: { Type: { FAILURE: "failure" } } },
        "../settings": { settings: { store: { stopWarnings: true } } },
        "../utils/collectionManager": { deleteCollection: () => new Promise<void>((resolve, reject) => { resolveDelete = resolve; rejectDelete = reject; }) },
        "../utils/getGif": {}, "../utils/misc": {}, "../utils/uuidv4": {}, "./modals": {}
    }, { React: jsxFixture });
    const tree = fixture.RemoveItemContextMenuItems({ type: "collection", nameOrId: "fixture", instance: { forceUpdate: () => { refreshes++; } } });
    const action = findElement(tree, node => node.props?.id === "delete-collection").props.action;
    action();
    assert.equal(refreshes, 0);
    resolveDelete();
    await drainTasks();
    assert.equal(refreshes, 1);
    action();
    rejectDelete(new Error("storage"));
    await drainTasks();
    assert.equal(refreshes, 1);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Try again/);
});

test("disabled upload fallbacks retain the explicitly selected destination even for incompatible files", () => {
    const types = loadModule("src/equicordplugins/fileUpload/types.ts", {}, {}).ServiceType;
    const settings = { store: { disableFallbacks: true } };
    const fixture = loadModule("src/equicordplugins/fileUpload/utils/upload.ts", {
        "@equicordplugins/fileUpload/constants": {}, "@equicordplugins/fileUpload/settings": { settings },
        "@equicordplugins/fileUpload/types": { ServiceType: types }, "@utils/clipboard": {}, "@utils/discord": {},
        "@utils/Logger": { Logger: class {} }, "@utils/web": {}, "@webpack/common": {},
        "./apngToGif": {}, "./getMediaUrl": {}, "./s3": {}, "./sharex": {}
    }, { IS_DISCORD_DESKTOP: false }, "\nexport { buildUploadOrder };\n");
    assert.deepEqual(Array.from(fixture.buildUploadOrder(types.CATBOX, "file.exe")), [types.CATBOX]);
    assert.deepEqual(Array.from(fixture.buildUploadOrder(types.ZEROX0, "file.png")), [types.ZEROX0]);
});

test("duplicate friend-tag labels still mutate only the selected tag and preserve unknown data", async () => {
    let serialized = JSON.stringify([{ tagName: "Same", userIds: [], extra: "first" }, { tagName: "Same", userIds: [], extra: "second" }]);
    const fixture = loadModule("src/equicordplugins/friendTags/index.tsx", {
        "@api/index": { DataStore: { get: async () => serialized, set: async (_key: string, value: string) => { serialized = value; } } },
        "@api/Settings": pluginSettings(), "@components/BaseText": {}, "@components/Divider": {},
        "@utils/constants": pluginAuthors, "@utils/react": {}, "@utils/types": pluginTypes,
        "@webpack/common": {}, "./styles.css?managed": {}
    }, {}, "\nexport { GetData, SetData, SavedData, UserToTagID, tagKey };\n");
    await fixture.GetData();
    const [first, second] = fixture.SavedData;
    assert.notEqual(fixture.tagKey(first), fixture.tagKey(second));
    fixture.UserToTagID("user", second, false);
    await fixture.SetData();
    const saved = JSON.parse(serialized);
    assert.deepEqual(saved[0].userIds, []);
    assert.deepEqual(saved[1].userIds, ["user"]);
    assert.equal(saved[1].extra, "second");
});

test("friend-code create and revoke share a synchronous mutation guard and stop updates on unmount", async () => {
    const effects: (() => (() => void))[] = [];
    const states: any[] = [];
    const refs: any[] = [];
    let stateIndex = 0;
    let refIndex = 0;
    let creates = 0;
    let revokes = 0;
    let resolveCreate!: (value: unknown) => void;
    const Button = Object.assign(() => {}, { Colors: {}, Looks: {}, Sizes: {} });
    const fixture = loadModule("src/equicordplugins/friendCodes/FriendCodesPanel.tsx", {
        "./styles.css": {}, "@components/BaseText": {}, "@components/Flex": {}, "@components/Heading": {}, "@utils/clipboard": {},
        "@webpack": { findCssClassesLazy: () => ({}), findByPropsLazy: () => ({
            getAllFriendInvites: async () => [{ code: "old" }],
            createFriendInvite: () => { creates++; return new Promise(resolve => { resolveCreate = resolve; }); },
            revokeFriendInvites: async () => { revokes++; }
        }) },
        "@webpack/common": { Button, Toasts: { Type: {} }, showToast() {},
            useState: (initial: unknown) => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
            useRef: (initial: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
            useEffect: (effect: () => (() => void)) => effects.push(effect)
        }
    }, { React: jsxFixture, setTimeout, clearTimeout });
    const render = () => { stateIndex = 0; refIndex = 0; return fixture.default(); };
    render();
    const cleanup = effects[0]();
    await drainTasks();
    const tree = render();
    const controls = tree.props.children[0].props.children[1].props.children[1].props.children;
    const pending = controls[0].props.onClick();
    await controls[1].props.onClick();
    assert.equal(creates, 1);
    assert.equal(revokes, 0);
    cleanup();
    resolveCreate({ code: "new" });
    await pending;
    assert.equal(states[0].length, 1);
    assert.equal(states[0][0].code, "old");
});

test("banner conversion rejects transient failures without poisoning the URL cache", async () => {
    let images = 0;
    const fixture = loadModule("src/equicordplugins/bannersEverywhere/index.tsx", {
        "@api/DataStore": {}, "@api/PluginManager": {}, "@api/Settings": pluginSettings(), "@plugins/usrbg": {},
        "@utils/constants": pluginAuthors, "@utils/types": pluginTypes, "@webpack/common": {}, "./style.css?managed": {}
    }, {
        Image: class { onerror!: () => void; onload!: () => void; width = 1; height = 1; set src(_value: string) { queueMicrotask(() => { if (++images === 1) this.onerror(); else this.onload(); }); } },
        document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => "data:image/png;fixture" }) }
    }).default;
    await assert.rejects(fixture.gifToPng("https://fixture/banner.gif"), /load banner/);
    assert.equal(fixture.pngCache.size, 0);
    assert.equal(await fixture.gifToPng("https://fixture/banner.gif"), "data:image/png;fixture");
    assert.equal(images, 2);
});

test("custom command save retries use one draft identity and reject unsafe URL protocols", async () => {
    let value: any[] = [];
    let fail = true;
    let registered = 0;
    let popped = 0;
    const persisted = { get: () => value, set: async (next: any[]) => { value = next; if (fail) throw new Error("storage"); } };
    const fixture = loadModule("src/equicordplugins/commandPalette/commands/custom.tsx", {
        "@utils/discord": {}, "@utils/misc": { parseUrl: (url: string) => { try { return new URL(url); } catch { return null; } } },
        "@webpack/common": { Toasts: { Type: {} }, showToast() {} }, "../api/registry": { registerCommands: () => { registered++; } },
        "../search/ranker": {}, "../state/persist": { createPersistedValue: () => persisted }, "../ui/icons": {},
        "./openSettings": { DISCORD_SETTINGS_ROUTES: [] }
    }, { crypto: { randomUUID: () => "stable-draft" } }, "\nexport { commandForm };\n");
    const form = fixture.commandForm(null).spec;
    assert.match(form.validate({ name: "test", kind: "url", url: "javascript:fixture" }), /HTTP/);
    assert.equal(form.validate({ name: "test", kind: "url", url: "https://example.org" }), null);
    await form.submit({ name: "test", kind: "url", url: "https://example.org" }, { pop: () => { popped++; } });
    assert.equal(registered, 0);
    assert.equal(popped, 0);
    fail = false;
    await form.submit({ name: "test", kind: "url", url: "https://example.org" }, { pop: () => { popped++; } });
    assert.equal(value.length, 1);
    assert.equal(value[0].id, "stable-draft");
    assert.equal(registered, 1);
    assert.equal(popped, 1);
});

test("clip final-send cancellation reports abort rather than success after a late response", async () => {
    const controller = new AbortController();
    let posts = 0;
    const notices: string[] = [];
    const fixture = loadModule("src/equicordplugins/clipUpload.desktop/upload.ts", {
        "@utils/Logger": { Logger: class {} }, "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" },
        "@webpack/common": { Constants: { Endpoints: { MESSAGE_CREATE_ATTACHMENT_UPLOAD: () => "reserve", MESSAGES: () => "send" } },
            RestAPI: { post: async () => { if (++posts === 1) return { body: { attachments: [{ upload_url: "https://fixture", upload_filename: "file" }] } }; controller.abort(); return { ok: true }; } },
            SnowflakeUtils: { fromTimestamp: () => "nonce" }, showToast: (notice: string) => notices.push(notice), Toasts: { Type: {} }
        }, "./ffmpeg": {}
    }, { VencordNative: { pluginHelpers: { ClipUpload: {} } }, fetch: async () => new Response(), File }, "\nexport { sendClipUpload };\n");
    await assert.rejects(fixture.sendClipUpload(new File(["file"], "clip.mp4"), { channelId: "channel", fileName: "clip.mp4" }, controller.signal), /abort/i);
    assert.equal(posts, 2);
    assert.ok(notices.some(notice => notice.includes("cannot be canceled")));
});

test("audio visualization never rebinds host audio and resumes drawing after zero-size resize", async () => {
    const effects: (() => (() => void))[] = [];
    const refs: any[] = [];
    const frames = new Map<number, () => void>();
    const bound: unknown[] = [];
    let closed = 0;
    let disconnected = 0;
    let resize!: () => void;
    let dimensions = { width: 0, height: 0 };
    const canvas = {
        getBoundingClientRect: () => dimensions,
        getContext: () => ({ setTransform() {}, clearRect() {} }), width: 0, height: 0
    };
    const host = Object.assign(new EventEmitter(), { paused: false, currentTime: 15, playbackRate: 1.5, src: "host-original" });
    Object.assign(host, { addEventListener: host.on.bind(host), removeEventListener: host.off.bind(host) });
    class Context {
        state = "running";
        destination = {};
        createAnalyser() { return { fftSize: 0, frequencyBinCount: 2, connect() {}, getByteTimeDomainData() {}, getByteFrequencyData() {} }; }
        createMediaElementSource(audio: unknown) {
            assert.notEqual(audio, host);
            assert.ok(!bound.includes(audio));
            bound.push(audio);
            return { connect() {} };
        }
        createGain() { return { gain: { value: 1 }, connect() {} }; }
        close() { closed++; return Promise.resolve(); }
        suspend() { return Promise.resolve(); }
        resume() { return Promise.resolve(); }
    }
    const fixture = audioFixture(async () => new Response(new Uint8Array([1])), { oscilloscope: false, spectrograph: false }, {
        useRef: (value: unknown) => { const ref = { current: refs.length === 0 ? canvas : value }; refs.push(ref); return ref; },
        useEffect: (callback: () => (() => void)) => effects.push(callback)
    }, {
        Audio: class { currentTime = 0; playbackRate = 1; constructor(public src: string) {} play() { return Promise.resolve(); } pause() {} removeAttribute() {} load() {} },
        AudioContext: Context,
        requestAnimationFrame: (callback: () => void) => { const id = frames.size + 1; frames.set(id, callback); return id; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        ResizeObserver: class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() { disconnected++; } },
        window: { devicePixelRatio: 1 }
    });
    for (let mount = 0; mount < 2; mount++) {
        effects.length = 0;
        refs.length = 0;
        fixture.Visualizer({ playerRef: { current: host }, src: mediaUrl });
        const cleanups = effects.map(effect => effect());
        await drainTasks();
        assert.equal(host.src, "host-original");
        assert.equal(bound.length, mount + 1);
        assert.equal(frames.size, 1);
        const draw = frames.values().next().value!;
        frames.clear();
        draw();
        assert.equal(frames.size, dimensions.width === 0 ? 0 : 1);
        dimensions = { width: 10, height: 10 };
        resize();
        assert.equal(frames.size, 1);
        host.currentTime = 21;
        host.emit("seeked");
        assert.equal((bound[mount] as any).currentTime, 21);
        for (const cleanup of cleanups) cleanup();
        assert.equal(frames.size, 0);
        assert.equal(host.listenerCount("play"), 0);
        assert.equal(host.listenerCount("seeked"), 0);
    }
    assert.equal(closed, 2);
    assert.equal(disconnected, 2);
});

test("number tab shortcuts leave browser modifiers untouched and remove their listener on unmount", () => {
    const effects: (() => void | (() => void))[] = [];
    let handler: ((event: any) => void) | undefined;
    let removed = false;
    const navigations: string[] = [];
    const fixture = loadModule("src/equicordplugins/channelTabs/components/ChannelTabsContainer.tsx", {
        "@components/Flex": {}, "@components/Heading": {}, "@components/Paragraph": {},
        "@equicordplugins/channelTabs/util": {
            settings: { use: () => ({ enableNumberKeySwitching: true, numberKeySwitchCount: 9 }) },
            openedTabs: [{ id: "first" }], useGhostTabs: () => [], setUpdaterFunction: () => () => {},
            moveToTab: (id: string) => navigations.push(id)
        },
        "@equicordplugins/channelTabs/util/keybinds": {}, "@utils/css": cssFixture,
        "@utils/misc": {}, "@utils/react": { useForceUpdater: () => () => {} }, "@webpack": { findComponentByCodeLazy: () => () => {} },
        "@webpack/common": {
            useState: (value: unknown) => [value, () => {}], useRef: (current: unknown) => ({ current }), useCallback: (callback: unknown) => callback,
            useEffect: (callback: typeof effects[number]) => effects.push(callback), useStateFromStores: () => false,
            UserStore: { getCurrentUser: () => undefined }, FluxDispatcher: { subscribe() {}, unsubscribe() {} }
        }, "..": {}, "./BookmarkContainer": {}, "./ChannelTab": {}, "./ContextMenus": {}
    }, { document: {
        addEventListener: (type: string, callback: typeof handler, capture: boolean) => { assert.equal(type, "keydown"); assert.equal(capture, true); handler = callback; },
        removeEventListener: (type: string, callback: typeof handler, capture: boolean) => { assert.equal(type, "keydown"); assert.equal(callback, handler); assert.equal(capture, true); removed = true; }
    } }).default;
    fixture({ channelId: "channel" });
    const cleanups = effects.map(effect => effect());
    assert.ok(handler);
    let prevented = 0;
    const event = { key: "1", target: { tagName: "DIV", isContentEditable: false }, preventDefault: () => { prevented++; } };
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) handler({ ...event, [modifier]: true });
    assert.equal(prevented, 0);
    assert.equal(navigations.length, 0);
    handler(event);
    assert.equal(prevented, 1);
    assert.deepEqual(navigations, ["first"]);
    handler({ ...event, target: { tagName: "INPUT" } });
    assert.equal(prevented, 1);
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    assert.equal(removed, true);
});

test("activity carousel distinguishes anonymous activity identities and reconciles cloned selections", () => {
    const key = (activity: any) => activity.id ?? JSON.stringify([activity.type, activity.application_id, activity.name, activity.details, activity.state]);
    const activity = { type: 0, name: "First" };
    const activities = [activity, { type: 0, name: "Second" }];
    const controls = loadModule("src/equicordplugins/betterActivities/components/CarouselControls.tsx", {
        "@webpack/common": { React: jsxFixture, Tooltip: "Tooltip" }, "../utils": { cl: (...values: unknown[]) => values.filter(Boolean).join(" "), getActivityKey: key }, "./Caret": {}
    }, {});
    const tree = controls.CarouselControls({ activities, currentActivity: { ...activities[1] }, onActivityChange() {} });
    const dots = findElement(tree, node => node.props?.className === "controls-carousel").props.children[0];
    assert.equal(dots[0].props.className, "controls-dot");
    assert.equal(dots[1].props.className, "controls-dot controls-selected");
    let effect!: () => void;
    let selected: unknown;
    const popout = loadModule("src/equicordplugins/betterActivities/patch-helpers/popout.tsx", {
        "@components/ErrorBoundary": {},
        "@webpack/common": { React: jsxFixture, UserStore: { getCurrentUser: () => ({ id: "self" }) }, PresenceStore: {},
            useState: () => [{ ...activities[1] }, (value: unknown) => { selected = value; }], useEffect: (callback: typeof effect) => { effect = callback; },
            useMemo: (callback: () => unknown) => callback(), useStateFromStores: () => activities },
        "../components/CarouselControls": {}, "../settings": { settings: { store: { allActivitiesStyle: "carousel" } } },
        "../utils": { getActivityKey: key }
    }, {});
    popout.showAllActivitiesComponent({ activity, user: { id: "user" } });
    effect();
    assert.equal(selected, activities[1]);
});

test("activity application cache retries rejected and empty results and ignores stale generations", async () => {
    const requests: { resolve: (value: unknown) => void; reject: (error: Error) => void; }[] = [];
    const fixture = loadModule("src/equicordplugins/betterActivities/utils.tsx", {
        "@utils/css": cssFixture,
        "@webpack": { findComponentByCodeLazy() {}, findByPropsLazy: () => ({ fetchApplication: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) }) },
        "@webpack/common": { ApplicationStore: { getApplication() {} } }, "./settings": { settings: { store: {} } }
    }, { console: { error() {} } });
    const activity = { application_id: "app", name: "First", type: 0 };
    fixture.getApplicationIcons([activity]);
    requests[0].reject(new Error("transient"));
    await drainTasks();
    fixture.getApplicationIcons([activity]);
    assert.equal(requests.length, 2);
    requests[1].resolve(null);
    await drainTasks();
    fixture.getApplicationIcons([activity]);
    assert.equal(requests.length, 3);
    fixture.clearFetchedApplications();
    fixture.getApplicationIcons([activity]);
    requests[2].reject(new Error("stale"));
    await drainTasks();
    fixture.getApplicationIcons([activity]);
    assert.equal(requests.length, 4);
    requests[3].resolve({ id: "app", name: "Loaded" });
    await drainTasks();
    assert.equal(fixture.getActivityApplication(activity).name, "Loaded");
    assert.notEqual(fixture.getActivityKey(activity), fixture.getActivityKey({ ...activity, name: "Second" }));
    assert.equal(fixture.getActivityKey(activity), fixture.getActivityKey({ ...activity }));
});

test("blocked-user search subscribes to relationship changes and disposes its captured callback", () => {
    let effect!: () => (() => void);
    let listener!: () => void;
    let blocked = ["one"];
    const updates: unknown[] = [];
    let removals = 0;
    const fixture = loadModule("src/equicordplugins/betterBlockedUsers/index.tsx", {
        "./styles.css": {}, "@utils/constants": pluginAuthors, "@utils/discord": {}, "@utils/types": pluginTypes,
        "@webpack/common": {
            React: { ...jsxFixture, useState: (initial: unknown) => [initial, () => {}], useEffect: (callback: typeof effect) => { effect = callback; } },
            RelationshipStore: { getBlockedIDs: () => blocked, addChangeListener: (callback: () => void) => { listener = callback; }, removeChangeListener: (callback: () => void) => { assert.equal(callback, listener); removals++; } },
            UserStore: { getUser: (id: string) => ({ username: id }) }
        }
    }, {}).default;
    fixture.setUpdateFunc({ listType: "blocked" }, (value: unknown) => updates.push(value));
    fixture.renderSearchInput();
    const cleanup = effect();
    assert.deepEqual(Array.from(updates[0] as any), ["one"]);
    blocked = ["two"];
    listener();
    assert.deepEqual(Array.from(updates[1] as any), ["two"]);
    cleanup();
    assert.equal(removals, 1);
});

test("channel special badges remain available with their base-type badge disabled", () => {
    const fixture = loadModule("src/equicordplugins/channelBadges/index.tsx", {
        "./style.css": {}, "@utils/constants": pluginAuthors, "@utils/types": pluginTypes,
        "@webpack/common": { React: jsxFixture, GuildStore: { getGuild: () => ({ rulesChannelId: "rules" }) } },
        "./settings": { settings: { store: { oneBadgePerChannel: false } }, isEnabled: (id: number) => id === 6101, returnChannelBadge: () => ({ text: "locked", label: "locked" }) }
    }, {}).default;
    const rendered = fixture.renderChannelBadges({ id: "rules", guild_id: "guild", type: 0, isPrivate: () => true, isArchivedThread: () => false, isNSFW: () => false });
    assert.ok(rendered);
    assert.equal(rendered.props.children[0].length, 1);
});

test("channel cleaning preserves adjacent Unicode letters and base64 extraction retains complete padding", () => {
    const cleaner = loadModule("src/equicordplugins/cleanChannelName/index.ts", {
        "@utils/constants": pluginAuthors, "@utils/types": pluginTypes, "@webpack/common": {}
    }, {}, "\nexport { computeClean };\n");
    assert.equal(cleaner.computeClean("猫🐈語", 0), "猫語");
    const decoder = loadModule("src/equicordplugins/baseDecoder/index.tsx", {
        "@api/Settings": pluginSettings(), "@components/CodeBlock": {}, "@components/ErrorBoundary": {},
        "@components/Heading": {}, "@utils/constants": pluginAuthors, "@utils/discord": {}, "@utils/types": pluginTypes, "@webpack/common": {}
    }, { atob, TextDecoder }, "\nexport { findBase64Strings, decodeBase64Strings };\n");
    assert.deepEqual(Array.from(decoder.findBase64Strings("[Zg==] [Zm8=] [Zm9v]")), ["Zg==", "Zm8=", "Zm9v"]);
    assert.deepEqual(Array.from(decoder.decodeBase64Strings(["Zg==", "Zm8=", "Zm9v"])), ["f", "fo", "foo"]);
    assert.equal(decoder.findBase64Strings("Zg===").length, 0);
});

function forwardFixture(sendMessage: (...args: any[]) => any) {
    return loadModule("src/equicordplugins/betterForwards/index.tsx", {
        "@api/Settings": pluginSettings(), "@components/BaseText": {}, "@components/ErrorBoundary": {},
        "@components/Flex": {}, "@components/Icons": {}, "@components/margins": {},
        "@utils/constants": pluginAuthors, "@utils/css": cssFixture, "@utils/discord": { sendMessage },
        "@utils/types": pluginTypes, "@webpack": { proxyLazyWebpack: (factory: unknown) => factory },
        "@webpack/common": { ChannelStore: {}, ChannelActionCreators: {} }, "./components": {}, "./style.css?managed": {}
    }, {}).default;
}

test("forward fallback sends only selected media, preserving original embed indices", async () => {
    const messages: string[] = [];
    const plugin = forwardFixture(async (_channel, body) => messages.push(body.content));
    const message = {
        channel_id: "origin", content: "DESELECTED PRIVATE TEXT", attachments: [{ id: "private", url: "private-file" }],
        embeds: [{ images: [{ url: "private-image-1" }, { url: "private-image-2" }] }, { url: "selected-image" }]
    };
    await plugin.sendForward("note", [{ id: "destination", type: "channel" }], message, { onlyEmbedIndices: [1] });
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes("selected-image"));
    assert.ok(messages[0].includes("note"));
    assert.ok(!messages[0].includes("PRIVATE") && !messages[0].includes("private-"));
    await plugin.sendForward(null, [{ id: "destination", type: "channel" }], { ...message, embeds: [{}] }, { onlyEmbedIndices: [0] })
        .then(() => assert.fail("Unsupported selected embed must fail closed"), error => assert.match(error.message, /safely/));
    assert.equal(messages.length, 1);
});

test("forward fallback awaits sequential chunks and propagates delivery failures", async () => {
    const releases: (() => void)[] = [];
    const sent: string[] = [];
    const plugin = forwardFixture((_channel, body) => new Promise<void>(resolve => { sent.push(body.content); releases.push(resolve); }));
    const message = { channel_id: "origin", content: "full text", embeds: [], attachments: Array.from({ length: 6 }, (_, index) => ({ id: String(index), url: `file-${index}` })) };
    let completed = false;
    const pending = plugin.sendForward(null, [{ id: "destination", type: "channel" }], message, {}).then(() => { completed = true; });
    await drainTasks();
    assert.equal(sent.length, 1);
    assert.equal(completed, false);
    releases.shift()!();
    await drainTasks();
    assert.equal(sent.length, 2);
    assert.equal(completed, false);
    releases.shift()!();
    await pending;
    assert.ok(sent[0].includes("full text"));
    const failed = forwardFixture(async () => { throw new Error("delivery failed"); });
    await assert.rejects(failed.sendForward(null, [{ id: "destination", type: "channel" }], message, {}), /delivery failed/);
});

function audioFixture(fetch: (...args: any[]) => any, overrides: Record<string, unknown> = {}, react = {}, globals = {}) {
    return loadModule("src/equicordplugins/betterAudioPlayer/index.tsx", {
        "./styles.css": {}, "@api/Settings": pluginSettings(overrides), "@utils/constants": pluginAuthors,
        "@utils/css": cssFixture, "@utils/types": pluginTypes,
        "@webpack/common": { React: { ...jsxFixture, ...react }, ColorUtils: {}, Toasts: { Type: {} }, showToast() {} }
    }, { fetch, setTimeout, clearTimeout, ...globals }, "\nexport { fetchAudioBlobData, getAudioBlob, Visualizer };\n");
}

test("audio fetch is direct-first and never sends private URLs to a proxy without explicit opt-in", async () => {
    const requests: { url: string; options: any; }[] = [];
    const fetch = async (url: string, options: any) => { requests.push({ url, options }); throw new Error("CORS"); };
    const direct = audioFixture(fetch);
    await assert.rejects(direct.fetchAudioBlobData(mediaUrl + "?private-token=fixture"), /CORS/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, mediaUrl + "?private-token=fixture");
    assert.equal(requests[0].options.credentials, "omit");
    requests.length = 0;
    const optedIn = audioFixture(async (url, options) => {
        requests.push({ url, options });
        if (requests.length === 1) throw new Error("CORS");
        return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/ogg" } });
    }, { allowExternalProxy: true });
    const blob = await optedIn.fetchAudioBlobData(mediaUrl);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, mediaUrl);
    assert.equal(new URL(requests[1].url).origin, "https://cors.keiran0.workers.dev");
    assert.equal(new URL(requests[1].url).searchParams.get("url"), mediaUrl);
    assert.equal(blob.size, 2);
});

test("audio fetch bounds streamed data, cancels/releases readers and retries failed cache entries", async () => {
    let canceled = 0;
    let released = 0;
    let calls = 0;
    const fixture = audioFixture(async () => {
        calls++;
        if (calls === 1) return {
            ok: true, headers: new Headers(), body: { getReader: () => ({
                read: async () => ({ done: false, value: new Uint8Array(13_000_000) }),
                cancel: async () => { canceled++; }, releaseLock: () => { released++; }
            }) }
        };
        return new Response(new Uint8Array([7]));
    });
    assert.equal(await fixture.getAudioBlob(mediaUrl), null);
    assert.equal(canceled, 1);
    assert.equal(released, 1);
    assert.equal((await fixture.getAudioBlob(mediaUrl)).size, 1);
    assert.equal(calls, 2);
});

test("KeepCurrentChannel hydrates a visible tab without navigation or overwriting saved tabs", async () => {
    const writes: unknown[] = [];
    const navigation: unknown[] = [];
    const accountIds: string[] = [];
    const fixture = loadModule("src/equicordplugins/channelTabs/util/tabs.tsx", {
        "@api/index": { DataStore: { get: () => assert.fail("Must not load saved tabs"), set: (...args: unknown[]) => writes.push(args) } },
        "@api/PluginManager": { isPluginEnabled: (name: string) => name === "KeepCurrentChannel" },
        "@utils/css": cssFixture,
        "@webpack/common": { NavigationRouter: { transitionTo: (...args: unknown[]) => navigation.push(args) }, showToast() {}, Toasts: { Type: {} } },
        "./constants": { settings: { store: { onStartup: "remember", maxOpenTabs: 10 } }, logger: { warn() {}, error() {} } }
    }, { setTimeout, clearTimeout });
    await fixture.openStartupTabs({ userId: "account", channelId: "current", guildId: "guild" }, (id: string) => accountIds.push(id));
    assert.deepEqual(accountIds, ["", "account"]);
    assert.equal(fixture.openedTabs.length, 1);
    assert.equal(fixture.openedTabs[0].channelId, "current");
    await fixture.openStartupTabs({ userId: "account", channelId: "current", guildId: "guild" }, () => {});
    assert.equal(fixture.openedTabs.length, 1);
    assert.equal(writes.length, 0);
    assert.equal(navigation.length, 0);
});

test("persisted palette writes report failures and allow a subsequent save", async () => {
    let fail = true;
    const saved: unknown[] = [];
    const fixture = loadModule("src/equicordplugins/commandPalette/state/persist.ts", {
        "@api/DataStore": { set: async (_key: string, value: unknown) => { if (fail) throw new Error("disk"); saved.push(value); } },
        "@utils/Logger": { Logger: class { error() {} } }, "../api/registry": { notifyPaletteChange() {} }
    }, {});
    const store = fixture.createPersistedValue("fixture", []);
    await assert.rejects(store.set(["first"]), /disk/);
    fail = false;
    await store.set(["second"]);
    assert.deepEqual(saved, [["second"]]);
});

test("collection reset serializes after pending mutations and updates lookup caches", async () => {
    let release!: () => void;
    const writes: any[] = [];
    const fixture = loadModule("src/equicordplugins/gifCollections/utils/collectionManager.ts", {
        "@api/index": { DataStore: { set: async (_key: string, value: unknown) => {
            writes.push(value);
            if (writes.length === 1) await new Promise<void>(resolve => { release = resolve; });
        } } },
        "@webpack/common": { Toasts: {} }, "../settings": { settings: { store: { defaultEmptyCollectionImage: "empty" } } },
        "../types": { isCollectionList: () => true }, "./getFormat": { getFormat: () => "png" },
        "./misc": { logger: { warn() {} } }, "./uuidv4": { uuidv4: () => "uuid" }
    }, {});
    const creating = fixture.createCollection("fixture", [{ id: "gif", src: "url" }]);
    const resetting = fixture.resetCollections();
    await drainTasks();
    assert.equal(writes.length, 1);
    release();
    await Promise.all([creating, resetting]);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].length, 0);
    assert.equal(fixture.cache_collections.length, 0);
    assert.equal(fixture.getGifById("gif"), undefined);
});

test("GIF attachment refresh excludes lookalike hosts and malformed expiries before authenticated requests", async () => {
    const requests: any[] = [];
    const refresh = loadModule("src/equicordplugins/gifCollections/utils/refreshUrl.ts", {
        "@webpack/common": { RestAPI: { post: async (request: unknown) => {
            requests.push(request);
            return { ok: true, body: { refreshed_urls: [] } };
        } } },
        "./misc": { logger: { warn() {} } }
    }, {});
    const trusted = ["cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net"]
        .map(host => `https://${host}/attachments/fixture?ex=1`);
    const rejected = [
        "https://cdn.discordapp.com.example.org/private?ex=1",
        "https://cdn.discordapp.com@private.example.org/private?ex=1",
        "https://user@cdn.discordapp.com/private?ex=1",
        "http://cdn.discordapp.com/attachments/fixture?ex=1",
        "https://cdn.discordapp.com:444/attachments/fixture?ex=1",
        "https://cdn.discordapp.com/attachments/fixture?ex=1-not-hex",
        "https://cdn.discordapp.com/attachments/fixture?ex=" + "f".repeat(400),
        "https://cdn.discordapp.com/attachments/fixture?ex=ffffffff",
        null, 123
    ];
    for (const url of trusted) assert.equal(refresh.isCdnUrlExpired(url), true);
    for (const url of rejected) assert.equal(refresh.isCdnUrlExpired(url), false);
    await refresh.batchRefreshAttachmentUrls(rejected);
    assert.equal(requests.length, 0);
    await refresh.batchRefreshAttachmentUrls([...rejected, ...trusted]);
    assert.deepEqual(Array.from(requests[0].body.attachment_urls), trusted);
});

test("shared native media utilities stay outside renderer and IPC entrypoint discovery", async () => {
    const { globPlugins } = await import("./build/common.mjs");
    const { getNativeExportNames } = await import("./build/pluginNatives.mjs");
    let load!: (args: OnLoadArgs) => OnLoadResult | Promise<OnLoadResult | null | undefined> | null | undefined;
    const build: Pick<PluginBuild, "onLoad" | "onResolve"> = {
        onResolve() {},
        onLoad(_options: unknown, callback: typeof load) { load = callback; }
    };
    globPlugins("discordDesktop").setup(build as PluginBuild);
    const result = await load({ path: "~plugins", namespace: "import-plugins", suffix: "", pluginData: undefined, with: {} });
    assert.equal(typeof result?.contents, "string");
    const contents = String(result?.contents);
    assert.equal(contents.includes("fileUpload/nativeNetwork"), false);
    assert.ok(contents.includes("guildPickerDumper"));
    for (const plugin of ["fileUpload", "clipUpload.desktop", "discordMcp.desktop", "favouriteAnything", "gifMaker"]) {
        const exports = await getNativeExportNames(`src/equicordplugins/${plugin}/native.ts`);
        assert.equal(exports.includes("fetchNativeMedia"), false);
        assert.equal(exports.includes("assertTrustedNativeEvent"), false);
    }
});

test("native media rejects untrusted frames and unsafe URLs before network activity", async () => {
    let requests = 0;
    const api = mediaFixture(() => { requests++; });
    const event = trustedEvent();
    assert.equal(api.isTrustedFileUploadEvent(event), false);
    const subframe = { ...event, senderFrame: { url: event.senderFrame.url } };
    const destroyed = { ...event, sender: { ...event.sender, isDestroyed: () => true } };
    for (const invalidEvent of [null, {}, subframe, destroyed, trustedEvent("https://example.org/"), trustedEvent("http://discord.com/"), trustedEvent("https://user@discord.com/")])
        await assert.rejects(api.fetchNativeMedia(invalidEvent, mediaUrl, hosts, 4), /Untrusted/);
    for (const url of [null, {}, "http://cdn.discordapp.com/", "https://user@cdn.discordapp.com/", "https://cdn.discordapp.com:444/", "https://example.org/", `https://cdn.discordapp.com/${"a".repeat(4_096)}`])
        await assert.rejects(api.fetchNativeMedia(event, url, hosts, 4), /Invalid URL/);
    assert.equal(requests, 0);
});

test("native media reads exact bounded bytes and retains MIME normalization", async () => {
    const api = mediaFixture((_url, options) => {
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "omit");
        assert.ok(options.signal instanceof AbortSignal);
        return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "IMAGE/GIF" } });
    });
    const result = await api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4);
    assert.deepEqual(Array.from(new Uint8Array(result.data)), [1, 2, 3, 4]);
    assert.equal(result.data.byteLength, 4);
    assert.equal(result.type, "image/gif");
});

test("native media cancels oversized declared bodies without reading them", async () => {
    let cancelled = false;
    let read = false;
    const api = mediaFixture(() => ({
        ok: true,
        headers: new Headers({ "content-length": "5" }),
        body: { cancel: async () => { cancelled = true; }, getReader: () => { read = true; } }
    }));
    await assert.rejects(api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4), /size limit/);
    assert.equal(cancelled, true);
    assert.equal(read, false);
});

test("fixed FileUpload fetch releases response readers on success and failure", async () => {
    for (const failure of [false, true]) {
        let released = false;
        let cancelled = false;
        const api = loadModule("src/equicordplugins/fileUpload/nativeNetwork.ts", {
            "@main/settings": { RendererSettings: { store: { plugins: { FileUpload: { enabled: true } } } } },
            "node:dns/promises": {}, "node:http": {}, "node:https": {}, "node:net": {}
        }, {
            Buffer, Headers, TextEncoder, TextDecoder, setTimeout, clearTimeout,
            fetch: async () => ({ ok: true, status: 200, statusText: "OK", headers: new Headers(), body: {
                getReader: () => ({
                    read: async () => { if (failure) throw new Error("reader failed"); return { done: true }; },
                    cancel: async () => { cancelled = true; },
                    releaseLock: () => { released = true; }
                })
            } })
        });
        const request = api.fixedFetch(trustedEvent(), "https://0x0.st/", {});
        if (failure) await assert.rejects(request, /reader failed/);
        else assert.equal(await (await request).text(), "");
        assert.equal(released, true);
        assert.equal(cancelled, failure);
    }
});

test("native media checks actual streamed size and cancels misleading responses", async () => {
    let cancelled = false;
    let released = false;
    let reads = 0;
    const api = mediaFixture(() => ({
        ok: true,
        headers: new Headers({ "content-length": "1" }),
        body: { getReader: () => ({
            read: async () => ({ done: false, value: new Uint8Array(++reads === 1 ? [1, 2, 3] : [4, 5]) }),
            cancel: async () => { cancelled = true; },
            releaseLock: () => { released = true; }
        }) }
    }));
    await assert.rejects(api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4), /size limit/);
    assert.equal(reads, 2);
    assert.equal(cancelled, true);
    assert.equal(released, true);
});

test("native media releases admission after network and reader failures", async () => {
    let requests = 0;
    let cancelled = 0;
    const api = mediaFixture(() => {
        requests++;
        if (requests === 1) throw new Error("network failed");
        if (requests === 2) return {
            ok: true, headers: new Headers(), body: { getReader: () => ({
                read: async () => { throw new Error("reader failed"); },
                cancel: async () => { cancelled++; }, releaseLock() { }
            }) }
        };
        return new Response("ok");
    });
    await assert.rejects(api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4), /network failed/);
    await assert.rejects(api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4), /reader failed/);
    assert.equal(cancelled, 1);
    assert.equal((await api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4)).data.byteLength, 2);
});

test("native media bounds concurrent admission without an unbounded wait queue", async () => {
    const resolveResponses: ((response: Response) => void)[] = [];
    const api = mediaFixture(() => new Promise<Response>(resolve => resolveResponses.push(resolve)));
    const first = api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4);
    const second = api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4);
    await assert.rejects(api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4), /Too many/);
    assert.equal(resolveResponses.length, 2);
    resolveResponses.splice(0).forEach(resolve => resolve(new Response("ok")));
    await Promise.all([first, second]);
    const next = api.fetchNativeMedia(trustedEvent(), mediaUrl, hosts, 4);
    resolveResponses[0](new Response("ok"));
    await next;
});

test("Discord MCP attachment readers release locks and cancel incomplete transfers", async () => {
    for (const mode of ["success", "read-error", "oversized"]) {
        let released = false;
        let cancelled = false;
        let reads = 0;
        const api = loadModule("src/equicordplugins/discordMcp.desktop/native.ts", {
            "@main/utils/constants": { DATA_DIR: "fixture" }, crypto: {}, electron: {}, fs: {}, "fs/promises": {},
            path: { join: (...parts: string[]) => parts.join("/") },
            "../fileUpload/nativeNetwork": {}, "./policy": { DISCORD_MCP_TOOL_NAMES: [] }
        }, { Buffer, fetch: async () => ({ ok: true, status: 200, headers: new Headers(), body: {
            getReader: () => ({
                read: async () => {
                    if (mode === "read-error") throw new Error("reader failed");
                    if (reads++) return { done: true };
                    return { done: false, value: new Uint8Array(mode === "oversized" ? 25 * 1024 * 1024 + 1 : 2) };
                },
                cancel: async () => { cancelled = true; },
                releaseLock: () => { released = true; }
            })
        } }) }, "\nexport { fetchAttachmentData };\n");
        const request = api.fetchAttachmentData("https://cdn.discordapp.com/attachments/fixture");
        if (mode === "success") assert.equal((await request).data.byteLength, 2);
        else await assert.rejects(request, mode === "read-error" ? /reader failed/ : /25 MB/);
        assert.equal(released, true);
        assert.equal(cancelled, mode !== "success");
    }
});

test("native media aborts on renderer destruction and removes native listeners", async () => {
    let requests = 0;
    const api = mediaFixture((_url, options) => {
        if (++requests > 1) return new Response("ok");
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
    });
    const event = trustedEvent();
    const pending = api.fetchNativeMedia(event, mediaUrl, hosts, 4);
    assert.equal(event.sender.listenerCount("destroyed"), 1);
    event.sender.emit("destroyed");
    await assert.rejects(pending, /aborted/);
    assert.equal(event.sender.listenerCount("destroyed"), 0);
    await api.fetchNativeMedia(event, mediaUrl, hosts, 4);
    assert.equal(event.sender.listenerCount("destroyed"), 0);
});

test("favorite and GIF native callers retain limits, validation and response shapes", async () => {
    const limits: number[] = [];
    const helper = {
        fetchNativeMedia: async (_event: unknown, _url: unknown, _hosts: unknown, maximumBytes: number) => {
            limits.push(maximumBytes);
            return { data: new ArrayBuffer(2), type: "" };
        }
    };
    const favorite = loadModule("src/equicordplugins/favouriteAnything/native.ts", { "../fileUpload/nativeNetwork": helper }, {});
    await assert.rejects(favorite.fetchAttachment(trustedEvent(), null), /Invalid attachment/);
    await assert.rejects(favorite.fetchAttachment(trustedEvent(), { filename: "a".repeat(256) }), /Invalid attachment/);
    const attachment = await favorite.fetchAttachment(trustedEvent(), { filename: "saved.txt", content_type: "text/plain", url: mediaUrl });
    assert.equal(attachment.filename, "saved.txt");
    assert.equal(attachment.type, "text/plain");
    assert.equal(attachment.data.byteLength, 2);
    const gif = loadModule("src/equicordplugins/gifMaker/native.ts", { "../fileUpload/nativeNetwork": helper }, {});
    assert.equal((await gif.fetchMedia(trustedEvent(), mediaUrl)).type, "application/octet-stream");
    assert.deepEqual(limits, [128 * 1024 * 1024, 64 * 1024 * 1024]);
});

test("clip reads reject files that shrink or grow after the native size check", async () => {
    for (const byteCount of [0, 2, 4, 5]) {
        let closed = false;
        const api = loadModule("src/equicordplugins/clipUpload.desktop/native.ts", {
            "@main/utils/constants": { DATA_DIR: "fixture" },
            "@main/utils/ensureSafePath": {}, crypto: {}, electron: {}, "../fileUpload/nativeNetwork": {},
            "fs/promises": { open: async () => ({
                stat: async () => ({ isFile: () => true, size: 4 }),
                read: async (_data: unknown, _offset: number, _size: number, position: number) => ({ bytesRead: position === 0 ? byteCount : 0 }),
                close: async () => { closed = true; }
            }) },
            path: { join: (...parts: string[]) => parts.join("/") }
        }, { Buffer }, "\nexport { readClipFile };\n");
        if (byteCount === 4) assert.equal((await api.readClipFile("fixture.mp4")).byteLength, 4);
        else await assert.rejects(api.readClipFile("fixture.mp4"), /changed while reading/);
        assert.equal(closed, true);
    }
});

test("all clip and bridge native entrypoints deny untrusted callers before side effects", async () => {
    const helper = mediaFixture(() => { throw new Error("Unexpected fetch"); });
    const imports = {
        "@main/utils/constants": { DATA_DIR: "fixture" }, "@main/utils/ensureSafePath": {},
        "../fileUpload/nativeNetwork": helper, crypto: {}, electron: {}, fs: {}, "fs/promises": {},
        path: { join: (...parts: string[]) => parts.join("/") },
        "./policy": { DISCORD_MCP_TOOL_NAMES: [] }
    };
    for (const path of ["clipUpload.desktop/native.ts", "discordMcp.desktop/native.ts"]) {
        const api = loadModule(`src/equicordplugins/${path}`, imports, { Buffer });
        for (const method of Object.values(api) as ((...args: unknown[]) => unknown)[]) {
            for (const event of [null, {}, trustedEvent("https://example.org/")]) {
                try {
                    const result = method(event, "fixture", "fixture");
                    await assert.rejects(Promise.resolve(result), /Untrusted/);
                } catch (error) {
                    assert.match(String(error), /Untrusted/);
                }
            }
        }
    }
});

function guildFixture(fetch: (...args: any[]) => any, count: number) {
    const saved: File[] = [];
    const failures: string[] = [];
    let archiveFiles: Record<string, Uint8Array> = {};
    const api = loadModule("src/equicordplugins/guildPickerDumper/index.tsx", {
        "@api/ContextMenu": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@utils/web": { saveFile: (file: File) => saved.push(file) },
        "@webpack/common": {
            EmojiStore: { getGuilds: () => ({ guild: { emojis: Array.from({ length: count }, (_unused, index) => ({ id: String(index), name: `emoji${index}`, animated: false })) } }) },
            Toasts: { Type: { FAILURE: "failure" } }, showToast: (message: string) => failures.push(message)
        },
        fflate: { zipSync: (files: Record<string, Uint8Array>) => { archiveFiles = files; return new Uint8Array([1]); } }
    }, { fetch, File, window: { GLOBAL_ENV: { MEDIA_PROXY_ENDPOINT: "//media.discordapp.net" } }, console: { error() { } } }, "\nexport { zipGuildAssets };\n");
    return { api, saved, failures, files: () => archiveFiles };
}

test("guild downloads keep at most four transfers active and retain archive order", async () => {
    const pending: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const fixture = guildFixture((_url, options) => {
        assert.ok(options.signal instanceof AbortSignal);
        active++;
        peak = Math.max(peak, active);
        return new Promise<Response>(resolve => pending.push(() => { active--; resolve(new Response("asset", { headers: { "content-type": "image/png" } })); }));
    }, 10);
    const downloading = fixture.api.zipGuildAssets({ id: "guild", name: "Guild" }, "emojis");
    assert.equal(pending.length, 4);
    while (pending.length) {
        pending.splice(0).forEach(resolve => resolve());
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    await downloading;
    assert.equal(peak, 4);
    assert.equal(Object.keys(fixture.files()).length, 10);
    assert.deepEqual(Object.keys(fixture.files()), Array.from({ length: 10 }, (_unused, index) => `emoji${index}_${index}.png`));
    assert.equal(fixture.saved.length, 1);
    assert.equal(fixture.failures.length, 0);
});

test("failed guild downloads abort active siblings and do not start queued transfers", async () => {
    let requests = 0;
    let cancelled = 0;
    const fixture = guildFixture((_url, options) => {
        if (++requests === 1) return Promise.resolve(new Response("error", { status: 500 }));
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => { cancelled++; reject(new Error("aborted")); }, { once: true });
        });
    }, 10);
    await fixture.api.zipGuildAssets({ id: "guild", name: "Guild" }, "emojis");
    assert.equal(requests, 4);
    assert.equal(cancelled, 3);
    assert.equal(fixture.saved.length, 0);
    assert.equal(fixture.failures.length, 1);
});
