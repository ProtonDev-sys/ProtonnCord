/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RenderInfoEntry } from "@song-spotlight/api/handlers";
import { useEffect, useMemo, useState } from "@webpack/common";
import { JSX, RefObject } from "react";

interface ProgressCircleProps extends SvgProps {
    border: number;
    audioRef: RefObject<HTMLAudioElement | undefined>;
    playingRef: RefObject<RenderInfoEntry | undefined>;
}
type SvgProps = JSX.IntrinsicElements["svg"];

const SIZE = 50;

export default function ProgressCircle({ border, audioRef, playingRef, ...props }: ProgressCircleProps) {
    const { radius, stroke, circumference } = useMemo(() => {
        const radius = SIZE - border * 2;
        return {
            radius,
            stroke: border * 2,
            circumference: Math.PI * 2 * radius,
        };
    }, [border]);
    const [progress, setProgress] = useState(0);
    const playingAudio = playingRef.current?.audio;

    useEffect(() => {
        if (!playingAudio) {
            setProgress(0);
            return;
        }
        let handle = requestAnimationFrame(function update() {
            const audio = audioRef.current, playing = playingRef.current?.audio;
            if (audio && playing && Number.isFinite(audio.duration) && audio.duration > 0 && !audio.paused) {
                let start = 0, slice = audio.duration;
                if (playing.previewStart !== undefined && playing.previewSlice) {
                    start = playing.previewStart / 1000;
                    slice = playing.previewSlice / 1000;
                }
                setProgress(slice > 0 ? Math.min(Math.max((audio.currentTime - start) / slice, 0), 1) : 0);
            } else {
                setProgress(0);
            }

            handle = requestAnimationFrame(update);
        });

        return () => cancelAnimationFrame(handle);
    }, [audioRef, playingAudio]);

    return (
        <svg
            {...props}
            viewBox={`0 0 ${SIZE * 2} ${SIZE * 2}`}
        >
            <circle
                cx={SIZE}
                cy={SIZE}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={stroke}
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - progress)}
                strokeLinecap="round"
                transform={`rotate(-90 ${SIZE} ${SIZE})`}
                data-empty={progress === 0}
            />
        </svg>
    );
}
