/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "@equicordplugins/musicControls/settings";
import { Provider, SyncedLyric } from "@equicordplugins/musicControls/spotify/lyrics/providers/types";

// stolen from src/plugins/translate/utils.ts

interface GoogleData {
    src: string;
    sentences: {
        // 🏳️‍⚧️
        trans: string;
        orig: string;
        src_translit?: string;
    }[];
}

async function googleTranslate(text: string, targetLang: string, romanize: boolean): Promise<GoogleData | null> {
    const url = "https://translate.googleapis.com/translate_a/single?" + new URLSearchParams({
        // see https://stackoverflow.com/a/29537590 for more params
        // holy shidd nvidia
        client: "gtx",
        // source language
        sl: "auto",
        // target language
        tl: targetLang,
        // what to return, t = translation probably
        dt: romanize ? "rm" : "t",
        // Send json object response instead of weird array
        dj: "1",
        source: "input",
        // query, duh
        q: text
    });

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok)
        return null;

    return await res.json();
}

async function processLyrics(
    lyrics: SyncedLyric[],
    targetLang: string,
    romanize: boolean
): Promise<SyncedLyric[] | null> {
    if (!lyrics) return null;

    const texts = [...new Set(lyrics.map(lyric => lyric.text).filter((text): text is string => !!text))];
    const processed = new Map<string, string>();
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, texts.length) }, async () => {
        while (index < texts.length) {
            const text = texts[index++];
            try {
                const translation = await googleTranslate(text, targetLang, romanize);
                if (!Array.isArray(translation?.sentences)) continue;
                const result = translation.sentences.map(sentence => romanize ? sentence.src_translit : sentence.trans)
                    .filter((value): value is string => typeof value === "string").join("");
                if (result) processed.set(text, result);
            } catch { /* Preserve the original line when a provider request fails. */ }
        }
    }));

    if (!processed.size) return null;

    return lyrics.map(lyric => ({
        ...lyric,
        text: lyric.text ? processed.get(lyric.text) ?? lyric.text : lyric.text
    }));
}

async function translateLyrics(lyrics: SyncedLyric[]) {
    return await processLyrics(lyrics, settings.store.translateTo, false);
}

async function romanizeLyrics(lyrics: SyncedLyric[]) {
    return await processLyrics(lyrics, "", true);
}

export const lyricsAlternativeFetchers = {
    [Provider.Translated]: translateLyrics,
    [Provider.Romanized]: romanizeLyrics
};
