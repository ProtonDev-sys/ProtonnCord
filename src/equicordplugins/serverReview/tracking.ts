/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { findStoreLazy } from "@webpack";
import { ChannelStore, EmojiStore, GuildStore, SelectedChannelStore, SelectedGuildStore, SoundboardStore, StickersStore, UserStore } from "@webpack/common";

import { ActivityHistory, ActivityKind, DAY, reviewGroup } from "./history";
import { settings } from "./settings";

const logger = new Logger("ServerReview");
export const SortedGuildStore = findStoreLazy("SortedGuildStore");
const histories = new Map<string, ActivityHistory>();
const listeners = new Set<() => void>();
let revision = 0;
let enabled = false;
let accountId: string | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let reminderTimer: ReturnType<typeof setTimeout> | undefined;
let openReview: (() => void) | undefined;
const reminded = new Set<string>();

export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getRevision = () => revision;
function emit() { revision++; listeners.forEach(listener => listener()); }
export function getHistory() { return accountId ? histories.get(accountId) : undefined; }
export function isCurrent(history: ActivityHistory) { return enabled && getHistory() === history && UserStore.getCurrentUser()?.id === accountId; }

async function save(history: ActivityHistory) {
    try { await history.flush(); }
    catch (error) { logger.error("Could not save activity", error); }
    if (isCurrent(history)) {
        emit();
        if (history.dirty) scheduleSave();
    }
}

export function changed(immediate = false) {
    emit();
    const history = getHistory();
    if (immediate && history?.ready) void save(history);
    else scheduleSave();
}

export async function retry() {
    await connect();
    const history = getHistory();
    if (history?.ready) await save(history);
}
function scheduleSave() {
    const history = getHistory();
    if (!enabled || !history?.ready || !history.dirty || saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        if (isCurrent(history)) void save(history);
    }, 60_000);
}

export function mark(guildId: string | null | undefined, kind: ActivityKind = "visit") {
    if (!enabled || !guildId || !GuildStore.getGuild(guildId)) return;
    const history = getHistory();
    if (!history || !isCurrent(history)) return;
    const now = Date.now();
    if (now - (history.data.guilds[guildId]?.[kind] ?? 0) < 60_000) return;
    history.record(guildId, kind, now);
    changed();
}

export function markChannel(channelId?: string | null) {
    if (channelId) mark(ChannelStore.getChannel(channelId)?.guild_id);
}

export function markSelected() {
    if (document.visibilityState !== "visible") return;
    mark(SelectedGuildStore.getGuildId());
    markChannel(SelectedChannelStore.getChannelId());
    markChannel(SelectedChannelStore.getVoiceChannelId());
}

export function emoji(id?: string) { if (id) mark(EmojiStore.getCustomEmojiById(id)?.guildId, "emoji"); }
export function sticker(id?: string) {
    const item = id && StickersStore.getStickerById(id);
    if (item && "guild_id" in item) mark(item.guild_id, "sticker");
}
export function sound(id?: string) { if (id) mark(SoundboardStore.getSoundById(id)?.guildId, "sound"); }

export function trackContent(content?: string, stickers?: Array<{ id: string; }>) {
    if (content) {
        for (const match of content.matchAll(/<a?:\w+:(\d+)>/g)) emoji(match[1]);
        // FakeNitro sends resources as CDN links. Keep their source servers too.
        for (const match of content.matchAll(/https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/(emojis|stickers)\/(\d+)/g))
            if (match[1] === "emojis") emoji(match[2]); else sticker(match[2]);
    }
    stickers?.forEach(item => sticker(item.id));
}

function clearTimers() {
    clearTimeout(saveTimer);
    clearTimeout(reminderTimer);
    saveTimer = reminderTimer = undefined;
}

export async function connect() {
    if (!enabled) return;
    const id = UserStore.getCurrentUser()?.id;
    if (!id) { disconnect(); return; }
    if (id !== accountId) {
        const previous = getHistory();
        clearTimers();
        if (previous) void save(previous);
        accountId = id;
        emit();
    }
    let history = histories.get(id);
    if (!history) {
        const key = `ServerReview:v1:${id}`;
        history = new ActivityHistory({ read: () => DataStore.get(key), write: data => DataStore.set(key, data) });
        histories.set(id, history);
    }
    markSelected();
    await history.load();
    if (!isCurrent(history)) { void save(history); return; }
    if (history.ready) {
        const guilds = GuildStore.getGuilds();
        const now = Date.now();
        for (const id of Object.keys(guilds)) history.ensure(id, now);
        markSelected();
        if (!reminded.has(id) && !reminderTimer) reminderTimer = setTimeout(() => {
            reminderTimer = undefined;
            if (!isCurrent(history) || !history.ready) return;
            reminded.add(id);
            if (!settings.store.startupReminder || history.data.reminderAfter > Date.now()) return;
            markSelected();
            const organized = new Set<string>(SortedGuildStore.getGuildFolders()
                .filter(folder => folder.folderName === settings.store.folderName.trim())
                .flatMap(folder => folder.guildIds));
            const candidates = Object.values(GuildStore.getGuilds()).filter(guild => {
                const record = history.data.guilds[guild.id];
                if (!record) return false;
                const group = reviewGroup(record, settings.store.days, Date.now());
                return group === "unused" || group === "resources" && !organized.has(guild.id);
            });
            if (!candidates.length) return;
            history.snooze(Date.now() + 7 * DAY);
            changed(true);
            showNotification({
                title: "Servers to review",
                body: `${candidates.length} ${candidates.length === 1 ? "server hasn't" : "servers haven't"} been opened in ${settings.store.days} days. Review activity before leaving or moving them to a folder.`,
                noPersist: true,
                onClick: () => { if (isCurrent(history)) openReview?.(); }
            });
        }, 15_000);
    }
    changed();
}

export function disconnect() {
    const history = getHistory();
    clearTimers();
    accountId = undefined;
    if (history) void save(history);
    emit();
}

function visibilityChanged() {
    if (document.visibilityState === "hidden") {
        const history = getHistory();
        if (history) void save(history);
    } else markSelected();
}

function flushCurrent() {
    const history = getHistory();
    if (history) void save(history);
}

export function start(review: () => void) {
    enabled = true;
    openReview = review;
    window.addEventListener("focus", markSelected);
    window.addEventListener("pagehide", flushCurrent);
    document.addEventListener("visibilitychange", visibilityChanged);
    void connect();
}

export function stop() {
    enabled = false;
    openReview = undefined;
    window.removeEventListener("focus", markSelected);
    window.removeEventListener("pagehide", flushCurrent);
    document.removeEventListener("visibilitychange", visibilityChanged);
    disconnect();
}
