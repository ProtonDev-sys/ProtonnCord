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

import indicators from "../src/equicordplugins/toneIndicators/indicators";

const React = {
    createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } }),
    isValidElement: (node: any) => node != null && typeof node === "object" && "type" in node && "props" in node,
    cloneElement: (node: any, props: object, children: unknown) => ({ ...node, props: { ...node.props, ...props, children } })
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T = any>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function definePluginSettings(defs: any) {
    const store = Object.fromEntries(Object.entries(defs).map(([key, value]: [string, any]) => [key, value.default ?? value.options?.find((option: any) => option.default)?.value]));
    const settings = { defs, store, use: () => store, withPrivateSettings: () => settings };
    return settings;
}
function load(file: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}, expose = "") {
    const imports: Record<string, unknown> = {
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {}, makeRange: () => [] },
        "@utils/constants": { Devs: {}, EquicordDevs: {}, IS_MAC: false },
        "@utils/css": { classNameFactory: () => (...names: string[]) => names.join(" ") },
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@api/Settings": { definePluginSettings, migratePluginToSettings() {}, migratePluginSettings() {}, migratePluginSetting() {} },
        "@components/ErrorBoundary": { __esModule: true, default: Object.assign("boundary", { wrap: (component: unknown) => component }) },
        ...mocks
    };
    const code = transpileModule(readFileSync("src/equicordplugins/" + file, "utf8") + expose, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, React, Promise, console, URL, URLSearchParams, Blob, File, TextEncoder,
        require(name: string) {
            if (name.includes(".css")) return {};
            assert.ok(Object.hasOwn(imports, name), "Unexpected import: " + name);
            return imports[name];
        },
        ...globals
    });
}

test("PingNotifications works with ordinary channels that have no isMuted method and respects guild mute", () => {
    const notifications: any[] = [];
    let muted = false;
    const plugin = load("pingNotifications/index.tsx", {
        "@api/Notifications": { showNotification: (value: any) => notifications.push(value) },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ id: "channel", guild_id: "guild", type: 0 }) },
            UserStore: { getCurrentUser: () => ({ id: "self" }), getUser: () => ({ username: "Sender" }) },
            PresenceStore: { getStatus: () => "online" }, RelationshipStore: { isBlocked: () => false },
            UserGuildSettingsStore: { isMuted: () => muted }, SelectedChannelStore: { getChannelId: () => "other" }
        }
    }).default;
    const message = { channel_id: "channel", author: { id: "sender" }, mentions: [{ id: "self", username: "Self" }], content: "hi <@self>" };
    plugin.flux.MESSAGE_CREATE({ message });
    assert.equal(notifications[0].body, "hi @Self");
    muted = true;
    plugin.flux.MESSAGE_CREATE({ message });
    assert.equal(notifications.length, 1);
});

test("MoreUserTags keeps webhook tags when ordinary bot tags are disabled", () => {
    const settings = { store: { dontShowForBots: true } };
    const plugin = load("moreUserTags/index.tsx", {
        "@utils/discord": {}, "./settings": { settings },
        "./consts": {
            isWebhook: (message: any) => Boolean(message?.webhookId),
            tags: [{ name: "WEBHOOK", condition: (message: any) => Boolean(message?.webhookId) }], Tag: "tag"
        },
        "@webpack/common": { ChannelStore: { getChannel: () => ({ id: "channel" }) }, GuildStore: { getGuild: () => undefined } }
    }).default;
    assert.equal(plugin.getTag({ message: { webhookId: "hook" }, user: { id: "bot", bot: true }, isChat: true }), 101);
    assert.equal(plugin.getTag({ message: {}, user: { id: "bot", bot: true }, isChat: true }), null);
});

test("NewPluginsManager retries failed persistence and deduplicates simultaneous modal requests", async () => {
    let writes = 0;
    let opens = 0;
    const gate = deferred();
    const mocks: Record<string, unknown> = Object.fromEntries([
        "@components/BaseText", "@components/Link", "@components/Notice", "@components/settings/tabs/plugins/PluginCard", "@components/settings/tabs/plugins/shared", "@utils/ChangeList", "@utils/native", "@utils/react"
    ].map(name => [name, {}]));
    const api = load("newPluginsManager/NewPluginsModal.tsx", {
        ...mocks,
        "~plugins": { PluginManifest: {} },
        "@webpack/common": { openModal: () => { opens++; return "modal"; } },
        "./knownSettings": {
            getNewPluginChanges: async () => ({ newPlugins: new Set(["New"]), newSettings: new Map() }),
            writeKnownSettings: () => ++writes === 1 ? Promise.reject(new Error("disk unavailable")) : gate.promise
        }
    });
    await assert.rejects(api.openNewPluginsModal(), /disk unavailable/);
    const one = api.openNewPluginsModal();
    const two = api.openNewPluginsModal();
    assert.equal(one, two);
    gate.resolve(undefined);
    await Promise.all([one, two]);
    await api.openNewPluginsModal();
    assert.equal(writes, 2);
    assert.equal(opens, 1);
});

