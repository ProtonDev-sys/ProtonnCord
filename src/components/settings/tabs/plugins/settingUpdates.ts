/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** One pending change per option, shared across modal renders. */
export function createSettingChangeScheduler(commit: (key: string, value: unknown) => void, delay = 300) {
    const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; value: unknown; }>();

    function cancel() {
        for (const entry of pending.values()) clearTimeout(entry.timer);
        pending.clear();
    }

    return {
        schedule(key: string, value: unknown) {
            const previous = pending.get(key);
            if (previous) clearTimeout(previous.timer);
            const entry = {
                value,
                timer: setTimeout(() => {
                    if (pending.get(key) !== entry) return;
                    pending.delete(key);
                    commit(key, value);
                }, delay)
            };
            pending.set(key, entry);
        },
        cancel,
        flush() {
            const entries = [...pending];
            cancel();
            for (const [key, entry] of entries) commit(key, entry.value);
        }
    };
}
