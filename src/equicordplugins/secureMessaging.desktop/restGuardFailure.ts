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

export function discordApiPathname(url: unknown): string | null {
    if (typeof url !== "string" || url.length > 500) return null;
    try {
        return new URL(url, "https://discord.invalid").pathname.replace(/^\/api(?:\/v\d+)?(?=\/)/u, "");
    } catch {
        return null;
    }
}

export function messageEndpoint(url: unknown, edit: boolean): { channelId: string; messageId: string | null; } | null {
    const pathname = discordApiPathname(url);
    if (pathname === null) return null;
    const pattern = edit
        ? /^\/channels\/(\d{17,20})\/messages\/(\d{17,20})$/u
        : /^\/channels\/(\d{17,20})\/messages$/u;
    const match = pattern.exec(pathname);
    return match ? { channelId: match[1], messageId: match[2] ?? null } : null;
}

export function attachmentReservationEndpoint(url: unknown): { channelId: string; } | null {
    const pathname = discordApiPathname(url);
    const match = pathname === null ? null : /^\/channels\/(\d{17,20})\/attachments$/u.exec(pathname);
    return match ? { channelId: match[1] } : null;
}

export function installStartupRestGuard(rest: Record<string, any>, blocked: () => boolean): () => void {
    const disposers: Array<() => void> = [];
    for (const method of ["post", "patch"] as const) {
        const original = rest[method];
        if (typeof original !== "function") continue;
        const guarded = async function (this: unknown, request: Record<string, any>, ...args: unknown[]) {
            if (blocked() && (messageEndpoint(request?.url, method === "patch") ||
                (method === "post" && attachmentReservationEndpoint(request?.url))))
                return settleGuardedRestFailure(new Error("Secure Messaging application guards are unavailable. Restart before sending."), args);
            return original.call(this, request, ...args);
        };
        rest[method] = guarded;
        disposers.push(() => {
            if (rest[method] === guarded) rest[method] = original;
        });
    }
    return () => disposers.forEach(dispose => dispose());
}
