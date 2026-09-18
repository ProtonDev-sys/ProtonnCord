/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";

import { build } from "esbuild";

import { moveToFolder } from "../src/equicordplugins/serverReview/folders";
import { ActivityHistory, DAY, HistoryData, readHistory, reviewGroup } from "../src/equicordplugins/serverReview/history";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function historyChecks() {
    const now = 100 * DAY;
    assert.equal(reviewGroup({ since: now }, 30, now), "recent", "new servers get a full observation period");
    assert.equal(reviewGroup({ since: 70 * DAY }, 30, now), "unused", "the cutoff includes the exact boundary");
    for (const kind of ["emoji", "sticker", "sound"]) {
        assert.equal(reviewGroup({ since: DAY, [kind]: now - DAY }, 30, now), "resources", `${kind} use prevents an unused recommendation`);
    }
    assert.equal(reviewGroup({ since: DAY, visit: 80 * DAY, emoji: now }, 30, now), "recent");
    assert.equal(reviewGroup({ since: DAY, keep: true }, 30, now), "kept");
    assert.equal(reviewGroup({ since: now + DAY }, 30, now), "recent", "clock rollback does not make a server unused");

    const old: HistoryData = { version: 1, reminderAfter: 1, customField: "preserved", guilds: { guild: { since: DAY, visit: 2 * DAY, keep: true, extra: 42 }, rejoined: { since: DAY, keep: true } } };
    const read = deferred<unknown>();
    const writes: HistoryData[] = [];
    const history = new ActivityHistory({ read: () => read.promise, write: async data => { writes.push(data); } });
    const loading = history.load();
    history.record("guild", "emoji", now);
    history.remove("rejoined");
    history.ensure("rejoined", now);
    read.resolve(old);
    await loading;
    assert.equal(history.data.guilds.guild.since, DAY);
    assert.equal(history.data.guilds.guild.emoji, now, "events received during hydration survive");
    assert.equal(history.data.guilds.guild.keep, true);
    assert.equal(history.data.guilds.rejoined.since, now, "rejoining during hydration starts a fresh observation period");
    assert.equal(history.data.guilds.rejoined.keep, undefined);
    await history.flush();
    assert.equal(writes[0].customField, "preserved");
    assert.equal(writes[0].guilds.guild.extra, 42);
    assert.equal(old.guilds.guild.emoji, undefined, "loading does not mutate the storage snapshot");
    await history.flush();
    assert.equal(writes.length, 1, "clean history does not write");

    let readFails = true;
    let writeFails = true;
    let attempts = 0;
    const retry = new ActivityHistory({
        read: async () => { if (readFails) throw new Error("read failed"); return old; },
        write: async () => { attempts++; if (writeFails) throw new Error("write failed"); }
    });
    retry.record("guild", "sound", now);
    await retry.load();
    await retry.flush();
    assert.equal(retry.ready, false);
    assert.equal(attempts, 0, "a failed read never overwrites saved data");
    readFails = false;
    await retry.load();
    assert.equal(retry.data.guilds.guild.sound, now);
    await assert.rejects(retry.flush());
    assert.equal(retry.dirty, true);
    writeFails = false;
    await retry.flush();
    assert.equal(retry.dirty, false);
    assert.equal(attempts, 2);
    assert.equal(retry.error, undefined);
    assert.throws(() => readHistory({ ...old, version: 2 }), /untouched/);
    assert.throws(() => readHistory({ ...old, guilds: { bad: { since: NaN } } }), /untouched/);

    const firstWrite = deferred<void>();
    const snapshots: HistoryData[] = [];
    const serial = new ActivityHistory({ read: async () => undefined, write: async data => {
        snapshots.push(data);
        if (snapshots.length === 1) await firstWrite.promise;
    } });
    await serial.load();
    serial.record("a", "visit", now);
    const first = serial.flush();
    serial.record("a", "sound", now + 1);
    const second = serial.flush();
    assert.equal(snapshots.length, 1, "writes cannot overtake an earlier snapshot");
    firstWrite.resolve();
    await Promise.all([first, second]);
    assert.equal(snapshots[0].guilds.a.sound, undefined);
    assert.equal(snapshots[1].guilds.a.sound, now + 1);
    assert.equal(serial.dirty, false);
}

