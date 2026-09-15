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
const inProgress = new Map<string, { configuration: string; text: string; controller: AbortController; }>();
const failed = new Map<string, { configuration: string; text: string; }>();
const CACHE_LIMIT = 1000;
let cachedConfiguration: { target: string; confidence: number; excluded: Set<string>; value: string; } | undefined;

function getConfiguration(): string {
    const target = settings.store.targetLanguage.trim().toLowerCase();
    const confidence = settings.store.confidenceRequirement;
    const excluded = getExcludedLanguages();
    if (!cachedConfiguration || cachedConfiguration.target !== target || cachedConfiguration.confidence !== confidence || cachedConfiguration.excluded !== excluded) {
        cachedConfiguration = { target, confidence, excluded, value: JSON.stringify([target, confidence, [...excluded].sort()]) };
    }
    return cachedConfiguration.value;
}

export function getCached(messageId: string): CachedTranslation | undefined {
    if (translationConfigurations.get(messageId) !== getConfiguration()) {
        translationCache.delete(messageId);
        translationConfigurations.delete(messageId);
        return undefined;
    }
    return translationCache.get(messageId);
}

export function hasFailed(messageId: string, text: string): boolean {
    const failure = failed.get(messageId);
    return failure?.text === text && failure.configuration === getConfiguration();
}

export function isInProgress(messageId: string, text: string): boolean {
    const request = inProgress.get(messageId);
    return request?.configuration === getConfiguration() && request.text === text;
}

export function clearCache(messageId: string) {
    translationCache.delete(messageId);
    translationConfigurations.delete(messageId);
    failed.delete(messageId);
    inProgress.get(messageId)?.controller.abort();
    inProgress.delete(messageId);
}

export function clearAllTranslations() {
    for (const request of inProgress.values()) request.controller.abort();
    inProgress.clear();
    translationCache.clear();
    translationConfigurations.clear();
    failed.clear();
    cachedConfiguration = undefined;
}

function rememberFailure(messageId: string, configuration: string, text: string) {
    if (!failed.has(messageId) && failed.size >= CACHE_LIMIT) failed.delete(failed.keys().next().value!);
    failed.set(messageId, { configuration, text });
}

async function fetchTranslation(text: string, targetLang: string, signal: AbortSignal): Promise<TranslateResponse> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&dj=1&q=${encodeURIComponent(text)}`;
    const response = await fetch(url, { signal });

    if (!response.ok) {
        throw new Error(`Translation API returned ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (typeof data?.src !== "string" || !Number.isFinite(data.confidence) || !Array.isArray(data.sentences)
        || !data.sentences.every(sentence => sentence && (sentence.trans == null || typeof sentence.trans === "string")))
        throw new Error("Invalid translation response");
    return data;
}

export async function translate(messageId: string, text: string): Promise<CachedTranslation | null> {
    const configuration = getConfiguration();
    if (isInProgress(messageId, text)) return null;
    const cached = getCached(messageId);
    if (cached?.original === text) return cached;

    clearCache(messageId);
    const request = { configuration, text, controller: new AbortController() };
    inProgress.set(messageId, request);
    const timeout = setTimeout(() => request.controller.abort(), 15_000);
    const isCurrent = () => !request.controller.signal.aborted && inProgress.get(messageId) === request && configuration === getConfiguration();

    try {
        const targetLang = settings.store.targetLanguage.trim().toLowerCase();
        const response = await fetchTranslation(text, targetLang, request.controller.signal);
        if (!isCurrent()) return null;
        const sourceLang = response.src.trim().toLowerCase();

        if (sourceLang === targetLang || response.confidence < settings.store.confidenceRequirement || getExcludedLanguages().has(sourceLang)) {
            rememberFailure(messageId, configuration, text);
            return null;
        }

        let translatedText = "";
        for (const sentence of response.sentences) {
            if (sentence.trans) translatedText += sentence.trans;
        }

        if (!translatedText || translatedText === text) {
            rememberFailure(messageId, configuration, text);
            return null;
        }

        const entry: CachedTranslation = {
            original: text,
            translated: translatedText,
            sourceLang: response.src,
        };
        if (!isCurrent()) return null;
        if (!translationCache.has(messageId) && translationCache.size >= CACHE_LIMIT) {
            const oldest = translationCache.keys().next().value!;
            translationCache.delete(oldest);
            translationConfigurations.delete(oldest);
        }
        translationCache.set(messageId, entry);
        translationConfigurations.set(messageId, configuration);
        return entry;
    } catch (e) {
        if (!isCurrent()) return null;
        logger.error("Translation failed", e);
        rememberFailure(messageId, configuration, text);
        return null;
    } finally {
        clearTimeout(timeout);
        if (inProgress.get(messageId) === request) inProgress.delete(messageId);
    }
}
