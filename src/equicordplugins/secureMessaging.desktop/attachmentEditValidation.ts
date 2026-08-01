/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const DISCORD_ATTACHMENT_ID = /^\d{17,20}$/u;

export function unchangedEncryptedAttachmentIds(value: unknown, originalIds: readonly string[]): boolean {
    if (value == null) return true;
    if (!Array.isArray(value) || value.length !== originalIds.length) return false;
    return value.every((attachment, index) => {
        if (typeof attachment !== "object" || attachment === null || !("id" in attachment)) return false;
        const { id } = attachment;
        return typeof id === "string" && DISCORD_ATTACHMENT_ID.test(id) && id === originalIds[index];
    });
}
