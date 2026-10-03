import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { ensureDirectoryExists } from "../src/equicordplugins/messageLoggerEnhanced/native/utils";

const requireBuiltin = createRequire(import.meta.url);

test("Moyai voice effects respect the connected channel and sender exclusions", () => {
    const configuration = { volume: 0.5, quality: "Normal", triggerWhenUnfocused: true, ignoreBots: true, ignoreBlocked: true };
    const sounds: unknown[] = [];
    const plugin = load<{ default: { start(): void; stop(): void; flux: { VOICE_CHANNEL_EFFECT_SEND(event: unknown): void; }; }; }>("../../moyai/index.ts", {
        "@api/Settings": { definePluginSettings: () => ({ store: configuration }) },
        "@utils/constants": { Devs: {} },
        "@utils/misc": { sleep: async () => undefined },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, makeRange: () => [], OptionType: {} },
        "@webpack/common": {
            SelectedChannelStore: { getVoiceChannelId: () => "voice" },
            UserStore: { getUser: (userId: string) => ({ bot: userId === "bot" }) },
            RelationshipStore: { isBlocked: (userId: string) => userId === "blocked" }
        }
    }, {
        document: { createElement: () => {
            const audio = { play: async () => undefined, pause() {}, removeAttribute() {}, load() {}, addEventListener() {} };
            sounds.push(audio);
            return audio;
        } }
    }).default;
    plugin.start();
    const event = { emoji: { name: "🗿" }, channelId: "voice", userId: "member" };
    plugin.flux.VOICE_CHANNEL_EFFECT_SEND({ ...event, channelId: "other" });
    plugin.flux.VOICE_CHANNEL_EFFECT_SEND({ ...event, userId: "bot" });
    plugin.flux.VOICE_CHANNEL_EFFECT_SEND({ ...event, userId: "blocked" });
    assert.equal(sounds.length, 0);
    plugin.flux.VOICE_CHANNEL_EFFECT_SEND(event);
    assert.equal(sounds.length, 1);
    configuration.ignoreBots = false;
    configuration.ignoreBlocked = false;
    plugin.flux.VOICE_CHANNEL_EFFECT_SEND({ ...event, userId: "bot" });
    plugin.flux.VOICE_CHANNEL_EFFECT_SEND({ ...event, userId: "blocked" });
    assert.equal(sounds.length, 3);
    plugin.stop();
    plugin.flux.VOICE_CHANNEL_EFFECT_SEND(event);
    assert.equal(sounds.length, 3);
});
const nativeDirectory = "src/equicordplugins/messageLoggerEnhanced/native/";
const constants = {
    DEFAULT_ATTACHMENT_SIZE_LIMIT_MEGABYTES: 1,
    MAX_ATTACHMENT_SIZE_LIMIT_MEGABYTES: 2,
    MAX_ATTACHMENT_CACHE_BYTES: 4 * 1024 * 1024,
    MAX_ATTACHMENT_CACHE_ENTRIES: 100,
    SUPPORTED_ATTACHMENT_FILE_EXTENSIONS: ["png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mp3", "ogg", "wav"],
    DEFAULT_ATTACHMENT_FILE_EXTENSIONS: "png",
    LOGS_DATA_FILENAME: "logs.json"
};

function load<T>(filename: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, expose = ""): T {
    const source = readFileSync(nativeDirectory + filename, "utf8") + expose;
    const code = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, Buffer, URL, Uint8Array, AbortController, setTimeout, clearTimeout,
        require(name: string) {
            if (Object.hasOwn(imports, name)) return imports[name];
            if (name.startsWith("node:")) return requireBuiltin(name);
            throw new Error(`Unexpected import ${name}`);
        },
        ...globals
    }) as T;
}

interface Limiter {
    run<T>(deadline: number, operation: () => Promise<T>): Promise<T>;
}

interface TestElement {
    type: string;
    props: Record<string, any>;
    children: TestElement[];
}

function questAlertsFixture() {
    let account = "first";
    let fetchOperation: () => Promise<void> = async () => undefined;
    const settings = { disableQuestsEverything: false, newQuestAlertSound: "sound", newQuestAlertVolume: 50, newExcludedQuestAlertSound: "excluded", newExcludedQuestAlertVolume: 50, notifyOnNewQuests: true, notifyOnNewExcludedQuests: true, questButtonIncludedTypes: {} };
    const store = { quests: new Map<string, { id: string; }>([["old", { id: "old" }]]), excludedQuests: new Map() };
    const sounds: string[] = [];
    let notifications = 0;
    let warnings = 0;
    const fetching = load<{ fetchAndAlertQuests(source: string): Promise<unknown>; invalidateQuestFetchAlerts(): void; }>("../../questify/utils/fetching.ts", {
        "@api/AudioPlayer": { playAudio: (sound: string) => sounds.push(sound) }, "@api/Notifications": { showNotification: () => notifications++ },
        "@utils/misc": { sleep: async () => undefined }, "@webpack": { findByCodeLazy: (code: string) => code === "QUESTS_FETCH_CURRENT_QUESTS_BEGIN" ? () => fetchOperation() : () => ({}) },
        "@webpack/common": { QuestStore: store, RestAPI: {} }, "@webpack/common/utils": { NavigationRouter: {} },
        "../settings/access": { getQuestifySettings: () => settings, getCurrentUserId: () => account }, "../settings/ignoredQuests": { questIsIgnored: () => false },
        "./filtering": { getNewQuests: (_old: unknown, next: { id: string; }[]) => next.filter(quest => quest.id !== "old"), normalizeQuestName: (quest: { id: string; }) => quest.id, questMatchesIncludedTypes: () => true },
        "./logging": { QL: { warn: () => warnings++ } }, "./ui": { QUEST_PAGE: "/quests" }
    }, { VencordNative: undefined });
    return { fetching, settings, store, sounds, notifications: () => notifications, warnings: () => warnings,
        setAccount: (value: string) => { account = value; }, setFetch: (operation: () => Promise<void>) => { fetchOperation = operation; } };
}

