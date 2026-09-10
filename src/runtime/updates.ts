/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { popNotice, showNotice } from "@api/Notices";
import { Settings } from "@api/Settings";
import { openSettingsTabModal, UpdaterTab } from "@components/settings";
import { relaunch } from "@utils/native";
import { checkForUpdates, isOutdated, repair, update, UpdateLogger } from "@utils/updater";

import type { Dispose, RendererService } from "./bootstrap";

export function createUpdateService(): RendererService {
    if (IS_WEB || IS_UPDATER_DISABLED) return { dispose() {} };

    let disposed = false;
    let notified = false;
    let checking = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const listeners: Dispose[] = [];

    async function runUpdateCheck() {
        if (disposed || checking) return;
        checking = true;
        const branch = Settings.updateBranch;
        try {
            const outdated = await checkForUpdates();
            if (disposed || branch !== Settings.updateBranch) return;
            if (IS_DISCORD_DESKTOP) VencordNative.tray.setUpdateState(outdated);
            if (!outdated) return;
            if (Settings.autoUpdate) {
                const didUpdate = await update();
                if (disposed || branch !== Settings.updateBranch || !didUpdate) return;
                if (IS_DISCORD_DESKTOP) VencordNative.tray.setUpdateState(false);
                if (Settings.autoUpdateNotification && !notified) {
                    notified = true;
                    showNotice("Protonn Cord has been updated!", "Restart", relaunch);
                }
            } else if (!notified) {
                notified = true;
                showNotice("A new version of Protonn Cord is available!", "View Update", () => openSettingsTabModal(UpdaterTab!));
            }
        } catch (error) {
            UpdateLogger.error("Failed to check for updates", error);
        } finally {
            checking = false;
        }
    }

    async function checkFromTray() {
        if (disposed) return;
        const branch = Settings.updateBranch;
        try {
            const outdated = await checkForUpdates();
            if (disposed || branch !== Settings.updateBranch) return;
            VencordNative.tray.setUpdateState(outdated);
            if (outdated)
                showNotice("A Protonn Cord update is available!", "View Update", () => openSettingsTabModal(UpdaterTab!));
            else
                showNotice("No updates available, you're on the latest version!", "OK", popNotice);
        } catch (error) {
            UpdateLogger.error("Failed to check for updates from tray", error);
            if (!disposed && branch === Settings.updateBranch)
                showNotice("Failed to check for updates, check the console for more info", "OK", popNotice);
        }
    }

    async function repairFromTray() {
        if (disposed) return;
        try {
            const repaired = await repair();
            if (!disposed && repaired) await relaunch();
        } catch (error) {
            UpdateLogger.error("Failed to repair Protonn Cord", error);
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        clearInterval(interval);
        for (const remove of listeners.splice(0).reverse()) {
            try {
                remove();
            } catch (error) {
                UpdateLogger.error("Failed to remove a tray listener", error);
            }
        }
    }

    try {
        listeners.push(VencordNative.tray.onCheckUpdates(checkFromTray));
        listeners.push(VencordNative.tray.onRepair(repairFromTray));
        VencordNative.tray.setUpdateState(isOutdated);
    } catch (error) {
        dispose();
        throw error;
    }

    return {
        dispose,
        ...(!IS_DEV && {
            runInitial() {
                if (disposed) return;
                // Retain periodic checks only for silent automatic updates.
                if (Settings.autoUpdate && !Settings.autoUpdateNotification)
                    interval = setInterval(() => { void runUpdateCheck(); }, 30 * 60_000);
                return runUpdateCheck();
            },
        }),
    };
}
