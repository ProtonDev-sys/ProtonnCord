/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs, EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { FluxDispatcher, Menu, React, Tooltip, UserStore } from "@webpack/common";

interface CallUpdate {
    ringing: string[];
    ongoingRings: string[];
    messageId: string;
    region: string;
}

const callUpdates = new Map<string, CallUpdate>();
const ignoredChannelIds = new Set<string>();
let accountId: string | undefined;

function checkAccount() {
    const currentId = UserStore.getCurrentUser()?.id;
    if (accountId !== currentId) {
        callUpdates.clear();
        ignoredChannelIds.clear();
        accountId = currentId;
    }
    return currentId;
}

function dismissCall(channelId: string, currentUserId: string) {
    if (checkAccount() !== currentUserId) return;
    const args = callUpdates.get(channelId);
    if (!args || !args.ringing.includes(currentUserId) && !args.ongoingRings.includes(currentUserId)) return;
    FluxDispatcher.dispatch({
        type: "CALL_UPDATE",
        channelId,
        ...args,
        ringing: args.ringing.filter(id => id !== currentUserId),
        ongoingRings: args.ongoingRings.filter(id => id !== currentUserId)
    });
}

const cl = classNameFactory("vc-ignore-calls-");
const Deafen = findComponentByCodeLazy("0-1.02-.1H3.05a9");

const ContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }: { channel: Channel; }) => {
    checkAccount();
    const permanentlyIgnoredUsers = settings.store.permanentlyIgnoredUsers.split(",").map(s => s.trim()).filter(Boolean);

    const [tempChecked, setTempChecked] = React.useState(ignoredChannelIds.has(channel?.id));
    const [permChecked, setPermChecked] = React.useState(permanentlyIgnoredUsers.includes(channel?.id));
    if (!channel) return;

    children.push(
        <>
            <Menu.MenuSeparator />
            <Menu.MenuCheckboxItem
                id="vc-ignore-calls-temp"
                label="Temporarily Ignore Calls"
                checked={tempChecked}
                action={() => {
                    if (tempChecked)
                        ignoredChannelIds.delete(channel.id);
                    else
                        ignoredChannelIds.add(channel.id);

                    setTempChecked(!tempChecked);
                }}
            />
            <Menu.MenuCheckboxItem
                id="vc-ignore-calls-perm"
                label="Permanently Ignore Calls"
                checked={permChecked}
                action={() => {
                    let updated = settings.store.permanentlyIgnoredUsers.split(",").map(value => value.trim()).filter(Boolean);
                    const isIgnored = updated.includes(channel.id);
                    if (isIgnored) {
                        updated = updated.filter(id => id !== channel.id);
                    } else {
                        updated.push(channel.id);
                    }
                    settings.store.permanentlyIgnoredUsers = updated.join(", ");

                    setPermChecked(!isIgnored);
                }}
            />
        </>
    );
};

const settings = definePluginSettings({
    permanentlyIgnoredUsers: {
        type: OptionType.STRING,
        description: "User IDs (comma + space) who should be permanetly ignored",
        restartNeeded: true,
        default: "",
    },
});

export default definePlugin({
    name: "IgnoreCalls",
    description: "Allows you to ignore calls from specific users or dm groups.",
    tags: ["Voice"],
    authors: [EquicordDevs.TheArmagan, Devs.thororen],
    settings,
    patches: [
        {
            find: "#{intl::INCOMING_CALL_ELLIPSIS}",
            replacement: {
                match: /(?<=onCallJoined:\(\).{0,150})\(\i\)\}\),className:\i\.\i\}\)/,
                replace: "$&,$self.renderIgnore(arguments[0].channel)"
            }
        }
    ],
    contextMenus: {
        "user-context": ContextMenuPatch,
        "gdm-context": ContextMenuPatch,
    },
    flux: {
        CALL_UPDATE({ channelId, ringing, ongoingRings, messageId, region }) {
            checkAccount();
            if (!channelId) return;
            const previous = callUpdates.get(channelId);
            callUpdates.set(channelId, {
                ringing: Array.isArray(ringing) ? ringing : previous?.ringing ?? [],
                ongoingRings: Array.isArray(ongoingRings) ? ongoingRings : previous?.ongoingRings ?? [],
                messageId: messageId ?? previous?.messageId ?? "",
                region: region ?? previous?.region ?? ""
            });
        },
        CALL_DELETE({ channelId }) {
            callUpdates.delete(channelId);
        }
    },
    stop() {
        callUpdates.clear();
        ignoredChannelIds.clear();
        accountId = undefined;
    },
    renderIgnore(channel) {
        const currentUserId = checkAccount();
        if (!currentUserId || !channel) return null;
        const permanentlyIgnoredUsers = settings.store.permanentlyIgnoredUsers.split(",").map(s => s.trim()).filter(Boolean);
        if (ignoredChannelIds.has(channel.id) || permanentlyIgnoredUsers.includes(channel.id)) {
            dismissCall(channel.id, currentUserId);
            return null;
        }

        return (
            <ErrorBoundary>
                <Tooltip text="Ignore">
                    {({ onMouseEnter, onMouseLeave }) => (
                        <Button
                            className={cl("button")}
                            size="small"
                            onMouseEnter={onMouseEnter}
                            onMouseLeave={onMouseLeave}
                            onClick={() => dismissCall(channel.id, currentUserId)}
                        >
                            <Deafen color={"var(--interactive-icon-active)"} />
                        </Button>
                    )}
                </Tooltip>
            </ErrorBoundary>
        );
    }
});
