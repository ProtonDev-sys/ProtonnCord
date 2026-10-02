/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { VoiceChannelLogEntry } from "./types";

const vcLogs = new Map<string, VoiceChannelLogEntry[]>();
const MAX_CHANNELS = 100;
const MAX_ENTRIES_PER_CHANNEL = 1000;
let vcLogSubscriptions: (() => void)[] = [];

let callStartTime: Date | null = null;

export function getCallStartTime(): Date | null {
    return callStartTime;
}

export function setCallStartTime(time: Date | null) {
    callStartTime = time;
}

const EMPTY_LOGS: VoiceChannelLogEntry[] = [];

export function getVcLogs(channelId?: string): VoiceChannelLogEntry[] {
    if (!channelId) return EMPTY_LOGS;
    return vcLogs.get(channelId) ?? EMPTY_LOGS;
}

export function addLogEntry(entry: VoiceChannelLogEntry) {
    const existing = vcLogs.get(entry.channelId) ?? [];
    vcLogs.delete(entry.channelId);
    vcLogs.set(entry.channelId, [...existing.slice(-(MAX_ENTRIES_PER_CHANNEL - 1)), entry]);
    if (vcLogs.size > MAX_CHANNELS) vcLogs.delete(vcLogs.keys().next().value!);
    vcLogSubscriptions.forEach(fn => fn());
}

export function clearLogs(channelId?: string) {
    if (!channelId) return;
    vcLogs.delete(channelId);
    vcLogSubscriptions.forEach(fn => fn());
}

export function vcLogSubscribe(listener: () => void) {
    vcLogSubscriptions = [...vcLogSubscriptions, listener];
    return () => {
        vcLogSubscriptions = vcLogSubscriptions.filter(l => l !== listener);
    };
}
