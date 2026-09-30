/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type TranscriptionTimestamp = [number, number | null];

export const PHONON_MODEL = "FermionResearch/Phonon-2";

export class IdleResultCache<Value> {
    private readonly entries = new Map<string, { value: Value; expiresAt: number; size: number; }>();
    private readonly viewers = new Map<string, number>();
    private readonly listeners = new Map<string, Set<() => void>>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private characters = 0;

    constructor(private readonly measure: (value: Value) => number, private readonly idleMs = 300_000) { }

    get(key: string): Value | undefined {
        const entry = this.entries.get(key);
        if (entry && !this.viewers.has(key) && entry.expiresAt <= Date.now()) {
            this.delete(key);
            return undefined;
        }
        return entry?.value;
    }

    set(key: string, value: Value) {
        const previous = this.entries.get(key);
        if (previous) this.characters -= previous.size;
        this.entries.delete(key);
        const size = this.measure(value);
        this.entries.set(key, { value, size, expiresAt: Date.now() + this.idleMs });
        this.characters += size;
        while (this.entries.size > 100 || this.characters > 1_000_000) {
            const oldest = [...this.entries.keys()].find(candidate => !this.viewers.has(candidate)) ?? this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.remove(oldest);
        }
        this.schedule();
    }

    retain(key: string): () => void {
        this.viewers.set(key, (this.viewers.get(key) ?? 0) + 1);
        this.schedule();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const remaining = (this.viewers.get(key) ?? 1) - 1;
            if (remaining) this.viewers.set(key, remaining);
            else {
                this.viewers.delete(key);
                const entry = this.entries.get(key);
                if (entry) entry.expiresAt = Date.now() + this.idleMs;
            }
            this.schedule();
        };
    }

    subscribe(key: string, listener: () => void): () => void {
        const listeners = this.listeners.get(key) ?? new Set();
        listeners.add(listener);
        this.listeners.set(key, listeners);
        return () => {
            listeners.delete(listener);
            if (!listeners.size) this.listeners.delete(key);
        };
    }

    delete(key: string) {
        this.remove(key);
        this.schedule();
    }

    clear() {
        for (const key of [...this.entries.keys()]) this.remove(key);
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private remove(key: string) {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.characters -= entry.size;
        this.entries.delete(key);
        this.listeners.get(key)?.forEach(listener => listener());
    }

    private schedule() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        let next = Infinity;
        for (const [key, entry] of this.entries) {
            if (!this.viewers.has(key)) next = Math.min(next, entry.expiresAt);
        }
        if (next === Infinity) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            for (const [key, entry] of this.entries) {
                if (!this.viewers.has(key) && entry.expiresAt <= Date.now()) this.remove(key);
            }
            this.schedule();
        }, Math.max(0, next - Date.now()));
        (this.timer as any).unref?.();
    }
}

export function parsePhononResult(stdout: string): TranscriptionResult {
    const result = JSON.parse(stdout);
    if (result?.model !== PHONON_MODEL || typeof result.text !== "string" || !Array.isArray(result.segments))
        throw new Error("The local runtime did not return a Phonon-2 transcript");
    if (result.truncated !== false)
        throw new Error("Phonon-2 returned an incomplete transcript; try a shorter recording");
    return normalizeTranscriptionResult({
        text: result.text,
        chunks: result.segments.map(segment => ({ text: segment?.text, timestamp: [segment?.start, segment?.end] }))
    });
}

export interface TranscriptionChunk {
    timestamp: TranscriptionTimestamp;
    text: string;
}

export interface TranscriptionResult {
    text: string;
    chunks: TranscriptionChunk[];
}

export interface TranscriptionProgress {
    file?: string;
    loaded?: number;
    progress?: number;
    status?: string;
    total?: number;
}

export function normalizeTranscriptionResult(value: unknown): TranscriptionResult {
    const candidate = value as Partial<TranscriptionResult> | null;
    const text = typeof candidate?.text === "string" ? candidate.text.trim() : "";
    const chunks = Array.isArray(candidate?.chunks)
        ? candidate.chunks.filter((chunk): chunk is TranscriptionChunk => (
            typeof chunk?.text === "string"
            && Array.isArray(chunk.timestamp)
            && Number.isFinite(chunk.timestamp[0]) && chunk.timestamp[0] >= 0
            && (chunk.timestamp[1] === null || (Number.isFinite(chunk.timestamp[1]) && chunk.timestamp[1] >= chunk.timestamp[0]))
        ))
        : [];

    return { text, chunks };
}

export function formatTimestamp(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

export function formatTimestampedTranscript(result: TranscriptionResult): string {
    return result.chunks.map(chunk => {
        const end = chunk.timestamp[1] == null ? "end" : formatTimestamp(chunk.timestamp[1]);
        return `[${formatTimestamp(chunk.timestamp[0])} - ${end}] ${chunk.text.trim()}`;
    }).join("\n");
}
