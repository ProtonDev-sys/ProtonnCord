/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { reload } from "@utils/native";
import { React, Toasts } from "@webpack/common";

export const cl = classNameFactory("vc-plugins-");
export const logger = new Logger("PluginSettings", "#a6d189");

export function showErrorToast(message: string) {
    Toasts.show({
        message,
        type: Toasts.Type.FAILURE,
        id: Toasts.genId(),
        options: {
            position: Toasts.Position.BOTTOM
        }
    });
}

export async function restartAfterSaving() {
    try {
        await reload();
    } catch (error) {
        logger.error("Cannot restart before saving settings", error);
        showErrorToast("Your settings could not be saved. Try again before restarting.");
    }
}

export const ExcludedReasons: Record<"web" | "browser" | "discordDesktop" | "vesktop" | "equibop" | "desktop" | "dev", string> = {
    desktop: "Discord Desktop app or Vesktop/Equibop",
    discordDesktop: "Discord Desktop app",
    vesktop: "Vesktop/Equibop apps",
    equibop: "Vesktop/Equibop apps",
    web: "Vesktop/Equibop apps & Discord web",
    browser: "Discord web browser client",
    dev: "Developer version of Protonn Cord"
};

export interface PluginSource {
    label: string;
    title: string;
}

/** Where a plugin comes from, derived from its source folder; no network assets are involved. */
export function getPluginSource(meta: { folderName: string; userPlugin: boolean; } | undefined, isModified?: boolean): PluginSource | null {
    if (isModified) return { label: "Modified", title: "Vencord plugin modified by Protonn Cord" };
    if (meta?.folderName.startsWith("src/equicordplugins/")) return { label: "Protonn Cord", title: "Protonn Cord plugin" };
    if (meta?.folderName.startsWith("src/plugins/")) return { label: "Vencord", title: "Vencord plugin" };
    if (meta?.userPlugin) return { label: "User", title: "User plugin" };
    return null;
}

export function PluginDependencyList({ deps }: { deps: readonly string[]; }) {
    return (
        <>
            <Paragraph>This plugin is required by:</Paragraph>
            {deps.map(dep => <Paragraph key={dep} className={cl("dep-text")}>{dep}</Paragraph>)}
        </>
    );
}