function randomVoice() {
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let account = "self";
    let channel = "voice";
    const sources = deferred();
    let streams = 0;
    const events = { addEventListener() {}, removeEventListener() {} };
    const api = load("randomVoice/index.tsx", {
        "@api/UserArea": {}, "@components/Button": {}, "@components/Switch": {}, "@shared/debounce": {},
        "@webpack": { findByPropsLazy: () => ({}), findByCodeLazy: (code: string) => code.includes("STREAM_START") ? () => { streams++; } : () => sources.promise },
        "@webpack/common": {
            React, UserStore: { getCurrentUser: () => ({ id: account }) },
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: channel }) },
            SelectedChannelStore: { getVoiceChannelId: () => channel }, PermissionStore: { can: () => true },
            PermissionsBits: { STREAM: 1 }, MediaEngineStore: { getMediaEngine: () => ({}) },
            Toasts: { Type: {}, Position: {}, show() {}, genId() {} }
        }
    }, {
        window: events, document: events,
        setInterval: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearInterval: (id: number) => timers.delete(id)
    }, "\nexport { runAfterVoiceJoin, startChannelStream };" );
    return { api, timers, sources, get streams() { return streams; }, setAccount: (id: string) => { account = id; }, setChannel: (id: string) => { channel = id; } };
}

test("RandomVoice cancels post-join callbacks on stop and account changes", async () => {
    const h = randomVoice();
    let callbacks = 0;
    h.api.runAfterVoiceJoin("voice", [() => { callbacks++; }]);
    h.api.default.stop();
    assert.equal(h.timers.size, 0);
    h.api.runAfterVoiceJoin("voice", [() => { callbacks++; }]);
    h.setAccount("different");
    [...h.timers.values()][0]();
    await tick();
    assert.equal(callbacks, 0);
    assert.equal(h.timers.size, 0);
});

test("RandomVoice discards desktop-source selection completed after plugin stop", async () => {
    const h = randomVoice();
    const pending = h.api.startChannelStream({ id: "voice", guild_id: "guild" }, 0);
    h.api.default.stop();
    h.sources.resolve([{ id: "source", name: "Screen" }]);
    await pending;
    assert.equal(h.streams, 0);
});

function recorderHarness() {
    const capture = deferred();
    const menus = new Map<string, Function>();
    let stops = 0;
    let uploads = 0;
    let media: any;
    const stream = { getTracks: () => [{ stop: () => { stops++; } }] };
    class Recorder {
        state = "inactive";
        listeners = new Map<string, Function>();
        constructor() { media = this; }
        start() { this.state = "recording"; }
        stop() { this.state = "inactive"; }
        addEventListener(name: string, callback: Function) { this.listeners.set(name, callback); }
        data() { this.listeners.get("dataavailable")?.({ data: new Blob(["recording"]) }); }
    }
    const plugin = load("screenRecorder.equibop/index.tsx", {
        "@api/ContextMenu": {
            addContextMenuPatch: (_: string, callback: Function) => menus.set(callback.name, callback),
            removeContextMenuPatch: (_: string, callback: Function) => menus.delete(callback.name)
        },
        "@components/Icons": {}, "@webpack/common": { Menu: { MenuItem: "item" }, UploadHandler: { promptToUpload: () => { uploads++; } } }
    }, { navigator: { mediaDevices: { getDisplayMedia: () => capture.promise } }, MediaRecorder: Recorder }).default;
    const children: any[] = [];
    plugin.contextMenus["channel-attach"](children);
    return { plugin, capture, stream, start: () => children[0].props.action(), menus, get media() { return media; }, get stops() { return stops; }, get uploads() { return uploads; } };
}

test("ScreenRecorder releases a capture approved after disable without creating a recorder", async () => {
    const h = recorderHarness();
    const pending = h.start();
    h.plugin.stop();
    h.capture.resolve(h.stream);
    await pending;
    assert.equal(h.stops, 1);
    assert.equal(h.media, undefined);
    assert.equal(h.menus.size, 0);
});

