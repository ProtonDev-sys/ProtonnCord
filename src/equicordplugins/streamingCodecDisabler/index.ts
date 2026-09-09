/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { MediaEngineStore } from "@webpack/common";

interface Codecs {
    AV1: boolean;
    H265: boolean,
    H264: boolean;
    VP8: boolean;
    VP9: boolean;
}

let codecEngine: ReturnType<typeof MediaEngineStore.getMediaEngine> | undefined;
let originalCodecStatuses: Partial<Codecs> = {};
let capabilitiesPromise: Promise<void> | undefined;
let generation = 0;
let active = false;

function applyCodecs(disabled: boolean) {
    if (!codecEngine) return;
    if (originalCodecStatuses.AV1 !== undefined) codecEngine.setAv1Enabled(originalCodecStatuses.AV1 && (!disabled || !Settings.plugins.StreamingCodecDisabler.disableAv1Codec));
    if (originalCodecStatuses.H265 !== undefined) codecEngine.setH265Enabled(originalCodecStatuses.H265 && (!disabled || !Settings.plugins.StreamingCodecDisabler.disableH265Codec));
    if (originalCodecStatuses.H264 !== undefined) codecEngine.setH264Enabled(originalCodecStatuses.H264 && (!disabled || !Settings.plugins.StreamingCodecDisabler.disableH264Codec));
}

const settings = definePluginSettings({
    disableAv1Codec: {
        description: "Make Discord not consider using AV1 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
    disableH265Codec: {
        description: "Make Discord not consider using H265 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
    disableH264Codec: {
        description: "Make Discord not consider using H264 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
    disableVP8Codec: {
        description: "Make Discord not consider using VP8 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
    disableVP9Codec: {
        description: "Make Discord not consider using VP9 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
});

export default definePlugin({
    name: "StreamingCodecDisabler",
    description: "Disable codecs for streaming of your choice",
    tags: ["Utility", "Voice"],
    authors: [EquicordDevs.davidkra230],
    settings,
    start() { active = true; generation++; },
    stop() {
        active = false;
        generation++;
        try { applyCodecs(false); }
        finally {
            codecEngine = undefined;
            capabilitiesPromise = undefined;
            originalCodecStatuses = {};
        }
    },

    patches: [
        {
            find: "setVideoBroadcast(this.shouldConnectionBroadcastVideo",
            replacement: {
                match: /setGoLiveSource\(.,.\)\{/,
                replace: "$&$self.updateDisabledCodecs();"
            },
        }
    ],

    async updateDisabledCodecs() {
        if (!active) return;
        const currentGeneration = generation;
        const mediaEngine = MediaEngineStore.getMediaEngine();
        if (!mediaEngine) return;
        if (codecEngine !== mediaEngine) {
            codecEngine = mediaEngine;
            originalCodecStatuses = {};
            capabilitiesPromise = undefined;
        }
        try {
            capabilitiesPromise ??= new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Codec capabilities timed out")), 5000);
                try {
                    mediaEngine.getCodecCapabilities(value => { clearTimeout(timer); resolve(value); });
                } catch (error) {
                    clearTimeout(timer);
                    reject(error);
                }
            }).then(value => {
                const codecs = JSON.parse(value);
                if (!Array.isArray(codecs)) throw new Error("Invalid codec capabilities");
                if (!active || currentGeneration !== generation || codecEngine !== mediaEngine) return;
                for (const codec of codecs) {
                    if (["AV1", "H265", "H264", "VP8", "VP9"].includes(codec?.codec) && typeof codec.encode === "boolean")
                        originalCodecStatuses[codec.codec] = codec.encode;
                }
            });
            await capabilitiesPromise;
            if (active && currentGeneration === generation && codecEngine === mediaEngine) applyCodecs(true);
        } catch (error) {
            if (currentGeneration === generation && codecEngine === mediaEngine) {
                capabilitiesPromise = undefined;
                console.error("StreamingCodecDisabler could not read codec capabilities", error);
            }
        }
    },
});
