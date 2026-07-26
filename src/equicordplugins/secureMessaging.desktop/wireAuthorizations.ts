/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const AUTHORIZATION_LIFETIME_MS = 30_000;
const MAX_AUTHORIZATIONS = 512;

interface WireAuthorization {
    count: number;
    expiresAt: number;
}

const authorizations = new Map<string, WireAuthorization>();

function authorizationKey(channelId: string, content: string): string {
    return `${channelId}\0${content}`;
}

function pruneAuthorizations(now: number): void {
    for (const [key, authorization] of authorizations) {
        if (authorization.expiresAt <= now) authorizations.delete(key);
    }
    while (authorizations.size >= MAX_AUTHORIZATIONS) {
        const oldestKey = authorizations.keys().next().value;
        if (oldestKey == null) break;
        authorizations.delete(oldestKey);
    }
}

export function authorizeWirePayload(channelId: string, content: string, now = Date.now()): void {
    pruneAuthorizations(now);
    const key = authorizationKey(channelId, content);
    const existing = authorizations.get(key);
    authorizations.set(key, {
        count: (existing?.count ?? 0) + 1,
        expiresAt: now + AUTHORIZATION_LIFETIME_MS,
    });
}

export function consumeWirePayloadAuthorization(channelId: string, content: string, now = Date.now()): boolean {
    const key = authorizationKey(channelId, content);
    const authorization = authorizations.get(key);
    if (!authorization || authorization.expiresAt <= now) {
        authorizations.delete(key);
        return false;
    }
    if (authorization.count > 1) {
        authorizations.set(key, { ...authorization, count: authorization.count - 1 });
    } else {
        authorizations.delete(key);
    }
    return true;
}

export function clearWirePayloadAuthorizations(): void {
    authorizations.clear();
}