test("ScreenRecorder releases tracks and removes its dynamic menu on stop", async () => {
    const h = recorderHarness();
    const pending = h.start();
    h.capture.resolve(h.stream);
    await pending;
    assert.equal(h.media.state, "recording");
    assert.ok(h.menus.has("stopRecording"));
    h.plugin.stop();
    assert.equal(h.media.state, "inactive");
    assert.equal(h.stops, 1);
    assert.equal(h.menus.size, 0);
    h.media.data();
    assert.equal(h.uploads, 0);
});

test("ScreenRecorder suppresses a queued upload prompt when disabled after finishing", async () => {
    const h = recorderHarness();
    const pending = h.start();
    h.capture.resolve(h.stream);
    await pending;
    const children: any[] = [];
    h.menus.get("stopRecording")!(children, { channel: { id: "selected" } });
    children[0].props.action();
    h.plugin.stop();
    h.media.data();
    assert.equal(h.stops, 1);
    assert.equal(h.uploads, 0);
});

test("RichMagnetLinks decodes names once and preserves literal plus and percent signs", () => {
    const rule = load("richMagnetLinks/index.tsx").default.magnetLink(1);
    const url = "magnet:?xt=urn:test&dn=C%2B%2B%20100%25";
    assert.equal(rule.parse([url], null, { messageId: "message" }).filename, "C++ 100%");
});

test("Snowfall recycles each transition node only once", () => {
    const listeners = new Map<string, Function>();
    const field: any = { id: "", addEventListener: (name: string, fn: Function) => listeners.set(name, fn), removeChild: (node: any) => { node.parentNode = null; } };
    let creates = 0;
    const api = load("snowfall/index.tsx", {
        "@components/Heading": {}, "@components/Paragraph": {}, "@webpack/common": { React }
    }, {
        window: { innerWidth: 1000, innerHeight: 800, addEventListener() {} },
        document: { createElement: () => ++creates <= 2 ? { style: { transform: "", transition: "" } } : field, body: { appendChild() {} }, addEventListener() {} }
    }, "\nexport { CopleSnow };" );
    const snow = new api.CopleSnow({ autoplay: false });
    const node = { parentNode: field, classList: { contains: () => true } };
    listeners.get("transitionend")!({ target: node });
    listeners.get("transitionend")!({ target: node });
    assert.equal(snow.queue.length, 1);
});

test("SidebarChat ignores stale DM resolutions and uses existing private channel IDs directly", async () => {
    const pending = deferred();
    let handlers: any;
    let calls = 0;
    class Store {
        constructor(_: unknown, events: any) { handlers = events; }
        emitChange() {}
    }
    const api = load("sidebarChat/store.ts", {
        "@utils/lazy": { proxyLazy: (factory: Function) => factory() },
        "@webpack/common": {
            Flux: { PersistedStore: Store },
            ChannelActionCreators: { getOrEnsurePrivateChannel: () => { calls++; return pending.promise; } },
            ChannelStore: { getChannel: (id: string) => id === "group" ? { isPrivate: () => true } : undefined }
        }
    });
    const opening = handlers.VC_SIDEBAR_CHAT_NEW({ guildId: null, id: "user" });
    handlers.VC_SIDEBAR_CHAT_CLOSE();
    pending.resolve("dm");
    await opening;
    assert.equal(api.SidebarStore.getState().channelId, "");
    await handlers.VC_SIDEBAR_CHAT_NEW({ guildId: null, id: "group" });
    assert.equal(api.SidebarStore.getState().channelId, "group");
    assert.equal(calls, 1);
});

test("ToneIndicators preserves frozen React input and empty custom descriptions", () => {
    const plugin = load("toneIndicators/index.tsx", { "@webpack/common": { React }, "./indicators": { __esModule: true, default: indicators }, "./ToneIndicator": { __esModule: true, default: "tone" } }).default;
    plugin.settings.store.customIndicators = "empty=; constructor=Literal meaning";
    const node = Object.freeze({ type: "span", props: Object.freeze({ children: "before /srs after /empty /constructor" }) });
    const rendered = plugin.patchToneIndicators(node);
    assert.notEqual(rendered, node);
    assert.equal(node.props.children, "before /srs after /empty /constructor");
    assert.ok(rendered.props.children.includes(" after /empty"));
    assert.equal(rendered.props.children.at(-1).props.desc, "Literal meaning");
});

