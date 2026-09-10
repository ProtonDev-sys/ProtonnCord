/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher } from "@webpack/common";

import { settings } from "../settings";

export interface Track {
    id: string;
    name: string;
    artist: string;
    imageSrc?: string | null;
    songDuration: number;
    elapsedSeconds?: number;
    url?: string;
    album?: string | null;
    vibrantColor?: string | null;
}

export interface PlayerState {
    track: Track | null;
    isPlaying: boolean,
    position: number,
    repeat: Repeat,
    shuffle: boolean,
    volume: number,
}

export type Repeat = 0 | 1 | 2;

const logger = new Logger("TidalControls");

function mapApiResponseToTrack(apiData: any): Track | null {
    if (!apiData?.track || typeof apiData.track !== "object") return null;

    const { track } = apiData;
    const artistName = track.artist?.name || track.artists?.[0]?.name;
    const artist = typeof artistName === "string" ? artistName : "Unknown Artist";
    const duration = apiData.duration ?? track.duration;

    return {
        name: typeof track.title === "string" ? track.title : "Unknown Title",
        artist,
        imageSrc: typeof apiData.coverUrl === "string" ? apiData.coverUrl : null,
        songDuration: Number.isFinite(duration) ? Math.max(0, duration) : 0,
        elapsedSeconds: Number.isFinite(apiData.currentTime) ? Math.max(0, apiData.currentTime) : 0,
        url: typeof track.url === "string" ? track.url : undefined,
        album: typeof track.album?.title === "string" ? track.album.title : null,
        id: typeof track.id === "string" || typeof track.id === "number" ? String(track.id) : "0",
        vibrantColor: typeof track.album?.vibrantColor === "string" ? track.album.vibrantColor : null,
    };
}

function isSameTrack(previous: Track | null, next: Track) {
    return previous?.id === next.id
        && previous.name === next.name
        && previous.artist === next.artist
        && previous.imageSrc === next.imageSrc
        && previous.songDuration === next.songDuration
        && previous.url === next.url
        && previous.album === next.album
        && previous.vibrantColor === next.vibrantColor;
}

type Message = { type: "update"; all: boolean; fields?: any; field?: string; value?: any; } | { type: "subscribed" | "unsubscribed" | "ok" | "error";[key: string]: any; };

class TidalSocket {
    public onChange: (e: Message) => void;
    public ready = false;

    public socket: WebSocket | undefined;
    private connecting = false;
    private reconnectTimeout: ReturnType<typeof setTimeout> | undefined;

    constructor(onChange: typeof this.onChange) {
        this.onChange = onChange;
        this.reconnect();
    }

    public reconnect() {
        if (this.ready || this.connecting) return;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        try {
            this.initWs();
        } catch (e) {
            this.connecting = false;
            logger.error("Failed to connect to Tidal WebSocket", e);
            this.scheduleReconnect(5_000);
            return;
        }
    }

    get routes() {
        return {
            "play": () => this.socket?.send(JSON.stringify({ action: "resume" })),
            "pause": () => this.socket?.send(JSON.stringify({ action: "pause" })),
            "toggle": () => this.socket?.send(JSON.stringify({ action: "toggle" })),
            "previous": () => this.socket?.send(JSON.stringify({ action: "previous" })),
            "next": () => this.socket?.send(JSON.stringify({ action: "next" })),
            "seek": (seconds: number) => this.socket?.send(JSON.stringify({ action: "seek", time: seconds })),
            "shuffle": (shuffle: boolean) => this.socket?.send(JSON.stringify({ action: "setShuffleMode", shuffle })),
            "repeat": (mode: Repeat) => this.socket?.send(JSON.stringify({ action: "setRepeatMode", mode })),
            "volume": (volume: number) => this.socket?.send(JSON.stringify({ action: "volume", volume })),
        };
    }

    private scheduleReconnect(delay: number) {
        if (this.reconnectTimeout) return;

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = undefined;
            this.reconnect();
        }, delay);
    }

    public destroy() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        const { socket } = this;
        this.socket = undefined;
        this.connecting = false;
        this.ready = false;
        socket?.close();
    }

    private initWs() {
        const url = settings.store.websocketURL || "ws://localhost:24123";
        if (!url) {
            return;
        }
        this.connecting = true;
        const previousSocket = this.socket;
        this.socket = undefined;
        previousSocket?.close();
        const socket = new WebSocket(url);
        this.socket = socket;

        socket.addEventListener("open", () => {
            if (this.socket !== socket) return;
            this.connecting = false;
            this.ready = true;
            socket.send(JSON.stringify({ action: "subscribe", all: true, fields: ["currentTime"] }));
        });

        socket.addEventListener("error", () => {
            if (this.socket !== socket) return;
            this.connecting = false;
            this.ready = false;
            this.scheduleReconnect(5_000);
            this.onChange({ type: "update", all: true, fields: { playing: false, track: null, currentTime: 0, repeatMode: 0, shuffle: false, volume: 100 } });
        });

        socket.addEventListener("close", () => {
            if (this.socket !== socket) return;
            this.connecting = false;
            this.ready = false;
            this.scheduleReconnect(10_000);
            this.onChange({ type: "update", all: true, fields: { playing: false, track: null, currentTime: 0, repeatMode: 0, shuffle: false, volume: 100 } });
        });

        socket.addEventListener("message", e => {
            if (this.socket !== socket) return;
            if (typeof e.data !== "string" || e.data.length > 1_000_000) return;
            let message: Message;
            try {
                message = JSON.parse(e.data) as Message;

                switch (message.type) {
                    case "update":
                        this.onChange(message);
                        break;
                    case "error":
                        logger.error("Tidal API error:", message);
                        break;
                }
            } catch (err) {
                logger.error("Invalid Tidal update", err);
                return;
            }
        });
    }
}

