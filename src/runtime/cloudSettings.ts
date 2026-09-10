/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Settings, SettingsStore } from "@api/Settings";
import { getCloudRequestContext, getCloudSyncScope } from "@api/SettingsSync/cloudSetup";
import { areLocalSettingsDirty, getCloudSettings, getCloudSyncDirection, markLocalSettingsDirty, putCloudSettings, shouldCloudSync } from "@api/SettingsSync/cloudSync";
import { Logger } from "@utils/Logger";
import { relaunch } from "@utils/native";
import { SettingsRouter } from "@webpack/common";

import type { RendererService } from "./bootstrap";

const logger = new Logger("CloudSettings");

/** Observe local edits immediately; initial authorization and network work are deferred by the runtime. */
export function createCloudSettingsService(): RendererService {
    let disposed = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;

    function currentScope() {
        try {
            return getCloudSyncScope();
        } catch {
            return null;
        }
    }

    function localChange() {
        if (disposed) return;
        try {
            markLocalSettingsDirty();
            clearTimeout(saveTimer);
            const scope = currentScope();
            saveTimer = setTimeout(() => {
                saveTimer = undefined;
                if (disposed || scope === null || currentScope() !== scope) return;
                try {
                    if (Settings.cloud.settingsSync && Settings.cloud.authenticated && shouldCloudSync("push"))
                        void putCloudSettings().catch(() => logger.error("Cloud upload failed"));
                } catch {
                    logger.error("Cloud upload failed");
                }
            }, 60_000);
        } catch {
            logger.error("Could not track local cloud settings changes");
        }
    }

    SettingsStore.addGlobalChangeListener(localChange);
    let removeQuickCss: () => void;
    try {
        removeQuickCss = VencordNative.quickCss.addChangeListener(localChange);
    } catch (error) {
        SettingsStore.removeGlobalChangeListener(localChange);
        throw error;
    }

    async function disableMissingCurrentAuthorization() {
        if (disposed || !Settings.cloud.authenticated) return;
        const expectedScope = currentScope();
        if (expectedScope === null) return;
        try {
            await getCloudRequestContext();
            return;
        } catch { }
        if (disposed || currentScope() !== expectedScope || !Settings.cloud.authenticated) return;
        showNotification({
            title: "Cloud Settings",
            body: "Cloud sync was disabled because this account isn't connected to the cloud App. You can enable it again by connecting this account in Cloud Settings. (note: it will store your preferences separately)",
            color: "var(--yellow-360)",
            onClick: () => SettingsRouter.openUserSettings("equicord_cloud_panel")
        });
        Settings.cloud.authenticated = false;
    }

    async function syncInitialSettings() {
        if (disposed) return;
        let authenticationContext;
        try {
            authenticationContext = await getCloudRequestContext();
        } catch { }
        if (disposed) return;
        if (!authenticationContext) {
            await disableMissingCurrentAuthorization();
            return;
        }
        try {
            const currentContext = await getCloudRequestContext();
            if (disposed || currentContext.scope !== authenticationContext.scope || currentContext.origin !== authenticationContext.origin)
                return;
        } catch {
            await disableMissingCurrentAuthorization();
            return;
        }

        if (!Settings.cloud.settingsSync || !Settings.cloud.authenticated || getCloudSyncDirection() === "manual") return;
        if (areLocalSettingsDirty() && shouldCloudSync("push")) {
            await putCloudSettings();
        } else if (shouldCloudSync("pull") && await getCloudSettings(false)) {
            if (disposed || currentScope() !== authenticationContext.scope) return;
            showNotification({
                title: "Cloud Settings",
                body: "Your settings have been updated! Click here to restart to fully apply changes!",
                color: "var(--green-360)",
                onClick: relaunch
            });
        }
    }

    return {
        runInitial: () => syncInitialSettings().catch(() => {
            // Startup status/logging must not include cloud credentials or server error bodies.
            throw new Error("Cloud settings initialization failed");
        }),
        dispose() {
            if (disposed) return;
            disposed = true;
            clearTimeout(saveTimer);
            try {
                SettingsStore.removeGlobalChangeListener(localChange);
            } finally {
                removeQuickCss();
            }
        },
    };
}
