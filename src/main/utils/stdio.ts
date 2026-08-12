/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface GuardableStdioStream {
    listenerCount(eventName: string | symbol): number;
    on(eventName: "error", listener: (error: unknown) => void): unknown;
    write(...args: unknown[]): unknown;
}

const guardedStreams = new WeakSet<object>();

export function isBrokenPipeError(error: unknown): boolean {
    return typeof error === "object" && error !== null &&
        (error as { code?: unknown; }).code === "EPIPE";
}

export function guardStdioBrokenPipe(stream: GuardableStdioStream | null | undefined): void {
    if (!stream) return;
    if (guardedStreams.has(stream)) return;
    guardedStreams.add(stream);

    const originalWrite = stream.write;
    stream.write = function (...args: unknown[]): unknown {
        try {
            return Reflect.apply(originalWrite, this, args);
        } catch (error) {
            if (isBrokenPipeError(error)) return true;
            throw error;
        }
    };

    stream.on("error", error => {
        if (!isBrokenPipeError(error) && stream.listenerCount("error") === 1) throw error;
    });
}

export function installStdioBrokenPipeGuards(): void {
    guardStdioBrokenPipe(process.stdout as unknown as GuardableStdioStream | undefined);
    guardStdioBrokenPipe(process.stderr as unknown as GuardableStdioStream | undefined);
}
