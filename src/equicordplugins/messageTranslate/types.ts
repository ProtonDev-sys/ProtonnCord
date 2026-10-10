import type { Message } from "@vencord/discord-types";

export interface TranslateResponse {
    src: string;
    confidence: number;
    sentences: { trans?: string; }[];
}

export interface CachedTranslation {
    original: string;
    translated: string;
    sourceLang: string;
}

export type MessageWithContent = Message & { content: string; };