test("Translate+ keeps the newest mounted setter and rejects out-of-order translations", async () => {
    const effects: Function[] = [];
    const changes: any[][] = [];
    const replies: ReturnType<typeof deferred>[] = [];
    const api = load("translatePlus/utils/accessory.tsx", {
        "@equicordplugins/translatePlus/misc/languages": { languages: {} },
        "@equicordplugins/translatePlus/misc/types": { cl: (value: string) => value },
        "./icon": {}, "./translator": { translate: () => { const value = deferred(); replies.push(value); return value.promise; } },
        "@webpack/common": { useEffect: (callback: Function) => effects.push(callback), useState: () => { const values: any[] = []; changes.push(values); return [undefined, (value: any) => values.push(value)]; } }
    });
    const message = { id: "message", content: "hello" };
    api.Accessory({ message });
    const firstCleanup = effects.shift()!();
    api.Accessory({ message });
    const secondCleanup = effects.shift()!();
    firstCleanup();
    const first = api.handleTranslate(message);
    const second = api.handleTranslate(message);
    replies[1].resolve({ src: "en", text: "new" });
    await second;
    replies[0].resolve({ src: "en", text: "old" });
    await first;
    assert.equal(changes[1].at(-1).text, "new");
    assert.equal(changes[1].length, 2);
    secondCleanup();
});

test("UnitConverter resolves speed before distance, carries rounded inches, and leaves ordinary words intact", () => {
    const settings = { store: { myUnits: "imperial" } };
    const api = load("unitConverter/converter.ts", { ".": { settings } });
    assert.equal(api.convert("160.9km/h"), "100.00mph");
    assert.equal(api.convert("0.3048m"), "1ft");
    assert.equal(api.convert("30.48cm"), "12.00in");
    settings.store.myUnits = "metric";
    assert.equal(api.convert("2 inputs and 1 foot"), "2 inputs and 0.30m");
});

test("UnitConverter unregisters accessories and clears old view setters when stopped", () => {
    const registered = new Map();
    const conversions = new Map([["old", () => {}]]);
    const plugin = load("unitConverter/index.tsx", {
        "@api/MessageAccessories": { addMessageAccessory: (id: string, value: unknown) => registered.set(id, value), removeMessageAccessory: (id: string) => registered.delete(id) },
        "@webpack/common": {}, "./converter": {}, "./ConverterAccessory": { conversions }
    }).default;
    plugin.start();
    assert.equal(registered.size, 1);
    plugin.stop();
    assert.equal(registered.size, 0);
    assert.equal(conversions.size, 0);
});

test("Timezone modal stays open after a failed database save", async () => {
    let closed = 0;
    let changed = 0;
    const api = load("timezones/TimezoneModal.tsx", {
        "@api/DataStore": {}, "@components/Heading": {}, "@utils/margins": { Margins: {} },
        ".": { settings: { store: {} }, timezones: {} },
        "./database": { setTimezone: async () => false, setUserDatabaseTimezone: () => { changed++; } },
        "@webpack/common": { Modal: "modal", useState: () => ["Europe/London", () => {}], useEffect() {}, useMemo: () => [] }
    });
    const modal = api.SetTimezoneModal({ userId: "self", database: true, modalProps: { onClose: () => { closed++; } } });
    await modal.props.actions[0].onClick();
    assert.equal(closed, 0);
    assert.equal(changed, 0);
});

test("VoiceButtons targets the selected other user without toggling the moderator's own mute/deafen", () => {
    const actions: any[] = [];
    const settings = { store: { useServer: true, serverSelf: false, whichNameToShow: "username" } };
    const api = load("voiceButtons/utils.tsx", {
        "./settings": { settings }, "@webpack": { findComponentByCodeLazy: () => "icon" },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "self" }) },
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice", mute: false, deaf: false }) },
            ChannelStore: { getChannel: () => ({ guild_id: "guild" }) },
            PermissionStore: { can: () => true }, PermissionsBits: {},
            MediaEngineStore: { isSelfMute: () => false, isSelfDeaf: () => false, isLocalMute: () => false, isLocalVideoDisabled: () => false },
            SoundboardStore: { isLocalSoundboardMuted: () => false },
            GuildActions: { setServerMute: (...args: any[]) => actions.push(["mute", ...args]), setServerDeaf: (...args: any[]) => actions.push(["deafen", ...args]) },
            VoiceActions: { toggleSelfMute: () => actions.push(["self-mute"]), toggleSelfDeaf: () => actions.push(["self-deafen"]) }
        }
    });
    api.UserMuteButton({ user: { id: "other", username: "Other" } }).props.onClick();
    api.UserDeafenButton({ user: { id: "other", username: "Other" } }).props.onClick();
    assert.deepEqual(actions, [["mute", "guild", "other", true], ["deafen", "guild", "other", true]]);
    api.UserMuteButton({ user: { id: "self", username: "Self" } }).props.onClick();
    assert.deepEqual(actions.at(-1), ["self-mute"]);
});

