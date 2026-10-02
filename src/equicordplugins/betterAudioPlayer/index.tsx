/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { ColorUtils, React, showToast, Toasts } from "@webpack/common";

const cl = classNameFactory("vc-better-audio-player-");
const CORS_PROXY = "https://cors.keiran0.workers.dev?url=";
const MAX_FILE_SIZE = 12e6;
const MAX_AUDIO_BLOB_CACHE_SIZE = 12;
const MAX_COLOR_CACHE_SIZE = 16;

const audioBlobCache = new Map<string, Promise<Blob | null>>();
const colorCache = new Map<string, readonly [number, number, number]>();

interface PlayerInstance {
    mediaRef: React.RefObject<HTMLAudioElement>;
    props: { src: string; type: string; };
}

function validateColor(value: string, key: string, fallback: string) {
    if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(value)) return;

    try {
        const rgb = ColorUtils.hexToRgb(value.replace("#", ""));
        if (rgb) {
            settings.store[key] = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
            return;
        }
    } catch { /* invalid hex */ }

    showToast(`Invalid color format for ${key}, use "R, G, B" or "#RRGGBB"`, Toasts.Type.FAILURE);
    settings.store[key] = fallback;
}

function getRgbColor(value: string): readonly [number, number, number] {
    const cachedColor = colorCache.get(value);
    if (cachedColor) return cachedColor;

    const firstSeparator = value.indexOf(",");
    const secondSeparator = value.indexOf(",", firstSeparator + 1);
    const r = Number(value.slice(0, firstSeparator));
    const g = Number(value.slice(firstSeparator + 1, secondSeparator));
    const b = Number(value.slice(secondSeparator + 1));
    const color = [r, g, b] as const;
    colorCache.set(value, color);

    if (colorCache.size > MAX_COLOR_CACHE_SIZE) {
        const oldestKey = colorCache.keys().next().value;
        if (oldestKey) colorCache.delete(oldestKey);
    }

    return color;
}

function maxTypedArray(arr: Uint8Array<ArrayBufferLike>): number {
    let max = 0;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] > max) max = arr[i];
    }
    return max;
}

function drawOscilloscope(ctx: CanvasRenderingContext2D, w: number, h: number, dataArray: Uint8Array<ArrayBufferLike>, bufferLength: number) {
    const sliceWidth = w / bufferLength;
    const [r, g, b] = getRgbColor(settings.store.oscilloscopeColor);
    const solidColor = settings.store.oscilloscopeSolidColor;
    const amp = 3;
    let x = 0;

    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i < bufferLength; i++) {
        const v = (dataArray[i] - 128) / 128;
        const y = (h / 2) - (v * amp * h / 2);

        if (solidColor) {
            ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        } else {
            const absV = Math.abs(v);
            ctx.strokeStyle = `rgb(${Math.min(r + absV * 100 + (i / bufferLength) * 155, 255)}, ${Math.min(g + absV * 50 + (i / bufferLength) * 155, 255)}, ${Math.min(b + absV * 150 + (i / bufferLength) * 155, 255)})`;
        }

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
    }
    ctx.stroke();
}

function drawSpectrograph(ctx: CanvasRenderingContext2D, w: number, h: number, frequencyData: Uint8Array<ArrayBufferLike>, bufferLength: number) {
    const barWidth = w / bufferLength;
    const maxVal = maxTypedArray(frequencyData);
    if (maxVal === 0) return;

    const [r, g, b] = getRgbColor(settings.store.spectrographColor);
    const solidColor = settings.store.spectrographSolidColor;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
        const barH = (frequencyData[i] / maxVal) * h;

        if (solidColor) {
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        } else {
            const red = Math.min(r + (i / bufferLength) * 155, 255);
            const green = Math.min(g + (i / bufferLength) * 155, 255);
            const blue = Math.min(b + (i / bufferLength) * 155, 255);
            const gradient = ctx.createLinearGradient(x, h - barH, x, h);
            gradient.addColorStop(0, `rgb(${red}, ${green}, ${blue})`);
            gradient.addColorStop(1, `rgb(${Math.max(red - 50, 0)}, ${Math.max(green - 50, 0)}, ${Math.max(blue - 50, 0)})`);
            ctx.fillStyle = gradient;
        }

        ctx.fillRect(x, h - barH, barWidth, barH);
        x += barWidth + 0.5;
    }
}

