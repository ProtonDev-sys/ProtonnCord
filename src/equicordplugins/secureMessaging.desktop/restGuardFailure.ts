/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface GuardedRestFailureResponse {
    body: {
        code: 0;
        message: string;
    };
    hasErr: true;
    headers: Record<string, string>;
    ok: false;
    status: 0;
    text: string;
}

type RestCallback = (response: GuardedRestFailureResponse) => unknown;

export function guardedRestFailureResponse(error: unknown): GuardedRestFailureResponse {
    const message = error instanceof Error ? error.message : String(error);
    return {
        body: { code: 0, message },
        hasErr: true,
        headers: {},
        ok: false,
        status: 0,
        text: message,
    };
}

export function settleGuardedRestFailure(error: unknown, restArgs: readonly unknown[]): void {
    const callback = restArgs[0];
    if (typeof callback !== "function") throw error;

    const response = guardedRestFailureResponse(error);
    queueMicrotask(() => (callback as RestCallback)(response));
}