test("VoiceChannelLog drops activity metadata completed after stop", async () => {
    const application = deferred();
    const entries: unknown[] = [];
    const plugin = load("voiceChannelLog/index.tsx", {
        "@vencord/discord-types/enums": { ChannelType: {} },
        "@webpack": { findByPropsLazy: () => ({ fetchApplication: () => application.promise }) },
        "./components/LogsButton": {}, "./components/VoiceChannelLogModal": {},
        "./logs": { addLogEntry: (value: unknown) => entries.push(value), setCallStartTime() {} },
        "./settings": { __esModule: true, default: { store: { logActivity: true } } },
        "@webpack/common": { ApplicationStore: { getApplication: () => undefined }, SelectedChannelStore: { getVoiceChannelId: () => "voice" }, UserStore: { getCurrentUser: () => ({ id: "self" }) } }
    }).default;
    plugin.flux.EMBEDDED_ACTIVITY_UPDATE_V2({ location: { channel_id: "voice" }, applicationId: "app", participants: [{ user_id: "other" }] });
    plugin.stop();
    application.resolve({ name: "Activity" });
    await tick();
    assert.equal(entries.length, 0);
});

test("WigglyText keeps frozen input immutable and preserves complete Unicode code points", () => {
    const plugin = load("wigglyText/index.tsx", { "@webpack/common": { React }, "@components/BaseText": {}, "./ui/components/ExampleWiggle": {} }).default;
    assert.doesNotThrow(() => plugin.settings.defs.intensity.onChange());
    assert.doesNotThrow(() => plugin.stop());
    const node = Object.freeze({ type: "span", props: Object.freeze({ children: "😀" }) });
    const source = Object.freeze([node]);
    const result = plugin.wigglyRule(1).react({ content: [], className: "x" }, () => source);
    assert.notEqual(result, source);
    assert.notEqual(result[0], node);
    assert.equal(result[0].props.children[0][0].props.children.props.children, "😀");
    assert.equal(node.props.children, "😀");
});

test("SteamStatusSync ignores status updates without a known status or game visibility", () => {
    const urls: string[] = [];
    const plugin = load("steamStatusSync/index.tsx", {}, { open: (url: string) => urls.push(url) }).default;
    plugin.settings.store.goInvisibleIfActivityIsHidden = true;
    plugin.flux.USER_SETTINGS_PROTO_UPDATE({ settings: { proto: { status: { status: { value: "unknown" } } } } });
    assert.equal(urls.length, 0);
    plugin.flux.USER_SETTINGS_PROTO_UPDATE({ settings: { proto: { status: { status: { value: "online" } } } } });
    assert.deepEqual(urls, ["steam://friends/status/online"]);
});

test("SaveFavoriteGIFs does not report export success after a save failure", async () => {
    const notices: any[] = [];
    const plugin = load("saveFavoriteGIFs/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {} }, "@api/Notifications": { showNotification: (notice: any) => notices.push(notice) },
        "@api/PluginManager": {}, "@equicordplugins/equicordToolbox": {}, "@utils/web": {},
        "@webpack/common": { UserSettingsActionCreators: { FrecencyUserSettingsActionCreators: { getCurrentValue: () => ({ favoriteGifs: { gifs: { "https://example.invalid/gif": {} } } }) } } }
    }, { IS_DISCORD_DESKTOP: true, DiscordNative: { fileManager: { saveWithDialog: async () => { throw new Error("disk unavailable"); } } }, fetch: async () => ({ ok: true }) }).default;
    await plugin.commands[1].execute();
    assert.equal(notices.at(-1).body, "Failed to save GIFs");
    assert.equal(notices.some(notice => notice.color === "var(--text-positive)"), false);
});

test("VoiceChannelLog rejects failed download responses without writing their error bodies", async () => {
    let writes = 0;
    let failures = 0;
    const api = load("voiceChannelLog/utils.ts", {
        "@api/AudioPlayer": {}, "@utils/web": {}, "@webpack": { findByPropsLazy: () => ({}) },
        "@webpack/common": { showToast: () => { failures++; }, Toasts: { Type: {} } },
        "./settings": { __esModule: true, default: { store: { soundboardFileType: ".ogg" } } }
    }, { IS_DISCORD_DESKTOP: true, DiscordNative: { fileManager: { saveWithDialog: () => { writes++; } } }, fetch: async () => ({ ok: false, status: 404, arrayBuffer: () => { throw new Error("must not read error body"); } }) });
    await api.downloadSound("sound");
    assert.equal(writes, 0);
    assert.equal(failures, 1);
});
