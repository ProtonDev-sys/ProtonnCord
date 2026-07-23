/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const VOICE_MESSAGE_FLAG = 1 << 13;

export interface LanguageOption {
    label: string;
    value: string;
}

export interface VoiceMessageMedia {
    duration?: number;
    needsPlaybackFallback: boolean;
    url: string;
    waveform?: string;
}

interface VoiceMessageCandidate {
    attachments?: Array<{
        content_type?: string;
        duration_secs?: number;
        filename?: string;
        url?: string;
        waveform?: string;
    }>;
    flags?: number;
}

export function getVoiceMessageMedia(message: VoiceMessageCandidate): VoiceMessageMedia | null {
    if (!((message.flags ?? 0) & VOICE_MESSAGE_FLAG)) return null;

    const attachment = message.attachments?.find(candidate => (
        typeof candidate.url === "string"
        && (candidate.content_type?.startsWith("audio/") || /\.(?:m4a|mp3|ogg|opus|wav)$/i.test(candidate.filename ?? ""))
    ));

    if (!attachment?.url) return null;

    return {
        duration: attachment.duration_secs,
        needsPlaybackFallback: !attachment.content_type?.startsWith("audio/") || !attachment.waveform,
        url: attachment.url,
        waveform: attachment.waveform
    };
}

export function buildTargetLanguageOptions(languages: Record<string, string>): LanguageOption[] {
    return Object.entries(languages)
        .filter(([code, label]) => code !== "auto" && code !== "" && !/^detect language$/i.test(label))
        .map(([value, label]) => ({ value, label }));
}

export function resolveTargetLanguage(configured: string, options: LanguageOption[]): string {
    if (options.some(option => option.value === configured)) return configured;

    return options.find(option => option.value === "en")?.value
        ?? options.find(option => option.value.toLowerCase().startsWith("en-"))?.value
        ?? options[0]?.value
        ?? "en";
}