export const TidalStore = proxyLazyWebpack(() => {
    const { Store } = Flux;

    class TidalStore extends Store {
        public mPosition = 0;
        public start = 0;

        public track: Track | null = null;
        public isPlaying = false;
        public repeat: Repeat = 0;
        public shuffle = false;
        public volume = 100;
        public playerElement: HTMLElement | null = null;
        private appliedVibrantColor: string | null = null;
        private apiState: Record<string, any> = {};

        public socket = new TidalSocket((message: Message) => {
            if (message.type === "update") {
                const fields = message.fields && typeof message.fields === "object" ? message.fields
                    : typeof message.field === "string" ? { [message.field]: message.value } : null;
                if (!fields) return;
                const knownFields = ["track", "coverUrl", "duration", "currentTime", "playing", "repeatMode", "shuffle", "volume"];
                if (message.all) this.apiState = {};
                for (const field of knownFields) {
                    if (Object.hasOwn(fields, field)) this.apiState[field] = fields[field];
                }
                const apiData = this.apiState;

                const track = mapApiResponseToTrack(apiData);
                if (!track || !isSameTrack(store.track, track)) store.track = track;
                if (Object.hasOwn(fields, "currentTime")) store.position = Number.isFinite(apiData.currentTime) ? Math.max(0, apiData.currentTime) : 0;
                else if (typeof apiData.playing === "boolean" && apiData.playing !== store.isPlaying) store.position /= 1000;
                this.applyVibrantColor(track?.vibrantColor);

                if (typeof apiData.playing === "boolean") store.isPlaying = apiData.playing;
                if ([0, 1, 2].includes(apiData.repeatMode)) store.repeat = apiData.repeatMode;
                if (typeof apiData.shuffle === "boolean") store.shuffle = apiData.shuffle;
                if (Number.isFinite(apiData.volume)) store.volume = Math.max(0, Math.min(100, apiData.volume));

                store.emitChange();
            }
        });

        public init() {
            this.socket.reconnect();
        }

        public openExternal(path: string) {
            VencordNative.native.openExternal(path.replace("http://www.tidal.com", "tidal://"));

        }

        private applyVibrantColor(vibrantColor?: string | null) {
            if (!this.playerElement?.isConnected) this.playerElement = null;
            if (vibrantColor && !CSS.supports("color", vibrantColor)) vibrantColor = null;
            if (!vibrantColor) {
                this.playerElement?.style.removeProperty("--eq-tdl-slider-gradient");
                this.playerElement?.style.removeProperty("--eq-tdl-slider-grabber");
                this.appliedVibrantColor = null;
                return;
            }
            if (this.playerElement && this.appliedVibrantColor === vibrantColor) return;

            this.playerElement ??= document.querySelector("#eq-tdl-player");
            if (!this.playerElement) return;

            this.playerElement.style.setProperty("--eq-tdl-slider-gradient", `linear-gradient(to right, ${vibrantColor} 80%, #E5E5E5 100%)`);
            this.playerElement.style.setProperty("--eq-tdl-slider-grabber", vibrantColor);
            this.appliedVibrantColor = vibrantColor;
        }

        set position(p: number) {
            this.mPosition = p * 1000;
            this.start = Date.now();
        }

        get position(): number {
            let pos = this.mPosition;
            if (this.isPlaying) {
                pos += Date.now() - this.start;
            }
            return pos;
        }

        previous() {
            if (!this.ensureSocketReady()) return;
            this.socket.routes.previous();
        }
        next() {
            if (!this.ensureSocketReady()) return;
            this.socket.routes.next();
        }
        setVolume(percent: number) {
            if (!this.ensureSocketReady() || !Number.isFinite(percent)) return;
            const volume = Math.max(0, Math.min(100, Math.round(percent)));
            this.socket.routes.volume(volume);
            this.volume = volume;
            this.emitChange();
        }
        setPlaying(playing: boolean) {
            if (!this.ensureSocketReady()) return;
            this.socket.routes[playing ? "play" : "pause"]();
            this.position /= 1000;
            this.isPlaying = playing;
            this.emitChange();
        }
        setRepeat(state: Repeat) {
            if (!this.ensureSocketReady()) return;
            this.socket.routes.repeat(state);
            this.repeat = state;
            this.emitChange();
        }
        setShuffle(state: boolean) {
            if (!this.ensureSocketReady()) return;
            this.socket.routes.shuffle(state);
            this.shuffle = state;
            this.emitChange();
        }
        seek(ms: number) {
            if (!this.ensureSocketReady() || !Number.isFinite(ms)) return;
            this.socket.routes.seek(Math.max(0, Math.round(ms / 1000)));
        }

        public ensureSocketReady(): boolean {
            if (!this.socket || !this.socket.ready) {
                return false;
            }
            return true;
        }

        public destroy() {
            this.socket.destroy();
            this.apiState = {};
            this.track = null;
            this.isPlaying = false;
            this.mPosition = 0;
            this.start = 0;
            this.playerElement = null;
            this.appliedVibrantColor = null;
            this.emitChange();
        }
    }

    const store = new TidalStore(FluxDispatcher);

    return store;
});