test("quest alerts suppress stale stop, account, and disabled-setting continuations", async () => {
    for (const invalidate of ["stop", "account", "disabled"]) {
        const fixture = questAlertsFixture();
        let release!: () => void;
        fixture.setFetch(() => new Promise<void>(resolve => { release = resolve; }));
        const pending = fixture.fetching.fetchAndAlertQuests("offline-test");
        fixture.store.quests.set("new", { id: "new" });
        if (invalidate === "stop") fixture.fetching.invalidateQuestFetchAlerts();
        if (invalidate === "account") fixture.setAccount("replacement");
        if (invalidate === "disabled") fixture.settings.disableQuestsEverything = true;
        release();
        assert.equal(await pending, null);
        assert.deepEqual(fixture.sounds, []);
        assert.equal(fixture.notifications(), 0);
    }
});

test("quest alerts use current sound settings and contain fetch failures without blocking retries", async () => {
    const fixture = questAlertsFixture();
    fixture.setFetch(async () => { throw new Error("synthetic offline error"); });
    assert.equal(await fixture.fetching.fetchAndAlertQuests("offline-test"), null);
    assert.equal(fixture.warnings(), 1);
    fixture.setFetch(async () => {
        fixture.store.quests.set("new", { id: "new" });
        fixture.settings.newQuestAlertSound = "";
        fixture.settings.newExcludedQuestAlertSound = "";
    });
    assert.ok(await fixture.fetching.fetchAndAlertQuests("offline-retry"));
    assert.deepEqual(fixture.sounds, []);
    assert.equal(fixture.notifications(), 1);
});

test("obsolete quest fetch completion cannot clear a newer in-flight fetch", async () => {
    const fixture = questAlertsFixture();
    const releases: (() => void)[] = [];
    let calls = 0;
    fixture.setFetch(() => { calls++; return new Promise<void>(resolve => releases.push(resolve)); });
    const old = fixture.fetching.fetchAndAlertQuests("old");
    fixture.fetching.invalidateQuestFetchAlerts();
    const fresh = fixture.fetching.fetchAndAlertQuests("fresh");
    releases[0]();
    await old;
    const shared = fixture.fetching.fetchAndAlertQuests("shared");
    assert.equal(calls, 2);
    releases[1]();
    await Promise.all([fresh, shared]);
});

const testReact = {
    createElement(type: string, props: Record<string, any>, ...children: TestElement[]) {
        return { type, props: props ?? {}, children: children.flat() };
    }
};

test("plugin toggle choices exclude required plugins and active dependencies", async () => {
    let offered: { id: string; }[] = [];
    const commands = load<{ actions: { id: string; callback(): Promise<void>; }[]; }>("../../keyboardNavigation/commands.tsx", {
        "@api/Notifications": {}, "@api/PluginManager": {}, "@api/Settings": {}, "@shared/vencordUserAgent": {},
        "@utils/clipboard": {}, "@utils/native": {}, "@utils/updater": {}, "@webpack/common": {}, "~git-remote": {},
        "~plugins": { __esModule: true, default: { Optional: {}, Required: { required: true }, Dependency: { isDependency: true }, ManifestRequired: {} }, PluginManifest: { ManifestRequired: { required: true } } },
        "./components/MultipleChoice": { openMultipleChoice: async (options: { id: string; }[]) => { offered = options; return null; } }, "./components/TextInput": {}
    });
    await commands.actions.find(action => action.id === "togglePlugin")!.callback();
    assert.deepEqual(Array.from(offered, option => option.id), ["Optional"]);
});

