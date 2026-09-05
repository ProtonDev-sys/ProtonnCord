/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs, IS_MAC } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { useForceUpdater } from "@utils/react";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { Button, ChannelRouter, ChannelStore, closeModal, IconUtils, lodash, Modal, openModal, React, RelationshipStore, SelectedChannelStore, Toasts, UserStore, useStateFromStores } from "@webpack/common";

const STORAGE_KEY = "RDMSwitch_history";
const logger = new Logger("RecentDMSwitcher");

interface History {
    userId: string;
    ids: string[];
    saved: string[];
    ready: boolean;
}

interface Cycle {
    ids: string[];
    index: number;
    toastId: string;
}

let history: History | undefined;
let cycle: Cycle | undefined;
let overlay: { key?: string; } | undefined;
let overlayRerender: (() => void) | undefined;

const cl = classNameFactory("vc-rdms-");

const settings = definePluginSettings({
    visualStyle: {
        type: OptionType.SELECT,
        description: "Visual indicator style while cycling",
        options: [
            { label: "Overlay (Alt+Tab style)", value: "overlay", default: true },
            { label: "Toast (status message)", value: "toast" },
            { label: "Off", value: "off" }
        ]
    },
    overlayMode: {
        type: OptionType.SELECT,
        description: "Overlay content",
        options: [
            { label: "Recent conversations", value: "row", default: true },
            { label: "Current only", value: "current" }
        ]
    },
    amountOfUsers: {
        type: OptionType.SLIDER,
        description: "Number of recent conversations to remember.",
        markers: makeRange(10, 50, 10),
        stickToMarkers: true,
        default: 20,
    },
    overlayRowLength: {
        type: OptionType.SLIDER,
        description: "Number of recent DMs to show in row",
        markers: [3, 4, 5, 6, 7],
        default: 5
    },
    overlayShowAvatars: {
        type: OptionType.BOOLEAN,
        description: "Show avatars in overlay",
        default: true
    },
    toastDurationMs: {
        type: OptionType.SLIDER,
        description: "Toast hide delay (ms)",
        markers: [300, 500, 600, 800, 1000, 1500, 2000],
        default: 600
    },
    clearRdms: {
        type: OptionType.COMPONENT,
        description: "Clear the saved recent DM history.",
        component: ClearHistory
    }
});

const OVERLAY_SETTINGS: ["visualStyle", "overlayMode", "overlayShowAvatars", "overlayRowLength"] =
    ["visualStyle", "overlayMode", "overlayShowAvatars", "overlayRowLength"];

function boundedSetting(value: number, minimum: number, maximum: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value))) : fallback;
}

function historyLimit(): number {
    return boundedSetting(settings.store.amountOfUsers, 10, 50, 20);
}

function isDirectMessageChannel(channelId: string | null | undefined): channelId is string {
    if (!channelId) return false;
    const channel = ChannelStore.getChannel(channelId);
    // Include 1:1 DMs and Group DMs
    return Boolean(channel && (channel.isDM() || channel.isGroupDM()));
}

function normalizeHistory(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("Recent DM history is not a list");
    return [...new Set(value.filter((id): id is string => typeof id === "string" && /^\d{17,20}$/.test(id)))];
}

function isCurrent(owner: History): boolean {
    return history === owner && owner.userId === UserStore.getCurrentUser()?.id;
}

async function saveHistory(owner: History): Promise<boolean> {
    const snapshot = owner.ids;
    try {
        await DataStore.set(`${STORAGE_KEY}_${owner.userId}`, snapshot);
        if (owner.ids === snapshot) owner.saved = snapshot;
        return true;
    } catch (error) {
        logger.error("Could not save recent DM history", error);
        if (isCurrent(owner)) Toasts.show(Toasts.create("Could not save recent DMs. Your changes will be retried on the next selection.", Toasts.Type.FAILURE));
        return false;
    }
}

