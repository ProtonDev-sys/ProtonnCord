/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const AUTHORIZATION_LIFETIME_MS = 30_000;
const ATTACHMENT_MESSAGE_AUTHORIZATION_LIFETIME_MS = 60 * 60 * 1_000;
const ATTACHMENT_UPLOAD_AUTHORIZATION_LIFETIME_MS = 60 * 60 * 1_000;
const MAX_AUTHORIZATIONS = 512;

interface WireAuthorization {
    count: number;
    expiresAt: number;
}

const authorizations = new Map<string, WireAuthorization>();
const editAuthorizations = new Map<string, WireAuthorization>();
const uploadAuthorizations = new Map<string, WireAuthorization>();

export interface AuthorizedAttachmentFile {
    filename: string;
    size: number;
}

function authorizationKey(channelId: string, content: string, attachmentFilenames: readonly string[]): string {
    return `${channelId}\0${content}\0${JSON.stringify(attachmentFilenames)}`;
}

function scopedKey(key: string, scope: string): string {
    return `${key}\0scope:${scope}`;
}

function uploadAuthorizationKey(channelId: string, file: AuthorizedAttachmentFile): string {
    return `${channelId}\0${file.filename}\0${file.size}`;
}

function editAuthorizationKey(channelId: string, messageId: string, content: string): string {
    return `${channelId}\0${messageId}\0${content}`;
}

function pruneAuthorizationMap(values: Map<string, WireAuthorization>, now: number): void {
    for (const [key, authorization] of values) {
        if (authorization.expiresAt <= now) values.delete(key);
    }
    while (values.size >= MAX_AUTHORIZATIONS) {
        const oldestKey = values.keys().next().value;
        if (oldestKey == null) break;
        values.delete(oldestKey);
    }
}

export function authorizeWirePayload(
    channelId: string,
    content: string,
    attachmentFilenamesOrNow: readonly string[] | number = [],
    now = Date.now(),
): void {
    const attachmentFilenames = typeof attachmentFilenamesOrNow === "number" ? [] : attachmentFilenamesOrNow;
    if (typeof attachmentFilenamesOrNow === "number") now = attachmentFilenamesOrNow;
    pruneAuthorizationMap(authorizations, now);
    const key = authorizationKey(channelId, content, attachmentFilenames);
    const existing = authorizations.get(key);
    authorizations.set(key, {
        count: (existing?.count ?? 0) + 1,
        expiresAt: now + (attachmentFilenames.length > 0 ? ATTACHMENT_MESSAGE_AUTHORIZATION_LIFETIME_MS : AUTHORIZATION_LIFETIME_MS),
    });
}

export function consumeWirePayloadAuthorization(
    channelId: string,
    content: string,
    attachmentFilenamesOrNow: readonly string[] | number = [],
    now = Date.now(),
): boolean {
    const attachmentFilenames = typeof attachmentFilenamesOrNow === "number" ? [] : attachmentFilenamesOrNow;
    if (typeof attachmentFilenamesOrNow === "number") now = attachmentFilenamesOrNow;
    const key = authorizationKey(channelId, content, attachmentFilenames);
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

export function authorizeScopedWirePayload(
    channelId: string,
    content: string,
    attachmentFilenames: readonly string[],
    scope: string,
    now = Date.now(),
): void {
    pruneAuthorizationMap(authorizations, now);
    const key = scopedKey(authorizationKey(channelId, content, attachmentFilenames), scope);
    const existing = authorizations.get(key);
    authorizations.set(key, {
        count: (existing?.count ?? 0) + 1,
        expiresAt: now + (attachmentFilenames.length > 0 ? ATTACHMENT_MESSAGE_AUTHORIZATION_LIFETIME_MS : AUTHORIZATION_LIFETIME_MS),
    });
}

export function consumeScopedWirePayloadAuthorization(
    channelId: string,
    content: string,
    attachmentFilenames: readonly string[],
    scope: string,
    now = Date.now(),
): boolean {
    const key = scopedKey(authorizationKey(channelId, content, attachmentFilenames), scope);
    const authorization = authorizations.get(key);
    if (!authorization || authorization.expiresAt <= now) {
        authorizations.delete(key);
        return false;
    }
    if (authorization.count > 1)
        authorizations.set(key, { ...authorization, count: authorization.count - 1 });
    else
        authorizations.delete(key);
    return true;
}

export function authorizeWireEdit(channelId: string, messageId: string, content: string, now = Date.now()): void {
    pruneAuthorizationMap(editAuthorizations, now);
    const key = editAuthorizationKey(channelId, messageId, content);
    const existing = editAuthorizations.get(key);
    editAuthorizations.set(key, {
        count: (existing?.count ?? 0) + 1,
        expiresAt: now + AUTHORIZATION_LIFETIME_MS,
    });
}

export function consumeWireEditAuthorization(
    channelId: string,
    messageId: string,
    content: string,
    now = Date.now(),
): boolean {
    const key = editAuthorizationKey(channelId, messageId, content);
    const authorization = editAuthorizations.get(key);
    if (!authorization || authorization.expiresAt <= now) {
        editAuthorizations.delete(key);
        return false;
    }
    if (authorization.count > 1)
        editAuthorizations.set(key, { ...authorization, count: authorization.count - 1 });
    else
        editAuthorizations.delete(key);
    return true;
}

export function authorizeScopedWireEdit(
    channelId: string,
    messageId: string,
    content: string,
    scope: string,
    now = Date.now(),
): void {
    pruneAuthorizationMap(editAuthorizations, now);
    const key = scopedKey(editAuthorizationKey(channelId, messageId, content), scope);
    const existing = editAuthorizations.get(key);
    editAuthorizations.set(key, {
        count: (existing?.count ?? 0) + 1,
        expiresAt: now + AUTHORIZATION_LIFETIME_MS,
    });
}

export function consumeScopedWireEditAuthorization(
    channelId: string,
    messageId: string,
    content: string,
    scope: string,
    now = Date.now(),
): boolean {
    const key = scopedKey(editAuthorizationKey(channelId, messageId, content), scope);
    const authorization = editAuthorizations.get(key);
    if (!authorization || authorization.expiresAt <= now) {
        editAuthorizations.delete(key);
        return false;
    }
    if (authorization.count > 1)
        editAuthorizations.set(key, { ...authorization, count: authorization.count - 1 });
    else
        editAuthorizations.delete(key);
    return true;
}

export function authorizeAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    now = Date.now(),
): void {
    pruneAuthorizationMap(uploadAuthorizations, now);
    for (const file of files) {
        const key = uploadAuthorizationKey(channelId, file);
        const existing = uploadAuthorizations.get(key);
        uploadAuthorizations.set(key, {
            count: (existing?.count ?? 0) + 1,
            expiresAt: now + ATTACHMENT_UPLOAD_AUTHORIZATION_LIFETIME_MS,
        });
    }
}

