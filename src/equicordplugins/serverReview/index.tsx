/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { Button } from "@components/Button";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Menu, React, UserStore } from "@webpack/common";

import { closeReview, openReview } from "./review";
import { settings } from "./settings";
import * as tracking from "./tracking";

const guildMenu: NavContextMenuPatchCallback = (children, { guild }) => {
    tracking.mark(guild?.id);
    children.push(<Menu.MenuItem id="pc-server-review" label="Review server activity" action={openReview} />);
};

// Observe the submitted resources before FakeNitro or Secure Messaging transforms them.
// This listener never changes, cancels, or waits on a send.
const submittedMessage: MessageSendListener = (channelId, message, options) => {
    tracking.markChannel(channelId);
    tracking.trackContent(message.content);
    for (const emoji of message.validNonShortcutEmojis ?? []) tracking.mark(emoji.guildId, "emoji");
    for (const id of options.stickerIds ?? options.stickers ?? []) tracking.sticker(id);
};

export default definePlugin({
    name: "ServerReview",
    description: "Review unused servers, keep favourites, and group servers you use for emojis, stickers, or sounds.",
    authors: [EquicordDevs.creations],
    tags: ["Servers", "Utility"],
    dependencies: ["MessageEventsAPI"],
    settings,
    settingsAboutComponent: () => {
        React.useSyncExternalStore(tracking.subscribe, tracking.getRevision);
        return <Button onClick={openReview} disabled={!tracking.getHistory()} title="Enable ServerReview to start tracking activity.">Review servers</Button>;
    },
    contextMenus: { "guild-context": guildMenu },
    start() {
        tracking.start(openReview);
        addMessagePreSendListener(submittedMessage, { priority: 1_000_001 });
    },
    stop() {
        removeMessagePreSendListener(submittedMessage);
        closeReview();
        tracking.stop();
    },
    flux: {
        CONNECTION_OPEN() { void tracking.connect(); },
        LOGOUT() { closeReview(); tracking.disconnect(); },
        CURRENT_USER_UPDATE() { void tracking.connect(); },
        GUILD_SELECT({ guildId }) { tracking.mark(guildId); },
        GUILD_SETTINGS_INIT({ guildId }) { tracking.mark(guildId); },
        CHANNEL_SELECT({ guildId, channelId }) { tracking.mark(guildId); tracking.markChannel(channelId); },
        VOICE_CHANNEL_SELECT({ channelId }) { tracking.markChannel(channelId); },
        GUILD_CREATE({ guild }) {
            const history = tracking.getHistory();
            if (!guild?.id || !history || !tracking.isCurrent(history)) return;
            history.ensure(guild.id, Date.now());
            tracking.changed();
        },
        GUILD_DELETE({ guild, guildId, unavailable }) {
            const history = tracking.getHistory();
            if (unavailable || guild?.unavailable || !history || !tracking.isCurrent(history)) return;
            const id = guild?.id ?? guildId;
            if (id) history.remove(id);
            tracking.changed();
        },
        MESSAGE_CREATE({ message, optimistic }) {
            if (optimistic || message?.author?.id !== UserStore.getCurrentUser()?.id) return;
            tracking.markChannel(message.channel_id);
            tracking.trackContent(message.content, message.sticker_items ?? message.stickerItems);
        },
        MESSAGE_REACTION_ADD({ userId, channelId, emoji }) {
            if (userId !== UserStore.getCurrentUser()?.id) return;
            tracking.markChannel(channelId);
            tracking.emoji(emoji?.id);
        },
        EMOJI_TRACK_USAGE({ emojiUsed }) {
            if (Array.isArray(emojiUsed)) for (const emoji of emojiUsed) {
                tracking.mark(emoji.guildId, "emoji");
                tracking.emoji(emoji.id);
            }
        },
        STICKER_TRACK_USAGE({ stickerIds }) {
            if (Array.isArray(stickerIds)) stickerIds.forEach(tracking.sticker);
        },
        VOICE_CHANNEL_EFFECT_SEND({ userId, soundId, emoji, channelId }) {
            if (userId !== UserStore.getCurrentUser()?.id) return;
            tracking.markChannel(channelId);
            tracking.sound(soundId);
            tracking.emoji(emoji?.id);
        },
        GUILD_SOUNDBOARD_SOUND_PLAY_LOCALLY({ sound, soundId, guildId }) {
            tracking.mark(sound?.guildId ?? guildId, "sound");
            tracking.sound(sound?.soundId ?? soundId);
        }
    }
});
