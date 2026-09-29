/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SettingsStore } from "@api/Settings";
import type { Activity } from "@vencord/discord-types";

import { settings, SettingsStore as ServiceSettings } from "../settings";

export interface PresenceUpdate {
    signal: AbortSignal;
    isCurrent(): boolean;
    wait<T>(work: Promise<T>): Promise<T>;
}

/** One bounded update owns its settings, cancellation and completion guard. */
export function createPresencePolling(
    prefix: "abs" | "jf" | "sfm",
    intervalMs: number,
    getActivity: (config: ServiceSettings, update: PresenceUpdate) => Promise<Activity | null>,
    setActivity: (activity: Activity | null) => void,
    reset: () => void,
    onError: () => void,
) {
    let running = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let active: { update: PresenceUpdate; controller: AbortController; deadline?: ReturnType<typeof setTimeout>; } | undefined;
    let previousEntries: Array<readonly [keyof ServiceSettings, unknown]> | undefined;

    function cancel() {
        const previous = active;
        active = undefined;
        clearTimeout(previous?.deadline);
        previous?.controller.abort();
    }

    async function poll() {
        if (!running) return;
        if (previousEntries && !previousEntries.every(([key, value]) => Object.is(settings.store[key], value))) {
            cancel();
            reset();
            setActivity(null);
        }
        if (active) return;

        const keys = Object.keys(settings.def).filter(key => key.startsWith(`${prefix}_`)) as Array<keyof ServiceSettings>;
        const entries = keys.map(key => [key, settings.store[key]] as const);
        previousEntries = entries;
        const config = Object.fromEntries(entries) as ServiceSettings;
        const controller = new AbortController();
        const { signal } = controller;
        const update: PresenceUpdate = {
            signal,
            isCurrent: () => running && active?.update === update && !signal.aborted
                && entries.every(([key, value]) => Object.is(settings.store[key], value)),
            wait<T>(work: Promise<T>): Promise<T> {
                return new Promise((resolve, reject) => {
                    const abort = () => reject(signal.reason);
                    signal.addEventListener("abort", abort, { once: true });
                    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
                    if (signal.aborted) abort();
                });
            }
        };
        const current = active = { update, controller, deadline: undefined as ReturnType<typeof setTimeout> | undefined };
        current.deadline = setTimeout(() => {
            if (active?.update !== update) return;
            cancel();
            setActivity(null);
        }, 15_000);
        try {
            const activity = await getActivity(config, update);
            if (update.isCurrent()) setActivity(activity);
        } catch {
            if (update.isCurrent()) {
                onError();
                setActivity(null);
            }
        } finally {
            clearTimeout(current.deadline);
            if (active?.update === update) active = undefined;
        }
    }

    function onSettingsChange(_: unknown, path: string) {
        if (path && path !== "plugins" && path !== "plugins.RichPresence"
            && !path.startsWith(`plugins.RichPresence.${prefix}_`)) return;
        if (path === `plugins.RichPresence.${prefix}_enabled`) return;
        cancel();
        previousEntries = undefined;
        reset();
        // Remove already-published details immediately, even if replacement work stalls.
        setActivity(null);
        void poll();
    }

    return {
        start() {
            if (running) return;
            running = true;
            previousEntries = undefined;
            reset();
            SettingsStore.addGlobalChangeListener(onSettingsChange);
            interval = setInterval(poll, intervalMs);
            void poll();
        },
        stop() {
            running = false;
            SettingsStore.removeGlobalChangeListener(onSettingsChange);
            clearInterval(interval);
            interval = undefined;
            cancel();
            previousEntries = undefined;
            reset();
            setActivity(null);
        }
    };
}
