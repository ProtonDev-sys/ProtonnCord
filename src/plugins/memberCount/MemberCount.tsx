/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getCurrentChannel } from "@utils/discord";
import { isObjectEmpty } from "@utils/misc";
import { ChannelStore, GuildMemberCountStore, PermissionsBits, PermissionStore, SelectedChannelStore, Tooltip, useEffect, useStateFromStores, VoiceStateStore } from "@webpack/common";

import { ChannelMemberStore, cl, numberFormat, settings, ThreadMemberListStore } from ".";
import { CircleIcon } from "./CircleIcon";
import { OnlineMemberCountStore } from "./OnlineMemberCountStore";
import { VoiceIcon } from "./VoiceIcon";

export function MemberCount({ isTooltip, tooltipGuildId }: { isTooltip?: true; tooltipGuildId?: string; }) {
    const { voiceActivity } = settings.use(["voiceActivity"]);
    const includeVoice = voiceActivity && !isTooltip;

    const currentChannel = useStateFromStores([SelectedChannelStore], () => getCurrentChannel());
    const guildId = isTooltip ? tooltipGuildId! : currentChannel?.guild_id;

    const voiceActivityCount = useStateFromStores(
        [VoiceStateStore],
        () => {
            if (!includeVoice) return 0;

            const voiceStates = VoiceStateStore.getVoiceStates(guildId);
            if (!voiceStates) return 0;

            let count = 0;
            for (const userId in voiceStates) {
                const { channelId } = voiceStates[userId];
                if (!channelId) continue;

                const channel = ChannelStore.getChannel(channelId);
                if (channel && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)) count++;
            }

            return count;
        }
    );

    const totalCount = useStateFromStores(
        [GuildMemberCountStore],
        () => GuildMemberCountStore.getMemberCount(guildId!)
    );

    let onlineCount = useStateFromStores(
        [OnlineMemberCountStore],
        () => OnlineMemberCountStore.getCount(guildId)
    );

    const { groups } = useStateFromStores(
        [ChannelMemberStore],
        () => ChannelMemberStore.getProps(guildId, currentChannel?.id)
    );

    const threadGroups = useStateFromStores(
        [ThreadMemberListStore],
        () => ThreadMemberListStore.getMemberListSections(currentChannel?.id)
    );

    if (!isTooltip && groups.length >= 1 && groups[0].id !== "unknown") {
        let count = 0;
        for (const group of groups) {
            if (group.id !== "offline") count += group.count;
        }

        onlineCount = count;
    }

    if (!isTooltip && threadGroups && !isObjectEmpty(threadGroups)) {
        let count = 0;
        for (const key in threadGroups) {
            const group = threadGroups[key];
            if (group.sectionId !== "offline") count += group.userIds.length;
        }

        onlineCount = count;
    }

    useEffect(() => {
        OnlineMemberCountStore.ensureCount(guildId);
    }, [guildId]);

    if (totalCount == null)
        return null;

    const formattedVoiceCount = numberFormat(voiceActivityCount ?? 0);
    const formattedOnlineCount = onlineCount != null ? numberFormat(onlineCount) : "?";
    const formattedTotalCount = numberFormat(totalCount);

    return (
        <div className={cl("widget", { tooltip: isTooltip, "member-list": !isTooltip })}>
            <Tooltip text={`${formattedOnlineCount} online in this channel`} position="bottom">
                {props => (
                    <div {...props} className={cl("container")}>
                        <CircleIcon className={cl("online-count")} />
                        <span className={cl("online")}>{formattedOnlineCount}</span>
                    </div>
                )}
            </Tooltip>
            <Tooltip text={`${formattedTotalCount} total server members`} position="bottom">
                {props => (
                    <div {...props} className={cl("container")}>
                        <CircleIcon className={cl("total-count")} />
                        <span className={cl("total")}>{formattedTotalCount}</span>
                    </div>
                )}
            </Tooltip>
            {includeVoice && voiceActivityCount > 0 &&
                <Tooltip text={`${formattedVoiceCount} members in voice`} position="bottom">
                    {props => (
                        <div {...props} className={cl("container")}>
                            <VoiceIcon className={cl("voice-icon")} />
                            <span className={cl("voice")}>{formattedVoiceCount}</span>
                        </div>
                    )}
                </Tooltip>
            }
        </div>
    );
}
