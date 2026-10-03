/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { followPlaybackPosition, getLyricIndexes } from "@equicordplugins/musicControls/playbackPosition";
import { settings } from "@equicordplugins/musicControls/settings";
import { SpotifyLrcStore } from "@equicordplugins/musicControls/spotify/lyrics/providers/store";
import { SpotifyStore } from "@equicordplugins/musicControls/spotify/SpotifyStore";
import { classNameFactory } from "@utils/css";
import { findCssClassesLazy } from "@webpack";
import { React, useEffect, useMemo, useState, useStateFromStores } from "@webpack/common";

export const scrollClasses = findCssClassesLazy("auto", "customTheme");

export const cl = classNameFactory("vc-spotify-lyrics-");

export function NoteSvg() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 480 720" fill="currentColor" className={cl("music-note")}>
            <path d="m160,-240 q -66,0 -113,-47 -47,-47 -47,-113 0,-66 47,-113 47,-47 113,-47 23,0 42.5,5.5 19.5,5.5 37.5,16.5 v -422 h 240 v 160 H 320 v 400 q 0,66 -47,113 -47,47 -113,47 z" />
        </svg>
    );
}

export function useLyrics({ scroll = true }: { scroll?: boolean; } = {}) {
    const [track, storePosition, isPlaying] = useStateFromStores(
        [SpotifyStore], () => [
            SpotifyStore.track,
            SpotifyStore.mPosition,
            SpotifyStore.isPlaying,
        ]);
    const lyricsInfo = useStateFromStores([SpotifyLrcStore], () => SpotifyLrcStore.lyricsInfo);

    const { lyricDelay } = settings.use(["lyricDelay"]);

    const [position, setPosition] = useState(storePosition);

    const currentLyrics = lyricsInfo?.lyricsVersions[lyricsInfo.useLyric];
    const duration = track?.duration ?? Number.POSITIVE_INFINITY;

    const lyricRefs = useMemo(() => currentLyrics?.map(() => React.createRef<HTMLDivElement>()) ?? [], [currentLyrics]);
    const [currLrcIndex, nextLyric] = useMemo(() => currentLyrics && position != null
        ? getLyricIndexes(currentLyrics, position, lyricDelay) : [null, null], [currentLyrics, position, lyricDelay]);

    useEffect(() => {
        const index = currLrcIndex ?? nextLyric;
        if (scroll && index !== null) lyricRefs[index]?.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [currLrcIndex, nextLyric, scroll, lyricRefs]);

    useEffect(() => followPlaybackPosition(SpotifyStore, duration, setPosition), [duration, storePosition, isPlaying, track?.id]);

    return { track, lyricsInfo, lyricRefs, currLrcIndex, nextLyric };
}
