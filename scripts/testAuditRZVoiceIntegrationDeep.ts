import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const tick = () => new Promise(resolve => setImmediate(resolve));
const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
const identity = (value: unknown) => value;
const defaultExport = (value: unknown) => ({ __esModule: true, default: value });
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}
function defineSettings(definitions: Record<string, any>) {
    const store = Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [key,
        structuredClone(definition.default ?? definition.options?.find((option: any) => option.default)?.value)
    ]));
    return { store, use: () => store };
}
function clock() {
    let nextId = 0;
    const state = { now: 100_000 };
    const intervals = new Map<number, () => unknown>();
    const timeouts = new Map<number, () => unknown>();
    const globals = {
        Date: class extends Date { static now() { return state.now; } },
        setInterval: (callback: () => unknown) => { const id = ++nextId; intervals.set(id, callback); return id; },
        clearInterval: (id: number) => intervals.delete(id),
        setTimeout: (callback: () => unknown) => { const id = ++nextId; timeouts.set(id, callback); return id; },
        clearTimeout: (id: number) => timeouts.delete(id)
    };
    async function timeout() {
        const [id, callback] = [...timeouts][0];
        timeouts.delete(id);
        await callback();
        await tick();
    }
    return { state, intervals, timeouts, globals, timeout };
}
function load(path: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, expose = "") {
    return loadTestModule(`${process.env.RZ_VOICE_SOURCE_ROOT ?? "src/equicordplugins"}/${path}`, {
        "@api/Settings": { definePluginSettings: defineSettings },
        "@components/ErrorBoundary": defaultExport({ wrap: identity }),
        "@utils/constants": { EquicordDevs: {}, Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { ...defaultExport(identity), OptionType: {}, makeRange: () => [] },
        "@webpack": { findComponentByCodeLazy: () => "host-component", findCssClassesLazy: () => ({}), findByPropsLazy: () => ({}), extractAndLoadChunksLazy: () => () => Promise.resolve() },
        ...imports
    }, { React, console, ...globals }, expose);
}
const voiceChannel = { id: "voice", guild_id: "guild", userLimit: 0, getGuildId: () => "guild", isDM: () => false, isGroupDM: () => false, isMultiUserDM: () => false };

function rejoinHarness() {
    const timers = clock();
    const state = { account: "alice", voice: null as any, fail: false };
    const saved = new Map<string, any>();
    const dispatches: any[] = [];
    const storage = {
        get: async (key: string) => saved.get(key),
        set: async (key: string, value: unknown) => { if (state.fail) throw Error("offline fixture failure"); saved.set(key, value); },
        setMany: async (entries: [string, unknown][]) => { if (state.fail) throw Error("offline fixture failure"); for (const [key, value] of entries) saved.set(key, value); }
    };
    const common = {
        UserStore: { getCurrentUser: () => state.account ? { id: state.account } : undefined },
        VoiceStateStore: { getVoiceStateForUser: () => state.voice, getVoiceStatesForChannel: () => ({ other: { userId: "other" } }) },
        ChannelStore: { getChannel: () => voiceChannel }, FluxDispatcher: { dispatch: (value: unknown) => dispatches.push(value) }
    };
    const api = load("voiceRejoin/index.tsx", { "@api/DataStore": storage, "@webpack/common": common }, timers.globals, "\nexport { persistActiveState, persistInactiveState };\n");
    return { api, plugin: api.default, state, saved, storage, dispatches, timers };
}

test("VoiceRejoin refuses ownerless legacy state without deleting it", async () => {
    const fixture = rejoinHarness();
    const legacy = { channelId: "voice", timestamp: 100_000 };
    fixture.saved.set("VCLastVoiceChannel", legacy);
    fixture.saved.set("VCLastVoiceChannelSession", true);
    await fixture.plugin.flux.CONNECTION_OPEN();
    assert.equal(fixture.timers.timeouts.size, 0);
    assert.equal(fixture.saved.get("VCLastVoiceChannel"), legacy);
});

test("VoiceRejoin scopes accounts, serializes transitions and retries failed writes", async () => {
    const fixture = rejoinHarness();
    const active = { userId: "alice", channelId: "voice", guildId: "guild" };
    fixture.state.fail = true;
    await assert.rejects(fixture.api.persistActiveState(active), /fixture failure/);
    fixture.state.fail = false;
    await Promise.all([fixture.api.persistActiveState(active), fixture.api.persistInactiveState()]);
    assert.equal(fixture.saved.get("VCLastVoiceChannelSession:alice"), false);
    fixture.state.account = "bob";
    await fixture.plugin.flux.CONNECTION_OPEN();
    assert.equal(fixture.timers.timeouts.size, 0);
    await fixture.api.persistActiveState({ ...active, userId: "bob" });
    assert.equal(fixture.saved.get("VCLastVoiceChannel:bob").userId, "bob");
    assert.equal(fixture.saved.get("VCLastVoiceChannelSession:alice"), false);
});

test("VoiceRejoin uses disconnect time rather than a long call's last update", async () => {
    const fixture = rejoinHarness();
    await fixture.api.persistActiveState({ userId: "alice", channelId: "voice", guildId: "guild" });
    fixture.timers.state.now += 3_600_000;
    fixture.plugin.flux.CONNECTION_CLOSED();
    await fixture.plugin.flux.CONNECTION_OPEN();
    await fixture.timers.timeout();
    assert.equal(fixture.dispatches.length, 1);
});

test("VoiceRejoin preserves an already active call and disposes heartbeat and pending reconnect", async () => {
    const fixture = rejoinHarness();
    fixture.state.voice = { userId: "alice", channelId: "voice", guildId: "guild" };
    fixture.plugin.start();
    [...fixture.timers.intervals.values()][0]();
    await tick();
    fixture.timers.state.now += 30_000;
    [...fixture.timers.intervals.values()][0]();
    await tick();
    assert.equal(fixture.saved.get("VCLastVoiceChannel:alice").timestamp, fixture.timers.state.now);
    await fixture.plugin.flux.CONNECTION_OPEN();
    assert.equal(fixture.saved.get("VCLastVoiceChannelSession:alice"), true);
    assert.equal(fixture.timers.timeouts.size, 0);
    fixture.state.voice = null;
    await fixture.plugin.flux.CONNECTION_OPEN();
    assert.equal(fixture.timers.timeouts.size, 1);
    fixture.plugin.stop();
    assert.equal(fixture.timers.timeouts.size + fixture.timers.intervals.size, 0);
});

test("VoiceRejoin rejects deferred reads after stop and account change", async () => {
    for (const boundary of ["stop", "account"]) {
        const fixture = rejoinHarness();
        const pending = deferred<boolean>();
        fixture.storage.get = () => pending.promise;
        const opening = fixture.plugin.flux.CONNECTION_OPEN();
        await tick();
        if (boundary === "stop") fixture.plugin.stop();
        else fixture.state.account = "bob";
        pending.resolve(true);
        await opening;
        assert.equal(fixture.timers.timeouts.size, 0);
    }
});

function statsHarness() {
    const timers = clock();
    const state = { account: "alice", fail: false };
    const saved = new Map<string, any>();
    const storage = { get: async (key: string) => saved.get(key), set: async (key: string, value: unknown) => { if (state.fail) throw Error("offline fixture failure"); saved.set(key, value); } };
    const api = load("voiceStats/index.tsx", {
        "@api/DataStore": storage, "@components/BaseText": {}, "@utils/react": {},
        "@webpack/common": {
            UserStore: { getCurrentUser: () => state.account ? { id: state.account } : undefined },
            SelectedChannelStore: { getVoiceChannelId: () => null }, VoiceStateStore: {}
        }
    }, { ...timers.globals, console: { error() {} } }, "\nexport { getLiveSeconds, persistTotals, totalsByUser }; export function accrueForTest(value: number) { totalsByUser.set('friend', value); totalsDirty = true; }\n");
    return { api, plugin: api.default, state, saved, storage };
}

test("VoiceStats isolates account totals and leaves unattributable legacy data untouched", async () => {
    const fixture = statsHarness();
    fixture.saved.set("VoiceStats_totals", { friend: 999 });
    fixture.saved.set("VoiceStats_totals:alice", { friend: 7 });
    fixture.saved.set("VoiceStats_totals:bob", { friend: 2 });
    await fixture.plugin.start();
    assert.equal(fixture.api.getLiveSeconds("friend"), 7);
    fixture.api.accrueForTest(9);
    fixture.state.account = "bob";
    assert.equal(fixture.api.getLiveSeconds("friend"), 0);
    await fixture.plugin.flux.CONNECTION_OPEN();
    assert.equal(fixture.api.getLiveSeconds("friend"), 2);
    assert.equal(fixture.saved.get("VoiceStats_totals:alice").friend, 9);
    assert.equal(fixture.saved.get("VoiceStats_totals").friend, 999);
    fixture.plugin.stop();
});

test("VoiceStats retains failed snapshots across stop/restart and retries only their owner keys", async () => {
    const fixture = statsHarness();
    await fixture.plugin.start();
    fixture.state.fail = true;
    fixture.api.accrueForTest(11);
    await fixture.api.persistTotals();
    fixture.plugin.stop();
    await fixture.plugin.start();
    assert.equal(fixture.api.getLiveSeconds("friend"), 11);
    fixture.state.account = "bob";
    await fixture.plugin.flux.CONNECTION_OPEN();
    assert.equal(fixture.api.getLiveSeconds("friend"), 0);
    fixture.state.fail = false;
    await fixture.api.persistTotals();
    assert.equal(fixture.saved.get("VoiceStats_totals:alice").friend, 11);
    assert.equal(fixture.saved.has("VoiceStats_totals:bob"), false);
    fixture.plugin.stop();
});

test("VoiceStats discards a deferred old-account load", async () => {
    const fixture = statsHarness();
    const pending = deferred<Record<string, number>>();
    fixture.storage.get = key => key.endsWith(":alice") ? pending.promise : Promise.resolve({ friend: 3 });
    const starting = fixture.plugin.start();
    await tick();
    fixture.state.account = "bob";
    await fixture.plugin.flux.CONNECTION_OPEN();
    pending.resolve({ friend: 50 });
    await starting;
    assert.equal(fixture.api.getLiveSeconds("friend"), 3);
    fixture.plugin.stop();
});

test("VoiceStats fails closed on storage read failure and retries on the next account initialization", async () => {
    const fixture = statsHarness();
    fixture.saved.set("VoiceStats_totals:alice", { friend: 40 });
    let failRead = true;
    fixture.storage.get = async key => {
        if (failRead) throw Error("offline read failure");
        return fixture.saved.get(key);
    };
    await fixture.plugin.start();
    assert.equal(fixture.api.getLiveSeconds("friend"), 0);
    await fixture.api.persistTotals();
    assert.equal(fixture.saved.get("VoiceStats_totals:alice").friend, 40);
    failRead = false;
    await fixture.plugin.flux.CONNECTION_OPEN();
    assert.equal(fixture.api.getLiveSeconds("friend"), 40);
    fixture.plugin.stop();
});

function sidebarHarness() {
    const timers = clock();
    const state = { account: "alice" };
    const pendingDm = deferred<string>();
    const windows = new Set<string>();
    const channels = new Map<string, any>([["dm", { id: "dm", isPrivate: () => true, name: "DM" }]]);
    let handlers: any;
    class Store {
        constructor(_dispatcher: unknown, events: unknown) { handlers = events; }
        emitChange() {}
    }
    const common = {
        UserStore: { getCurrentUser: () => ({ id: state.account }), getUser: () => undefined },
        Flux: { PersistedStore: Store }, FluxDispatcher: {},
        ChannelActionCreators: { getOrEnsurePrivateChannel: () => pendingDm.promise },
        ChannelStore: { getChannel: (id: string) => channels.get(id), getDMFromUserId: () => undefined },
        PopoutWindowStore: { getWindowKeys: () => [...windows], getWindowOpen: (id: string) => windows.has(id) },
        PopoutActions: { open: (id: string) => windows.add(id), close: (id: string) => windows.delete(id), setAlwaysOnTop() {} },
        RelationshipStore: { getNickname: () => undefined }
    };
    const store = load("sidebarChat/store.ts", { "@utils/lazy": { proxyLazy: (factory: () => unknown) => factory() }, "@webpack/common": common });
    const api = load("sidebarChat/index.tsx", {
        "@api/HeaderBar": {}, "@utils/css": { classNameFactory: () => identity }, "@utils/discord": {},
        "@vencord/discord-types/enums": { ChannelType: {} }, "@webpack/common": common, "./store": store
    }, { ...timers.globals, window: timers.globals }, "\nexport { openPopoutFromUserMenu, openPopout };\n");
    return { api, plugin: api.default, state, pendingDm, windows, channels, store, timers, handlers };
}

test("SidebarChat bounds unavailable-channel restoration and resumes persistence", () => {
    const fixture = sidebarHarness();
    fixture.store.settings.store.persistedPopoutWindowsByUser = { alice: ["missing"] };
    fixture.plugin.start();
    assert.equal(fixture.timers.intervals.size, 1);
    fixture.timers.state.now += 10_000;
    [...fixture.timers.intervals.values()][0]();
    assert.equal(fixture.timers.intervals.size, 0);
    fixture.api.openPopout("dm");
    assert.deepEqual([...fixture.store.settings.store.persistedPopoutWindowsByUser.alice], ["dm"]);
    fixture.plugin.stop();
});

test("SidebarChat does not toggle an already open restored popout closed", () => {
    const fixture = sidebarHarness();
    fixture.windows.add("DISCORD_VC_SC-dm");
    fixture.store.settings.store.persistedPopoutWindowsByUser = { alice: ["dm"] };
    fixture.plugin.start();
    assert.equal(fixture.windows.size, 1);
    fixture.plugin.stop();
});

test("SidebarChat stops restoring immediately when persistence is disabled", () => {
    const fixture = sidebarHarness();
    fixture.store.settings.store.persistedPopoutWindowsByUser = { alice: ["missing"] };
    fixture.plugin.start();
    fixture.store.settings.store.persistPopoutWindows = false;
    [...fixture.timers.intervals.values()][0]();
    assert.equal(fixture.timers.intervals.size, 0);
    assert.equal(fixture.windows.size, 0);
    fixture.plugin.stop();
});

test("SidebarChat rejects delayed private-channel opens after stop or account change", async () => {
    for (const boundary of ["stop", "account", "reject-after-stop"]) {
        const fixture = sidebarHarness();
        fixture.plugin.start();
        const opening = fixture.api.openPopoutFromUserMenu("friend");
        if (boundary === "account") fixture.state.account = "bob";
        else fixture.plugin.stop();
        if (boundary === "reject-after-stop") fixture.pendingDm.reject(Error("fixture"));
        else fixture.pendingDm.resolve("dm");
        await opening;
        assert.equal(fixture.windows.size, 0);
        assert.equal(fixture.timers.timeouts.size, 0);
        fixture.plugin.stop();
    }
});

test("SidebarChat account changes preserve old window snapshots without assigning them to the new account", () => {
    const fixture = sidebarHarness();
    fixture.store.settings.store.persistedPopoutWindowIds = ["legacy"];
    fixture.plugin.start();
    fixture.api.openPopout("dm");
    fixture.state.account = "bob";
    fixture.plugin.flux.CONNECTION_OPEN();
    assert.equal(fixture.windows.size, 0);
    assert.deepEqual([...fixture.store.getPersistedPopoutChannelIds()], []);
    assert.deepEqual([...fixture.store.settings.store.persistedPopoutWindowsByUser.alice], ["dm"]);
    assert.deepEqual([...fixture.store.settings.store.persistedPopoutWindowIds], ["legacy"]);
    fixture.plugin.stop();
});

test("SidebarStore rejects stopped/account-stale DM resolutions and preserves a selection on failed DM open", async () => {
    for (const boundary of ["stop", "account", "failure"]) {
        const fixture = sidebarHarness();
        fixture.plugin.start();
        await fixture.handlers.VC_SIDEBAR_CHAT_NEW({ guildId: "guild", id: "text" });
        const opening = fixture.handlers.VC_SIDEBAR_CHAT_NEW({ guildId: null, id: "friend" });
        if (boundary === "stop") fixture.plugin.stop();
        if (boundary === "account") fixture.state.account = "bob";
        if (boundary === "failure") fixture.pendingDm.reject(Error("fixture"));
        else fixture.pendingDm.resolve("dm");
        await opening;
        assert.equal(fixture.store.SidebarStore.getState().channelId, boundary === "account" ? "" : "text");
        fixture.plugin.stop();
    }
});

test("SidebarStore accepts owner-tagged saved state but refuses ownerless/cross-account restoration", () => {
    for (const owner of [undefined, "alice", "bob"]) {
        const fixture = sidebarHarness();
        fixture.store.SidebarStore.initialize({ userId: owner, guildId: "guild", channelId: "text", width: 300 });
        assert.equal(fixture.store.SidebarStore.getState().channelId, owner === "alice" ? "text" : "");
        assert.equal(fixture.store.SidebarStore.getState().width, 300);
    }
});

test("VoiceButtons completes partial local deafen without unmuting and respects disabled components", () => {
    for (const muteSoundboard of [false, true]) {
        const media = { muted: true, soundboard: false, video: false };
        const settings = { store: { useServer: false, muteSoundboard, disableVideo: true, whichNameToShow: "nickname" } };
        const api = load("voiceButtons/utils.tsx", {
            "./settings": { settings }, "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: "self" }) },
                VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice" }) },
                ChannelStore: { getChannel: () => voiceChannel }, GuildMemberStore: { getMember: () => ({ nick: "Guild nick" }) }, RelationshipStore: {},
                MediaEngineStore: { isLocalMute: () => media.muted, isLocalVideoDisabled: () => media.video },
                SoundboardStore: { isLocalSoundboardMuted: () => media.soundboard },
                VoiceActions: { toggleLocalMute: () => { media.muted = !media.muted; }, toggleLocalSoundboardMute: () => { media.soundboard = !media.soundboard; }, setDisableLocalVideo: (_user: string, value: string) => { media.video = value === "DISABLED"; } }
            }
        }, {}, "\nexport { getUserName };\n");
        const user = { id: "friend", username: "name" };
        assert.equal(api.getUserName(user), "Guild nick");
        const rendered = api.UserDeafenButton({ user });
        rendered.props.onClick();
        assert.equal(media.muted, true);
        assert.equal(media.soundboard, muteSoundboard);
        assert.equal(media.video, true);
        assert.match(api.UserDeafenButton({ user }).props.tooltip, /^Undeafen/);
        api.UserDeafenButton({ user }).props.onClick();
        assert.equal(media.muted, false);
        assert.equal(media.video, false);
    }
});