test("hotkey recordings with overlapping ordinary keys save a usable chord", () => {
    const listeners = new Map<string, (event: any) => void>();
    const settings = { store: { hotkey: ["Control", "Shift", "P"] }, use: () => ({ hotkey: ["Control", "Shift", "P"] }) };
    const plugin = load<{ HotkeyRecorder(): TestElement; default: { event(event: unknown): void; }; }>("../../keyboardNavigation/index.tsx", {
        "@api/Settings": { definePluginSettings: () => settings }, "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: () => (value: string) => value }, "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": { useState: () => [false, () => undefined], useRef: (value: unknown) => ({ current: value }), useEffect: () => undefined },
        "./commands": {}, "./components/CommandPalette": { openCommandPalette: () => { opened++; } }
    }, { React: testReact, document: { addEventListener: (type: string, callback: (event: any) => void) => listeners.set(type, callback), removeEventListener: (type: string) => listeners.delete(type), querySelector: () => null }, window: { addEventListener: () => undefined, removeEventListener: () => undefined } }, "\nexports.HotkeyRecorder = HotkeyRecorder;");
    let opened = 0;
    plugin.HotkeyRecorder().props.onClick();
    const event = (key: string) => ({ key, preventDefault() {}, stopPropagation() {} });
    for (const key of ["Control", "P", "Q"]) listeners.get("keydown")!(event(key));
    for (const key of ["Q", "P", "Control"]) listeners.get("keyup")!(event(key));
    assert.deepEqual(Array.from(settings.store.hotkey), ["control", "p"]);
    plugin.default.event({ ...event("p"), ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
    assert.equal(opened, 1);
});

test("capture Escape cancellation restores automatic scrolling but other cancellation preserves user position", async () => {
    for (const restore of [true, false]) {
        const controller = new AbortController();
        const scroller = { scrollTop: 50, isConnected: true, clientTop: 0, clientHeight: 100, getBoundingClientRect: () => ({ top: 0 }) };
        const row = { parentElement: scroller, getBoundingClientRect: () => ({ top: 200 - scroller.scrollTop, bottom: 400 - scroller.scrollTop, left: 0, right: 100, width: 100, height: 200 }) };
        const capture = load<{ captureMessage(channel: string, message: string, signal: AbortSignal): Promise<unknown>; }>("../../messageImage.desktop/capture.ts", {
            "@webpack/common": { ContextMenuApi: { closeContextMenu() {} } }, "./image": { MAX_PIXELS: 1_000_000 }
        }, { VencordNative: { pluginHelpers: { MessageImage: { capture: async () => { controller.abort(restore ? "restore-scroll" : undefined); return []; } } } },
            document: { querySelector: () => null, getElementById: () => row, createElement: () => ({}) },
            requestAnimationFrame: (callback: () => void) => setImmediate(callback), cancelAnimationFrame: clearImmediate,
            getComputedStyle: () => ({ overflowY: "auto" }), devicePixelRatio: 1, innerHeight: 100, innerWidth: 500, DOMException });
        await assert.rejects(capture.captureMessage("channel", "message", controller.signal), /Cancelled/);
        assert.equal(scroller.scrollTop, restore ? 50 : 200);
    }
});

test("folder cancellation preserves settings without toasts and path copying uses a button", async () => {
    const settings = { store: { logsDir: "original" } };
    const copied: string[] = [];
    let toastCount = 0;
    const folder = load<{ SelectFolderInput(props: unknown): TestElement; }>("../components/FolderSelectInput.tsx", {
        "@components/Button": { Button: "button" }, "@components/Heading": { Heading: "heading" },
        "@equicordplugins/messageLoggerEnhanced/index": { cl: (value: string) => value, Native: { chooseDir: async () => undefined }, settings },
        "@equicordplugins/messageLoggerEnhanced/utils/constants": { DEFAULT_IMAGE_CACHE_DIR: "default" },
        "@utils/discord": { copyWithToast: (value: string) => copied.push(value) },
        "@utils/misc": { classes: (...values: string[]) => values.join(" ") },
        "@webpack": { findCssClassesLazy: () => ({ input: "input" }) },
        "@webpack/common": { Toasts: { show: () => toastCount++ } }
    }, { React: testReact, IS_WEB: false });
    const element = folder.SelectFolderInput({ settingsKey: "logsDir", successMessage: "Updated" });
    assert.equal(element.children[0].type, "button");
    element.children[0].props.onClick();
    assert.deepEqual(copied, ["original"]);
    await element.children[1].props.onClick();
    assert.equal(settings.store.logsDir, "original");
    assert.equal(toastCount, 0);
});

test("custom stream sliders flush their pending final value before canceling on unmount", () => {
    let cleanup!: () => void;
    let pendingValue: number | undefined;
    let canceled = 0;
    const applied: number[] = [];
    const range = load<{ CustomRange(props: unknown): TestElement; }>("../../limitlessScreenshare/CustomRange.tsx", {
        "@webpack/common": {
            Menu: { MenuControlItem: "control", MenuSliderControl: "slider" },
            useState: (value: number) => [value, () => undefined], useMemo: (factory: () => unknown) => factory(),
            useEffect: (effect: () => () => void) => { cleanup = effect(); },
            lodash: { throttle: (callback: (value: number) => void) => Object.assign((value: number) => { pendingValue = value; }, {
                flush: () => { if (pendingValue !== undefined) callback(pendingValue); pendingValue = undefined; },
                cancel: () => { canceled++; pendingValue = undefined; }
            }) }
        },
        "./settings": { COOLDOWN_MS: 1000 },
        "./utils": { normalize: () => 0, denormalize: (value: number, minimum: number, maximum: number) => value * (maximum - minimum) / 100 + minimum }
    }, { React: testReact });
    const element = range.CustomRange({ onChange: (value: number) => applied.push(value), initialValue: 1, minMax: [1, 50], group: "fps", id: "test", suffix: "fps" });
    element.props.control({}, null).props.onChange(100);
    assert.deepEqual(applied, []);
    cleanup();
    assert.deepEqual(applied, [50]);
    assert.equal(canceled, 1);
});

test("rounded resolution sliders never round their minimum down to source resolution", () => {
    const settings = { store: { maxFPS: 120, maxResolution: 1080, roundResolution: true, resolutions: [], fpss: [] } };
    const plugin = load<{ default: { OptionsRange(callback: (value: number) => void, initial: number, resolution: boolean): any[]; SettingsRange(callback: (...values: any[]) => void, params: unknown, resolution: boolean): any[]; }; }>("../../limitlessScreenshare/index.tsx", {
        "./style.css": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack/common": { MediaEngineStore: { getState: () => ({}) }, Menu: {} },
        "./CustomRange": { CustomRange: (props: unknown) => props }, "./settings": { settings, MIN_FPS: 1, MIN_RESOLUTION: 3 }
    });
    const applied: number[] = [];
    const options = plugin.default.OptionsRange(value => applied.push(value), 720, true)[0];
    const stream = plugin.default.SettingsRange((_enabled, value) => applied.push(value), [true, "resolution"], true)[0];
    options.onChange(Math.round(options.minMax[0]));
    stream.onChange(Math.round(stream.minMax[0]));
    assert.deepEqual(applied, [10, 10]);
});

test("preset additions reject duplicate and invalid numeric IDs while preserving saved metadata", () => {
    let inputValue = 720;
    const resolutions = [{ label: "saved", value: 720, metadata: "keep" }];
    const preset = load<{ SettingsPresetList(resolution: boolean): TestElement; }>("../../limitlessScreenshare/SettingsPresetList.tsx", {
        "@components/Button": { Button: "button" }, "@components/Card": { Card: "card" }, "@components/Flex": { Flex: "flex" },
        "@components/Icons": { DeleteIcon: "delete", PlusIcon: "plus" }, "@components/Paragraph": { Paragraph: "paragraph" },
        "@webpack/common": { TextInput: "input", useMemo: (factory: () => unknown) => factory(), useState: () => [inputValue, () => undefined] },
        ".": { cl: () => "" }, "./settings": { MIN_FPS: 1, MIN_RESOLUTION: 3, settings: { use: () => ({ resolutions, fpss: [] }) } }
    }, { React: testReact });
    function add() {
        const root = preset.SettingsPresetList(true);
        const cards = root.children[0].children;
        cards[cards.length - 1].children[0].children[1].props.onClick();
    }
    add();
    assert.deepEqual(resolutions, [{ label: "saved", value: 720, metadata: "keep" }]);
    inputValue = NaN;
    add();
    assert.equal(resolutions.length, 1);
    inputValue = 1080;
    add();
    assert.equal(resolutions.length, 2);
});

test("markdown headers retain every cell and stopped rules cannot match", () => {
    const parser = load<{ parseMarkdownTableMatch(source: string): any; }>("../../markdownTables/parser.ts", {});
    assert.equal(parser.parseMarkdownTableMatch("| first | second | lost |\n| --- | --- |\n| one | two |"), null);
    assert.equal(parser.parseMarkdownTableMatch("| first | second |\n| --- | --- |\n| one | two |").table.header.length, 2);
    const tables = load<{ default: { start(): void; stop(): void; getTableRule(): { match(source: string, state: unknown): unknown; }; }; }>("../../markdownTables/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({}) }, "@components/CodeBlock": {},
        "@components/ErrorBoundary": { wrap: () => undefined }, "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { waitFor: () => undefined }, "@webpack/common": {},
        "./parser": parser, "./styles.css?managed": {}
    }, { window: { clearTimeout: () => undefined } });
    const rule = tables.default.getTableRule();
    const source = "| first | second |\n| --- | --- |\n| one | two |";
    tables.default.start();
    assert.ok(rule.match(source, {}));
    tables.default.stop();
    assert.equal(rule.match(source, {}), null);
});

test("message color matcher does not consume prefixes of longer hex codes", () => {
    const settings = { store: { enableShortHexCodes: true } };
    const { replaceRegexp } = load<{ replaceRegexp(source: string): RegExp; }>("../../messageColors/constants.ts", {
        "@api/Settings": { definePluginSettings: () => ({}) }, "@utils/types": { OptionType: {} }
    });
    const colors = load<{ default: { start(): void; getColor(order: number): { match(content: string): RegExpExecArray | null; }; }; }>("../../messageColors/index.tsx", {
        "./styles.css": {}, "@components/ErrorBoundary": { wrap: () => undefined }, "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, StartAt: {} }, "@webpack/common": {},
        "./constants": { ColorType: { HEX: "hex" }, regex: [], settings, replaceRegexp }
    });
    colors.default.start();
    const rule = colors.default.getColor(1);
    assert.equal(rule.match("#1234"), null);
    assert.equal(rule.match("#1234567"), null);
    assert.equal(rule.match("#123! remaining")?.[0], "#123");
    assert.equal(rule.match("#123456 remaining")?.[0], "#123456");
    settings.store.enableShortHexCodes = false;
    colors.default.start();
    assert.equal(colors.default.getColor(1).match("#123"), null);
});

test("manual and automatic decryption share cover normalization and preserve internal markers", async () => {
    const revealed = "part\u200b inside\u200b";
    const captured: string[] = [];
    const plugin = load<{ decrypt(content: string, password: string, strip: boolean): string; iteratePasswords(message: unknown): Promise<string | false>; }>("../../invisibleChat.desktop/index.tsx", {
        "@api/ChatButtons": {}, "@api/MessageUpdater": {},
        "@api/Settings": { definePluginSettings: () => ({ store: { savedPasswords: "password" } }) },
        "@components/ErrorBoundary": { wrap: () => undefined }, "@utils/constants": { Devs: {} }, "@utils/dependencies": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {}, ReporterTestable: {} },
        "@webpack/common": {}, "./components/DecryptionModal": {}, "./components/EncryptionModal": {}
    }, { fakeSteg: { reveal: (content: string) => { captured.push(content); return revealed; } } }, "\nsteggo = fakeSteg;");
    assert.equal(plugin.decrypt("\u200csecret", "password", true), "part\u200b inside");
    assert.equal(await plugin.iteratePasswords({ content: "\u200csecret" }), revealed);
    assert.deepEqual(captured, ["d \u200csecretd", "d \u200csecretd"]);
    let decrypted = "wrong password output";
    let embeds = 0;
    let failures = 0;
    const modal = load<{ DecModal(props: unknown): any; }>("../../invisibleChat.desktop/components/DecryptionModal.tsx", {
        "@components/Heading": {},
        "@webpack/common": {
            Modal: "modal", TextInput: "input", Toasts: { Type: { FAILURE: "failure" } }, showToast: () => { failures++; },
            React: { useState: () => ["password", () => undefined], createElement: (_type: unknown, props: unknown) => ({ props }) }
        },
        "../index": { decrypt: () => decrypted, isCorrectPassword: (value: string) => value.endsWith("\u200b"), buildEmbed: async (_message: unknown, value: string) => { assert.equal(value, "part\u200b inside"); embeds++; } }
    });
    const action = modal.DecModal({ message: { content: "encrypted" }, onClose: () => undefined }).props.actions[0];
    await action.onClick();
    assert.equal(failures, 1);
    assert.equal(embeds, 0);
    decrypted = revealed;
    await action.onClick();
    assert.equal(embeds, 1);
});

