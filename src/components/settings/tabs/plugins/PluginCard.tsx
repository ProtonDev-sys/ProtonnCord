/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotice } from "@api/Notices";
import { hasAnyVisibleSettings, isPluginEnabled, pluginRequiresRestart, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { CogWheel, InfoIcon } from "@components/Icons";
import { AddonCard } from "@components/settings/AddonCard";
import { openPluginModal } from "@components/settings/tabs";
import type { PluginManifestEntry } from "@shared/pluginDefinition";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { React, showToast, Toasts } from "@webpack/common";

import Plugins, { PluginManifest, PluginMeta } from "~plugins";

const logger = new Logger("PluginCard");
const cl = classNameFactory("vc-plugins-");
interface PluginCardProps extends React.HTMLProps<HTMLDivElement> {
    plugin: Pick<PluginManifestEntry, "name" | "description" | "isModified">;
    disabled?: boolean;
    enabled?: boolean;
    hasVisibleSettings?: boolean;
    onRestartNeeded(name: string, key: string): void;
    isNew?: boolean;
    onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
    onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
}

export function PluginCard({ plugin, disabled, enabled, hasVisibleSettings, onRestartNeeded, onMouseEnter, onMouseLeave, isNew }: PluginCardProps) {
    const pluginMeta = PluginMeta[plugin.name];
    const isEquicordPlugin = pluginMeta.folderName.startsWith("src/equicordplugins/");
    const isVencordPlugin = pluginMeta.folderName.startsWith("src/plugins/");
    const isUserPlugin = pluginMeta?.userPlugin ?? false;
    const isModifiedPlugin = plugin.isModified ?? false;

    const isEnabled = () => isPluginEnabled(plugin.name);

    function toggleEnabled() {
        const settings = Settings.plugins[plugin.name];
        const definition = Plugins[plugin.name];
        const wasEnabled = isEnabled();

        // If we're enabling a plugin, make sure all deps are enabled recursively.
        if (!wasEnabled) {
            const { restartNeeded, failures } = startDependenciesRecursive(definition);

            if (failures.length) {
                logger.error(`Failed to start dependencies for ${plugin.name}: ${failures.join(", ")}`);
                showNotice("Failed to start dependencies: " + failures.join(", "), "Close", () => null);
                return;
            }

            if (restartNeeded) {
                // If any dependencies have patches, don't start the plugin yet.
                settings.enabled = true;
                onRestartNeeded(plugin.name, "enabled");
                return;
            }
        }

        // if the plugin requires a restart, don't use stopPlugin/startPlugin. Wait for restart to apply changes.
        if (pluginRequiresRestart(definition)) {
            settings.enabled = !wasEnabled;
            onRestartNeeded(plugin.name, "enabled");
            return;
        }

        // If the plugin is enabled, but hasn't been started, then we can just toggle it off.
        if (wasEnabled && !definition.started) {
            settings.enabled = !wasEnabled;
            return;
        }

        const result = wasEnabled ? stopPlugin(definition) : startPlugin(definition);

        if (!result) {
            settings.enabled = false;

            const msg = `Error while ${wasEnabled ? "stopping" : "starting"} plugin ${plugin.name}`;
            showToast(msg, Toasts.Type.FAILURE, {
                position: Toasts.Position.BOTTOM,
            });

            return;
        }

        settings.enabled = !wasEnabled;
    }

    const pluginInfo = [
        {
            condition: isModifiedPlugin,
            src: "https://raw.githubusercontent.com/ProtonDev-sys/ProtonnCord/refs/heads/main/browser/icon.png",
            alt: "Modified",
            title: "Modified Vencord Plugin"
        },
        {
            condition: isEquicordPlugin,
            src: "https://raw.githubusercontent.com/ProtonDev-sys/ProtonnCord/refs/heads/main/browser/icon.png",
            alt: "Protonn Cord",
            title: "Protonn Cord Plugin"
        },
        {
            condition: isVencordPlugin,
            src: "https://raw.githubusercontent.com/Vendicated/Vencord/main/browser/icon.png",
            alt: "Vencord",
            title: "Vencord Plugin"
        },
        {
            condition: isUserPlugin,
            src: "https://raw.githubusercontent.com/ProtonDev-sys/ProtonnCord/refs/heads/main/browser/icon.png",
            alt: "User",
            title: "User Plugin"
        }
    ];

    const pluginDetails = pluginInfo.find(p => p.condition);

    const sourceBadge = pluginDetails ? (
        <img
            src={pluginDetails.src}
            alt={pluginDetails.alt}
            className={cl("source")}
        />
    ) : null;

    const tooltip = pluginDetails?.title || "Unknown Plugin";

    return (
        <AddonCard
            name={plugin.name}
            sourceBadge={sourceBadge}
            tooltip={tooltip}
            description={plugin.description}
            isNew={isNew}
            enabled={enabled ?? isEnabled()}
            setEnabled={toggleEnabled}
            disabled={disabled}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            infoButton={
                <button
                    type="button"
                    aria-label={`Open ${plugin.name} settings and information`}
                    onClick={() => openPluginModal(Plugins[plugin.name], onRestartNeeded)}
                    className={cl("info-button")}
                >
                    {(hasVisibleSettings ?? PluginManifest[plugin.name].hasVisibleSettings ?? hasAnyVisibleSettings(Plugins[plugin.name]))
                        ? <CogWheel className={cl("info-icon")} />
                        : <InfoIcon className={cl("info-icon")} />
                    }
                </button>
            } />
    );
}
