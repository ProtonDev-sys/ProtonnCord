/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { DecoratorProps } from "@api/MemberListDecorators";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { AttachmentIcon, GifIcon, ImageIcon, Microphone, StickerIcon, VideoIcon } from "@components/Icons";
import betterActivities from "@equicordplugins/betterActivities";
import showMeYourName from "@plugins/showMeYourName";
import { Devs, EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Activity, ApplicationStream, Channel, Message, OnlineStatus, User } from "@vencord/discord-types";
import { MessageFlags } from "@vencord/discord-types/enums";
import { findByCodeLazy, findByPropsLazy, findComponentByCodeLazy, findCssClassesLazy } from "@webpack";
import { ChannelStore, ExperimentStore, MessageStore, Parser, RelationshipStore, SnowflakeUtils, UserGuildSettingsStore, UserStore, useStateFromStores } from "@webpack/common";

const cl = classNameFactory("vc-message-peek-");

const PrivateChannelClasses = findCssClassesLazy("subtext", "channel", "interactive");
const ActivityClasses = findCssClassesLazy("textWithIconContainer", "icon", "truncated", "container", "textXs");
const MessageActions = findByPropsLazy("fetchMessages", "sendMessage");

const hasRelevantActivity: (props: ActivityCheckProps) => boolean = findByCodeLazy(".OFFLINE||", ".INVISIBLE)return!1");
const ActivityText: React.ComponentType<ActivityTextProps> = findComponentByCodeLazy('"ActivityStatus"');

const ONE_HOUR_MS = 60 * 60 * 1000;
const STARTUP_FETCH_BATCH_SIZE = 5;
const STARTUP_FETCH_DELAY_MS = 3000;

let startupFetchGeneration = 0;
let startupDelay: { timer: ReturnType<typeof setTimeout>; resolve(): void; } | undefined;

function cancelStartupFetch() {
    startupFetchGeneration++;
    if (startupDelay) {
        clearTimeout(startupDelay.timer);
        startupDelay.resolve();
        startupDelay = undefined;
    }
}

const settings = definePluginSettings({
    hideMuted: {
        type: OptionType.BOOLEAN,
        description: "Hide message previews and timestamps for muted DMs and group chats.",
        default: false
    }
});

type AttachmentType = "image" | "gif" | "video" | "file";
type IconType = AttachmentType | "voice" | "sticker";

const Icons: Record<IconType, React.ComponentType<{ size: string; className: string; }>> = {
    image: ImageIcon,
    file: AttachmentIcon,
    voice: Microphone,
    sticker: StickerIcon,
    gif: GifIcon,
    video: VideoIcon,
};

const ATTACHMENT_LABELS: Record<AttachmentType, string> = {
    gif: "GIF",
    image: "image",
    video: "video",
    file: "file"
};

interface ActivityCheckProps {
    activities: Activity[] | null;
    status: OnlineStatus;
    applicationStream: ApplicationStream | null;
    voiceChannel: Channel | null;
}

interface ActivityTextProps {
    user: User;
    activities: Activity[] | null;
    applicationStream: ApplicationStream | null;
    voiceChannel: Channel | null;
}

interface PrivateChannelProps extends ActivityCheckProps {
    channel: Channel;
    user: User;
}

interface MessageContent {
    text: React.ReactNode;
    icon?: IconType;
}

function getActivityIcons(activities: Activity[] | null, user: User): React.ReactNode {
    if (!activities?.length) return null;

    if (!isPluginEnabled(betterActivities.name)) return null;

    return betterActivities.patchActivityList({
        activities,
        user,
        hideTooltip: false
    });
}

function getAttachmentType(contentType = ""): AttachmentType {
    if (contentType === "image/gif") return "gif";
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/")) return "video";
    return "file";
}

function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days >= 365) return `${Math.floor(days / 365)}y`;
    if (days >= 30) return `${Math.floor(days / 30)}mo`;
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    return `${Math.max(1, minutes)}m`;
}

