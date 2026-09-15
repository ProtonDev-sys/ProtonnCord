/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    days: {
        type: OptionType.NUMBER,
        description: "Review servers after this many days without activity.",
        default: 30,
        isValid: value => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3650 || "Enter a whole number from 1 to 3650."
    },
    startupReminder: {
        type: OptionType.BOOLEAN,
        description: "Show a reminder after Discord starts when servers are ready to review. At most once a week.",
        default: true
    },
    folderName: {
        type: OptionType.STRING,
        description: "Folder for servers you use for emojis, stickers, or sounds. Reuses a folder with this name, or creates one.",
        default: "Emotes & sounds",
        isValid: value => typeof value === "string" && value.trim().length > 0 && value.length <= 100 || "Enter a folder name of 1 to 100 characters."
    }
});
