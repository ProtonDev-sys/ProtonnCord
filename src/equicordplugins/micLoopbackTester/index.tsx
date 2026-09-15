/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserAreaButton, UserAreaButtonFactory, UserAreaRenderProps } from "@api/UserArea";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { MediaEngineStore, React, showToast, Toasts, UserStore, VoiceActions, VoiceStateStore } from "@webpack/common";

let loopbackActive = false;
let selfDeafenedByPlugin = false;
let deafenedAccountId: string | undefined;
let pluginActive = false;
let lifecycleGeneration = 0;
let togglePending = false;
let operationQueue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
let stateVersion = 0;

function notifyState() {
    stateVersion++;
    for (const listener of listeners) {
        try { listener(); } catch { }
    }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function enqueue<T>(operation: () => Promise<T>) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => undefined);
    return result;
}

function isInVoiceChannel() {
    const id = UserStore.getCurrentUser()?.id;
    if (!id) return false;
    const state = VoiceStateStore.getVoiceStateForUser(id);
    return Boolean(state?.channelId);
}

async function enableLoopback() {
    const generation = lifecycleGeneration;
    const accountId = UserStore.getCurrentUser()?.id;
    if (!pluginActive || !accountId) return false;
    try {
        await VoiceActions.setLoopback("mic_test", true);
        loopbackActive = true;
        if (!pluginActive || generation !== lifecycleGeneration || UserStore.getCurrentUser()?.id !== accountId) {
            await disableLoopback();
            return false;
        }

        if (isInVoiceChannel() && !MediaEngineStore.isSelfDeaf()) {
            await VoiceActions.toggleSelfDeaf();
            selfDeafenedByPlugin = true;
            deafenedAccountId = accountId;
        } else {
            selfDeafenedByPlugin = false;
        }

        return true;
    } catch {
        await disableLoopback();
        showToast("Could not start microphone loopback.", Toasts.Type.FAILURE);
        return false;
    } finally {
        notifyState();
    }
}

async function disableLoopback() {
    try {
        await VoiceActions.setLoopback("mic_test", false);
        loopbackActive = false;
    } catch {
        showToast("Could not stop microphone loopback.", Toasts.Type.FAILURE);
    }
    try {
        if (selfDeafenedByPlugin && deafenedAccountId === UserStore.getCurrentUser()?.id && MediaEngineStore.isSelfDeaf()) {
            await VoiceActions.toggleSelfDeaf();
        }
    } catch {
        showToast("Could not restore your deafen setting.", Toasts.Type.FAILURE);
    } finally {
        selfDeafenedByPlugin = false;
        deafenedAccountId = undefined;
        notifyState();
    }
}

async function toggleLoopback() {
    if (!pluginActive || togglePending) return;
    togglePending = true;
    const generation = lifecycleGeneration;
    notifyState();
    try {
        await enqueue(async () => {
            if (!pluginActive || generation !== lifecycleGeneration) return;
            if (loopbackActive) await disableLoopback();
            else await enableLoopback();
        });
    } finally {
        togglePending = false;
        notifyState();
    }
}

function stopOwnedLoopback() {
    lifecycleGeneration++;
    return enqueue(async () => {
        if (loopbackActive || selfDeafenedByPlugin) await disableLoopback();
    });
}

function MicLoopbackIcon({ active = false, className = "" }: { active?: boolean; className?: string; }) {
    const maskId = React.useId();
    const redLinePath = "M22.7 2.7a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4Z";
    const maskBlackPath = "M23.27 4.73 19.27 .73 -.27 20.27 3.73 24.27Z";

    return (
        <svg
            className={className}
            width="20"
            height="20"
            viewBox="0 0 24 24"
        >
            <path
                fill={!active ? "var(--status-danger)" : "currentColor"}
                mask={!active ? `url(#${maskId})` : void 0}
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z"
            />
            <path
                fill={!active ? "var(--status-danger)" : "currentColor"}
                mask={!active ? `url(#${maskId})` : void 0}
                fillRule="evenodd"
                clipRule="evenodd"
                d="M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z"
            />
            {!active && <>
                <path fill="var(--status-danger)" d={redLinePath} />
                <mask id={maskId}>
                    <rect fill="white" x="0" y="0" width="24" height="24" />
                    <path fill="black" d={maskBlackPath} />
                </mask>
            </>}
        </svg>
    );
}

function MicLoopbackButton({ iconForeground, hideTooltips, nameplate }: UserAreaRenderProps) {
    React.useSyncExternalStore(subscribe, () => stateVersion);

    return (
        <UserAreaButton
            tooltipText={hideTooltips ? void 0 : "Mic Test Loopback"}
            icon={<MicLoopbackIcon active={loopbackActive} className={iconForeground} />}
            role="switch"
            aria-checked={loopbackActive}
            aria-busy={togglePending}
            redGlow={!loopbackActive}
            plated={nameplate != null}
            onClick={toggleLoopback}
        />
    );
}

const MicLoopbackUserAreaButton: UserAreaButtonFactory = props => <MicLoopbackButton {...props} />;

export default definePlugin({
    name: "MicLoopbackTester",
    description: "Adds mic loopback test icon to the user panel",
    tags: ["Utility", "Voice"],
    authors: [EquicordDevs.benjii],
    dependencies: ["UserSettingsAPI", "UserAreaAPI"],
    userAreaButton: {
        icon: MicLoopbackIcon,
        render: MicLoopbackUserAreaButton
    },

    start() {
        lifecycleGeneration++;
        pluginActive = true;
    },

    flux: {
        LOGOUT: stopOwnedLoopback,
        CONNECTION_OPEN: stopOwnedLoopback,
    },

    stop() {
        pluginActive = false;
        return stopOwnedLoopback();
    },
});