test("RandomVoice rechecks mute/deafen at execution and respects cancellation and changed settings", async () => {
    for (const boundary of ["manual", "settings", "stop", "account", "apply"]) {
        const timers = clock();
        const state = { account: "alice", channel: null as string | null, muted: false, deaf: false };
        const api = load("randomVoice/index.tsx", {
            "@api/UserArea": {}, "@components/Button": {}, "@components/Switch": {}, "@shared/debounce": {},
            "@utils/css": { classNameFactory: () => identity },
            "@webpack": { findByPropsLazy: () => ({}), findByCodeLazy: () => () => [] },
            "@webpack/common": {
                React, UserStore: { getCurrentUser: () => ({ id: state.account }) },
                GuildStore: { getGuilds: () => ({ guild: { id: "guild", name: "guild" } }), getGuild: () => ({}) },
                ChannelStore: { getChannel: () => voiceChannel }, PermissionStore: { can: () => true }, PermissionsBits: {},
                VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: state.channel }), getVoiceStates: () => ({ friend: { channelId: "voice" } }), getVoiceStatesForChannel: () => ({ friend: {} }) },
                SelectedChannelStore: { getVoiceChannelId: () => state.channel }, RelationshipStore: { getFriendIDs: () => [] },
                MediaEngineStore: { isSelfMute: () => state.muted, isSelfDeaf: () => state.deaf },
                VoiceActions: { toggleSelfMute: () => { state.muted = !state.muted; }, toggleSelfDeaf: () => { state.deaf = !state.deaf; } },
                ChannelActions: { selectVoiceChannel() {} }, Toasts: { Type: {}, Position: {}, show() {}, genId() {} }
            }
        }, { ...timers.globals, window: { addEventListener() {}, removeEventListener() {} }, document: { addEventListener() {}, removeEventListener() {} } }, "\nexport { joinRandomVoice };\n");
        Object.assign(api.default.settings.store, { selfMute: true, selfDeafen: true, UserAmount: 0, spacesLeft: 0, vcLimit: 0 });
        await api.joinRandomVoice();
        assert.equal(timers.intervals.size, 1);
        state.channel = "voice";
        if (boundary === "manual") { state.muted = true; state.deaf = true; }
        if (boundary === "settings") Object.assign(api.default.settings.store, { selfMute: false, selfDeafen: false });
        if (boundary === "account") state.account = "bob";
        if (boundary === "stop") api.default.stop();
        for (const callback of timers.intervals.values()) callback();
        await tick();
        assert.equal(state.muted, boundary === "manual" || boundary === "apply");
        assert.equal(state.deaf, boundary === "manual" || boundary === "apply");
        assert.equal(timers.intervals.size, 0);
    }
});