function rememberChannel(channelId: string): void {
    const owner = history;
    if (!owner?.ready || !isCurrent(owner)) return;
    const next = [channelId, ...owner.ids.filter(id => id !== channelId)].slice(0, historyLimit());
    if (next.length !== owner.ids.length || next.some((id, i) => id !== owner.ids[i])) owner.ids = next;
    if (owner.ids !== owner.saved) void saveHistory(owner);
}

function ClearHistory() {
    const [busy, setBusy] = React.useState(false);
    return (
        <Button color={Button.Colors.RED} disabled={busy} onClick={async () => {
            const owner = history;
            if (!owner?.ready || !isCurrent(owner)) {
                Toasts.show(Toasts.create("Recent DM history is not loaded. Enable the plugin while signed in and try again.", Toasts.Type.FAILURE));
                return;
            }
            setBusy(true);
            cancelCycle();
            owner.ids = [];
            try {
                if (await saveHistory(owner) && isCurrent(owner)) Toasts.show(Toasts.create("Cleared recent DM history", Toasts.Type.SUCCESS));
            } finally {
                setBusy(false);
            }
        }}>
            Clear recent DM history
        </Button>
    );
}

function closeOverlay(): void {
    const previous = overlay;
    overlay = undefined;
    if (previous?.key) closeModal(previous.key);
}

function cancelCycle(): void {
    cycle = undefined;
    closeOverlay();
}

function finishCycle(): void {
    const selected = cycle?.ids[cycle.index];
    cancelCycle();
    if (!history || !isCurrent(history) || !isDirectMessageChannel(selected)) return;
    ChannelRouter.transitionToChannel(selected);
    rememberChannel(selected);
}

