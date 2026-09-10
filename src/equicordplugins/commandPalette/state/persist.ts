/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { notifyPaletteChange } from "../api/registry";

const logger = new Logger("CommandPalette");

export function createPersistedValue<T>(key: string, fallback: T) {
    const fullKey = `CommandPalette_${key}`;
    let value = fallback;
    let revision = 0;
    let saveQueue = Promise.resolve();
    let pendingLoad: Promise<void> | undefined;

    return {
        load(): Promise<void> {
            if (pendingLoad) return pendingLoad;
            const loadRevision = revision;
            pendingLoad = saveQueue
                .then(() => DataStore.get<T>(fullKey))
                .then(stored => {
                    if (revision !== loadRevision) return;
                    if (stored !== undefined) value = stored;
                    notifyPaletteChange();
                })
                .finally(() => { pendingLoad = undefined; });
            return pendingLoad;
        },
        get(): T {
            return value;
        },
        set(next: T) {
            revision++;
            value = next;
            saveQueue = saveQueue
                .then(() => DataStore.set(fullKey, next))
                .catch(error => logger.error(`Failed to save ${key}`, error));
            notifyPaletteChange();
        }
    };
}
