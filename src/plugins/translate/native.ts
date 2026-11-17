/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

import { buildOpenAITranslationRequest, parseOpenAITranslation } from "./openai";

export async function makeOpenAITranslateRequest(_: IpcMainInvokeEvent, apiKey: string, model: string, text: string, sourceLang: string, targetLang: string) {
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512 || /[\r\n]/.test(apiKey)
        || typeof model !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(model)
        || typeof text !== "string" || text.length > 32_000
        || typeof sourceLang !== "string" || sourceLang.length > 100
        || typeof targetLang !== "string" || !targetLang.trim() || targetLang.length > 100)
        return { error: "Check your OpenAI key, model and languages. Messages must be under 32,000 characters." };

    if (!text.trim()) return { translation: { sourceLanguage: sourceLang, text } };

    try {
        const res = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey.trim()}`
            },
            body: JSON.stringify(buildOpenAITranslationRequest(model, text, sourceLang, targetLang)),
            signal: AbortSignal.timeout(30_000)
        });
        // Do not forward API error bodies: they can contain credentials or message text.
        if (!res.ok) {
            switch (res.status) {
                case 401: return { error: "Invalid OpenAI API key. Check the key in Translate settings." };
                case 403: return { error: "This OpenAI API key does not have access to the selected model." };
                case 404: return { error: "OpenAI model unavailable. Select another model in Translate settings." };
                case 429: return { error: "OpenAI rate limit or API credit balance reached. Check your API usage and billing." };
                default: return { error: `OpenAI translation request failed (HTTP ${res.status}). Please retry.` };
            }
        }
        const response = await res.json();
        try {
            return { translation: parseOpenAITranslation(response) };
        } catch (error) {
            return { error: (error as Error).message };
        }
    } catch {
        return { error: "Could not reach OpenAI or the translation timed out. Please retry." };
    }
}

export async function makeDeeplTranslateRequest(_: IpcMainInvokeEvent, pro: boolean, apiKey: string, payload: string) {
    const url = pro
        ? "https://api.deepl.com/v2/translate"
        : "https://api-free.deepl.com/v2/translate";

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `DeepL-Auth-Key ${apiKey}`
            },
            body: payload,
            signal: AbortSignal.timeout(10_000)
        });

        const data = await res.text();
        return { status: res.status, data };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}

export async function makeKagiTranslateRequest(_: IpcMainInvokeEvent, token: string, text: string, sourceLang: string, targetLang: string) {
    const url = "https://translate.kagi.com/api/translate";

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Cookie": `kagi_session=${token}`
            },
            body: JSON.stringify({
                text,
                from: sourceLang,
                to: targetLang,
                model: "standard"
            }),
            signal: AbortSignal.timeout(10_000)
        });

        const data = await res.json();
        return { status: res.status, data };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}
