/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";

import type { ConversationResult, ConversationSnapshot } from "./native";

export function availableSelectedRecipientIds(conversation: ConversationResult): string[] {
    if (!("participants" in conversation)) return [];
    const trustedParticipantIds = new Set(conversation.participants
        .filter(participant => participant.status === "trusted")
        .map(participant => participant.identity.userId));
    const selected = conversation.selectedRecipientIds.filter(userId => trustedParticipantIds.has(userId));
    if (conversation.status === "unconfigured" && conversation.snapshot.kind === "DM" && selected.length === 0) {
        const onlyParticipant = conversation.participants[0];
        if (onlyParticipant?.status === "trusted") return [onlyParticipant.identity.userId];
    }
    return selected;
}

export function snapshotForChannel(channel: Channel | undefined, localUserId: string): ConversationSnapshot | null {
    if (!channel) return null;
    const isGroup = Boolean(channel.isGroupDM?.() || channel.isMultiUserDM?.());
    if (!isGroup && !channel.isDM?.()) return null;

    const participantUserIds = [...new Set((channel.recipients ?? [])
        .filter((value): value is string => typeof value === "string" && value !== localUserId))]
        .sort((left, right) => left.localeCompare(right));
    if (participantUserIds.length === 0 || (!isGroup && participantUserIds.length !== 1)) return null;

    return {
        channelId: channel.id,
        kind: isGroup ? "GROUP_DM" : "DM",
        participantUserIds,
    };
}
