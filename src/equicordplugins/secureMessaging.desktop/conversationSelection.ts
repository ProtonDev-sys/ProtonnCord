/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ConversationResult } from "./native";

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
