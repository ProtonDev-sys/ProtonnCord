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

function authorize(values: Map<string, WireAuthorization>, key: string, expiresAt: number): void {
    values.set(key, { count: (values.get(key)?.count ?? 0) + 1, expiresAt });
}

function consumeAuthorization(values: Map<string, WireAuthorization>, key: string, now: number): boolean {
    const authorization = values.get(key);
    if (!authorization || authorization.expiresAt <= now) {
        values.delete(key);
        return false;
    }
    if (authorization.count > 1) authorization.count--;
    else values.delete(key);
    return true;
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
    authorize(authorizations, authorizationKey(channelId, content, attachmentFilenames),
        now + (attachmentFilenames.length > 0 ? ATTACHMENT_MESSAGE_AUTHORIZATION_LIFETIME_MS : AUTHORIZATION_LIFETIME_MS));
}

export function consumeWirePayloadAuthorization(
    channelId: string,
    content: string,
    attachmentFilenamesOrNow: readonly string[] | number = [],
    now = Date.now(),
): boolean {
    const attachmentFilenames = typeof attachmentFilenamesOrNow === "number" ? [] : attachmentFilenamesOrNow;
    if (typeof attachmentFilenamesOrNow === "number") now = attachmentFilenamesOrNow;
    return consumeAuthorization(authorizations, authorizationKey(channelId, content, attachmentFilenames), now);
}

export function authorizeScopedWirePayload(
    channelId: string,
    content: string,
    attachmentFilenames: readonly string[],
    scope: string,
    now = Date.now(),
): void {
    pruneAuthorizationMap(authorizations, now);
    authorize(authorizations, scopedKey(authorizationKey(channelId, content, attachmentFilenames), scope),
        now + (attachmentFilenames.length > 0 ? ATTACHMENT_MESSAGE_AUTHORIZATION_LIFETIME_MS : AUTHORIZATION_LIFETIME_MS));
}

export function consumeScopedWirePayloadAuthorization(
    channelId: string,
    content: string,
    attachmentFilenames: readonly string[],
    scope: string,
    now = Date.now(),
): boolean {
    return consumeAuthorization(authorizations, scopedKey(authorizationKey(channelId, content, attachmentFilenames), scope), now);
}

export function authorizeWireEdit(channelId: string, messageId: string, content: string, now = Date.now()): void {
    pruneAuthorizationMap(editAuthorizations, now);
    authorize(editAuthorizations, editAuthorizationKey(channelId, messageId, content), now + AUTHORIZATION_LIFETIME_MS);
}

export function consumeWireEditAuthorization(
    channelId: string,
    messageId: string,
    content: string,
    now = Date.now(),
): boolean {
    return consumeAuthorization(editAuthorizations, editAuthorizationKey(channelId, messageId, content), now);
}

export function authorizeScopedWireEdit(
    channelId: string,
    messageId: string,
    content: string,
    scope: string,
    now = Date.now(),
): void {
    pruneAuthorizationMap(editAuthorizations, now);
    authorize(editAuthorizations, scopedKey(editAuthorizationKey(channelId, messageId, content), scope), now + AUTHORIZATION_LIFETIME_MS);
}

export function consumeScopedWireEditAuthorization(
    channelId: string,
    messageId: string,
    content: string,
    scope: string,
    now = Date.now(),
): boolean {
    return consumeAuthorization(editAuthorizations, scopedKey(editAuthorizationKey(channelId, messageId, content), scope), now);
}

export function authorizeAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    now = Date.now(),
): void {
    pruneAuthorizationMap(uploadAuthorizations, now);
    for (const file of files) {
        const key = uploadAuthorizationKey(channelId, file);
        authorize(uploadAuthorizations, key, now + ATTACHMENT_UPLOAD_AUTHORIZATION_LIFETIME_MS);
    }
}

export function consumeAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    now = Date.now(),
): boolean {
    return consumeUploadReservations(channelId, files, now, "", false);
}

function consumeUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    now: number,
    scope: string,
    scoped: boolean,
): boolean {
    const required = new Map<string, number>();
    for (const file of files) {
        const base = uploadAuthorizationKey(channelId, file);
        const key = scoped ? scopedKey(base, scope) : base;
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
        if (remaining > 0) authorization.count = remaining;
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
        authorize(uploadAuthorizations, key, now + ATTACHMENT_UPLOAD_AUTHORIZATION_LIFETIME_MS);
    }
}

export function consumeScopedAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    scope: string,
    now = Date.now(),
): boolean {
    return consumeUploadReservations(channelId, files, now, scope, true);
}

export function revokeAnyAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    now = Date.now(),
): boolean {
    pruneAuthorizationMap(uploadAuthorizations, now);
    const candidates = [...uploadAuthorizations.keys()];
    const matchedKeys = new Set<string>();
    for (const file of files) {
        const base = uploadAuthorizationKey(channelId, file);
        const key = candidates.find(candidate =>
            !matchedKeys.has(candidate) &&
            (candidate === base || candidate.startsWith(`${base}\0scope:`)));
        if (!key) return false;
        matchedKeys.add(key);
    }
    for (const key of matchedKeys) uploadAuthorizations.delete(key);
    return true;
}

export function clearWirePayloadAuthorizations(): void {
    authorizations.clear();
    editAuthorizations.clear();
    uploadAuthorizations.clear();
}
