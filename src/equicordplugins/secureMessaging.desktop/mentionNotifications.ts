/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    type EncryptedEnvelopeContext,
    extractMentionedUserIds,
    parseEncryptedEnvelope,
} from "./protocol";

export interface DiscordAllowedMentions {
    parse: string[];
    replied_user?: boolean;
    users: string[];
}

/** Build a fail-closed Discord allowlist from PCEM mention metadata, excluding the author. */
export function encryptedAllowedMentions(
    content: string,
    context: EncryptedEnvelopeContext,
    previous: unknown,
): DiscordAllowedMentions {
    const envelope = parseEncryptedEnvelope(content, context);
    const previousRecord = previous && typeof previous === "object"
        ? previous as Record<string, unknown>
        : null;
    const repliedUser = previousRecord?.replied_user ?? previousRecord?.repliedUser;
    return {
        parse: [],
        users: (envelope.m ?? []).filter(userId => userId !== context.discordAuthorId),
        ...(typeof repliedUser === "boolean" ? { replied_user: repliedUser } : {}),
    };
}

/** Resolve the local mention state before decryption when PCEM3 carries it, with an authenticated plaintext fallback. */
export function encryptedMessageMentionsUser(
    content: string,
    context: EncryptedEnvelopeContext,
    userId: string,
    decryptedPlaintext?: string,
): boolean {
    if (!/^\d{17,20}$/u.test(userId)) return false;
    try {
        if (content.includes(`<@${userId}>`) && parseEncryptedEnvelope(content, context).m?.includes(userId)) return true;
    } catch {
        // A verified decrypted plaintext may still supply mention state for an older envelope.
    }
    return decryptedPlaintext !== undefined && extractMentionedUserIds(decryptedPlaintext).includes(userId);
}
