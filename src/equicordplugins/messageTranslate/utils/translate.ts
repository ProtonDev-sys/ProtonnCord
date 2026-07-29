/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { getExcludedLanguages, settings } from "../settings";
import { CachedTranslation, TranslateResponse } from "../types";

const logger = new Logger("MessageTranslate");

const translationCache = new Map<string, CachedTranslation>();
const translationConfigurations = new Map<string, string>();
const inProgress = new Map<string, string>();
const failed = new Map<string, { configuration: string; text: string; }>();

function getConfiguration(): string {
    return JSON.stringify([
        settings.store.targetLanguage.trim().toLowerCase(),
        settings.store.confidenceRequirement,
        [...getExcludedLanguages()].sort(),
    ]);
}

export function getCached(messageId: string): CachedTranslation | undefined {
    if (translationConfigurations.get(messageId) !== getConfiguration()) {
        clearCache(messageId);
        return undefined;
    }
    return translationCache.get(messageId);
}

export function hasFailed(messageId: string, text: string): boolean {
    const failure = failed.get(messageId);
    return failure?.text === text && failure.configuration === getConfiguration();
}

export function isInProgress(messageId: string): boolean {
    return inProgress.get(messageId) === getConfiguration();
}

export function clearCache(messageId: string) {
    translationCache.delete(messageId);
    translationConfigurations.delete(messageId);
    failed.delete(messageId);
}

async function fetchTranslation(text: string, targetLang: string): Promise<TranslateResponse> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&dj=1&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Translation API returned ${response.status} ${response.statusText}`);
    }

    return await response.json();
}

export async function translate(messageId: string, text: string): Promise<CachedTranslation | null> {
    const configuration = getConfiguration();
    if (inProgress.get(messageId) === configuration) return null;
    const cached = getCached(messageId);
    if (cached) return cached;

    inProgress.set(messageId, configuration);

    try {
        const targetLang = settings.store.targetLanguage.trim().toLowerCase();
        const response = await fetchTranslation(text, targetLang);
        const sourceLang = response.src.trim().toLowerCase();

        if (sourceLang === targetLang || response.confidence < settings.store.confidenceRequirement || getExcludedLanguages().has(sourceLang)) {
            if (configuration === getConfiguration()) failed.set(messageId, { configuration, text });
            return null;
        }

        let translatedText = "";
        for (const sentence of response.sentences) {
            if (sentence.trans) translatedText += sentence.trans;
        }

        if (!translatedText || translatedText === text) {
            if (configuration === getConfiguration()) failed.set(messageId, { configuration, text });
            return null;
        }

        const entry: CachedTranslation = {
            original: text,
            translated: translatedText,
            sourceLang: response.src,
        };
        if (configuration !== getConfiguration()) return null;
        translationCache.set(messageId, entry);
        translationConfigurations.set(messageId, configuration);
        return entry;
    } catch (e) {
        logger.error("Translation failed", e);
        if (configuration === getConfiguration()) failed.set(messageId, { configuration, text });
        return null;
    } finally {
        if (inProgress.get(messageId) === configuration) inProgress.delete(messageId);
    }
}
