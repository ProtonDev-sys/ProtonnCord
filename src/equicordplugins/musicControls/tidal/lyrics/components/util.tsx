/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "@equicordplugins/musicControls/settings";
import { TidalLrcStore } from "@equicordplugins/musicControls/tidal/lyrics/providers/store";
import { EnhancedLyric } from "@equicordplugins/musicControls/tidal/lyrics/types";
import { TidalStore } from "@equicordplugins/musicControls/tidal/TidalStore";
import { classNameFactory } from "@utils/css";
import { findCssClassesLazy } from "@webpack";
import { React, useEffect, useState, useStateFromStores } from "@webpack/common";

export const scrollClasses = findCssClassesLazy("auto", "customTheme");

export const cl = classNameFactory("eq-tidal-lyrics-");

export function NoteSvg(className: string) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 480 720" fill="currentColor" className={className} >
            <path d="m160,-240 q -66,0 -113,-47 -47,-47 -47,-113 0,-66 47,-113 47,-47 113,-47 23,0 42.5,5.5 19.5,5.5 37.5,16.5 v -422 h 240 v 160 H 320 v 400 q 0,66 -47,113 -47,47 -113,47 z" />
        </svg>
    );
}

const calculateIndexes = (lyrics: EnhancedLyric[], position: number, delay: number): [number | null, number | null] => {
    const posInSec = (position + delay) / 1000;
    let left = 0;
    let right = lyrics.length - 1;
    let currentIndex: number | null = null;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const curr = lyrics[mid];
        const next = lyrics[mid + 1];

        if (curr.time <= posInSec && (!next || next.time > posInSec)) {
            currentIndex = mid;
            break;
        }

        if (curr.time > posInSec) right = mid - 1;
        else left = mid + 1;
    }

    const nextIdx = currentIndex !== null ? currentIndex + 1 : left;
    const nextLyric = nextIdx < lyrics.length ? nextIdx : null;

    if (currentIndex !== null && posInSec - lyrics[currentIndex].time > 8) {
        return [null, nextLyric];
    }

    return [currentIndex, nextLyric];
};

export function useLyrics({ scroll = true }: { scroll?: boolean; } = {}) {
    const [track, storePosition, isPlaying] = useStateFromStores(
        [TidalStore], () => [
            TidalStore.track,
            TidalStore.mPosition,
            TidalStore.isPlaying,
        ]);
    const lyrics = useStateFromStores([TidalLrcStore], () => TidalLrcStore.lyrics);

    const { lyricDelay } = settings.use(["lyricDelay"]);

    const [currLrcIndex, setCurrLrcIndex] = useState<number | null>(null);
    const [nextLyric, setNextLyric] = useState<number | null>(null);
    const [position, setPosition] = useState(storePosition);
    const [lyricRefs, setLyricRefs] = useState<React.RefObject<HTMLDivElement | null>[]>([]);

    const currentLyrics = lyrics || null;
    const duration = track?.songDuration ? track.songDuration * 1000 : Number.POSITIVE_INFINITY;

    useEffect(() => {
        setLyricRefs(currentLyrics?.map(() => React.createRef()) ?? []);
    }, [currentLyrics]);

    useEffect(() => {
        setPosition(Math.min(storePosition, duration));
    }, [duration, storePosition]);

    useEffect(() => {
        if (currentLyrics && position != null) {
            const [currentIndex, nextLyric] = calculateIndexes(currentLyrics, position, lyricDelay);
            setCurrLrcIndex(currentIndex);
            setNextLyric(nextLyric);
        } else {
            setCurrLrcIndex(null);
            setNextLyric(null);
        }
    }, [currentLyrics, position, lyricDelay]);

    useEffect(() => {
        if (scroll && currLrcIndex !== null) {
            if (currLrcIndex >= 0) {
                lyricRefs[currLrcIndex]?.current?.scrollIntoView({ behavior: "smooth", block: "center" });
            }
            if (currLrcIndex < 0 && nextLyric !== null) {
                lyricRefs[nextLyric]?.current?.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }
    }, [currLrcIndex, nextLyric, scroll, lyricRefs]);

    useEffect(() => {
        if (isPlaying) {
            setPosition(TidalStore.position);
            const interval = setInterval(() => {
                setPosition(p => Math.min(p + 1000, duration));
            }, 1000);

            return () => clearInterval(interval);
        }
    }, [duration, storePosition, isPlaying]);

    return { track, lyrics, lyricRefs, currLrcIndex, nextLyric };
}
