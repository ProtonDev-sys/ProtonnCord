/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { BrowserWindow, type IpcMainInvokeEvent } from "electron";

import {
    buildQuestifyReferrer,
    buildQuestifyUrl,
    isBoundedPlainText,
    isDiscordSnowflake,
    isQuestTarget,
    MAX_QUESTIFY_AUTH_CODE_LENGTH,
    MAX_QUESTIFY_RESPONSE_BYTES,
    MAX_QUESTIFY_TOKEN_LENGTH,
    QUESTIFY_REQUEST_TIMEOUT_MS,
    type QuestifyRoute
} from "./nativePolicy";

const TRUSTED_RENDERER_ORIGINS = new Set([
    "https://canary.discord.com",
    "https://discord.com",
    "https://ptb.discord.com"
]);

type CompleteResult = { success: boolean; error: string | null; };

function failure(error: string): CompleteResult {
    return { success: false, error };
}

function isTrustedQuestifyEvent(event: IpcMainInvokeEvent): boolean {
    if (RendererSettings.store.plugins?.Questify?.enabled !== true) return false;

    try {
        const frame = event?.senderFrame;
        if (!frame || !event?.sender || event.sender.isDestroyed() || frame !== event.sender.mainFrame) return false;

        const rawUrl = frame.url;
        if (typeof rawUrl !== "string" || rawUrl.length < 1 || rawUrl.length > 4096) return false;
        const url = new URL(rawUrl);
        return url.protocol === "https:" && !url.username && !url.password && !url.port
            && TRUSTED_RENDERER_ORIGINS.has(url.origin);
    } catch {
        return false;
    }
}

export function canOpenDevTools(event: IpcMainInvokeEvent): boolean {
    return !event.sender.isDestroyed();
}

export function openDevTools(event: IpcMainInvokeEvent): boolean {
    if (!canOpenDevTools(event)) {
        return false;
    }

    const window = BrowserWindow.fromWebContents(event.sender);

    if (event.sender.isDevToolsOpened()) {
        window?.focus();

        return true;
    }

    event.sender.openDevTools();

    return true;
}

export async function complete(event: IpcMainInvokeEvent, appId: unknown, authCode: unknown, questTarget: unknown, questId: unknown, proxyTicket?: unknown): Promise<CompleteResult> {
    if (!isTrustedQuestifyEvent(event)) return failure("UNTRUSTED_REQUEST");
    if (!isDiscordSnowflake(appId) || !isDiscordSnowflake(questId)
        || !isBoundedPlainText(authCode, MAX_QUESTIFY_AUTH_CODE_LENGTH)
        || !isQuestTarget(questTarget)) {
        return failure("INVALID_INPUT");
    }

    const activityReferrer = buildQuestifyReferrer(appId, proxyTicket);
    if (activityReferrer === null) return failure("INVALID_INPUT");

    const authorization = await authorize(appId, authCode, questId, activityReferrer);

    if (!authorization.token) return failure("AUTH_FAILED");

    const progressResult = await progress(appId, authorization.token, questTarget, questId, activityReferrer);

    if (!progressResult) return failure("PROGRESS_FAILED");

    return { success: true, error: null };
}

function getActivityHeaders(questId: string, authToken: string = "", activityReferrer?: string): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Discord-Quest-ID": questId,
    };

    if (authToken) {
        headers["X-Auth-Token"] = authToken;
    }

    if (activityReferrer) {
        headers.Referer = activityReferrer;
    }

    return headers;
}

async function readLimitedJson(res: Response): Promise<unknown> {
    const declaredLength = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_QUESTIFY_RESPONSE_BYTES) {
        await res.body?.cancel();
        return null;
    }

    try {
        if (res.body == null) return null;

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value == null) continue;
            total += value.byteLength;
            if (total > MAX_QUESTIFY_RESPONSE_BYTES) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

function getResponseToken(data: unknown): string | false {
    if (data != null && typeof data === "object" && "token" in data
        && isBoundedPlainText(data.token, MAX_QUESTIFY_TOKEN_LENGTH)) {
        return data.token;
    }

    return false;
}

async function request<T>(
    appId: string,
    route: QuestifyRoute,
    headers: Record<string, string>,
    body: string,
    handleResponse: (response: Response) => Promise<T>
): Promise<T | null> {
    const url = buildQuestifyUrl(appId, route);
    if (url == null) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), QUESTIFY_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            body,
            credentials: "omit",
            headers,
            method: "POST",
            mode: "cors",
            redirect: "error",
            signal: controller.signal
        });
        return await handleResponse(response);
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function authorize(appId: string, authCode: string, questId: string, activityReferrer?: string): Promise<{ token: string | false; }> {
    const token = await request(
        appId,
        "authorize",
        getActivityHeaders(questId, "", activityReferrer),
        JSON.stringify({ code: authCode }),
        async response => {
            const data = await readLimitedJson(response);
            const token = getResponseToken(data);
            return response.ok ? token : false;
        }
    );
    return { token: token ?? false };
}

async function progress(appId: string, token: string, questTarget: number, questId: string, activityReferrer?: string): Promise<boolean> {
    return await request(
        appId,
        "progress",
        getActivityHeaders(questId, token, activityReferrer),
        JSON.stringify({ progress: questTarget }),
        async response => {
            await response.body?.cancel();
            return response.ok;
        }
    ) ?? false;
}