test("logger pagination rejects invalid persisted sizes and grouping preserves channel boundaries", () => {
    const hooks = load<{ normalizeMessagePageSize(value: number): number; }>("../components/hooks.ts", {
        "@webpack/common": {}, "../db": {}, "../utils/parseQuery": {}, "./LogsModal": {}
    });
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(hooks.normalizeMessagePageSize(value), 100);
    assert.equal(hooks.normalizeMessagePageSize(25), 25);
    const modal = load<{ isGroupStart(current: unknown, previous: unknown, newest: boolean): boolean; }>("../components/LogsModal.tsx", {
        "@components/BaseText": {}, "@components/Button": {}, "@components/Flex": {}, "@components/Icons": {},
        "@utils/discord": {}, "@utils/react": { LazyComponent: () => () => undefined },
        "@webpack": { findByCodeLazy: () => undefined }, "@webpack/common": {},
        "../db": {}, "../index": {}, "../utils": {}, "../utils/settingsUtils": {}, "./hooks": {}
    }, {}, "\nexports.isGroupStart = isGroupStart;");
    const previous = { id: "one", author: { id: "author" }, channel_id: "first", timestamp: "2026-01-01T00:00:00Z" };
    const current = { ...previous, id: "two", channel_id: "second" };
    assert.equal(modal.isGroupStart(current, previous, true), true);
    assert.equal(modal.isGroupStart({ ...current, channel_id: "first" }, previous, true), false);
});

