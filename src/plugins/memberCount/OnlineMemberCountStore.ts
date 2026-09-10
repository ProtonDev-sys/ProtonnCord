/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazy } from "@utils/lazy";
import { sleep } from "@utils/misc";
import { Queue } from "@utils/Queue";
import { ChannelActionCreators, Flux, FluxDispatcher, GuildChannelStore } from "@webpack/common";

export const OnlineMemberCountStore = proxyLazy(() => {
    let preloadQueue = new Queue();
    let generation = 0;
    let active = false;
    let enabled = false;

    const onlineMemberMap = new Map<string, number>();
    const pendingPreloads = new Set<string>();

    function resetCounts() {
        generation++;
        onlineMemberMap.clear();
        pendingPreloads.clear();
        preloadQueue = new Queue();
    }

    class OnlineMemberCountStore extends Flux.Store {
        start() {
            resetCounts();
            enabled = true;
            active = true;
            this.emitChange();
        }

        stop() {
            active = false;
            enabled = false;
            resetCounts();
            this.emitChange();
        }

        getCount(guildId?: string) {
            if (!guildId) return undefined;
            return onlineMemberMap.get(guildId);
        }

        async _ensureCount(guildId: string) {
            if (onlineMemberMap.has(guildId)) return;
            const defaultChannel = GuildChannelStore.getDefaultChannel(guildId);
            if (!defaultChannel) return;

            await ChannelActionCreators.preload(guildId, defaultChannel.id);
        }

        ensureCount(guildId?: string) {
            if (!active || !guildId || onlineMemberMap.has(guildId) || pendingPreloads.has(guildId)) return;

            const requestGeneration = generation;
            pendingPreloads.add(guildId);
            preloadQueue.push(() => {
                if (!active || requestGeneration !== generation) return;
                return this._ensureCount(guildId)
                    .finally(() => {
                        if (requestGeneration === generation) pendingPreloads.delete(guildId);
                    })
                    .then(
                        () => sleep(200),
                        () => sleep(200)
                    );
            });
        }
    }

    return new OnlineMemberCountStore(FluxDispatcher, {
        LOGOUT() {
            active = false;
            resetCounts();
        },
        CONNECTION_OPEN() {
            active = enabled;
            resetCounts();
        },
        GUILD_MEMBER_LIST_UPDATE({ guildId, groups }: { guildId: string, groups: { count: number; id: string; }[]; }) {
            if (!active) return false;
            onlineMemberMap.set(
                guildId,
                groups.reduce((total, curr) => total + (curr.id === "offline" ? 0 : curr.count), 0)
            );
            pendingPreloads.delete(guildId);
        },
        ONLINE_GUILD_MEMBER_COUNT_UPDATE({ guildId, count }) {
            if (!active) return false;
            onlineMemberMap.set(guildId, count);
            pendingPreloads.delete(guildId);
        }
    });
});