export function consumeAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    now = Date.now(),
): boolean {
    const required = new Map<string, number>();
    for (const file of files) {
        const key = uploadAuthorizationKey(channelId, file);
        required.set(key, (required.get(key) ?? 0) + 1);
    }
    for (const [key, count] of required) {
        const authorization = uploadAuthorizations.get(key);
        if (!authorization || authorization.expiresAt <= now || authorization.count < count) {
            if (authorization?.expiresAt && authorization.expiresAt <= now) uploadAuthorizations.delete(key);
            return false;
        }
    }
    for (const [key, count] of required) {
        const authorization = uploadAuthorizations.get(key);
        if (!authorization) return false;
        const remaining = authorization.count - count;
        if (remaining > 0) uploadAuthorizations.set(key, { ...authorization, count: remaining });
        else uploadAuthorizations.delete(key);
    }
    return true;
}

export function authorizeScopedAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    scope: string,
    now = Date.now(),
): void {
    pruneAuthorizationMap(uploadAuthorizations, now);
    for (const file of files) {
        const key = scopedKey(uploadAuthorizationKey(channelId, file), scope);
        const existing = uploadAuthorizations.get(key);
        uploadAuthorizations.set(key, {
            count: (existing?.count ?? 0) + 1,
            expiresAt: now + ATTACHMENT_UPLOAD_AUTHORIZATION_LIFETIME_MS,
        });
    }
}

export function consumeScopedAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    scope: string,
    now = Date.now(),
): boolean {
    const required = new Map<string, number>();
    for (const file of files) {
        const key = scopedKey(uploadAuthorizationKey(channelId, file), scope);
        required.set(key, (required.get(key) ?? 0) + 1);
    }
    for (const [key, count] of required) {
        const authorization = uploadAuthorizations.get(key);
        if (!authorization || authorization.expiresAt <= now || authorization.count < count) {
            if (authorization?.expiresAt && authorization.expiresAt <= now) uploadAuthorizations.delete(key);
            return false;
        }
    }
    for (const [key, count] of required) {
        const authorization = uploadAuthorizations.get(key);
        if (!authorization) return false;
        const remaining = authorization.count - count;
        if (remaining > 0) uploadAuthorizations.set(key, { ...authorization, count: remaining });
        else uploadAuthorizations.delete(key);
    }
    return true;
}

export function revokeAnyAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    now = Date.now(),
): boolean {
    pruneAuthorizationMap(uploadAuthorizations, now);
    const matchedKeys: string[] = [];
    for (const file of files) {
        const base = uploadAuthorizationKey(channelId, file);
        const key = [...uploadAuthorizations.keys()].find(candidate =>
            candidate === base || candidate.startsWith(`${base}\0scope:`));
        if (!key) return false;
        matchedKeys.push(key);
    }
    for (const key of matchedKeys) uploadAuthorizations.delete(key);
    return true;
}

export function clearWirePayloadAuthorizations(): void {
    authorizations.clear();
    editAuthorizations.clear();
    uploadAuthorizations.clear();
}
