/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type AsyncTask<T> = () => Promise<T>;

export function createTaskQueue(maxActive: number) {
    if (!Number.isInteger(maxActive) || maxActive < 1)
        throw new Error("Task queue concurrency must be a positive integer");

    let active = 0;
    const waiting: Array<() => void> = [];

    return async function run<T>(task: AsyncTask<T>): Promise<T> {
        if (active >= maxActive) await new Promise<void>(resolve => waiting.push(resolve));
        else active++;

        try {
            return await task();
        } finally {
            const next = waiting.shift();
            if (next) next();
            else active--;
        }
    };
}
