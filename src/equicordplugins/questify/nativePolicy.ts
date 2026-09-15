/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;
const FORBIDDEN_TEXT_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export const MAX_QUESTIFY_AUTH_CODE_LENGTH = 4096;
export const MAX_QUESTIFY_PROXY_TICKET_LENGTH = 4096;
export const MAX_QUESTIFY_TOKEN_LENGTH = 8192;
export const MAX_QUESTIFY_RESPONSE_BYTES = 64 * 1024;
export const QUESTIFY_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_QUESTIFY_PROGRESS = 24 * 60 * 60;

export type QuestifyRoute = "authorize" | "progress";

export function isDiscordSnowflake(value: unknown): value is string {
    return typeof value === "string" && DISCORD_SNOWFLAKE.test(value);
}

export function isBoundedPlainText(value: unknown, maxLength: number): value is string {
    return typeof value === "string"
        && value.length > 0
        && value.length <= maxLength
        && value.trim() === value
        && !FORBIDDEN_TEXT_CHARACTERS.test(value);
}

export function isQuestTarget(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_QUESTIFY_PROGRESS;
}

export function buildQuestifyUrl(appId: string, route: QuestifyRoute): URL | null {
    if (!isDiscordSnowflake(appId)) return null;

    const expectedHostname = `${appId}.discordsays.com`;
    const expectedPath = route === "authorize" ? "/.proxy/acf/authorize" : "/.proxy/acf/quest/progress";
    const url = new URL(`https://${expectedHostname}`);
    url.pathname = expectedPath;

    if (url.protocol !== "https:"
        || url.hostname !== expectedHostname
        || url.port !== ""
        || url.username !== ""
        || url.password !== ""
        || url.pathname !== expectedPath
        || url.search !== ""
        || url.hash !== "") {
        return null;
    }

    return url;
}

export function buildQuestifyReferrer(appId: string, proxyTicket: unknown): string | null | undefined {
    if (proxyTicket === undefined) return undefined;
    if (!isBoundedPlainText(proxyTicket, MAX_QUESTIFY_PROXY_TICKET_LENGTH)) return null;

    const base = buildQuestifyUrl(appId, "authorize");
    if (base == null) return null;

    base.pathname = "/";
    base.searchParams.set("instance_id", "example-cl-instance");
    base.searchParams.set("platform", "desktop");
    base.searchParams.set("discord_proxy_ticket", proxyTicket);
    return base.href;
}
