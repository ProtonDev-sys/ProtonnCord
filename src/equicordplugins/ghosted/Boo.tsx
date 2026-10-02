/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Channel } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { MessageStore, useEffect, UserStore, useState, useStateFromStores } from "@webpack/common";

import { cl, settings } from ".";
import { IconGhost } from "./IconGhost";

let exemptedSource: string | undefined;
let exemptedIds = new Set<string>();

function isChannelExempted(channel: Channel): boolean {
    const source = settings.store.exemptedChannels;
    if (source !== exemptedSource) {
        exemptedSource = source;
        exemptedIds = new Set(source.split(",").map(id => id.trim()).filter(Boolean));
    }
    const isGroupDmsExempted = settings.store.ignoreGroupDms && channel.isGroupDM();

    return exemptedIds.has(channel.id) || isGroupDmsExempted;
}

const countedChannels = new Set<string>();
// track channels that were manually cleared and the message ID at time of clear
const clearedChannels = new Map<string, string>();
// listeners for when a channel is cleared or un-cleared (thororen is this allowed lolz)
const clearedChannelListeners = new Set<(channelId: string) => void>();

let _booCount = 0;
const listeners = new Set<(n: number) => void>();
const expiryTimers = new Set<ReturnType<typeof setTimeout>>();
const trackingListeners = new Set<() => void>();
let trackingVersion = 0;
let trackingAccountId: string | undefined;
let trackingStopped = false;

function resetGhostTracking() {
    const channelIds = new Set([...countedChannels, ...clearedChannels.keys()]);
    countedChannels.clear();
    clearedChannels.clear();
    for (const timer of expiryTimers) clearTimeout(timer);
    expiryTimers.clear();
    trackingVersion++;
    setBooCount(0);
    for (const listener of trackingListeners) listener();
    for (const channelId of channelIds) {
        for (const listener of clearedChannelListeners) listener(channelId);
    }
}

export function syncGhostAccount() {
    const accountId = UserStore.getCurrentUser()?.id;
    if (accountId === trackingAccountId) return;
    trackingAccountId = accountId;
    resetGhostTracking();
}

export function startGhostTracking() {
    trackingStopped = false;
    syncGhostAccount();
}

export function stopGhostTracking() {
    trackingStopped = true;
    trackingAccountId = undefined;
    resetGhostTracking();
}

export function getBooCount() {
    return _booCount;
}

export function setBooCount(n: number) {
    _booCount = n;
    for (const l of listeners) l(_booCount);
}

