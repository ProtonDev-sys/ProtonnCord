/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { Message } from "@vencord/discord-types";
import { MessageStore, SelectedChannelStore, showToast, Toasts, UserStore } from "@webpack/common";

import { settings } from "./settings";

const logger = new Logger("TriviaAI");
const MAX_PAYLOAD_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CONCURRENT_IMAGE_LOADS = 2;
let activeImageLoads = 0;

type TextPart = {
    type: "text";
    text: string;
};

type ImagePart = {
    type: "image_url";
    image_url: {
        url: string;
        detail?: "auto" | "high" | "low";
    };
};

export type ContentPayload = string | (TextPart | ImagePart)[];

export type ApiMessage = {
    role: "user" | "assistant";
    content: ContentPayload;
};

export async function getPayload(message: Message): Promise<ApiMessage[] | null> {
    const prevMessages = getPreviousMessages(message, settings.store.context);
    const allMessages = [...prevMessages, message];

    const currentUserId = UserStore.getCurrentUser()?.id;

    const payload: ApiMessage[] = [];
    let remainingImages = MAX_PAYLOAD_IMAGES;

    for (const msg of allMessages) {
        const parsed = parseMessageContent(msg, remainingImages);
        if (!parsed) continue;
        if (Array.isArray(parsed)) remainingImages -= parsed.filter(part => part.type === "image_url").length;

        const isOwn = currentUserId != null && msg.author?.id === currentUserId;
        const isTargetMessage = msg.id === message.id;
        const role = (isOwn && !isTargetMessage && settings.store.treatSelfAsAssistant) ? "assistant" : "user";

        let content = parsed;

        if (!isOwn && settings.store.passMessageAuthorName) {
            const username = msg.author?.username ?? "Unknown";
            const prefix = `${username}: `;

            if (typeof parsed === "string") {
                content = prefix + parsed;
            } else if (Array.isArray(parsed)) {
                content = [...parsed];
                const firstTextIdx = content.findIndex(p => p.type === "text");

                if (firstTextIdx !== -1) {
                    content[firstTextIdx] = {
                        type: "text",
                        text: prefix + (content[firstTextIdx] as TextPart).text
                    };
                } else {
                    content.unshift({
                        type: "text",
                        text: prefix
                    });
                }
            }
        }

        payload.push({ role, content });
    }

    if (payload.length === 0) return null;

    if (!settings.store.sendImagesAsBase64) return payload;

    // Convert sequentially within each payload; the shared bound also covers overlapping answers.
    for (const msg of payload) {
        if (typeof msg.content === "string") continue;
        const content: (TextPart | ImagePart)[] = [];
        for (const part of msg.content) {
            const converted = part.type === "image_url" ? await toBase64Image(part) : part;
            if (converted) content.push(converted);
        }
        msg.content = content;
    }
    return payload;
}

export function getPreviousMessages(message: Message, count: number): Message[] {
    if (count <= 0) return [];

    const allMessages: Message[] | undefined = MessageStore.getMessages(message.channel_id)?._array;
    if (!allMessages?.length) return [];

    let idx = -1;
    for (let i = allMessages.length - 1; i >= 0; i--) {
        if (allMessages[i].id !== message.id) continue;
        idx = i;
        break;
    }

    if (idx <= 0) return [];
    return allMessages.slice(Math.max(0, idx - count), idx);
}

export function parseMessageContent(message: Message, maxImages = MAX_PAYLOAD_IMAGES): ContentPayload | null {
    const textParts: string[] = [];

    if (message.content && message.content.trim().length > 0) {
        textParts.push(message.content);
    }

    message.embeds.forEach(embed => {
        const embedBuffer: string[] = [];

        const parts = [
            embed.provider?.name ? `> ${embed.provider.name}` : null,
            embed.author?.name ? `**${embed.author.name}**` : null,
            embed.rawTitle ? `## ${embed.rawTitle}` : null,
            embed.rawDescription ?? null,
            ...(embed.fields?.map(f => (f.rawName && f.rawValue) ? `**${f.rawName}**: ${f.rawValue}` : null) ?? []),
            embed.footer?.text ? `_${embed.footer.text}_` : null,
        ];

        parts.forEach(p => {
            if (p) embedBuffer.push(p);
        });

        if (embedBuffer.length > 0) textParts.push(embedBuffer.join("\n"));
    });

    const combinedText = textParts.join("\n\n");

    if (!settings.store.supportImages) {
        return combinedText || null;
    }

    const imageUrls = new Set<string>();
    const addImage = (url?: string) => {
        if (url && imageUrls.size < maxImages) imageUrls.add(url);
    };

    message.attachments
        .filter(att => att.content_type?.startsWith("image/"))
        .forEach(att => addImage(att.proxy_url ?? att.url));

    message.embeds.forEach(embed => {
        const potentialUrls = [
            embed.image?.url,
            embed.thumbnail?.url,
            ...(embed.images?.map(img => img.url) ?? [])
        ];

        potentialUrls.forEach(url => {
            addImage(url);
        });
    });

    if (imageUrls.size === 0) {
        return combinedText || null;
    }

    const payload: (TextPart | ImagePart)[] = [];

    if (combinedText.length > 0) {
        payload.push({
            type: "text",
            text: combinedText
        });
    }

    imageUrls.forEach(url => {
        payload.push({
            type: "image_url",
            image_url: { url }
        });
    });

    return payload;
}

