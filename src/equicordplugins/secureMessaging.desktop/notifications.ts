/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showToast as showDiscordToast } from "@webpack/common";

export function showToast(message: string, type: string): void {
    try {
        showDiscordToast(message, type);
    } catch {
        // Host notifications are optional. Never include chat or identity data in the fallback log.
        console.warn("[SecureMessaging] Discord could not display a notification.");
    }
}
