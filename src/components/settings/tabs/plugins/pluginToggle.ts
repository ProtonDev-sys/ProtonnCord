/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotice } from "@api/Notices";
import { isPluginEnabled, pluginRequiresRestart, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { showToast, Toasts } from "@webpack/common";

import Plugins from "~plugins";

const logger = new Logger("PluginToggle");

export type PluginToggleResult = "toggled" | "restart" | "failed";

/** Flips a plugin's enabled state, starting dependencies first and deferring patched plugins to a restart. */
export function togglePlugin(name: string, onRestartNeeded?: (name: string, key: string) => void): PluginToggleResult {
    const settings = Settings.plugins[name];
    const definition = Plugins[name];
    const wasEnabled = isPluginEnabled(name);

    // If we're enabling a plugin, make sure all deps are enabled recursively.
    if (!wasEnabled) {
        const { restartNeeded, failures } = startDependenciesRecursive(definition);

        if (failures.length) {
            logger.error(`Failed to start dependencies for ${name}: ${failures.join(", ")}`);
            showNotice("Failed to start dependencies: " + failures.join(", "), "Close", () => null);
            return "failed";
        }

        if (restartNeeded) {
            // If any dependencies have patches, don't start the plugin yet.
            settings.enabled = true;
            onRestartNeeded?.(name, "enabled");
            return "restart";
        }
    }

    // if the plugin requires a restart, don't use stopPlugin/startPlugin. Wait for restart to apply changes.
    if (pluginRequiresRestart(definition)) {
        settings.enabled = !wasEnabled;
        onRestartNeeded?.(name, "enabled");
        return "restart";
    }

    // If the plugin is enabled, but hasn't been started, then we can just toggle it off.
    if (wasEnabled && !definition.started) {
        settings.enabled = false;
        return "toggled";
    }

    const result = wasEnabled ? stopPlugin(definition) : startPlugin(definition);

    if (!result) {
        settings.enabled = false;
        showToast(`Error while ${wasEnabled ? "stopping" : "starting"} plugin ${name}`, Toasts.Type.FAILURE, {
            position: Toasts.Position.BOTTOM,
        });
        return "failed";
    }

    settings.enabled = !wasEnabled;
    return "toggled";
}