async function toBase64Image(part: ImagePart): Promise<ImagePart | null> {
    if (activeImageLoads >= MAX_CONCURRENT_IMAGE_LOADS) return null;
    activeImageLoads++;
    try {
        const req = await fetch(part.image_url.url, { signal: AbortSignal.timeout(15_000) });
        if (!req.ok || Number(req.headers.get("content-length")) > MAX_IMAGE_BYTES || !req.body) {
            await req.body?.cancel();
            return null;
        }

        const reader = req.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_IMAGE_BYTES) throw new Error("Image is too large to convert.");
                chunks.push(value);
            }
        } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
        } finally {
            reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }

        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }

        return {
            type: "image_url",
            image_url: { url: `data:${req.headers.get("content-type") ?? "image/png"};base64,${btoa(binary)}` }
        };
    } catch (e) {
        logger.warn("failed to convert image to base64", e);
        return null;
    } finally {
        activeImageLoads--;
    }
}

export async function handleResponse(message: Message, response: string, mode = settings.store.mode): Promise<string> {
    if (!response.trim()) return "";

    switch (mode) {
        case "autoreply":
            await sendMessage(
                message.channel_id,
                { content: response },
                true,
                { messageReference: { channel_id: message.channel_id, message_id: message.id } }
            );
            break;
        case "chatbar":
            if (SelectedChannelStore.getChannelId() !== message.channel_id) return "";
            insertTextIntoChatInputBox(response);
            break;
        case "bot":
            sendBotMessage(message.channel_id, { content: response });
            break;
    }

    return response;
}

function getSystemPrompt() {
    const currentUser = UserStore.getCurrentUser();
    const currentTime = new Date().toString();

    return settings.store.systemPrompt
        .replace(/{current_user}/g, currentUser?.username ?? "Unknown User")
        .replace(/{current_time}/g, currentTime);
}

export async function getResponse(payload: ApiMessage[]): Promise<string> {
    if (!settings.store.apiKey || !settings.store.endpoint || !settings.store.model) {
        showToast("TriviaAI: API settings are incomplete.", Toasts.Type.FAILURE);
        return "";
    }

    try {
        const req = await fetch(settings.store.endpoint, {
            method: "POST",
            signal: AbortSignal.timeout(60_000),
            redirect: "error",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.store.apiKey}`
            },
            body: JSON.stringify({
                model: settings.store.model,
                messages: [
                    {
                        role: "system",
                        content: getSystemPrompt()
                    },
                    ...payload
                ],
                max_tokens: settings.store.maxTokens,
            })
        });

        const rawBody = await req.text();
        const data: { error?: { message?: string; }, choices?: { message: { content: string; }; }[]; } = (() => {
            try { return JSON.parse(rawBody); }
            catch { return {}; }
        })();

        if (!req.ok || data.error) {
            const errorMsg = data.error?.message ?? rawBody ?? `Status ${req.status}`;
            logger.error(`API Error: ${errorMsg}`);
            showToast(errorMsg, Toasts.Type.FAILURE);
            return "";
        }

        const response = data.choices?.[0]?.message?.content;
        if (typeof response !== "string" || !response.trim()) {
            logger.warn("no response from AI model");
            return "";
        }

        return response;
    } catch (e) {
        logger.error("Error getting response from AI model", e);
        showToast("Error getting response from AI model", Toasts.Type.FAILURE);
        return "";
    }
}
