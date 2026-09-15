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

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Menu, UserStore } from "@webpack/common";

import { settings } from "./settings";
import { setShouldShowTranslateEnabledTooltip, TranslateChatBarIcon, TranslateIcon } from "./TranslateIcon";
import { handleTranslate, TranslationAccessory } from "./TranslationAccessory";
import { translate } from "./utils";

let active = false;
let generation = 0;

async function translateMessage(message: Message, content: string) {
    if (!active) return;
    const currentGeneration = generation;
    const accountId = UserStore.getCurrentUser()?.id;
    try {
        const trans = await translate("received", content);
        if (active && generation === currentGeneration && accountId === UserStore.getCurrentUser()?.id)
            handleTranslate(message.id, trans);
    } catch {
        // translate() already reports provider failures to the user.
    }
}

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const content = getMessageContent(message);
    if (!content) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-trans"
            label="Translate"
            icon={TranslateIcon}
            action={() => translateMessage(message, content)}
        />
    ));
};

function getMessageContent(message: Message) {
    // Message snapshots is an array, which allows for nested snapshots, which Discord does not do yet.
    // no point collecting content or rewriting this to render in a certain way that makes sense
    // for something currently impossible.
    return message.content
        || message.messageSnapshots?.[0]?.message.content
        || message.embeds?.find(embed => embed.type === "auto_moderation_message")?.rawDescription || "";
}

let tooltipTimeout: ReturnType<typeof setTimeout> | undefined;

function clearTranslateTooltipTimeout() {
    if (tooltipTimeout === undefined) return;

    clearTimeout(tooltipTimeout);
    tooltipTimeout = undefined;
}

export default definePlugin({
    name: "Translate",
    description: "Translate messages with Google Translate, DeepL or Kagi.",
    dependencies: ["ChatInputButtonAPI", "MessageAccessoriesAPI", "MessagePopoverAPI"],
    tags: ["Chat", "Utility"],
    authors: [Devs.Ven, Devs.AshtonMemer, Devs.koish1],
    settings,
    contextMenus: {
        "message": messageCtxPatch
    },
    // not used, just here in case some other plugin wants it or w/e
    translate,

    start() {
        active = true;
        generation++;
    },

    renderMessageAccessory: props => <TranslationAccessory message={props.message} />,

    chatBarButton: {
        icon: TranslateIcon,
        render: TranslateChatBarIcon
    },

    messagePopoverButton: {
        icon: TranslateIcon,
        render(message: Message) {
            const content = getMessageContent(message);
            if (!content) return null;

            return {
                label: "Translate",
                icon: TranslateIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: () => translateMessage(message, content)
            };
        }
    },

    async onBeforeMessageSend(_, message) {
        if (!active || !settings.store.autoTranslate) return;
        if (!message.content) return;
        const currentGeneration = generation;
        const accountId = UserStore.getCurrentUser()?.id;
        const { content } = message;

        setShouldShowTranslateEnabledTooltip?.(true);
        clearTranslateTooltipTimeout();
        tooltipTimeout = setTimeout(() => {
            tooltipTimeout = undefined;
            setShouldShowTranslateEnabledTooltip?.(false);
        }, 2000);

        const trans = await translate("sent", content);
        if (!active || generation !== currentGeneration || accountId !== UserStore.getCurrentUser()?.id || message.content !== content)
            return { cancel: true };
        message.content = trans.text;
    },

    stop() {
        active = false;
        generation++;
        clearTranslateTooltipTimeout();
        setShouldShowTranslateEnabledTooltip?.(false);
    }
});
