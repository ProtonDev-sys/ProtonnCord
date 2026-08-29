/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function scopeKey(localUserId: string, peerUserId: string): string {
    return `${localUserId}\0${peerUserId}`;
}

interface KeyReviewGateState {
    attemptId: string;
    failed: boolean;
    order: number;
    pending: number;
}

function isNewerAttempt(state: KeyReviewGateState, attemptId: string, order: number): boolean {
    return order > state.order || (order === state.order && attemptId > state.attemptId);
}

export class KeyReviewGate {
    private readonly states = new Map<string, KeyReviewGateState>();

    begin(localUserId: string, peerUserId: string, attemptId: string, order: number): void {
        const scope = scopeKey(localUserId, peerUserId);
        const existing = this.states.get(scope);
        if (!existing || isNewerAttempt(existing, attemptId, order)) {
            this.states.set(scope, { attemptId, failed: false, order, pending: 1 });
            return;
        }
        if (existing.attemptId === attemptId && existing.order === order) existing.pending++;
    }

    finish(localUserId: string, peerUserId: string, attemptId: string): void {
        const state = this.states.get(scopeKey(localUserId, peerUserId));
        if (state?.attemptId === attemptId && state.pending > 0) state.pending--;
    }

    fail(localUserId: string, peerUserId: string, attemptId: string): void {
        const state = this.states.get(scopeKey(localUserId, peerUserId));
        if (state?.attemptId === attemptId) state.failed = true;
    }

    succeed(localUserId: string, peerUserId: string, attemptId: string): void {
        const state = this.states.get(scopeKey(localUserId, peerUserId));
        if (state?.attemptId === attemptId) state.failed = false;
    }

    isBlocked(localUserId: string, peerUserId: string): boolean {
        const state = this.states.get(scopeKey(localUserId, peerUserId));
        return Boolean(state && (state.pending > 0 || state.failed));
    }

    clear(): void {
        this.states.clear();
    }
}