test("log searches expose stale debounced results as pending and count filtered results exactly", async () => {
    const values: any[] = [];
    let cursor = 0;
    let effects: Array<() => void> = [];
    const dependencies: unknown[][] = [];
    let effectCursor = 0;
    const hooks = load<{ useMessages(query: string, tab: string, newest: boolean, count: number): any; }>("../components/hooks.ts", {
        "@webpack/common": {
            useState: (initial: unknown) => {
                const index = cursor++;
                if (!(index in values)) values[index] = initial;
                return [values[index], (value: any) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
            },
            useEffect: (effect: () => void, deps: unknown[]) => {
                const index = effectCursor++;
                if (!dependencies[index] || deps.some((value, position) => value !== dependencies[index][position])) effects.push(effect);
                dependencies[index] = deps;
            }
        },
        "../db": {
            DBMessageStatus: { DELETED: "deleted" },
            countMessagesIDB: async () => 2,
            countMessagesByStatusIDB: async () => 2,
            getDateStortedMessagesByStatusIDB: async () => [{ message_id: "one", message: { content: "apple" } }, { message_id: "two", message: { content: "banana" } }]
        },
        "../utils/parseQuery": { tokenizeQuery: (query: string) => ({ queries: [], rest: [query] }) },
        "./LogsModal": { LogTabs: { DELETED: "deleted" } }
    }, { setTimeout: () => 1, clearTimeout: () => undefined });
    const render = (query: string) => {
        cursor = 0;
        effectCursor = 0;
        const result = hooks.useMessages(query, "deleted", true, 100);
        const pendingEffects = effects;
        effects = [];
        pendingEffects.forEach(effect => effect());
        return result;
    };
    assert.equal(render("apple").pending, true);
    await new Promise<void>(resolve => setImmediate(resolve));
    const loaded = render("apple");
    assert.equal(loaded.pending, false);
    assert.equal(loaded.statusTotal, 1);
    assert.equal(loaded.messages.length, 1);
    assert.equal(render("banana").pending, true);
    const modalSource = readFileSync("src/equicordplugins/messageLoggerEnhanced/components/LogsModal.tsx", "utf8");
    assert.ok(modalSource.includes("disabled: pending || messages?.length === 0"));
    assert.ok(modalSource.includes("if (pending || messages.length === 0) return;"));
});

test("logger reinsertion compares snowflakes exactly and ghost pings respect exclusions", () => {
    const store = { blacklistedIds: "blocked", whitelistedIds: "", ignoreMutedChannels: false };
    const logger = load<{ reAddDeletedMessages(messages: any[], deleted: any[], start: boolean, end: boolean): void; shouldIgnore(args: unknown): boolean; }>("../utils/index.ts", {
        "@api/Settings": { Settings: { plugins: { MessageLogger: {} } } },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ isDM: () => false }) }, SelectedChannelStore: { getChannelId: () => "other" },
            UserStore: { getCurrentUser: () => ({ id: "self" }) },
            UserGuildSettingsStore: { isChannelMuted: () => true }
        },
        "../index": { settings: { store } },
        "./cleanUp": {},
        "./misc": { getGuildIdByChannel: () => "guild", findLastIndex: (values: any[], predicate: (value: any) => boolean) => values.findLastIndex(predicate) }
    });
    const messages = [{ id: "1234567890123456790" }, { id: "1234567890123456788" }];
    logger.reAddDeletedMessages(messages, [{ id: "1234567890123456789" }], false, false);
    assert.deepEqual(messages.map(message => message.id), ["1234567890123456790", "1234567890123456789", "1234567890123456788"]);
    assert.equal(logger.shouldIgnore({ authorId: "blocked", channelId: "channel", ghostPinged: true }), true);
    store.blacklistedIds = "";
    store.ignoreMutedChannels = true;
    assert.equal(logger.shouldIgnore({ authorId: "author", channelId: "channel", ghostPinged: true }), true);
    store.whitelistedIds = "author";
    assert.equal(logger.shouldIgnore({ authorId: "author", channelId: "channel", ghostPinged: true }), false);
});