export function onBooCountChange(cb: (n: number) => void) {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function onClearedChannelChange(cb: (channelId: string) => void) {
    clearedChannelListeners.add(cb);
    return () => {
        clearedChannelListeners.delete(cb);
    };
}

export function getGhostedChannels(): string[] {
    return Array.from(countedChannels);
}

export function clearChannelFromGhost(channelId: string): void {
    if (!countedChannels.has(channelId)) {
        return;
    }
    countedChannels.delete(channelId);
    setBooCount(getBooCount() - 1);

    // so we can detect new messages from the other person
    const lastMessage = MessageStore.getMessages(channelId)?.last();
    if (lastMessage) {
        clearedChannels.set(channelId, lastMessage.id);
    }

    // notify all listeners that this channel was cleared
    for (const listener of clearedChannelListeners) {
        listener(channelId);
    }

}

export function isChannelCleared(channelId: string): boolean {
    return clearedChannels.has(channelId);
}

const ChannelWrapperStyles = findCssClassesLazy("muted", "wrapper");

export function Boo({ channel }: { channel: Channel; }) {
    const { id } = channel;
    const { exemptedChannels, ignoreGroupDms, ignoreBots, maxInactiveTimeMs } = settings.use([
        "exemptedChannels", "ignoreGroupDms", "ignoreBots", "maxInactiveTimeMs", "showDmIcons"
    ]);

    const currentUserId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const lastMessage = useStateFromStores([MessageStore], () => MessageStore.getMessages(id)?.last());
    const state = {
        isCurrentUser: lastMessage?.author.id === currentUserId,
        containsQuestionMark: lastMessage?.author.id !== currentUserId && !!lastMessage?.content.includes("?"),
        isDataProcessed: !!lastMessage && !!currentUserId,
    };
    const [isCleared, setIsCleared] = useState(() => clearedChannels.has(id));
    const [, wakeForExpiry] = useState(0);

    const lastMessageTimestampMs = lastMessage ? new Date(lastMessage.timestamp).getTime() : 0;
    const isInactive = !!lastMessage && maxInactiveTimeMs > 0 && Number.isFinite(lastMessageTimestampMs) && Date.now() - lastMessageTimestampMs > maxInactiveTimeMs;

    useEffect(() => {
        const listener = () => wakeForExpiry(value => value + 1);
        trackingListeners.add(listener);
        return () => { trackingListeners.delete(listener); };
    }, []);

    useEffect(() => {
        syncGhostAccount();
    }, [currentUserId]);

    useEffect(() => {
        if (trackingStopped || !currentUserId || !lastMessage || maxInactiveTimeMs <= 0 || !Number.isFinite(lastMessageTimestampMs)) return;
        let timer: ReturnType<typeof setTimeout>;
        const deadline = lastMessageTimestampMs + maxInactiveTimeMs + 1;
        const schedule = () => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                wakeForExpiry(value => value + 1);
                return;
            }
            timer = setTimeout(() => {
                expiryTimers.delete(timer);
                if (!trackingStopped && currentUserId === UserStore.getCurrentUser()?.id) schedule();
            }, Math.min(remaining, 2147483647));
            expiryTimers.add(timer);
        };
        if (!isInactive) schedule();
        return () => {
            clearTimeout(timer);
            expiryTimers.delete(timer);
        };
    }, [id, lastMessage?.id, lastMessageTimestampMs, maxInactiveTimeMs, currentUserId, trackingVersion]);

    // track if this channel was manually cleared
    useEffect(() => {
        setIsCleared(clearedChannels.has(id));

        // subscribe to cleared channel changes for instant visual updates
        const unsubscribe = onClearedChannelChange(clearedChannelId => {
            if (clearedChannelId === id) {
                // check current state: if it's still in clearedChannels, it was cleared; otherwise un-cleared
                setIsCleared(clearedChannels.has(id));
            }
        });

        return unsubscribe;
    }, [id, lastMessage?.id]);

    useEffect(() => {
        if (trackingStopped || currentUserId !== UserStore.getCurrentUser()?.id || !state.isDataProcessed || !lastMessage) return;

        const isExempted = isChannelExempted(channel);
        let wasManuallyCleared = clearedChannels.has(id);

        // if manually cleared, check if there's a NEW message from the other person
        if (wasManuallyCleared && !state.isCurrentUser) {
            const clearedAtMessageId = clearedChannels.get(id);
            const currentLastMessageId = lastMessage?.id;

            // if it's the same message, stay cleared (don't re-ghost)
            if (clearedAtMessageId === currentLastMessageId) {
                return;
            }

            // if there's a NEW message from the OTHER person, remove from cleared state
            // so it can be re-ghosted
            if (currentLastMessageId !== clearedAtMessageId) {
                clearedChannels.delete(id);
                wasManuallyCleared = false; // update the flag since we deleted it
                // notify listeners that this channel is no longer cleared (new message)
                for (const listener of clearedChannelListeners) {
                    listener(id);
                }
            }
        }

        // if the current user responded, clear all tracking
        if (state.isCurrentUser) {
            if (countedChannels.has(id)) {
                countedChannels.delete(id);
                setBooCount(getBooCount() - 1);
            }
            if (clearedChannels.has(id)) {
                clearedChannels.delete(id);
            }
            return;
        }

        // if exempted or bot (if setting enabled), remove from ghost tracking
        if (isExempted || (settings.store.ignoreBots && lastMessage.author.bot) || isInactive) {
            if (countedChannels.has(id)) {
                countedChannels.delete(id);
                setBooCount(getBooCount() - 1);
            }
            return;
        }

        // if manually cleared, don't add back to ghost count
        if (wasManuallyCleared) {
            return;
        }

        // normal ghosting logic: last message is from other person
        if (!state.isCurrentUser) {
            if (!countedChannels.has(id)) {
                countedChannels.add(id);
                setBooCount(getBooCount() + 1);
            }
        }
    }, [state.isCurrentUser, state.isDataProcessed, currentUserId, id, lastMessage?.id, isInactive, exemptedChannels, ignoreGroupDms, ignoreBots, trackingVersion]);

    if (trackingStopped || !state.isDataProcessed || !currentUserId || !lastMessage || state.isCurrentUser || isChannelExempted(channel) || isCleared || (settings.store.ignoreBots && lastMessage.author.bot) || isInactive)
        return null;

    if (!settings.store.showDmIcons) return null;

    return (
        <div className={cl("icon", ChannelWrapperStyles.wrapper)}>
            <IconGhost fill={state.containsQuestionMark ? "#ff8000" : "currentColor"} />
        </div>
    );
}
