/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function serializeErrors<Args extends unknown[], Result>(
    func: (...args: Args) => Result | Promise<Result>,
) {
    return async function (_event: unknown, ...args: Args) {
        try {
            return {
                ok: true,
                value: await func(...args),
            };
        } catch (error: unknown) {
            return {
                ok: false,
                error: error instanceof Error ? {
                    // Prototypes are lost across IPC, so turn errors into plain objects.
                    ...error,
                    message: error.message,
                    name: error.name,
                    stack: error.stack,
                } : error,
            };
        }
    };
}

/** Share one queue between operations that use the same source tree or archive. */
export function createOperationQueue() {
    let tail = Promise.resolve();
    return function enqueue<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
        const result = tail.then(operation);
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
}
