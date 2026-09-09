/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { RobotIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Menu, showToast, Toasts, UserStore } from "@webpack/common";

import { settings } from "./settings";
import { getPayload, getResponse, handleResponse } from "./utils";

let generation = 0;
let active = false;

async function answerMessage(message: Message) {
    const userId = UserStore.getCurrentUser()?.id;
    const currentGeneration = generation;
    const { mode } = settings.store;
    const current = () => active && generation === currentGeneration && userId && UserStore.getCurrentUser()?.id === userId;
    if (!current()) return;
    try {
        const payload = await getPayload(message);
        if (!payload || !current()) return;
        const answer = await getResponse(payload);
        if (current()) await handleResponse(message, answer, mode);
    } catch {
        if (current()) showToast("TriviaAI could not complete this answer.", Toasts.Type.FAILURE);
    }
}

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!message.content.trim() && !message.embeds.length && (!settings.store.supportImages || !message.attachments.some(att => att.content_type?.startsWith("image/")))) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-trivia-ai"
            label="Answer With AI"
            icon={RobotIcon}
            action={() => answerMessage(message)}
        />
    ));
};

export default definePlugin({
    name: "TriviaAI",
    description: "A plugin that helps you answer trivia questions using AI.",
    dependencies: ["MessagePopoverAPI"],
    tags: ["Appearance", "Customisation", "Fun"],
    authors: [EquicordDevs.yash],
    settings,
    start() { active = true; generation++; },
    stop() { active = false; generation++; },
    contextMenus: {
        "message": messageCtxPatch
    },
    messagePopoverButton: {
        icon: RobotIcon,
        render(message: Message) {
            if (!message.content.trim() && !message.embeds.length && (!settings.store.supportImages || !message.attachments.some(att => att.content_type?.startsWith("image/")))) return null;

            return {
                label: "Answer With AI",
                icon: RobotIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: () => answerMessage(message)
            };
        }
    }
});
