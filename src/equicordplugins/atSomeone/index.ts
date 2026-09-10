/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMessagePreSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelStore, GuildMemberStore } from "@webpack/common";

export default definePlugin({
    name: "AtSomeone",
    authors: [Devs.Joona],
    description: "Mention someone randomly",
    tags: ["Chat", "Fun"],
    patches: [
        {
            find: ".LAUNCHABLE_APPLICATIONS;",
            replacement: [
                {
                    match: /&(\i)\(\)\((\i),\i\(\)\.test\)&&(\i)\.push\(\i\(\)\)/g,
                    replace: "$&,$1()($2,/someone/.test)&&$3.push({text:'@someone',description:'Mention someone randomly'})"
                },
            ],
        },
        {
            find: "inQuote:",
            replacement: {
                match: /\|here/,
                replace: "$&|someone"
            }
        }
    ],
    start() {
        this.preSend = addMessagePreSendListener((channelId, msg) => {
            msg.content = msg.content.replace(/@someone/g, match => {
                const userId = randomUser(channelId);
                return userId ? `<@${userId}>` : match;
            });
        });
    },

    stop() {
        removeMessagePreSendListener(this.preSend);
    }
});

const randomUser = (channelId: string) => {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;
    if (!channel.guild_id) {
        const dmUsers = channel.recipients ?? [];
        return dmUsers[Math.floor(dmUsers.length * Math.random())];
    }
    const members = GuildMemberStore.getMembers(channel.guild_id);
    return members[Math.floor(members.length * Math.random())]?.userId;
};
