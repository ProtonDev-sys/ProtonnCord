/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { CallbackFn, FilterFn } from "./webpack";

export type SubscriptionErrorHandler = (error: unknown, filter: FilterFn, callback: CallbackFn, value: unknown) => void;

function* readableExports(exports: Record<string, any>) {
    // Match the existing shallow search: enumerable string keys, including inherited keys.
    for (const key in exports) {
        let value: any;
        try {
            value = exports[key];
        } catch {
            // Circular imports can expose getters before their binding is initialized.
            continue;
        }
        if (value != null) yield value;
    }
}

/**
 * Deliver one module to pending waiters in Map order, testing its top level first.
 * Nested exports are read lazily once between deliveries and reused by later filters.
 * A delivered callback may mutate exports, so it invalidates this dispatch-local cache.
 */
export function dispatchSubscriptions(
    subscriptions: Map<FilterFn, CallbackFn>,
    exports: any,
    moduleId: PropertyKey,
    onError: SubscriptionErrorHandler,
) {
    if (exports == null || subscriptions.size === 0) return;

    const values: any[] = [];
    let iterator: Generator<any, void> | undefined;
    let exhausted = typeof exports !== "object";

    // Keep the live Map iterator: replacement retains position, removals skip later
    // waiters, and subscriptions added by callbacks join the end of this dispatch.
    for (const [filter, callback] of subscriptions) {
        let matched = false;
        let match = exports;
        try {
            matched = filter(exports);
        } catch (error) {
            onError(error, filter, callback, exports);
        }

        for (let index = 0; !matched; index++) {
            if (index === values.length) {
                if (exhausted) break;
                iterator ??= readableExports(exports);
                try {
                    const next = iterator.next();
                    if (next.done) {
                        exhausted = true;
                        break;
                    }
                    values.push(next.value);
                } catch (error) {
                    // A Proxy can throw while enumerating keys, independently of getters.
                    exhausted = true;
                    onError(error, filter, callback, exports);
                    break;
                }
            }
            try {
                matched = filter(values[index]);
                if (matched) match = values[index];
            } catch (error) {
                onError(error, filter, callback, values[index]);
            }
        }

        if (!matched) continue;
        subscriptions.delete(filter);
        try {
            callback(match, moduleId);
        } catch (error) {
            // A throwing callback is still a completed one-shot subscription.
            onError(error, filter, callback, match);
        } finally {
            values.length = 0;
            iterator = undefined;
            exhausted = typeof exports !== "object";
        }
    }
}