async function fetchAudioBlobData(src: string): Promise<Blob | null> {
    const url = new URL(src);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const request = (target: string) => fetch(target, { signal: controller.signal, credentials: "omit" });
        let response = await request(url.href).catch(error => {
            if (!settings.store.allowExternalProxy || controller.signal.aborted) throw error;
            return request(CORS_PROXY + encodeURIComponent(url.href));
        });
        if (!response.ok && settings.store.allowExternalProxy && !response.url.startsWith(CORS_PROXY)) {
            await response.body?.cancel();
            response = await request(CORS_PROXY + encodeURIComponent(url.href));
        }
        if (!response.ok) {
            await response.body?.cancel();
            return null;
        }
        const contentLength = response.headers.get("content-length");
        if (contentLength && Number(contentLength) > MAX_FILE_SIZE) {
            await response.body?.cancel();
            return null;
        }
        const reader = response.body?.getReader();
        if (!reader) return null;
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        let completed = false;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    completed = true;
                    return new Blob(chunks, { type: response.headers.get("content-type") ?? "" });
                }
                size += value.byteLength;
                if (size > MAX_FILE_SIZE) return null;
                chunks.push(new Uint8Array(value));
            }
        } finally {
            if (!completed) await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
}

async function getAudioBlob(src: string): Promise<Blob | null> {
    const cachedBlob = audioBlobCache.get(src);
    if (cachedBlob) return cachedBlob;

    const blobPromise = fetchAudioBlobData(src).then(blob => {
        if (!blob && audioBlobCache.get(src) === blobPromise) audioBlobCache.delete(src);
        return blob;
    }).catch(error => {
        if (audioBlobCache.get(src) === blobPromise) audioBlobCache.delete(src);
        throw error;
    });

    audioBlobCache.set(src, blobPromise);
    if (audioBlobCache.size > MAX_AUDIO_BLOB_CACHE_SIZE) {
        const oldestKey = audioBlobCache.keys().next().value;
        if (oldestKey) audioBlobCache.delete(oldestKey);
    }

    return blobPromise;
}

async function fetchAudioBlob(src: string): Promise<string | null> {
    const blob = await getAudioBlob(src);
    if (!blob) return null;

    return URL.createObjectURL(blob);
}

function Visualizer({ playerRef, src }: { playerRef: React.RefObject<HTMLAudioElement>; src: string; }) {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const audioCtxRef = React.useRef<AudioContext | null>(null);
    const analyserRef = React.useRef<AnalyserNode | null>(null);
    const animFrameRef = React.useRef(0);
    const setupDoneRef = React.useRef(false);
    const blobUrlRef = React.useRef<string | null>(null);
    const canvasSizeRef = React.useRef({ width: 0, height: 0 });
    const requestDrawRef = React.useRef<(() => void) | null>(null);

    React.useEffect(() => {
        const audio = playerRef.current;
        const canvas = canvasRef.current;
        if (!audio || !canvas) return () => { };

        let cancelled = false;
        let analysisAudio: HTMLAudioElement | null = null;

        const init = async () => {
            const blobUrl = await fetchAudioBlob(src).catch(() => null);
            if (!blobUrl) return;
            if (cancelled) {
                URL.revokeObjectURL(blobUrl);
                return;
            }

            blobUrlRef.current = blobUrl;

            const audioCtx = new AudioContext();
            audioCtxRef.current = audioCtx;
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 2048;
            analysisAudio = new Audio(blobUrl);
            const source = audioCtx.createMediaElementSource(analysisAudio);
            const silentOutput = audioCtx.createGain();
            silentOutput.gain.value = 0;
            source.connect(analyser);
            analyser.connect(silentOutput);
            silentOutput.connect(audioCtx.destination);
            analyserRef.current = analyser;
            setupDoneRef.current = true;

            if (!audio.paused) onPlay();
        };

        const canvasCtx = canvas.getContext("2d");
        let dataArray: Uint8Array<ArrayBuffer> | null = null;
        let frequencyData: Uint8Array<ArrayBuffer> | null = null;

        const requestDraw = () => {
            if (animFrameRef.current !== 0 || audio.paused) return;

            animFrameRef.current = requestAnimationFrame(draw);
        };
        requestDrawRef.current = requestDraw;

        const draw = () => {
            animFrameRef.current = 0;

            const analyser = analyserRef.current;
            if (!canvasCtx || !analyser || audio.paused) return;

            if (!dataArray || !frequencyData) {
                const bufferLength = analyser.frequencyBinCount;
                dataArray = new Uint8Array(bufferLength);
                frequencyData = new Uint8Array(bufferLength);
            }

            analyser.getByteTimeDomainData(dataArray);
            analyser.getByteFrequencyData(frequencyData);

            const { width, height } = canvasSizeRef.current;
            if (width === 0 || height === 0) return;

            canvasCtx.clearRect(0, 0, width, height);
            if (settings.store.oscilloscope) drawOscilloscope(canvasCtx, width, height, dataArray, dataArray.length);
            if (settings.store.spectrograph) drawSpectrograph(canvasCtx, width, height, frequencyData, frequencyData.length);

            requestDraw();
        };

        const onPlay = () => {
            if (!setupDoneRef.current) return;
            if (audioCtxRef.current?.state === "suspended") {
                audioCtxRef.current.resume().catch(() => { });
            }
            if (analysisAudio) {
                analysisAudio.currentTime = audio.currentTime;
                analysisAudio.playbackRate = audio.playbackRate;
                analysisAudio.play().catch(() => { });
            }
            requestDraw();
        };

        const onPause = () => {
            analysisAudio?.pause();
            audioCtxRef.current?.suspend().catch(() => { });
            cancelAnimationFrame(animFrameRef.current);
            animFrameRef.current = 0;
        };

        audio.addEventListener("play", onPlay);
        audio.addEventListener("pause", onPause);
        const onSeek = () => {
            if (!analysisAudio) return;
            analysisAudio.currentTime = audio.currentTime;
            analysisAudio.playbackRate = audio.playbackRate;
        };
        audio.addEventListener("seeked", onSeek);
        audio.addEventListener("ratechange", onSeek);
        init().catch(() => {
            analysisAudio?.pause();
            audioCtxRef.current?.close().catch(() => { });
            audioCtxRef.current = null;
            analyserRef.current = null;
            setupDoneRef.current = false;
        });

        return () => {
            cancelled = true;
            audio.removeEventListener("play", onPlay);
            audio.removeEventListener("pause", onPause);
            audio.removeEventListener("seeked", onSeek);
            audio.removeEventListener("ratechange", onSeek);
            cancelAnimationFrame(animFrameRef.current);
            animFrameRef.current = 0;
            requestDrawRef.current = null;
            analysisAudio?.pause();
            if (analysisAudio) {
                analysisAudio.removeAttribute("src");
                analysisAudio.load();
            }
            audioCtxRef.current?.close().catch(() => { });
            audioCtxRef.current = null;
            analyserRef.current = null;
            setupDoneRef.current = false;
            if (blobUrlRef.current) {
                URL.revokeObjectURL(blobUrlRef.current);
                blobUrlRef.current = null;
            }
        };
    }, [playerRef, src]);

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return () => { };

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            const devicePixelRatio = window.devicePixelRatio || 1;

            canvasSizeRef.current = { width: rect.width, height: rect.height };
            canvas.width = Math.floor(rect.width * devicePixelRatio);
            canvas.height = Math.floor(rect.height * devicePixelRatio);

            const ctx = canvas.getContext("2d");
            ctx?.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
            if (rect.width > 0 && rect.height > 0) requestDrawRef.current?.();
        };

        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);

    return (
        <canvas
            className={cl("canvas")}
            ref={canvasRef}
        />
    );
}

