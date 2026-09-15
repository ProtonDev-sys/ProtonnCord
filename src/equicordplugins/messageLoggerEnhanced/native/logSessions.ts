/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

import { isTrustedDiscordRendererEvent } from "./attachmentDownload";

const MAX_OPEN_SESSIONS = 8;
const IDLE_TIMEOUT_MS = 120_000;

function ownerKey(event: IpcMainInvokeEvent) {
    if (!isTrustedDiscordRendererEvent(event) || !Number.isSafeInteger(event.sender?.id)
        || !Number.isSafeInteger(event.senderFrame?.processId) || !Number.isSafeInteger(event.senderFrame?.routingId))
        throw new Error("Untrusted log file request");
    return `${event.sender.id}:${event.senderFrame!.processId}:${event.senderFrame!.routingId}`;
}

interface Session<T> {
    owner: string;
    value: T;
    timer: ReturnType<typeof setTimeout>;
    sender: IpcMainInvokeEvent["sender"];
    onDestroyed(): void;
}

export class LogSessionStore<T> {
    private readonly sessions = new Map<string, Session<T>>();
    private pending = 0;

    constructor(private readonly dispose: (value: T) => void | Promise<void>) { }

    reserve(event: IpcMainInvokeEvent) {
        ownerKey(event);
        if (this.sessions.size + this.pending >= MAX_OPEN_SESSIONS) throw new Error("Too many open log files");
        this.pending++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.pending--;
        };
    }

    add(event: IpcMainInvokeEvent, id: string, value: T) {
        const owner = ownerKey(event);
        if (event.sender.isDestroyed()) throw new Error("Log file owner has closed");
        const onDestroyed = () => {
            const session = this.remove(id);
            if (session) void Promise.resolve().then(() => this.dispose(session)).catch(() => undefined);
        };
        const timer = setTimeout(onDestroyed, IDLE_TIMEOUT_MS);
        timer.unref();
        this.sessions.set(id, { owner, value, timer, sender: event.sender, onDestroyed });
        event.sender.once("destroyed", onDestroyed);
    }

    get(event: IpcMainInvokeEvent, id: string) {
        const owner = ownerKey(event);
        if (typeof id !== "string" || id.length > 64) throw new Error("Invalid log file handle");
        const session = this.sessions.get(id);
        if (!session) return undefined;
        if (session.owner !== owner) throw new Error("Log file belongs to another renderer");
        session.timer.refresh();
        return session.value;
    }

    take(event: IpcMainInvokeEvent, id: string) {
        this.get(event, id);
        return this.remove(id);
    }

    private remove(id: string) {
        const session = this.sessions.get(id);
        if (!session) return undefined;
        this.sessions.delete(id);
        clearTimeout(session.timer);
        session.sender.removeListener("destroyed", session.onDestroyed);
        return session.value;
    }
}