function stopEvent(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function onKeyDown(event: KeyboardEvent): void {
    if (!history?.ready || !isCurrent(history)) {
        cancelCycle();
        return;
    }
    if (cycle && event.key === "Escape") {
        stopEvent(event);
        cancelCycle();
        return;
    }
    if (event.key !== "Tab" || event.altKey || !(event.ctrlKey || (IS_MAC && event.metaKey))) return;
    if (!cycle) {
        const current = SelectedChannelStore.getChannelId();
        const ids = [...new Set([...(isDirectMessageChannel(current) ? [current] : []), ...history.ids])]
            .filter(isDirectMessageChannel).slice(0, historyLimit());
        if (!ids.length || (ids.length === 1 && ids[0] === current)) return;
        cycle = { ids, index: ids[0] === current || event.shiftKey ? 0 : -1, toastId: Toasts.genId() };
    }
    stopEvent(event);
    cycle.index = (cycle.index + (event.shiftKey ? -1 : 1) + cycle.ids.length) % cycle.ids.length;
    if (settings.store.visualStyle === "overlay") {
        if (!overlay) {
            const opened: { key?: string; } = {};
            overlay = opened;
            opened.key = openModal(props => <OverlayContent {...props} />, {
                onCloseCallback() {
                    if (overlay !== opened) return;
                    overlay = undefined;
                    cancelCycle();
                }
            });
        }
        overlayRerender?.();
    } else {
        closeOverlay();
        if (settings.store.visualStyle === "toast") {
            const { name } = getDisplayForChannel(cycle.ids[cycle.index]);
            Toasts.show({
                id: cycle.toastId,
                message: `Switching to: ${name}`,
                type: Toasts.Type.MESSAGE,
                options: { position: Toasts.Position.BOTTOM, duration: boundedSetting(settings.store.toastDurationMs, 300, 2000, 600) }
            });
        }
    }
}

function onKeyUp(event: KeyboardEvent): void {
    if (!cycle || (event.key !== "Control" && (!IS_MAC || event.key !== "Meta"))) return;
    stopEvent(event);
    if (!(event.ctrlKey || (IS_MAC && event.metaKey))) finishCycle();
}

function getDisplayForChannel(id: string) {
    const channel = ChannelStore.getChannel(id);
    if (!channel) return { name: "Unknown", avatar: "" };
    if (channel.isDM()) {
        const userId = channel.recipients?.[0];
        const user = userId ? UserStore.getUser(userId) : undefined;
        const nickname = user ? RelationshipStore.getNickname(user.id) : undefined;
        return { name: nickname ?? user?.globalName ?? user?.username ?? "DM", avatar: user ? IconUtils.getUserAvatarURL(user, true, 64) : "" };
    }
    return { name: channel.name || "Group DM", avatar: IconUtils.getChannelIconURL(channel) ?? "" };
}

const OverlayContent = ErrorBoundary.wrap((props: RenderModalProps) => {
    const { visualStyle, overlayMode, overlayShowAvatars, overlayRowLength } = settings.use(OVERLAY_SETTINGS);
    const forceUpdate = useForceUpdater();
    React.useEffect(() => {
        overlayRerender = forceUpdate;
        return () => { if (overlayRerender === forceUpdate) overlayRerender = undefined; };
    }, [forceUpdate]);
    React.useEffect(() => { if (visualStyle !== "overlay") closeOverlay(); }, [visualStyle]);
    const active = cycle;
    const ids = active?.ids;
    const displays = useStateFromStores([ChannelStore, UserStore, RelationshipStore],
        () => ids?.map(getDisplayForChannel) ?? [], [ids], lodash.isEqual);
    if (!active || visualStyle !== "overlay") return null;
    const pageSize = overlayMode === "current" ? 1 : boundedSetting(overlayRowLength, 3, 7, 5);
    const currentPage = Math.floor(active.index / pageSize);
    const start = currentPage * pageSize;
    const pageCount = Math.ceil(active.ids.length / pageSize);
    return (
        <Modal {...props} title="Recent direct messages" size="lg">
            <div className={cl("cards")} role="list" aria-label="Recent direct messages">
                {active.ids.slice(start, start + pageSize).map((id, i) => {
                    const { name, avatar } = displays[start + i];
                    return (
                        <div key={id} className={cl("background")} role="listitem" aria-current={id === active.ids[active.index] ? "true" : undefined}>
                            {overlayShowAvatars && avatar && <img alt="" src={avatar} className={cl("avatar")} />}
                            <div className={cl("name")}>{name}</div>
                        </div>
                    );
                })}
            </div>
            <div className={cl("selection")} aria-live="polite">{displays[active.index].name}. Release Control{IS_MAC ? " or Command" : ""} to switch.</div>
            {pageCount > 1 && <div className={cl("selection")}>Page {currentPage + 1} of {pageCount}</div>}
        </Modal>
    );
}, { noop: true });

function stop(): void {
    history = undefined;
    cancelCycle();
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", cancelCycle);
}

async function start(): Promise<void> {
    const userId = UserStore.getCurrentUser()?.id;
    if (history?.userId === userId) return;
    stop();
    if (!userId) return;
    const owner: History = { userId, ids: [], saved: [], ready: false };
    history = owner;
    try {
        let saved = await DataStore.get<unknown>(`${STORAGE_KEY}_${userId}`);
        if (!isCurrent(owner)) return;
        if (saved === undefined) {
            const legacy = await DataStore.get<unknown>(STORAGE_KEY);
            if (!isCurrent(owner)) return;
            saved = normalizeHistory(legacy).filter(isDirectMessageChannel);
        }
        owner.ids = normalizeHistory(saved).slice(0, historyLimit());
        owner.saved = owner.ids;
        owner.ready = true;
        const current = SelectedChannelStore.getChannelId();
        if (isDirectMessageChannel(current)) rememberChannel(current);
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", cancelCycle);
    } catch (error) {
        logger.error("Could not load recent DM history", error);
        if (isCurrent(owner)) {
            history = undefined;
            Toasts.show(Toasts.create("Could not load recent DMs. Restart the plugin to try again.", Toasts.Type.FAILURE));
        }
    }
}

export default definePlugin({
    name: "RecentDMSwitcher",
    description: "Ctrl+Tab between most recently used DMs (Ctrl+Shift+Tab reverse)",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.mmeta],
    settings,
    flux: {
        CONNECTION_OPEN: start,
        LOGOUT: stop,
        CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            cancelCycle();
            if (!isDirectMessageChannel(channelId)) return;
            rememberChannel(channelId);
        }
    },
    start,
    stop
});
