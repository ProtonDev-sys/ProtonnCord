/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as DataStore from "@api/DataStore";
import { popNotice, showNotice } from "@api/Notices";
import { showNotification } from "@api/Notifications";
import { getUniqueUsername, openUserProfile } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { ChannelType, RelationshipType } from "@vencord/discord-types/enums";
import { ChannelStore, GuildAvailabilityStore, GuildMemberStore, GuildStore, RelationshipStore, UserStore, UserUtils } from "@webpack/common";

import settings from "./settings";
import { SimpleGroupChannel, SimpleGuild } from "./types";

const guilds = new Map<string, SimpleGuild>();
const groups = new Map<string, SimpleGroupChannel>();
const friends = {
    friends: [] as string[],
    requests: [] as string[]
};

const LEGACY_DATASTORE_KEYS = ["relationship-notifier-guilds", "relationship-notifier-groups", "relationship-notifier-friends"];
let migrationsRun = false;
let active = false;
let generation = 0;
let syncRequest = 0;
const logger = new Logger("RelationshipNotifier");

export function resetState(enabled = active) {
    active = enabled;
    generation++;
    guilds.clear();
    groups.clear();
    friends.friends = [];
    friends.requests = [];
}

export function getContext() {
    return { generation, userId: UserStore.getCurrentUser()?.id };
}

export function isCurrentContext(context: ReturnType<typeof getContext>) {
    return active && context.generation === generation && context.userId != null && context.userId === UserStore.getCurrentUser()?.id;
}

function logPersistenceError(error: unknown) {
    logger.error("Could not synchronize relationship state", error);
}

const guildsKey = (userId: string) => `relationship-notifier-guilds-${userId}`;
const groupsKey = (userId: string) => `relationship-notifier-groups-${userId}`;
const friendsKey = (userId: string) => `relationship-notifier-friends-${userId}`;

async function runMigrations() {
    if (migrationsRun) return;

    await DataStore.delMany(LEGACY_DATASTORE_KEYS);
    migrationsRun = true;
}

export async function syncAndRunChecks() {
    try {
        await syncAndRunChecksInternal();
    } catch (error) {
        logPersistenceError(error);
    }
}

async function syncAndRunChecksInternal() {
    const context = getContext();
    if (!isCurrentContext(context)) return;
    const request = ++syncRequest;
    const isCurrent = () => request === syncRequest && isCurrentContext(context);
    try {
        await runMigrations();
    } catch (error) {
        logPersistenceError(error);
        return;
    }
    if (!isCurrent()) return;
    const currentUserId = context.userId!;

    const previous = await DataStore.getMany([
        guildsKey(currentUserId),
        groupsKey(currentUserId),
        friendsKey(currentUserId)
    ]).catch(logPersistenceError);
    if (!previous || !isCurrent()) return;
    const [oldGuilds, oldGroups, oldFriends] = previous as [Map<string, SimpleGuild> | undefined, Map<string, SimpleGroupChannel> | undefined, Record<"friends" | "requests", string[]> | undefined];

    await Promise.all([syncGuildsForUser(currentUserId), syncGroupsForUser(currentUserId), syncFriendsForUser(currentUserId)]);
    if (!isCurrent()) return;

    if (settings.store.offlineRemovals) {
        if (settings.store.groups && oldGroups instanceof Map && oldGroups.size) {
            for (const [id, group] of oldGroups) {
                if (!groups.has(id))
                    notify(`You are no longer in the group ${group.name}.`, group.iconURL);
            }
        }

        if (settings.store.servers && oldGuilds instanceof Map && oldGuilds.size) {
            for (const [id, guild] of oldGuilds) {
                if (!guilds.has(id) && !GuildAvailabilityStore.isUnavailable(id))
                    notify(`You are no longer in the server ${guild.name}.`, guild.iconURL);
            }
        }

        if (settings.store.friends && Array.isArray(oldFriends?.friends)) {
            for (const id of oldFriends.friends) {
                if (friends.friends.includes(id)) continue;

                const user = await UserUtils.getUser(id).catch(() => void 0);
                if (!isCurrent()) return;
                if (user)
                    notify(
                        `You are no longer friends with ${getUniqueUsername(user)}.`,
                        user.getAvatarURL(undefined, undefined, false),
                        () => openUserProfile(user.id)
                    );
            }
        }

        if (settings.store.friendRequestCancels && Array.isArray(oldFriends?.requests)) {
            for (const id of oldFriends.requests) {
                if (
                    friends.requests.includes(id) ||
                    [RelationshipType.FRIEND, RelationshipType.BLOCKED, RelationshipType.OUTGOING_REQUEST].includes(RelationshipStore.getRelationshipType(id))
                ) continue;

                const user = await UserUtils.getUser(id).catch(() => void 0);
                if (!isCurrent()) return;
                if (user)
                    notify(
                        `Friend request from ${getUniqueUsername(user)} has been revoked.`,
                        user.getAvatarURL(undefined, undefined, false),
                        () => openUserProfile(user.id)
                    );
            }
        }
    }
}