function folderChecks() {
    const original = [
        { guildIds: ["1"] },
        { id: { value: "20" }, name: { value: "Friends" }, color: { value: 123 }, extra: "keep", guildIds: ["2", "3"] },
        { id: { value: "21" }, name: { value: "Emotes" }, guildIds: ["4"] },
        { guildIds: ["5"] }
    ];
    const unknownField = Symbol("protobuf unknown field");
    Object.defineProperty(original[1], unknownField, { value: "preserved", enumerable: false });
    const moved = moveToFolder(original, ["1", "2"], { ...original[2], guildIds: ["4", "1", "2"] });
    assert.deepEqual(moved.map(folder => folder.guildIds), [["3"], ["4", "1", "2"], ["5"]]);
    assert.equal(moved[0].extra, "keep");
    assert.equal(Reflect.get(moved[0], unknownField), "preserved");
    assert.deepEqual(moved[0].color, { value: 123 });
    assert.deepEqual(original[1].guildIds, ["2", "3"], "the source layout is not mutated");
    const created = moveToFolder(original, ["2", "3"], { id: { value: "22" }, name: { value: "New" }, guildIds: ["2", "3"] });
    assert.deepEqual(created.map(folder => folder.guildIds), [["1"], ["4"], ["5"], ["2", "3"]]);
    assert.deepEqual(moveToFolder(moved, ["1", "2"], moved[1]), moved, "repeating a move does not duplicate memberships");
    assert.throws(() => moveToFolder([{ guildIds: null! }], [], moved[1]), /No servers were moved/);
    assert.equal(moveToFolder([...original, { guildIds: [] }], ["1"], moved[1]).at(-1)?.guildIds.length, 0, "unrelated empty folders survive");
}

