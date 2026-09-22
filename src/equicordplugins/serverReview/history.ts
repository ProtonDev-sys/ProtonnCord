/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DAY = 86_400_000;
export const activityKinds = ["visit", "emoji", "sticker", "sound"] as const;
export type ActivityKind = typeof activityKinds[number];
export type ReviewGroup = "unused" | "resources" | "kept" | "recent";

export interface GuildActivity {
    since: number;
    visit?: number;
    emoji?: number;
    sticker?: number;
    sound?: number;
    keep?: boolean;
    [key: string]: unknown;
}

export interface HistoryData {
    version: 1;
    guilds: Record<string, GuildActivity>;
    reminderAfter: number;
    [key: string]: unknown;
}

export function lastActivity(record: GuildActivity) {
    return Math.max(record.since, ...activityKinds.map(kind => record[kind] ?? 0));
}

export function reviewGroup(record: GuildActivity, days: number, now: number): ReviewGroup {
    if (record.keep) return "kept";
    const cutoff = now - days * DAY;
    if (Math.max(record.since, record.visit ?? 0) > cutoff) return "recent";
    return lastActivity(record) <= cutoff ? "unused" : "resources";
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function readHistory(value: unknown): HistoryData {
    if (value === undefined) return { version: 1, guilds: {}, reminderAfter: 0 };
    // A failed read or a newer format must never be replaced with empty history.
    if (!isObject(value) || value.version !== 1 || !isObject(value.guilds) || !timestamp(value.reminderAfter))
        throw new Error("Server activity history could not be read. The saved data has been left untouched.");
    for (const record of Object.values(value.guilds)) {
        if (!isObject(record) || !timestamp(record.since)
            || activityKinds.some(kind => record[kind] !== undefined && !timestamp(record[kind]))
            || (record.keep !== undefined && typeof record.keep !== "boolean"))
            throw new Error("Server activity history could not be read. The saved data has been left untouched.");
    }
    return structuredClone(value) as HistoryData;
}

/** One account's history. Events received during a slow read are kept in memory. */
export class ActivityHistory {
    data: HistoryData = { version: 1, guilds: {}, reminderAfter: 0 };
    ready = false;
    error: string | undefined;
    private revision = 0;
    private savedRevision = 0;
    private writing: Promise<void> | undefined;
    private loading: Promise<void> | undefined;
    private removedWhileLoading = new Set<string>();

    constructor(private readonly io: { read(): Promise<unknown>; write(data: HistoryData): Promise<void>; }) { }

    load(): Promise<void> {
        if (this.ready) return Promise.resolve();
        if (this.loading) return this.loading;
        this.loading = (async () => {
            try {
                const saved = readHistory(await this.io.read());
                for (const id of this.removedWhileLoading) delete saved.guilds[id];
                for (const [id, pending] of Object.entries(this.data.guilds)) {
                    const previous = saved.guilds[id];
                    if (!previous) saved.guilds[id] = pending;
                    else for (const kind of activityKinds)
                        if (pending[kind]) previous[kind] = Math.max(previous[kind] ?? 0, pending[kind]);
                }
                this.data = saved;
                this.ready = true;
                this.removedWhileLoading.clear();
                this.error = undefined;
            } catch (error) {
                this.error = error instanceof Error ? error.message : "Could not load server activity.";
            } finally {
                this.loading = undefined;
            }
        })();
        return this.loading;
    }

    ensure(id: string, now: number) {
        if (!Object.hasOwn(this.data.guilds, id)) {
            this.data.guilds[id] = { since: now };
            this.revision++;
        }
        return this.data.guilds[id];
    }

    record(id: string, kind: ActivityKind, now: number) {
        const record = this.ensure(id, now);
        if ((record[kind] ?? 0) >= now) return;
        record[kind] = now;
        this.revision++;
    }

    remove(id: string) {
        if (!this.ready) {
            this.removedWhileLoading.add(id);
            delete this.data.guilds[id];
            this.revision++;
            return;
        }
        if (!Object.hasOwn(this.data.guilds, id)) return;
        delete this.data.guilds[id];
        this.revision++;
    }

    keep(id: string, keep: boolean, now: number) {
        if (!this.ready) return;
        this.ensure(id, now).keep = keep;
        this.revision++;
    }

    snooze(until: number) {
        if (!this.ready) return;
        this.data.reminderAfter = until;
        this.revision++;
    }

    get dirty() { return this.revision !== this.savedRevision; }

    async flush(): Promise<void> {
        if (!this.ready) return;
        if (this.writing) {
            await this.writing;
            return this.flush();
        }
        if (!this.dirty) return;
        const { revision } = this;
        const snapshot = structuredClone(this.data);
        this.writing = this.io.write(snapshot).then(() => {
            this.savedRevision = revision;
            this.error = undefined;
        }).catch(error => {
            this.error = "Could not save server activity. It will be retried.";
            throw error;
        });
        try {
            await this.writing;
        } finally {
            this.writing = undefined;
        }
    }
}
