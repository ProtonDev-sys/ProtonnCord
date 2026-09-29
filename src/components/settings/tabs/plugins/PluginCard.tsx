/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./PluginCard.css";

import { hasAnyVisibleSettings, isPluginEnabled } from "@api/PluginManager";
import { Badge } from "@components/Badge";
import { CogWheel, InfoIcon, StarFilled } from "@components/Icons";
import { openPluginModal } from "@components/settings/tabs";
import { Switch } from "@components/Switch";
import type { PluginManifestEntry } from "@shared/pluginDefinition";
import { classNameFactory } from "@utils/css";
import { React } from "@webpack/common";
import type { MouseEvent } from "react";

import Plugins, { PluginManifest, PluginMeta } from "~plugins";

import { togglePlugin } from "./pluginToggle";
import { getPluginSource } from "./shared";

const cl = classNameFactory("vc-plugin-card-");

interface PluginCardProps extends React.HTMLProps<HTMLDivElement> {
    plugin: Pick<PluginManifestEntry, "name" | "description" | "isModified">;
    disabled?: boolean;
    enabled?: boolean;
    hasVisibleSettings?: boolean;
    onRestartNeeded(name: string, key: string): void;
    isNew?: boolean;
    isFavorite?: boolean;
    /** Enabled plugins that keep this one on. Only shown for disabled (required) cards. */
    requiredBy?: readonly string[];
    onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
    onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
}

const stopPropagation = (event: MouseEvent) => event.stopPropagation();

export function PluginCard({ plugin, disabled, enabled, hasVisibleSettings, onRestartNeeded, onMouseEnter, onMouseLeave, isNew, isFavorite, requiredBy }: PluginCardProps) {
    const { name } = plugin;
    const titleId = React.useId();
    const source = getPluginSource(PluginMeta[name], plugin.isModified);
    const showCog = hasVisibleSettings ?? PluginManifest[name]?.hasVisibleSettings ?? hasAnyVisibleSettings(Plugins[name]);
    const isEnabled = enabled ?? isPluginEnabled(name);

    const openDetails = () => openPluginModal(Plugins[name], onRestartNeeded);

    return (
        <div
            className={cl("root", { enabled: isEnabled, disabled })}
            onClick={openDetails}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className={cl("header")}>
                <span id={titleId} className={cl("name")} title={name}>{name}</span>
                {isNew && <Badge text="New" variant="danger" />}
                {isFavorite && <StarFilled aria-label="Favorite" className={cl("favorite")} width={14} height={14} />}
                <div className={cl("actions")} onClick={stopPropagation}>
                    <button
                        type="button"
                        aria-label={`Open ${name} ${showCog ? "settings" : "information"}`}
                        title={showCog ? "Settings" : "Information"}
                        onClick={openDetails}
                        className={cl("details")}
                    >
                        {showCog
                            ? <CogWheel width={18} height={18} />
                            : <InfoIcon width={18} height={18} />
                        }
                    </button>
                    <Switch
                        aria-labelledby={titleId}
                        checked={isEnabled}
                        onChange={() => togglePlugin(name, onRestartNeeded)}
                        disabled={disabled}
                    />
                </div>
            </div>

            <p className={cl("description")} title={plugin.description}>{plugin.description}</p>

            {(source || disabled) && (
                <div className={cl("footer")}>
                    {source && <span className={cl("source")} title={source.title}>{source.label}</span>}
                    {disabled && (
                        <span className={cl("required")} title={requiredBy?.join(", ")}>
                            {requiredBy?.length ? `Required by ${requiredBy.join(", ")}` : "Required"}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