const settings = definePluginSettings({
    allowExternalProxy: {
        type: OptionType.BOOLEAN,
        description: "Allow the external cors.keiran0.workers.dev proxy if direct audio fetching fails. This shares the complete attachment URL, including private access parameters, with that service.",
        default: false,
    },
    oscilloscope: {
        type: OptionType.BOOLEAN,
        description: "Enable oscilloscope visualizer.",
        default: true,
    },
    spectrograph: {
        type: OptionType.BOOLEAN,
        description: "Enable spectrograph visualizer.",
        default: true,
    },
    oscilloscopeSolidColor: {
        type: OptionType.BOOLEAN,
        description: "Use a solid color for the oscilloscope.",
        default: false,
    },
    oscilloscopeColor: {
        type: OptionType.STRING,
        description: "Color for the oscilloscope (R, G, B or #hex).",
        default: "255, 255, 255",
        onChange: value => validateColor(value, "oscilloscopeColor", "255, 255, 255"),
    },
    spectrographSolidColor: {
        type: OptionType.BOOLEAN,
        description: "Use a solid color for the spectrograph.",
        default: false,
    },
    spectrographColor: {
        type: OptionType.STRING,
        description: "Color for the spectrograph (R, G, B or #hex).",
        default: "33, 150, 243",
        onChange: value => validateColor(value, "spectrographColor", "33, 150, 243"),
    },
});

export default definePlugin({
    name: "BetterAudioPlayer",
    description: "Adds a spectrograph and oscilloscope visualizer to audio attachment players.",
    tags: ["Appearance", "Media", "Voice"],
    authors: [EquicordDevs.creations],
    settings,

    patches: [
        {
            find: "}renderPlayIcon(){",
            replacement: {
                match: /this\.renderAudio\(\):this\.renderVideo\(\)/,
                replace: "$&,$self.renderVisualizer(this)",
            },
        },
    ],

    renderVisualizer(player: PlayerInstance) {
        if (player.props.type !== "AUDIO") return null;
        return <Visualizer playerRef={player.mediaRef} src={player.props.src} key={player.props.src} />;
    },
});
