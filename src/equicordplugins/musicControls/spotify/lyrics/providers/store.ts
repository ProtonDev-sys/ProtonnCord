/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { settings } from "@equicordplugins/musicControls/settings";
import { getLyrics, lyricFetchers, providers, updateLyrics } from "@equicordplugins/musicControls/spotify/lyrics/api";
import { SpotifyStore, type Track } from "@equicordplugins/musicControls/spotify/SpotifyStore";
import { proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher } from "@webpack/common";

import { lyricsAlternativeFetchers } from "./translator";
import { LyricsData, Provider } from "./types";

export const lyricsAlternative = [Provider.Translated, Provider.Romanized];

function showNotif(title: string, body: string) {
    if (settings.store.showFailedToasts) {
        showNotification({
            color: "#ee2902",
            title,
            body,
            noPersist: true
        });
    }
}

export const SpotifyLrcStore = proxyLazyWebpack(() => {
    let lyricsInfo: LyricsData | null = null;
    const fetchingTrackIds = new Set<string>();
    let lyricsRequestGeneration = 0;
    let active = false;
    let lastTrackKey: string | null = null;

    class SpotifyLrcStore extends Flux.Store {
        init() { active = true; }
        destroy() {
            active = false;
            lyricsRequestGeneration++;
            fetchingTrackIds.clear();
            lastTrackKey = null;
            lyricsInfo = null;
            this.emitChange();
        }
        get lyricsInfo() {
            return lyricsInfo;
        }
    }

    const store = new SpotifyLrcStore(FluxDispatcher, {
        async SPOTIFY_PLAYER_STATE(e: { track: Track | null; }) {
            if (!active) return;
            const { track } = e;
            if (!track?.id) {
                lyricsRequestGeneration++;
                fetchingTrackIds.clear();
                lyricsInfo = null;
                lastTrackKey = null;
                store.emitChange();
                return;
            }

            const trackKey = JSON.stringify([track.id, settings.store.lyricsProvider, settings.store.fallbackProvider,
                settings.store.spotifyLyricsApiUrl, settings.store.lyricsConversion, settings.store.translateTo]);
            if (lastTrackKey === trackKey) return;
            lastTrackKey = trackKey;

            const generation = ++lyricsRequestGeneration;
            fetchingTrackIds.add(track.id);

            let nextLyricsInfo: LyricsData | null;
            try {
                nextLyricsInfo = await getLyrics(track);
            } catch {
                nextLyricsInfo = null;
                if (generation === lyricsRequestGeneration) showNotif("Lyrics fetch failed", "Could not load lyrics");
            } finally {
                fetchingTrackIds.delete(track.id);
            }

            if (generation !== lyricsRequestGeneration || SpotifyStore.track?.id !== track.id) return;

            lyricsInfo = nextLyricsInfo;
            const { lyricsConversion } = settings.store;
            if (lyricsConversion !== Provider.None) {
                FluxDispatcher.dispatch({
                    // @ts-ignore
                    type: "SPOTIFY_LYRICS_PROVIDER_CHANGE",
                    provider: lyricsConversion
                });
            }

            store.emitChange();
        },

        // @ts-ignore
        async SPOTIFY_LYRICS_PROVIDER_CHANGE(e: { provider: Provider; }) {
            if (!active) return;
            try {
            const { track } = SpotifyStore;
            if (!track?.id) return;

            const generation = ++lyricsRequestGeneration;
            const requestTrackId = track.id;
            const currentInfo = await getLyrics(track);
            if (generation !== lyricsRequestGeneration || SpotifyStore.track?.id !== requestTrackId) return;

            const { provider } = e;
            if (currentInfo?.useLyric === provider) return;

            if (currentInfo?.lyricsVersions[provider]) {
                await updateLyrics(track.id, currentInfo.lyricsVersions[provider]!, provider);
                if (generation !== lyricsRequestGeneration || SpotifyStore.track?.id !== requestTrackId) return;

                lyricsInfo = { ...currentInfo, useLyric: provider };
                store.emitChange();
                return;
            }

            if (provider === Provider.Translated || provider === Provider.Romanized) {
                const originalLyrics = currentInfo?.lyricsVersions[settings.store.lyricsProvider] ||
                    providers.map(p => currentInfo?.lyricsVersions[p]).find(Boolean);

                if (!originalLyrics || !currentInfo) {
                    showNotif("No lyrics", `No lyrics to ${provider === Provider.Translated ? "translate" : "romanize"}`);
                    return;
                }

                let lyricsCheckText = "";
                for (const line of originalLyrics) {
                    if (lyricsCheckText) lyricsCheckText += " ";
                    lyricsCheckText += line.text;
                }

                if (provider === Provider.Romanized && !/[^\u0000-\u007F]/.test(lyricsCheckText)) {
                    lyricsInfo = {
                        ...currentInfo,
                        useLyric: settings.store.lyricsProvider,
                        lyricsVersions: {
                            ...currentInfo.lyricsVersions,
                        },
                    };
                    store.emitChange();
                    return;
                }

                const targetLanguage = settings.store.translateTo;
                const fetchResult = await lyricsAlternativeFetchers[provider](originalLyrics);
                if (generation !== lyricsRequestGeneration || SpotifyStore.track?.id !== requestTrackId) return;
                if (provider === Provider.Translated && targetLanguage !== settings.store.translateTo) return;

                if (!fetchResult) {
                    showNotif("Lyrics fetch failed", `Failed to fetch ${provider === Provider.Translated ? "translation" : "romanization"}`);
                    return;
                }

                await updateLyrics(track.id, fetchResult, provider);
                if (generation !== lyricsRequestGeneration || SpotifyStore.track?.id !== requestTrackId) return;

                lyricsInfo = {
                    ...currentInfo,
                    useLyric: provider,
                    lyricsVersions: {
                        ...currentInfo.lyricsVersions,
                        [provider]: fetchResult
                    }
                };

                store.emitChange();
                return;
            }

            const newLyricsInfo = await lyricFetchers[e.provider](track);
            if (generation !== lyricsRequestGeneration || SpotifyStore.track?.id !== requestTrackId) return;

            if (!newLyricsInfo) {
                showNotif("Lyrics fetch failed", `Failed to fetch ${e.provider} lyrics`);
                return;
            }

            lyricsInfo = newLyricsInfo;

            await updateLyrics(track.id, newLyricsInfo.lyricsVersions[e.provider]!, e.provider);
            if (generation !== lyricsRequestGeneration || SpotifyStore.track?.id !== requestTrackId) return;

            store.emitChange();
            } catch {
                if (active) showNotif("Lyrics fetch failed", "Could not change lyrics provider");
            }
        }
    });

    return store;
});