test("encryption requires an explicitly entered password without changing legacy password support", () => {
    let suppliedPassword = "";
    let encryptions = 0;
    const initialValues: unknown[] = [];
    const render = load<{ EncModal(props: unknown): any; }>("../../invisibleChat.desktop/components/EncryptionModal.tsx", {
        "@components/FormSwitch": { FormSwitch: "switch" },
        "@components/Heading": { Heading: "heading" },
        "@utils/discord": { insertTextIntoChatInputBox: () => undefined },
        "@webpack/common": {
            Modal: "modal", TextInput: "input", Toasts: { Type: { FAILURE: "failure" } }, showToast: () => undefined,
            React: {
                useState: (initial: unknown) => {
                    initialValues.push(initial);
                    return [initialValues.length % 4 === 3 ? suppliedPassword : initialValues.length % 4 === 1 ? "secret" : initialValues.length % 4 === 2 ? "two words" : false, () => undefined];
                },
                createElement: (_type: unknown, props: unknown) => ({ props })
            }
        },
        "../index": { encrypt: () => { encryptions++; return "encrypted"; } }
    }, {}, "\nexports.EncModal = EncModal;");
    const empty = render.EncModal({ onClose: () => undefined }).props.actions[0];
    assert.equal(initialValues[2], "");
    assert.equal(empty.disabled, true);
    empty.onClick();
    assert.equal(encryptions, 0);
    suppliedPassword = "password";
    const explicit = render.EncModal({ onClose: () => undefined }).props.actions[0];
    assert.equal(explicit.disabled, false);
    explicit.onClick();
    assert.equal(encryptions, 1);
});

test("message cleanup preserves deletion history and complete embed timestamps", () => {
    const cleanup = load<{ cleanupMessage(message: unknown): any; cleanupEmbed(embed: unknown): any; }>("../utils/cleanUp.ts", {
        "@webpack/common": { MessageStore: { getMessage: () => undefined } },
        "./index": { getGuildIdByChannel: () => "guild", isGhostPinged: () => false }
    });
    const deletedTimestamp = "2025-01-02T03:04:05.678Z";
    const original = { author: { id: "author" }, deleted: true, deletedTimestamp, channel_id: "channel", unknownSavedField: "preserved" };
    const cleaned = cleanup.cleanupMessage(original);
    assert.equal(cleaned.deletedTimestamp, deletedTimestamp);
    assert.equal(cleaned.unknownSavedField, "preserved");
    assert.equal(original.deletedTimestamp, deletedTimestamp);
    assert.ok(Number.isFinite(Date.parse(cleanup.cleanupMessage({ ...original, deletedTimestamp: "invalid" }).deletedTimestamp)));
    assert.equal(cleanup.cleanupMessage({ ...original, deleted: false }).deletedTimestamp, undefined);
    const timestamp = Date.parse(deletedTimestamp);
    assert.equal(cleanup.cleanupEmbed({ id: "embed", timestamp: { _isAMomentObject: true, milliseconds: () => 678, valueOf: () => timestamp } }).timestamp, timestamp);
    assert.equal(cleanup.cleanupEmbed({ id: "embed", timestamp: null }).timestamp, undefined);
});

test("primary stream audio polling inspects the video DOM once per update", () => {
    let inspections = 0;
    const audio = [20, 40, 60].map(volume => ({
        _volume: volume,
        audioElement: { isConnected: true, volume: 1 }
    }));
    const fixture = load<{ updateTrackedAudio(): void; trackedAudio: Set<unknown>; }>("../../primaryStreamAudio/index.ts", {
        "@utils/constants": { EquicordDevs: { nobody: {} } },
        "@utils/types": (plugin: unknown) => plugin,
        "@webpack/common": { ChannelRTCStore: {}, SelectedChannelStore: {} },
        "./logic": {
            getEffectiveVolume: (data: { _volume: number; }) => data._volume / 100,
            MIN_VIDEO_AREA: 24_000,
            UPDATE_INTERVAL_MS: 250
        }
    }, {
        document: { querySelectorAll: () => { inspections++; return []; } }
    }, "\nexports.updateTrackedAudio = updateTrackedAudio; exports.trackedAudio = trackedAudio;");
    for (const data of audio) fixture.trackedAudio.add(data);
    fixture.updateTrackedAudio();
    assert.equal(inspections, 1);
    assert.deepEqual(audio.map(data => data.audioElement.volume), [0.2, 0.4, 0.6]);
});

function limiterFixture() {
    let now = 1_000;
    const { BoundedOperationLimiter } = load<{ BoundedOperationLimiter: new (active: number, queued: number) => Limiter; }>("attachmentDownload.ts", {
        "../utils/constants": constants,
        "./cacheFile": { normalizeAttachmentId: (id: string) => id }
    }, { Date: { now: () => now } });
    return { limiter: new BoundedOperationLimiter(1, 2), setNow: (value: number) => { now = value; } };
}