export function notify(text: string, icon?: string, onClick?: () => void) {
    if (!active) return;
    if (settings.store.notices)
        showNotice(text, "OK", () => popNotice());

    showNotification({
        title: "Relationship Notifier",
        body: text,
        icon,
        onClick
    });
}

export function getGuild(id: string) {
    return guilds.get(id);
}

export function deleteGuild(id: string) {
    guilds.delete(id);
    syncGuilds();
}

export async function syncGuilds() {
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!active || !currentUserId) return;

    return syncGuildsForUser(currentUserId).catch(logPersistenceError);
}

async function syncGuildsForUser(userId: string) {
    guilds.clear();

    for (const [id, { name, icon }] of Object.entries(GuildStore.getGuilds())) {
        if (GuildMemberStore.isMember(id, userId))
            guilds.set(id, {
                id,
                name,
                iconURL: icon && `https://cdn.discordapp.com/icons/${id}/${icon}.png`
            });
    }
    await DataStore.set(guildsKey(userId), new Map(guilds)).catch(logPersistenceError);
}

export function getGroup(id: string) {
    return groups.get(id);
}

export function deleteGroup(id: string) {
    groups.delete(id);
    syncGroups();
}

export async function syncGroups() {
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!active || !currentUserId) return;

    return syncGroupsForUser(currentUserId).catch(logPersistenceError);
}

async function syncGroupsForUser(userId: string) {
    groups.clear();

    for (const { type, id, name, rawRecipients, icon } of ChannelStore.getSortedPrivateChannels()) {
        if (type === ChannelType.GROUP_DM) {
            let fallbackName = "";
            for (const recipient of rawRecipients) {
                if (fallbackName) fallbackName += ", ";
                fallbackName += recipient.username;
            }

            groups.set(id, {
                id,
                name: name || fallbackName,
                iconURL: icon && `https://cdn.discordapp.com/channel-icons/${id}/${icon}.png`
            });
        }
    }

    await DataStore.set(groupsKey(userId), new Map(groups)).catch(logPersistenceError);
}

export async function syncFriends() {
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!active || !currentUserId) return;

    return syncFriendsForUser(currentUserId).catch(logPersistenceError);
}

async function syncFriendsForUser(userId: string) {
    friends.friends = [];
    friends.requests = [];

    const relationShips = RelationshipStore.getMutableRelationships();
    for (const [id, type] of relationShips) {
        switch (type) {
            case RelationshipType.FRIEND:
                friends.friends.push(id);
                break;
            case RelationshipType.INCOMING_REQUEST:
                friends.requests.push(id);
                break;
        }
    }

    await DataStore.set(friendsKey(userId), { friends: [...friends.friends], requests: [...friends.requests] }).catch(logPersistenceError);
}
