/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MAX_OPTIMISTIC_PLAINTEXTS = 128;
const OPTIMISTIC_PLAINTEXT_TTL_MS = 60_000;

interface OptimisticPlaintextEntry {
    expiresAt: number;
    groupable: boolean;
    plaintext: string;
}

const optimisticPlaintexts = new Map<string, OptimisticPlaintextEntry>();

function pruneOptimisticPlaintexts(now: number): void {
    for (const [ciphertext, entry] of optimisticPlaintexts) {
        if (entry.expiresAt <= now) optimisticPlaintexts.delete(ciphertext);
    }
    while (optimisticPlaintexts.size > MAX_OPTIMISTIC_PLAINTEXTS) {
        const oldest = optimisticPlaintexts.keys().next().value;
        if (typeof oldest !== "string") break;
        optimisticPlaintexts.delete(oldest);
    }
}

export function rememberOptimisticOutgoingPlaintext(
    ciphertext: string,
    plaintext: string,
    groupable = false,
    now = Date.now(),
): void {
    pruneOptimisticPlaintexts(now);
    optimisticPlaintexts.delete(ciphertext);
    optimisticPlaintexts.set(ciphertext, {
        expiresAt: now + OPTIMISTIC_PLAINTEXT_TTL_MS,
        groupable,
        plaintext,
    });
    pruneOptimisticPlaintexts(now);
}

export function getOptimisticOutgoingPlaintext(ciphertext: string, now = Date.now()): string | undefined {
    pruneOptimisticPlaintexts(now);
    const entry = optimisticPlaintexts.get(ciphertext);
    if (!entry) return undefined;
    optimisticPlaintexts.delete(ciphertext);
    optimisticPlaintexts.set(ciphertext, entry);
    return entry.plaintext;
}

export function isProvisionalOutgoingMessage(messageId: string, nonce: string | null): boolean {
    return nonce === messageId;
}

export function getOptimisticOutgoingPlaintextForGrouping(ciphertext: string, now = Date.now()): string | undefined {
    const plaintext = getOptimisticOutgoingPlaintext(ciphertext, now);
    return optimisticPlaintexts.get(ciphertext)?.groupable ? plaintext : undefined;
}

export function settleOptimisticOutgoingPlaintext(
    ciphertext: string,
    messageId: string,
    nonce: string | null,
): void {
    // Discord first renders a local send under its request nonce, then replaces that row with the
    // canonical server ID. Clearing at the provisional stage creates a blank render between them.
    if (!isProvisionalOutgoingMessage(messageId, nonce)) optimisticPlaintexts.delete(ciphertext);
}

export function clearOptimisticOutgoingPlaintexts(): void {
    optimisticPlaintexts.clear();
}

export function optimisticOutgoingPlaintextCountForTest(now = Date.now()): number {
    pruneOptimisticPlaintexts(now);
    return optimisticPlaintexts.size;
}