test("MessageLogger cache updates preserve unrelated entries at capacity", () => {
    const settings = { store: { cacheLimit: 2 } };
    const { LimitedMap } = load<{
        LimitedMap: new () => { map: Map<string, number>; set(key: string, value: number): void; get(key: string): number | undefined; };
    }>("../utils/LimitedMap.ts", { "../index": { settings } });
    const cache = new LimitedMap();
    cache.set("oldest", 1);
    cache.set("newest", 2);
    cache.set("newest", 3);
    assert.equal(cache.get("oldest"), 1);
    assert.equal(cache.get("newest"), 3);
    assert.equal(cache.map.size, 2);
    cache.set("third", 4);
    assert.equal(cache.get("oldest"), undefined);
    assert.equal(cache.get("newest"), 3);
    assert.equal(cache.map.size, 2);
    settings.store.cacheLimit = 0;
    cache.set("fourth", 5);
    assert.equal(cache.map.size, 3);
});

test("native attachment limiter rejects invalid and expired deadlines before starting work", async () => {
    const { limiter } = limiterFixture();
    let calls = 0;
    const operation = async () => { calls++; return "done"; };
    for (const deadline of [NaN, Infinity, -Infinity])
        await assert.rejects(limiter.run(deadline, operation), /Invalid attachment deadline/);
    for (const deadline of [999, 1_000])
        await assert.rejects(limiter.run(deadline, operation), /timed out/);
    assert.equal(calls, 0);
    assert.equal(await limiter.run(2_000, operation), "done");
});

test("native attachment limiter rechecks a deadline after acquiring a slot and releases it", async () => {
    const { limiter, setNow } = limiterFixture();
    let calls = 0;
    const pending = limiter.run(1_100, async () => { calls++; });
    setNow(1_100);
    await assert.rejects(pending, /timed out/);
    assert.equal(calls, 0);
    assert.equal(await limiter.run(2_000, async () => "recovered"), "recovered");
});

test("native attachment limiter does not start expired queued work when timer delivery is delayed", async () => {
    const { limiter, setNow } = limiterFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = limiter.run(2_000, async () => { await gate; });
    let calls = 0;
    const queued = limiter.run(1_100, async () => { calls++; });
    const rejection = assert.rejects(queued, /timed out/);
    await Promise.resolve();
    setNow(1_100);
    release();
    await first;
    await rejection;
    assert.equal(calls, 0);
    assert.equal(await limiter.run(2_000, async () => "recovered"), "recovered");
});

