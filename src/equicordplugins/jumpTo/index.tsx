/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Channel, Message, User } from "@vencord/discord-types";
import { ChannelStore, Constants, Menu, NavigationRouter, RestAPI, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

let navigationGeneration = 0;

function jumpToFirstMessage(channelId: string, guildId?: string | null) {
    navigationGeneration++;
    NavigationRouter.transitionTo(`/channels/${guildId ?? "@me"}/${channelId}/0`);
}

async function jumpToLastMessage(channelId: string, guildId?: string | null) {
    const generation = ++navigationGeneration;
    const accountId = UserStore.getCurrentUser()?.id;
    try {
        const res = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: { limit: 1 }
        });
        if (generation !== navigationGeneration || accountId !== UserStore.getCurrentUser()?.id) return;
        const messageId = res.body?.[0]?.id;
        if (!messageId) return;
        NavigationRouter.transitionTo(`/channels/${guildId ?? "@me"}/${channelId}/${messageId}`);
    } catch {
        if (generation === navigationGeneration) Toasts.show({ type: Toasts.Type.FAILURE, message: "Failed to find the last message.", id: Toasts.genId() });
    }
}

async function jumpToUserMessage(channelId: string, guildId: string, userId: string, first: boolean) {
    const generation = ++navigationGeneration;
    const accountId = UserStore.getCurrentUser()?.id;
    try {
        const res = await RestAPI.get({
            url: Constants.Endpoints.SEARCH_GUILD(guildId),
            query: {
                author_id: userId,
                channel_id: channelId,
                sort_by: "timestamp",
                sort_order: first ? "asc" : "desc"
            }
        });

        if (generation !== navigationGeneration || accountId !== UserStore.getCurrentUser()?.id) return;
        const results: Message[] = res.body?.messages?.flat?.() ?? [];
        const messageId = results.find(message => message.author?.id === userId && message.channel_id === channelId && (message as Message & { hit?: boolean; }).hit)?.id
            ?? results.find(message => message.author?.id === userId && message.channel_id === channelId)?.id;
        if (!messageId) {
            Toasts.show({
                type: Toasts.Type.FAILURE,
                message: "No messages found from this user in this channel.",
                id: Toasts.genId()
            });
            return;
        }

        NavigationRouter.transitionTo(`/channels/${guildId}/${channelId}/${messageId}`);
    } catch (e) {
        if (generation !== navigationGeneration || accountId !== UserStore.getCurrentUser()?.id) return;
        Toasts.show({
            type: Toasts.Type.FAILURE,
            message: "Failed to search for messages.",
            id: Toasts.genId()
        });
    }
}

const ChannelMenuPatch: NavContextMenuPatchCallback = (
    children,
    { channel, thread }: { channel?: Channel; thread?: Channel; }
) => {
    const selectedId = SelectedChannelStore.getChannelId();
    const selectedChannel = selectedId ? ChannelStore.getChannel(selectedId) : null;
    const forumChild = channel?.isForumLikeChannel?.() && selectedChannel?.isThread?.() && selectedChannel.parent_id === channel.id
        ? selectedChannel
        : null;
    const targetChannel = thread ?? forumChild ?? channel;
    if (!targetChannel) return;

    children.push(
        <Menu.MenuItem
            id="vc-jump-to-first"
            label="Jump To First Message"
            action={() => jumpToFirstMessage(targetChannel.id, targetChannel.guild_id)}
        />,
        <Menu.MenuItem
            id="vc-jump-to-last"
            label="Jump To Last Message"
            action={() => jumpToLastMessage(targetChannel.id, targetChannel.guild_id)}
        />
    );
};

const UserMenuPatch: NavContextMenuPatchCallback = (children, { user, channel }: { user: User; channel?: Channel; }) => {
    if (!user) return;
    if (!channel || channel.guild_id) return;
    children.push(
        <Menu.MenuItem
            id="vc-jump-to-first"
            label="Jump To First Message"
            action={() => jumpToFirstMessage(channel.id, null)}
        />,
        <Menu.MenuItem
            id="vc-jump-to-last"
            label="Jump To Last Message"
            action={() => jumpToLastMessage(channel.id, null)}
        />
    );
};

const MessageMenuPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!message) return;
    const channelId = message.channel_id;
    const guildId = ChannelStore.getChannel(channelId)?.guild_id;
    if (!channelId || !guildId) return;
    children.push(
        <Menu.MenuItem
            id="vc-jump-to-first-user"
            label="Jump To First Message"
            action={() => jumpToUserMessage(channelId, guildId, message.author.id, true)}
        />,
        <Menu.MenuItem
            id="vc-jump-to-last-user"
            label="Jump To Last Message"
            action={() => jumpToUserMessage(channelId, guildId, message.author.id, false)}
        />
    );
};

export default definePlugin({
    name: "JumpTo",
    description: "Adds context menu options to jump to the start or bottom of a channel/DM.",
    tags: ["Chat", "Utility"],
    authors: [Devs.Samwich, Devs.thororen],
    stop() {
        navigationGeneration++;
    },
    contextMenus: {
        "channel-context": ChannelMenuPatch,
        "gdm-context": ChannelMenuPatch,
        "thread-context": ChannelMenuPatch,
        "user-context": UserMenuPatch,
        "message": MessageMenuPatch
    }
});
