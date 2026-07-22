/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import SettingsPlugin from "@plugins/_core/settings";
import { detectClient } from "@plugins/_core/supportHelper";
import { gitHashShort } from "@shared/vencordUserAgent";
import { React } from "@webpack/common";
import { JSX } from "react";

import { ChromiumIcon, ClientIcon, DevBannerIcon, DiscordIcon, ElectronIcon, EquicordIcon, names, settings } from ".";

export function makeDevBanner(state?: string): string | JSX.Element {
    const { RELEASE_CHANNEL, BUILD_NUMBER, VERSION_HASH } = window.GLOBAL_ENV;
    const buildChannel = names[RELEASE_CHANNEL] || RELEASE_CHANNEL.charAt(0).toUpperCase() + RELEASE_CHANNEL.slice(1);
    const { chromiumVersion, electronVersion, getVersionInfo } = SettingsPlugin;
    const format = settings.store.format ?? "{devbannerIcon} {buildChannel} {buildNumber} ({buildHash}) | {equicordIcon} {equicordName} {equicordVersion} ({equicordHash})";
    const baseFormat = state ?? format;

    const clientInfo = detectClient();

    const replaced = baseFormat
        .replace(/{buildChannel}/g, buildChannel)
        .replace(/{buildNumber}/g, BUILD_NUMBER)
        .replace(/{buildHash}/g, VERSION_HASH.slice(0, 9))
        .replace(/{equicordVersion}/g, VERSION)
        .replace(/{equicordHash}/g, gitHashShort)
        .replace(/{equicordPlatform}/g, getVersionInfo(false))
        .replace(/{electronVersion}/g, electronVersion)
        .replace(/{chromiumVersion}/g, chromiumVersion)
        .replace(/{clientName}/g, clientInfo.name)
        .replace(/{clientVersion}/g, `v${clientInfo?.version ?? "0.0.0"}`)
        .replace(/{equibopHash}/g, clientInfo.shortHash ?? "Not Supported")
        .replace(/{equibopPlatform}/g, `v${clientInfo?.dev ? "Dev Build" : "Standalone"}`)
        .replace(/\\n|{newline}/g, "__NEWLINE__");

    if (!replaced.includes("__NEWLINE__") && !/{.*Icon}/.test(baseFormat)) {
        return replaced;
    }

    const parts: React.ReactNode[] = [];
    for (const part of replaced.split(/({.*?}|__NEWLINE__)/)) {
        if (!part) continue;
        const i = parts.length;
        switch (part) {
            case "{discordIcon}":
                parts.push(<span key={`icon-discord-${i}`} className="vc-discord-dev-banner-icons"><DiscordIcon /></span>);
                break;
            case "{equicordIcon}":
                parts.push(<span key={`icon-equicord-${i}`} className="vc-discord-dev-banner-icons"><EquicordIcon /></span>);
                break;
            case "{electronIcon}":
                parts.push(<span key={`icon-electron-${i}`} className="vc-discord-dev-banner-icons"><ElectronIcon /></span>);
                break;
            case "{chromiumIcon}":
                parts.push(<span key={`icon-chromium-${i}`} className="vc-discord-dev-banner-icons"><ChromiumIcon /></span>);
                break;
            case "{devbannerIcon}":
                parts.push(<span key={`icon-dev-${i}`} className="vc-discord-dev-banner-icons"><DevBannerIcon /></span>);
                break;
            case "{clientIcon}":
                parts.push(<span key={`icon-dev-${i}`} className="vc-discord-dev-banner-icons"><ClientIcon /></span>);
                break;
            case "__NEWLINE__":
                parts.push(<br key={`br-${i}`} />);
                break;
            default:
                parts.push(<React.Fragment key={`text-${i}`}>{part}</React.Fragment>);
        }
    }

    return <div style={{ display: "inline" }}>{parts}</div>;
}
