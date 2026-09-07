/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { LazyComponent } from "@utils/lazyReact";
import type { ComponentType } from "react";

export * from "./BaseTab";

function lazyTab(title: string, load: () => ComponentType<any>) {
    const Tab = LazyComponent(load);
    Tab.displayName = `${title}SettingsTab`;
    return Tab;
}

// Sidebar registration and shared settings imports do not initialize unopened pages.
export const PatchHelperTab = IS_STANDALONE ? null : lazyTab("PatchHelper", () => (require("./patchHelper") as typeof import("./patchHelper")).default!);
export const PluginsTab = lazyTab("Plugins", () => (require("./plugins") as typeof import("./plugins")).default);
export const BackupAndRestoreTab = lazyTab("Backup & Restore", () => (require("./sync/BackupAndRestoreTab") as typeof import("./sync/BackupAndRestoreTab")).default);
export const CloudTab = lazyTab("Cloud", () => (require("./sync/CloudTab") as typeof import("./sync/CloudTab")).default);
export const ThemesTab = lazyTab("Themes", () => (require("./themes") as typeof import("./themes")).default);
export const UpdaterTab = lazyTab("Updates", () => (require("./updater") as typeof import("./updater")).default);
export const VencordTab = lazyTab("Protonn Cord", () => (require("./vencord") as typeof import("./vencord")).default);

export function openContributorModal(...args: Parameters<typeof import("./plugins/ContributorModal").openContributorModal>) {
    return (require("./plugins/ContributorModal") as typeof import("./plugins/ContributorModal")).openContributorModal(...args);
}

export function openPluginModal(...args: Parameters<typeof import("./plugins/PluginModal").openPluginModal>) {
    return (require("./plugins/PluginModal") as typeof import("./plugins/PluginModal")).openPluginModal(...args);
}
