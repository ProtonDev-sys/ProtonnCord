/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { popNotice, showNotice } from "@api/Notices";
import { Settings } from "@api/Settings";
import { openSettingsTabModal, UpdaterTab } from "@components/settings";
import { relaunch } from "@utils/native";
import { checkForUpdates, getUpdateState, repair, subscribeToUpdates, update, UpdateLogger } from "@utils/updater";

import type { Dispose, RendererService } from "./bootstrap";

export function createUpdateService(): RendererService {
    if (IS_WEB || IS_UPDATER_DISABLED) return { dispose() {} };

    let disposed = false;
    let notified: "available" | "installed" | undefined;
    let notifiedBranch = Settings.updateBranch;
    let failed = false;
    let checking = false;
    let trayChecking = false;
    let repairing = false;
    let trayState: boolean | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    const listeners: Dispose[] = [];

    function viewUpdates() {
        if (!disposed) openSettingsTabModal(UpdaterTab!);
    }

    function syncUpdateState() {
        if (disposed) return;
        if (notifiedBranch !== Settings.updateBranch) {
            notifiedBranch = Settings.updateBranch;
            notified = undefined;
            failed = false;
        }
        const { isOutdated } = getUpdateState();
        if (IS_DISCORD_DESKTOP && trayState !== isOutdated) {
            VencordNative.tray.setUpdateState(isOutdated);
            trayState = isOutdated;
        }
    }

    async function restart(branch: typeof Settings.updateBranch) {
        if (disposed) return;
        if (branch !== Settings.updateBranch) return viewUpdates();
        try {
            await relaunch();
        } catch (error) {
            UpdateLogger.error("Failed to restart Protonn Cord", error);
            if (!disposed)
                showNotice("The update is installed, but Discord could not restart. Restart Discord manually to apply it.", "OK", popNotice);
        }
    }

    async function runUpdateCheck() {
        if (disposed || checking) return;
        checking = true;
        const branch = Settings.updateBranch;
        try {
            const outdated = await checkForUpdates();
            if (disposed || branch !== Settings.updateBranch) return;
            if (!outdated) {
                if (notified === "available") notified = undefined;
                failed = false;
                return;
            }
            if (Settings.autoUpdate) {
                const didUpdate = await update();
                if (disposed || branch !== Settings.updateBranch) return;
                if (!didUpdate) throw new Error("The automatic update was not installed. Check for updates and try again.");
                failed = false;
                if (Settings.autoUpdateNotification && notified !== "installed") {
                    notified = "installed";
                    showNotice("Protonn Cord has been updated!", "Restart", () => { void restart(branch); });
                }
            } else {
                failed = false;
                if (!notified) {
                    notified = "available";
                    showNotice("A new version of Protonn Cord is available!", "View Update", viewUpdates);
                }
            }
        } catch (error) {
            UpdateLogger.error("Failed to check for updates", error);
            if (!disposed && branch === Settings.updateBranch && !failed) {
                failed = true;
                showNotice("Protonn Cord could not check for or install updates. Open Updates to retry.", "View Update", viewUpdates);
            }
        } finally {
            checking = false;
        }
    }

    async function checkFromTray() {
        if (disposed || trayChecking) return;
        trayChecking = true;
        const branch = Settings.updateBranch;
        try {
            const outdated = await checkForUpdates();
            if (disposed || branch !== Settings.updateBranch) return;
            if (outdated)
                showNotice("A Protonn Cord update is available!", "View Update", viewUpdates);
            else if (getUpdateState().isNewer)
                showNotice("Your local copy contains commits outside the selected update branch. Open Updates to review them.", "View Update", viewUpdates);
            else if (getUpdateState().needsRestart)
                showNotice("The latest update is installed. Restart Discord to apply it.", "Restart", () => { void restart(branch); });
            else
                showNotice("No updates available, you're on the latest version!", "OK", popNotice);
        } catch (error) {
            UpdateLogger.error("Failed to check for updates from tray", error);
            if (!disposed && branch === Settings.updateBranch)
                showNotice("Failed to check for updates. Open Updates to retry.", "View Update", viewUpdates);
        } finally {
            trayChecking = false;
        }
    }

    async function repairFromTray() {
        if (disposed || repairing) return;
        repairing = true;
        const branch = Settings.updateBranch;
        try {
            const repaired = await repair();
            if (disposed || branch !== Settings.updateBranch) return;
            if (!repaired) throw new Error("The repair was not installed. Please try again.");
            await restart(branch);
        } catch (error) {
            UpdateLogger.error("Failed to repair Protonn Cord", error);
            if (!disposed && branch === Settings.updateBranch)
                showNotice("Failed to repair Protonn Cord. Open Updates to retry.", "View Update", viewUpdates);
        } finally {
            repairing = false;
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
        listeners.push(subscribeToUpdates(syncUpdateState));
        syncUpdateState();
    } catch (error) {
        dispose();
        throw error;
    }

    return {
        dispose,
        ...(!IS_DEV && {
            runInitial() {
                if (disposed) return;
                // Retry transient startup failures regardless of notification preferences,
                // and read the current setting so enabling automatic updates takes effect.
                interval ??= setInterval(() => {
                    if (Settings.autoUpdate) void runUpdateCheck();
                }, 30 * 60_000);
                return runUpdateCheck();
            },
        }),
    };
}
