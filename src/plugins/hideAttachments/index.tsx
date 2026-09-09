/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
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

import { get, set } from "@api/DataStore";
import { updateMessage } from "@api/MessageUpdater";
import { migratePluginSettings } from "@api/Settings";
import { ImageInvisible, ImageVisible } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Toasts } from "@webpack/common";

const KEY = "HideMedia_HiddenIds";

let hiddenMessages = new Set<string>();
let hiddenMessagesLoaded = false;
let hiddenMessagesLoad: Promise<Set<string>> | null = null;
let hiddenMessagesWrite = Promise.resolve();
let lifecycleGeneration = 0;

async function getHiddenMessages() {
    if (hiddenMessagesLoaded) return hiddenMessages;

    if (hiddenMessagesLoad) return hiddenMessagesLoad;

    const generation = lifecycleGeneration;
    const pending = get(KEY)
        .then(stored => {
            const loaded = new Set<string>(Array.isArray(stored) ? stored.filter(id => typeof id === "string") : []);
            if (generation === lifecycleGeneration) {
                hiddenMessages = loaded;
                hiddenMessagesLoaded = true;
            }
            return loaded;
        })
        .finally(() => {
            if (hiddenMessagesLoad === pending) hiddenMessagesLoad = null;
        });

    return hiddenMessagesLoad = pending;
}

const saveHiddenMessages = (ids: Set<string>) => set(KEY, [...ids]);

migratePluginSettings("HideMedia", "HideAttachments");

const hasMedia = (msg: Message) => !!(msg.attachments?.length || msg.embeds?.length || msg.stickerItems?.length || msg.components?.length);

function toggleHide(channelId: string, messageId: string) {
    const generation = lifecycleGeneration;
    hiddenMessagesWrite = hiddenMessagesWrite.then(async () => {
        if (generation !== lifecycleGeneration) return;
        const ids = new Set(await getHiddenMessages());
        if (generation !== lifecycleGeneration) return;
        if (!ids.delete(messageId)) ids.add(messageId);

        await saveHiddenMessages(ids);
        if (generation !== lifecycleGeneration) return;
        hiddenMessages = ids;
        updateMessage(channelId, messageId);
    }).catch(error => {
        new Logger("HideMedia").error("Failed to save hidden media", error);
        if (generation !== lifecycleGeneration) return;
        Toasts.show({ id: Toasts.genId(), message: "Could not save media visibility. Please try again.", type: Toasts.Type.FAILURE });
    });
    return hiddenMessagesWrite;
}

export default definePlugin({
    name: "HideMedia",
    description: "Hide attachments and embeds for individual messages via hover button",
    tags: ["Chat", "Appearance"],
    authors: [Devs.Ven],
    dependencies: ["MessageUpdaterAPI", "MessageAccessoriesAPI", "MessagePopoverAPI"],

    patches: [{
        find: "this.renderAttachments(",
        replacement: {
            match: /(?<=\i=)this\.render(?:Attachments|Embeds|StickersAccessories|ComponentAccessories)\((\i)\)/g,
            replace: "$self.shouldHide($1?.id)?null:$&"
        }
    }],

    messagePopoverButton: {
        icon: ImageInvisible,
        render(msg) {
            if (!hasMedia(msg) && !msg.messageSnapshots?.some(s => hasMedia(s.message))) return null;

            const isHidden = hiddenMessages.has(msg.id);

            return {
                label: isHidden ? "Show Media" : "Hide Media",
                icon: isHidden ? ImageVisible : ImageInvisible,
                message: msg,
                channel: ChannelStore.getChannel(msg.channel_id),
                onClick: () => toggleHide(msg.channel_id, msg.id)
            };
        },
    },

    renderMessageAccessory({ message }) {
        if (!this.shouldHide(message.id)) return null;

        return (
            <span className={classes("vc-hideAttachments-accessory", !message.content && "vc-hideAttachments-no-content")}>
                Media Hidden
            </span>
        );
    },

    async start() {
        const generation = lifecycleGeneration;
        await hiddenMessagesWrite;
        if (generation !== lifecycleGeneration) return;
        await getHiddenMessages();
    },

    stop() {
        lifecycleGeneration++;
        hiddenMessages = new Set();
        hiddenMessagesLoaded = false;
        hiddenMessagesLoad = null;
    },

    shouldHide(messageId: string) {
        return hiddenMessages.has(messageId);
    },
});