function pluralize(count: number, singular: string, plural = singular + "s") {
    return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

function getMessageContent(message: Message): MessageContent | null {
    if (message.content) {
        if (/https?:\/\/(\S+\.gif|tenor\.com|giphy\.com|klipy\.com)/i.test(message.content)) {
            return { text: "sent a GIF", icon: "gif" };
        }
        return { text: Parser.parseInlineReply(message.content) };
    }

    if (message.flags & MessageFlags.IS_VOICE_MESSAGE) {
        return { text: "voice message", icon: "voice" };
    }

    if (message.attachments?.length) {
        const types = message.attachments.map(a => getAttachmentType(a.content_type));
        const count = types.length;
        const firstType = types[0];
        const allSameType = types.every(t => t === firstType);

        if (allSameType) {
            return { text: pluralize(count, ATTACHMENT_LABELS[firstType]), icon: firstType };
        }
        return { text: pluralize(count, "file"), icon: "file" };
    }

    if (message.stickerItems?.length) {
        return { text: message.stickerItems[0].name, icon: "sticker" };
    }

    return null;
}

function MessagePreviewContent({ channel, user }: { channel: Channel; user: User | null | undefined; }) {
    const lastMessage = useStateFromStores(
        [MessageStore, UserStore, RelationshipStore],
        () => MessageStore.getLastMessage(channel.id) as Message | undefined
    );

    if (channel.isSystemDM()) {
        return <>Official Discord Message</>;
    }

    if (!lastMessage) {
        if (channel.isMultiUserDM()) return <>{channel.recipients.length + 1} Members</>;
        return null;
    }

    const content = getMessageContent(lastMessage);
    if (!content) return null;

    const currentUserId = UserStore.getCurrentUser()?.id;
    const isOwnMessage = lastMessage.author.id === currentUserId;
    const smynName = !isOwnMessage && isPluginEnabled(showMeYourName.name)
        ? showMeYourName.getTypingMemberListProfilesReactionsVoiceNameText({ user: lastMessage.author, type: "membersList" })
        : null;
    const authorName = isOwnMessage ? "You" : (smynName || RelationshipStore.getNickname(lastMessage.author.id) || lastMessage.author.globalName || lastMessage.author.username);
    const Icon = content.icon ? Icons[content.icon] : null;

    return (
        <div className={classes(ActivityClasses.container, ActivityClasses.textXs, cl("preview"))}>
            <span className={ActivityClasses.truncated}>{authorName}: {content.text}</span>
            {Icon && (
                <span className={cl("icon")}>
                    <Icon size="xxs" className={ActivityClasses.icon} />
                </span>
            )}
        </div>
    );
}

function SubText({ channel, user, activities, applicationStream, voiceChannel, showActivity }: PrivateChannelProps & { showActivity: boolean; }) {
    if (showActivity) {
        return (
            <ActivityText
                user={user}
                activities={activities}
                voiceChannel={voiceChannel}
                applicationStream={applicationStream}
            />
        );
    }

    const activityIcons = getActivityIcons(activities, user);

    if (activityIcons) {
        return (
            <div className={PrivateChannelClasses.subtext}>
                <div className={cl("activity-row")}>
                    <MessagePreviewContent channel={channel} user={user} />
                    {activityIcons}
                </div>
            </div>
        );
    }

    return (
        <div className={PrivateChannelClasses.subtext}>
            <MessagePreviewContent channel={channel} user={user} />
        </div>
    );
}

function Timestamp({ channel }: { channel: Channel; }) {
    const { hideMuted } = settings.use(["hideMuted"]);
    const [lastMessage, isChannelPinned, isFavoritesEnabled, isMuted] = useStateFromStores(
        [MessageStore, UserGuildSettingsStore, ExperimentStore],
        () => [
            MessageStore.getLastMessage(channel.id) as Message | undefined,
            UserGuildSettingsStore.isMessagesFavorite(channel.id),
            ExperimentStore.getUserExperimentBucket("2026-01-favorites-server") > 0,
            UserGuildSettingsStore.isChannelMuted(null!, channel.id)
        ] as const
    );

    if (!lastMessage || hideMuted && isMuted) return null;

    const timestamp = SnowflakeUtils.extractTimestamp(lastMessage.id);
    const className = isFavoritesEnabled || isChannelPinned ? cl("timestamp-favorites") : cl("timestamp");
    return <span className={className}>{formatRelativeTime(timestamp)}</span>;
}

function shouldShowActivity(lastMessage: Message | undefined, hasActivity: boolean): boolean {
    if (!hasActivity) return false;
    if (!lastMessage) return true;

    const messageTimestamp = SnowflakeUtils.extractTimestamp(lastMessage.id);
    return Date.now() - messageTimestamp > ONE_HOUR_MS;
}

function PrivateChannelSubText(props: PrivateChannelProps) {
    const { channel, user, activities, status, applicationStream, voiceChannel } = props;
    const { hideMuted } = settings.use(["hideMuted"]);
    const [lastMessage, isMuted] = useStateFromStores([MessageStore, UserGuildSettingsStore], () => [
        MessageStore.getLastMessage(channel.id) as Message | undefined,
        UserGuildSettingsStore.isChannelMuted(null!, channel.id)
    ] as const);
    const hasActivity = hasRelevantActivity({ activities, status, applicationStream, voiceChannel });
    if (hideMuted && isMuted) return hasActivity
        ? <ActivityText user={user} activities={activities} voiceChannel={voiceChannel} applicationStream={applicationStream} />
        : null;
    return <SubText {...props} showActivity={shouldShowActivity(lastMessage, hasActivity)} />;
}

export default definePlugin({
    name: "MessagePeek",
    description: "Shows the last message preview and timestamp in the Direct Messages list.",
    dependencies: ["MemberListDecoratorsAPI"],
    tags: ["Appearance", "Chat"],
    authors: [Devs.prism, EquicordDevs.justjxke],
    settings,
    patches: [
        {
            find: "PrivateChannel.renderAvatar",
            replacement: {
                match: /,subText:\i\.isSystemDM\(\).{0,700}:null,(?=name:)/,
                replace: ",subText:$self.getSubText(arguments[0]),"
            }
        }
    ],

    async start() {
        cancelStartupFetch();
        const generation = startupFetchGeneration;
        const accountId = UserStore.getCurrentUser()?.id;
        if (!accountId) return;
        const isCurrent = () => generation === startupFetchGeneration && UserStore.getCurrentUser()?.id === accountId;
        const channels = ChannelStore.getSortedPrivateChannels()
            .slice(0, 25)
            .filter(c => !MessageStore.getLastMessage(c.id));

        for (let i = 0; i < channels.length && isCurrent(); i += STARTUP_FETCH_BATCH_SIZE) {
            const batch = channels.slice(i, i + STARTUP_FETCH_BATCH_SIZE);

            await Promise.allSettled(
                batch.map(channel => Promise.resolve().then(() =>
                    isCurrent() && MessageActions.fetchMessages({
                        channelId: channel.id,
                        limit: 1
                    })
                ))
            );

            if (!isCurrent()) break;

            if (i + STARTUP_FETCH_BATCH_SIZE < channels.length) {
                await new Promise<void>(resolve => {
                    startupDelay = { resolve, timer: setTimeout(() => {
                        startupDelay = undefined;
                        resolve();
                    }, STARTUP_FETCH_DELAY_MS) };
                });
            }
        }
    },

    stop() {
        cancelStartupFetch();
    },

    renderMemberListDecorator({ channel }: DecoratorProps) {
        if (!channel) return null;
        return <Timestamp channel={channel} />;
    },

    getSubText(props: PrivateChannelProps) {
        return <PrivateChannelSubText {...props} />;
    }
});