async function runtimeChecks() {
    const result = await build({
        stdin: { contents: 'export { default as plugin } from "./src/equicordplugins/serverReview"; export * as tracking from "./src/equicordplugins/serverReview/tracking";', resolveDir: process.cwd() },
        bundle: true, format: "cjs", platform: "node", write: false,
        plugins: [{ name: "discord-test-runtime", setup(builder) {
            builder.onResolve({ filter: /^@/ }, args => ({ path: args.path, namespace: "mock" }));
            builder.onResolve({ filter: /^\.\/review$/ }, () => ({ path: "review", namespace: "mock" }));
            builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
            builder.onLoad({ filter: /.*/, namespace: "mock" }, args => {
                const mocks: Record<string, string> = {
                    "@api/DataStore": "export const get = __test.read; export const set = __test.write;",
                    "@api/MessageEvents": "export const addMessagePreSendListener=__test.addSend; export const removeMessagePreSendListener=__test.removeSend;",
                    "@api/Notifications": "export const showNotification = __test.notify;",
                    "@api/Settings": "export const definePluginSettings = values => ({store:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value.default]))});",
                    "@utils/Logger": "export class Logger { error() {} }",
                    "@webpack": "export const findStoreLazy=()=>({getGuildFolders:()=>__test.folders});",
                    "@utils/types": "export default x=>x; export const OptionType={NUMBER:1,STRING:2,BOOLEAN:3};",
                    "@utils/constants": "export const EquicordDevs={creations:{}};",
                    "@components/Button": "export const Button=()=>null;",
                    "@webpack/common": "export const {ChannelStore,EmojiStore,GuildStore,SelectedChannelStore,SelectedGuildStore,SoundboardStore,StickersStore,UserStore,Menu,React}=__test.stores;",
                    "review": "export const openReview=()=>{}; export const closeReview=()=>{};"
                };
                assert(args.path in mocks, `unexpected runtime dependency: ${args.path}`);
                return { contents: mocks[args.path], loader: "js" };
            });
        } }]
    });
    let now = 100 * DAY;
    let user = "account-a";
    let selected: string | null = null;
    let guildScans = 0;
    const guilds = Object.fromEntries(["visited", "emoji-source", "sticker-source", "sound-source", "ignored"].map(id => [id, { id, name: id }]));
    const stored = new Map<string, HistoryData>();
    const pendingReads = new Map<string, ReturnType<typeof deferred<HistoryData | undefined>>>();
    const notifications: unknown[] = [];
    const timers = new Map<number, { fn: () => void; delay: number; }>();
    let nextTimer = 0;
    const windowEvents = new Map<string, () => void>();
    const documentEvents = new Map<string, () => void>();
    const sendListeners = new Set<(...args: any[]) => unknown>();
    const test = {
        folders: [] as Array<{ folderName: string; guildIds: string[]; }>,
        addSend: (fn: (...args: any[]) => unknown) => sendListeners.add(fn),
        removeSend: (fn: (...args: any[]) => unknown) => sendListeners.delete(fn),
        read: async (key: string) => pendingReads.get(key)?.promise ?? stored.get(key),
        write: async (key: string, data: HistoryData) => { stored.set(key, structuredClone(data)); },
        notify: (data: unknown) => notifications.push(data),
        stores: {
            GuildStore: { getGuild: (id: string) => guilds[id], getGuilds: () => { guildScans++; return guilds; } },
            ChannelStore: { getChannel: (id: string) => ({ guild_id: id === "dm" ? undefined : "visited" }) },
            UserStore: { getCurrentUser: () => ({ id: user }) },
            SelectedGuildStore: { getGuildId: () => selected },
            SelectedChannelStore: { getChannelId: () => null, getVoiceChannelId: () => null },
            EmojiStore: { getCustomEmojiById: (id: string) => id === "111" ? { guildId: "emoji-source" } : undefined },
            StickersStore: { getStickerById: (id: string) => id === "222" ? { guild_id: "sticker-source" } : undefined },
            SoundboardStore: { getSoundById: (id: string) => id === "333" ? { guildId: "sound-source" } : undefined },
            Menu: {}
        }
    };
    const module: { exports: any; } = { exports: {} };
    runInNewContext(result.outputFiles[0].text, {
        __test: test, module, exports: module.exports, structuredClone, console,
        Date: class extends Date { static now() { return now; } },
        setTimeout: (fn: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
        clearTimeout: (id: number) => timers.delete(id),
        window: { addEventListener: (key: string, fn: () => void) => windowEvents.set(key, fn), removeEventListener: (key: string) => windowEvents.delete(key) },
        document: { visibilityState: "visible", addEventListener: (key: string, fn: () => void) => documentEvents.set(key, fn), removeEventListener: (key: string) => documentEvents.delete(key) }
    });
    const { plugin, tracking } = module.exports;
    const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    const fireTimers = async (delay: number) => {
        for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); }
        await settle();
    };
    plugin.start();
    await settle();
    const history = tracking.getHistory();
    assert.equal(history.ready, true);
    assert.equal(Object.keys(history.data.guilds).length, 5);
    await fireTimers(15_000);
    assert.equal(notifications.length, 0, "first install never recommends old memberships immediately");
    now += 31 * DAY;
    const submitted = { content: "<:test:111>", validNonShortcutEmojis: [{ id: "111", guildId: "emoji-source" }] };
    const options = { stickerIds: ["222"] };
    const beforeSend = JSON.stringify({ submitted, options });
    assert.equal([...sendListeners][0]("dm", submitted, options), undefined);
    assert.equal(JSON.stringify({ submitted, options }), beforeSend, "the early send observer never mutates content or options");
    plugin.flux.CHANNEL_SELECT({ channelId: "channel" });
    plugin.flux.EMOJI_TRACK_USAGE({ emojiUsed: [{ id: "111", guildId: "emoji-source" }] });
    plugin.flux.STICKER_TRACK_USAGE({ stickerIds: ["222"] });
    plugin.flux.GUILD_SOUNDBOARD_SOUND_PLAY_LOCALLY({ sound: { soundId: "333", guildId: "sound-source" }, channelId: "channel" });
    assert.equal(reviewGroup(history.data.guilds.visited, 30, now), "recent");
    for (const id of ["emoji-source", "sticker-source", "sound-source"]) assert.equal(reviewGroup(history.data.guilds[id], 30, now), "resources");
    assert.equal(reviewGroup(history.data.guilds.ignored, 30, now), "unused");
    assert.equal(history.data.guilds["emoji-source"].visit, undefined, "using an external emoji does not count as visiting its server");

    const beforeIgnored = JSON.stringify(history.data.guilds.ignored);
    plugin.flux.MESSAGE_CREATE({ message: { author: { id: "someone-else" }, channel_id: "channel", content: "<:x:111>" } });
    plugin.flux.MESSAGE_REACTION_ADD({ userId: "someone-else", channelId: "channel", emoji: { id: "111" } });
    plugin.flux.VOICE_CHANNEL_EFFECT_SEND({ userId: "someone-else", soundId: "333" });
    assert.equal(JSON.stringify(history.data.guilds.ignored), beforeIgnored);
    now += DAY;
    plugin.flux.MESSAGE_CREATE({ message: { author: { id: user }, channel_id: "dm", content: "https://cdn.discordapp.com/emojis/111.png", sticker_items: [{ id: "222" }] } });
    assert.equal(history.data.guilds["emoji-source"].emoji, now);
    assert.equal(history.data.guilds["sticker-source"].sticker, now);
    plugin.flux.MESSAGE_REACTION_ADD({ userId: user, channelId: "channel", emoji: { id: "111" } });
    plugin.flux.VOICE_CHANNEL_EFFECT_SEND({ userId: user, channelId: "channel", soundId: "333" });
    assert.equal(history.data.guilds["sound-source"].sound, now);
    plugin.flux.GUILD_DELETE({ guild: { id: "ignored", unavailable: true } });
    assert.ok(history.data.guilds.ignored, "temporary unavailability preserves history");

    const scans = guildScans;
    const began = performance.now();
    for (let i = 0; i < 10_000; i++) plugin.flux.EMOJI_TRACK_USAGE({ emojiUsed: [{ id: "111", guildId: "emoji-source" }] });
    console.log(`10,000 emoji usage events: ${(performance.now() - began).toFixed(1)} ms`);
    assert.equal(guildScans, scans, "resource use does not scan all guilds");
    assert.equal([...timers.values()].filter(timer => timer.delay === 60_000).length, 1, "activity bursts share one save timer");
    await fireTimers(60_000);
    assert.ok(stored.has("ServerReview:v1:account-a"));

    user = "account-b";
    plugin.flux.GUILD_DELETE({ guild: { id: "ignored" } });
    plugin.flux.GUILD_CREATE({ guild: { id: "other-account-only" } });
    assert.ok(history.data.guilds.ignored);
    assert.equal(history.data.guilds["other-account-only"], undefined, "membership events cannot alter the previous account before connection initialization");
    plugin.flux.CONNECTION_OPEN();
    await settle();
    const other = tracking.getHistory();
    assert.notEqual(other, history);
    assert.equal(tracking.isCurrent(history), false, "old UI actions are invalid after an account switch");
    assert.equal(other.data.guilds["emoji-source"].emoji, undefined);
    selected = "ignored";
    windowEvents.get("focus")!();
    assert.equal(other.data.guilds.ignored.visit, now);
    plugin.stop();
    await settle();
    assert.equal(timers.size, 0);
    assert.equal(windowEvents.size, 0);
    assert.equal(documentEvents.size, 0);
    assert.equal(sendListeners.size, 0);
    assert.equal(stored.get("ServerReview:v1:account-b")?.guilds.ignored.visit, now);
    assert.equal(stored.get("ServerReview:v1:account-a")?.guilds.ignored.visit, undefined);
    assert.equal(tracking.getHistory(), undefined);

    selected = null;
    user = "account-c";
    stored.set("ServerReview:v1:account-c", { version: 1, reminderAfter: 0, guilds: {
        visited: { since: now - 40 * DAY },
        "emoji-source": { since: now - 40 * DAY, emoji: now },
        "sticker-source": { since: now - 40 * DAY, keep: true },
        "sound-source": { since: now - 40 * DAY, sound: now },
        ignored: { since: now }
    } });
    test.folders = [{ folderName: "Emotes & sounds", guildIds: ["sound-source"] }];
    plugin.start();
    await settle();
    await fireTimers(15_000);
    assert.equal(notifications.length, 1);
    assert.match((notifications[0] as { body: string; }).body, /^2 servers/, "kept and already organized resource servers do not cause reminders");
    assert.equal(stored.get("ServerReview:v1:account-c")?.reminderAfter, now + 7 * DAY, "reminder cooldown is saved immediately");
    plugin.stop();
    await settle();

    user = "account-loading";
    const pending = deferred<HistoryData | undefined>();
    pendingReads.set("ServerReview:v1:account-loading", pending);
    plugin.start();
    plugin.flux.EMOJI_TRACK_USAGE({ emojiUsed: [{ id: "111", guildId: "emoji-source" }] });
    user = "account-next";
    plugin.flux.CONNECTION_OPEN();
    await settle();
    const current = tracking.getHistory();
    pending.resolve(undefined);
    await settle();
    assert.equal(tracking.getHistory(), current, "a late account load cannot replace the active account");
    assert.equal(stored.get("ServerReview:v1:account-loading")?.guilds["emoji-source"].emoji, now, "pending activity is saved to the old account after a late load");
    assert.equal(current.data.guilds["emoji-source"].emoji, undefined);
    plugin.stop();
    await settle();
    assert.equal(timers.size, 0);
}

async function main() {
    await historyChecks();
    folderChecks();
    await runtimeChecks();
    console.log("Server Review: history, storage retry, folder layout, and event checks passed.");
}

void main();
