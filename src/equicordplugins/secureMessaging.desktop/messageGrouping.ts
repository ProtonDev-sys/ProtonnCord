/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isEncryptedMessage } from "./protocol";

const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1_000;

export const SecureMessageGroup = {
    Previous: 1,
    Next: 2,
} as const;

export interface SecureMessageGroupCandidate {
    attachments: readonly unknown[];
    author?: { id: string; };
    components: readonly unknown[];
    content: string;
    embeds: readonly unknown[];
    id: string;
    messageReference?: unknown;
    reactions: readonly unknown[];
    stickerItems: readonly unknown[];
    timestamp: Date;
}

function hasTrailingAccessories(message: SecureMessageGroupCandidate): boolean {
    return message.attachments.length > 0 || message.components.length > 0 || message.embeds.length > 0 ||
        message.reactions.length > 0 || message.stickerItems.length > 0;
}

function canJoinMessages<T extends SecureMessageGroupCandidate>(
    previous: T,
    next: T,
    canJoin: (previous: T, next: T) => boolean,
    isGroupStart: (message: T) => boolean | null,
): boolean {
    if (!isEncryptedMessage(previous.content) || !isEncryptedMessage(next.content) ||
        !previous.author?.id || previous.author.id !== next.author?.id ||
        previous.messageReference || next.messageReference || isGroupStart(next) !== false ||
        hasTrailingAccessories(previous) || hasTrailingAccessories(next)) return false;
    const elapsed = next.timestamp.getTime() - previous.timestamp.getTime();
    return elapsed >= 0 && elapsed < MESSAGE_GROUP_WINDOW_MS && canJoin(previous, next);
}

export function secureMessageGroupFlags<T extends SecureMessageGroupCandidate>(
    message: T,
    messages: readonly T[],
    canJoin: (previous: T, next: T) => boolean = () => true,
    isGroupStart: (message: T) => boolean | null = () => false,
): number {
    const index = messages.findIndex(candidate => candidate.id === message.id);
    if (index < 0) return 0;
    let flags = 0;
    if (index > 0 && canJoinMessages(messages[index - 1], message, canJoin, isGroupStart)) flags |= SecureMessageGroup.Previous;
    if (index + 1 < messages.length && canJoinMessages(message, messages[index + 1], canJoin, isGroupStart)) flags |= SecureMessageGroup.Next;
    return flags;
}
