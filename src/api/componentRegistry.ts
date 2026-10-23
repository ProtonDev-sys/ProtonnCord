/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { React } from "@webpack/common";

const logger = new Logger("ComponentRegistry");

/** Private UI contributions, sorted only when registration changes. */
export function createComponentRegistry<T extends { priority: number; }>(order: "ascending" | "descending" = "ascending") {
    const entries = new Map<string, T>();
    const listeners = new Set<() => void>();
    let snapshot: ReadonlyArray<readonly [string, T]> = [];
    const getSnapshot = () => snapshot;
    const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    };

    function update() {
        snapshot = [...entries].sort(([, a], [, b]) => order === "ascending" ? a.priority - b.priority : b.priority - a.priority);
        for (const listener of listeners) {
            try {
                listener();
            } catch (error) {
                logger.error("Component registry listener failed", error);
            }
        }
    }

    return {
        set(id: string, entry: T) {
            entries.set(id, entry);
            update();
        },
        delete(id: string) {
            if (entries.delete(id)) update();
        },
        useEntries() {
            return React.useSyncExternalStore(subscribe, getSnapshot);
        }
    };
}
