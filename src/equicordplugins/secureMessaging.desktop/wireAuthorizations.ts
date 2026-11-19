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

function expireAuthorizations(values: Map<string, WireAuthorization>, now: number): void {
    for (const [key, authorization] of values) {
        if (authorization.expiresAt <= now) values.delete(key);
    }
}

function authorize(values: Map<string, WireAuthorization>, key: string, expiresAt: number): void {
    const count = (values.get(key)?.count ?? 0) + 1;
    values.delete(key);
    values.set(key, { count, expiresAt });
    if (values.size > MAX_AUTHORIZATIONS) values.delete(values.keys().next().value!);
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
    expireAuthorizations(authorizations, now);
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
    expireAuthorizations(authorizations, now);
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

export function authorizeScopedWireEdit(
    channelId: string,
    messageId: string,
    content: string,
    scope: string,
    now = Date.now(),
): void {
    expireAuthorizations(editAuthorizations, now);
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

export function authorizeScopedAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    scope: string,
    now = Date.now(),
): void {
    expireAuthorizations(uploadAuthorizations, now);
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
    const required = new Map<string, number>();
    for (const file of files) {
        const base = uploadAuthorizationKey(channelId, file);
        const key = scopedKey(base, scope);
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

export function revokeAnyAttachmentUploadReservations(
    channelId: string,
    files: readonly AuthorizedAttachmentFile[],
    now = Date.now(),
): boolean {
    expireAuthorizations(uploadAuthorizations, now);
    if (!files.length) return false;
    const remaining = new Map<string, number>();
    for (const file of files) {
        const prefix = uploadAuthorizationKey(channelId, file) + "\0scope:";
        let matched = false;
        for (const [key, authorization] of uploadAuthorizations) {
            if (!key.startsWith(prefix)) continue;
            const count = remaining.get(key) ?? authorization.count;
            if (count === 0) continue;
            remaining.set(key, count - 1);
            matched = true;
            break;
        }
        if (!matched) return false;
    }
    for (const key of remaining.keys()) uploadAuthorizations.delete(key);
    return true;
}

export function clearWirePayloadAuthorizations(): void {
    authorizations.clear();
    editAuthorizations.clear();
    uploadAuthorizations.clear();
}
