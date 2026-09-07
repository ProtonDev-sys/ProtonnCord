/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface PendingSettings<T> {
    value: T;
    paths: Set<string>;
    completion: PromiseWithResolvers<void>;
}

/** Coalesce snapshots from one turn and allow only one durable commit at a time. */
export function createSettingsPersistence<T>(persist: (value: T, paths: readonly string[]) => Promise<void>) {
    let pending: PendingSettings<T> | undefined;
    let active: Promise<void> | undefined;
    let scheduled = false;
    let failure: { error: unknown; } | undefined;

    function schedule() {
        if (scheduled || active || !pending) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            commit();
        });
    }

    function commit() {
        if (active || !pending) return;
        const batch = pending;
        pending = undefined;
        let result: Promise<void>;
        try {
            result = persist(batch.value, [...batch.paths]);
        } catch (error) {
            result = Promise.reject(error);
        }

        active = Promise.resolve(result).then(() => {
            failure = undefined;
            batch.completion.resolve();
        }, error => {
            failure = { error };
            batch.completion.reject(error);
        }).finally(() => {
            active = undefined;
            schedule();
        });
    }

    return {
        set(value: T, pathToNotify?: string | readonly string[]): Promise<void> {
            if (!pending) pending = { value, paths: new Set(), completion: Promise.withResolvers<void>() };
            else pending.value = value;
            const paths = typeof pathToNotify === "string" ? [pathToNotify] : pathToNotify ?? [];
            for (const path of paths) if (path) pending.paths.add(path);
            schedule();
            return pending.completion.promise;
        },

        /** Wait for the latest snapshot; an uncovered failed save also prevents restart. */
        async flush(): Promise<void> {
            while (active || pending) {
                commit();
                await active;
            }
            if (failure) throw failure.error;
        },
    };
}