test("MessageLogger directory initialization handles missing parents and concurrent creation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pc-audit-hq-directory-"));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    try {
        const target = path.join(root, "data", "MessageLoggerData", "savedImages");
        await Promise.all(Array.from({ length: 16 }, () => ensureDirectoryExists(target)));
        await ensureDirectoryExists(target);
        const file = path.join(root, "regular-file");
        await writeFile(file, "keep");
        await assert.rejects(ensureDirectoryExists(file));
        await assert.rejects(ensureDirectoryExists(path.join(file, "child")));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function cachedDownloadFixture(extension: string, bytes: number, canceledDialog = false) {
    let networkCalls = 0;
    const imagePath = path.join("cache", `123.${extension}`);
    const native = load<{
        cache: Map<string, string>;
        chooseDir(event: unknown, setting: string): Promise<string | undefined>;
        performAttachmentDownload(id: string, extension: string, urls: URL[], allowed: string[], limit: number, deadline: number): Promise<{ path: string; }>;
    }>("index.ts", {
        "@main/utils/constants": { DATA_DIR: "data" },
        "electron": { dialog: { showOpenDialog: async () => ({ canceled: canceledDialog, filePaths: [] }) }, shell: {} },
        "./settings": { getSettings: async () => ({ logsDir: "logs", imageCacheDir: "cache" }), updateSettings: () => { throw new Error("Unexpected settings mutation"); } },
        "./export": {}, "./import": {}, "../list": { blockedExts: [] }, "../utils/constants": constants,
        "./attachmentDownload": {
            assertAttachmentContent() {},
            isSupportedAttachmentExtension: () => true,
            isTrustedDiscordRendererEvent: () => true,
            MAX_ATTACHMENT_DOWNLOAD_BYTES: 2 * 1024 * 1024,
            BoundedOperationLimiter: class { },
            fetchDiscordAttachment: async () => { networkCalls++; throw new Error("Unexpected network access"); }
        },
        "./cacheFile": {
            parseImageCacheFilename: () => ({ attachmentId: "123", extension }),
            readBoundedImageCacheFile: async () => Buffer.alloc(bytes)
        },
        "./utils": { ensureDirectoryExists: async () => undefined }
    }, {}, "\nexports.cache = nativeSavedImages; exports.performAttachmentDownload = performAttachmentDownload;\n");
    native.cache.set("123", imagePath);
    return { native, imagePath, networkCalls: () => networkCalls };
}

test("native directory cancellation is silent while invalid successful selections still reject", async () => {
    assert.equal(await cachedDownloadFixture("png", 0, true).native.chooseDir({}, "logsDir"), undefined);
    await assert.rejects(cachedDownloadFixture("png", 0).native.chooseDir({}, "logsDir"), /Invalid Directory/);
});

test("cached MessageLogger downloads enforce the current byte limit on actual cached bytes", async () => {
    const fixture = cachedDownloadFixture("png", 1_025);
    await assert.rejects(fixture.native.performAttachmentDownload("123", "png", [], ["png"], 1_024, Date.now() + 1_000), /current download settings/);
    assert.equal(fixture.networkCalls(), 0);
    assert.equal(fixture.native.cache.get("123"), fixture.imagePath);
});

test("cached MessageLogger downloads enforce the cached media type rather than the requested extension", async () => {
    const fixture = cachedDownloadFixture("webp", 32);
    await assert.rejects(fixture.native.performAttachmentDownload("123", "png", [], ["png"], 1_024, Date.now() + 1_000), /current download settings/);
    assert.equal(fixture.networkCalls(), 0);
    const result = await fixture.native.performAttachmentDownload("123", "png", [], ["png", "webp"], 32, Date.now() + 1_000);
    assert.equal(result.path, fixture.imagePath);
    assert.equal(fixture.networkCalls(), 0);
});

function webImageFixture(stored = new Map<string, Uint8Array>(), readKeys?: () => Promise<string[]>) {
    let failedDelete = false;
    let reads = 0;
    const imports = {
        "@api/DataStore": {
            createStore: () => ({}), keys: readKeys ?? (async () => Array.from(stored.keys())),
            get: async (key: string) => { reads++; return stored.get(key); },
            set: async (key: string, content: Uint8Array) => { stored.set(key, content); },
            del: async (key: string) => {
                if (failedDelete) throw new Error("Delete failed");
                stored.delete(key);
            }
        },
        "@utils/misc": { sleep: async () => undefined },
        "../..": { Flogger: { error() {}, warn() {} }, Native: {} },
        "../constants": { DEFAULT_IMAGE_CACHE_DIR: "savedImages" }
    };
    const imageManager = load<{
        downloadAttachment(attachment: { id: string; url: string; fileExtension: string; }): Promise<string | undefined>;
        getImage(id: string): Promise<unknown>;
        deleteImage(id: string): Promise<void>;
    }>("../utils/saveImage/ImageManager.ts", imports, {
        IS_WEB: true,
        fetch: async () => ({ status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
    });
    return { imageManager, stored, reads: () => reads, failDelete: (value: boolean) => { failedDelete = value; } };
}

test("web attachment filenames normalize bare extensions and remain discoverable after reload", async () => {
    const fixture = webImageFixture();
    const savedPath = await fixture.imageManager.downloadAttachment({ id: "123", url: "https://cdn.discordapp.com/mock", fileExtension: "png" });
    assert.equal(savedPath, "savedImages/123.png");
    const reloaded = webImageFixture(fixture.stored);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(await reloaded.imageManager.getImage("123"));
});

test("web attachment deletion clears the in-memory index only after successful persistence", async () => {
    const fixture = webImageFixture(new Map([["savedImages/123.png", new Uint8Array([1])]]));
    await new Promise(resolve => setImmediate(resolve));
    fixture.failDelete(true);
    await assert.rejects(fixture.imageManager.deleteImage("123"), /Delete failed/);
    assert.ok(await fixture.imageManager.getImage("123"));
    fixture.failDelete(false);
    await fixture.imageManager.deleteImage("123");
    const previousReads = fixture.reads();
    assert.equal(await fixture.imageManager.getImage("123"), null);
    assert.equal(fixture.reads(), previousReads);
});

test("web attachment reads wait for the initial persistent index", async () => {
    let releaseKeys!: (keys: string[]) => void;
    const keyRead = new Promise<string[]>(resolve => { releaseKeys = resolve; });
    const fixture = webImageFixture(new Map([["savedImages/123.png", new Uint8Array([1])]]), () => keyRead);
    let completed = false;
    const pending = fixture.imageManager.getImage("123").then(value => { completed = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    releaseKeys(["savedImages/123.png"]);
    assert.ok(await pending);
});

test("web attachment deletion waits for index hydration rather than silently retaining the file", async () => {
    let releaseKeys!: (keys: string[]) => void;
    const keyRead = new Promise<string[]>(resolve => { releaseKeys = resolve; });
    const fixture = webImageFixture(new Map([["savedImages/123.png", new Uint8Array([1])]]), () => keyRead);
    const pending = fixture.imageManager.deleteImage("123");
    releaseKeys(["savedImages/123.png"]);
    await pending;
    assert.equal(fixture.stored.has("savedImages/123.png"), false);
    assert.equal(await fixture.imageManager.getImage("123"), null);
});

test("message retention removes excess records even when excess exceeds the configured limit", async () => {
    const settings = { store: { saveImages: false, timeBasedCleanupMinutes: 0, messageLimit: 10 } };
    const requestedLimits: number[] = [];
    const deletedIds: string[] = [];
    let counts = 0;
    const manager = load<{ addMessage(message: { id: string; }, status: string): Promise<void>; }>("../LoggedMessageManager.ts", {
        ".": { settings },
        "./db": {
            DBMessageStatus: { DELETED: "DELETED" },
            addMessageIDB: async () => undefined,
            db: { count: async () => { counts++; return 25; } },
            getOldestMessagesIDB: async (limit: number) => {
                requestedLimits.push(limit);
                return Array.from({ length: limit }, (_, index) => ({ message_id: String(index) }));
            },
            deleteMessagesBulkIDB: async (ids: string[]) => { deletedIds.push(...ids); }
        },
        "./utils": { cleanupMessage: (message: unknown) => message },
        "./utils/saveImage": { cacheMessageImages: async () => undefined }
    });
    await manager.addMessage({ id: "new" }, "EDITED");
    assert.deepEqual(requestedLimits, [15]);
    assert.equal(deletedIds.length, 15);
    settings.store.messageLimit = 0;
    await manager.addMessage({ id: "unlimited" }, "EDITED");
    assert.equal(counts, 1);
});
