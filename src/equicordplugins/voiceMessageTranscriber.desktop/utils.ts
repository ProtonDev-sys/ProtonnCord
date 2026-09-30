/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { PluginNative } from "@utils/types";

import { TranscriptionResult } from "./transcriptionData";

const Native = VencordNative.pluginHelpers.VoiceMessageTranscriber as PluginNative<typeof import("./native")>;
export const cl = classNameFactory("vc-transcription-");

const getAudioContext = () => new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
export async function decodeAudio(blob: Blob): Promise<Float32Array> {
    const arrayBuffer = await blob.arrayBuffer();
    const audioContext = getAudioContext();
    try {
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        // Mix down to mono
        const channelData = audioBuffer.getChannelData(0);
        if (audioBuffer.numberOfChannels > 1) {
            for (let i = 1; i < audioBuffer.numberOfChannels; i++) {
                const channel = audioBuffer.getChannelData(i);
                for (let j = 0; j < channelData.length; j++) {
                    channelData[j] += channel[j];
                }
            }
            for (let i = 0; i < channelData.length; i++) {
                channelData[i] /= audioBuffer.numberOfChannels;
            }
        }

        return new Float32Array(channelData);
    } finally {
        void audioContext.close().catch(() => undefined);
    }
}

const activeWorkers = new Set<TranscriptionWorker>();

export function terminateTranscriptionWorkers() {
    for (const worker of activeWorkers) worker.terminate();
}

export class TranscriptionWorker {
    private readonly id = crypto.randomUUID();
    private terminated = false;
    private running = false;
    private progressTimer: ReturnType<typeof setTimeout> | undefined;
    private preview = "";

    constructor(
        private readonly onStatus: (status: string) => void,
        private readonly onComplete: (output: TranscriptionResult) => void,
        private readonly onError: (error: unknown) => void,
        private readonly onPartial?: (text: string) => void
    ) {
        activeWorkers.add(this);
    }

    public run(audio: Float32Array) {
        if (this.terminated || this.running) return;
        this.running = true;
        this.onStatus("transcribing");
        if (this.onPartial) this.progressTimer = setTimeout(() => void this.pollProgress(), 100);
        void Native.transcribe(this.id, audio).then(output => {
            this.running = false;
            clearTimeout(this.progressTimer);
            if (!this.terminated) this.onComplete(output);
        }, error => {
            this.running = false;
            clearTimeout(this.progressTimer);
            if (!this.terminated) this.onError(error);
        });
    }

    private async pollProgress() {
        try {
            const text = await Native.getTranscriptionProgress(this.id);
            if (!this.terminated && this.running && text && text !== this.preview) {
                this.preview = text;
                this.onPartial?.(text);
            }
        } catch { }
        if (!this.terminated && this.running)
            this.progressTimer = setTimeout(() => void this.pollProgress(), 100);
    }

    public terminate() {
        if (this.terminated) return;
        this.terminated = true;
        clearTimeout(this.progressTimer);
        this.preview = "";
        activeWorkers.delete(this);
        if (this.running) void Native.cancelTranscription(this.id).catch(() => undefined);
    }
}
