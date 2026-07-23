/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DEFAULT_WAVEFORM = "AAAAAAAAAAAA";

const MIN_BINS = 32;
const MAX_BINS = 256;
const BINS_PER_SECOND = 10;
const MAX_VALUE = 0xff;

export function generateWaveform(samples: Float32Array, sampleRate: number): string {
    if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return DEFAULT_WAVEFORM;

    const requestedBins = Math.floor(samples.length / sampleRate * BINS_PER_SECOND);
    const binCount = Math.max(Math.min(MIN_BINS, samples.length), Math.min(MAX_BINS, requestedBins));
    const bins = new Uint8Array(binCount);

    for (let binIndex = 0; binIndex < binCount; binIndex++) {
        const start = Math.floor(binIndex * samples.length / binCount);
        const end = Math.max(start + 1, Math.floor((binIndex + 1) * samples.length / binCount));
        let sum = 0;

        for (let sampleIndex = start; sampleIndex < end; sampleIndex++)
            sum += samples[sampleIndex] ** 2;

        bins[binIndex] = Math.min(MAX_VALUE, Math.floor(Math.sqrt(sum / (end - start)) * MAX_VALUE));
    }

    const maxBin = Math.max(...bins);
    if (maxBin) {
        const easing = Math.min(1, 100 * (maxBin / MAX_VALUE) ** 3);
        const ratio = 1 + (MAX_VALUE / maxBin - 1) * easing;
        for (let index = 0; index < binCount; index++)
            bins[index] = Math.min(MAX_VALUE, Math.floor(bins[index] * ratio));
    }

    return globalThis.btoa(String.fromCharCode(...bins));
}
