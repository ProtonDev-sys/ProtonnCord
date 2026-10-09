/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { type PluginNative } from "@utils/types";
import type { Channel, CloudUpload, Message, MessageAttachment } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import {
    ChannelStore,
    CloudUploader,
    Constants,
    GuildRoleStore,
    MessageStore,
    RestAPI,
    showToast,
    Toasts,
    UserStore,
} from "@webpack/common";

import { encryptedAttachmentInput } from "../secureMessaging.desktop/attachmentCache";
import {
    type AttachmentMetadata,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_COUNT,
    type SecureStickerItem,
} from "../secureMessaging.desktop/attachments";
import { decryptCachedMessage } from "../secureMessaging.desktop/decryptCache";
import {
    composeSecureForwardText,
    type ForwardEmbed,
    type ForwardProtection,
    secureForwardEmbedText,
    secureForwardImageEmbeds,
    secureForwardRoute,
    validatedDiscordAttachmentUrl,
} from "../secureMessaging.desktop/forwarding";
import type {
    ChannelProtectionResult,
    ConversationResult,
    ConversationSnapshot,
    NativeFailure,
} from "../secureMessaging.desktop/native";
import { isEncryptedMessage } from "../secureMessaging.desktop/protocol";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("../secureMessaging.desktop/native")>;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_TOTAL_FORWARD_BYTES = MAX_ATTACHMENT_BYTES;
const SNOWFLAKE = /^\d{17,20}$/u;

interface ForwardOptions {
    embedIndicesAreImages?: boolean;
    isICYMIGameContentForwarding?: boolean;
    onlyAttachmentIds?: string[];
    onlyEmbedIndices?: number[];
    withMessage?: string;
}

interface ForwardUpload {
    description: string | null;
    duration: number | null;
    file: File;
    spoiler: boolean;
    waveform: string | null;
}

interface PreparedForward {
    plaintext: string;
    stickerIds: string[];
    uploads: ForwardUpload[];
}

interface SecureMessagingPluginState {
    getScreenCaptureProtectionStatus?(): string;
    sendEncryptedForward?(channelId: string, content: string, uploads: CloudUpload[], stickerIds: string[]): Promise<void>;
    started?: boolean;
}

let generation = 0;
let running = false;

function secureMessagingPlugin(): SecureMessagingPluginState | undefined {
    return (plugins as unknown as Record<string, SecureMessagingPluginState>).SecureMessaging;
}

function isNativeFailure(result: { status: string; }): result is NativeFailure {
    return result.status === "invalid_input" || result.status === "unavailable" || result.status === "failed";
}

function failureReason(result: NativeFailure): string {
    if (result.status === "invalid_input") return result.error;
    if (result.status === "unavailable") return "Secure key storage is unavailable.";
    if (result.error === "attachment_download_failed") return "An encrypted attachment could not be loaded from Discord.";
    if (result.error === "attachment_too_large") return "An encrypted attachment exceeds Secure Messaging's safety limit.";
    return "Secure Messaging could not authenticate the forwarded message.";
}

function snapshotForChannel(channel: Channel | undefined, localUserId: string): ConversationSnapshot | null {
    if (!channel) return null;
    const isGroup = Boolean(channel.isGroupDM?.() || channel.isMultiUserDM?.());
    if (!isGroup && !channel.isDM?.()) return null;
    const participantUserIds = [...new Set((channel.recipients ?? [])
        .filter((value): value is string => typeof value === "string" && value !== localUserId))]
        .sort((left, right) => left.localeCompare(right));
    if (participantUserIds.length === 0 || (!isGroup && participantUserIds.length !== 1)) return null;
    return {
        channelId: channel.id,
        kind: isGroup ? "GROUP_DM" : "DM",
        participantUserIds,
    };
}

function secureMessagingRuntimeReady(): boolean {
    const plugin = secureMessagingPlugin();
    return plugin?.started === true && plugin.getScreenCaptureProtectionStatus?.() === "ready";
}

function assertForwardStillActive(expectedGeneration: number, localUserId: string | undefined): void {
    if (expectedGeneration !== generation || !localUserId || UserStore.getCurrentUser()?.id !== localUserId
        || !secureMessagingRuntimeReady())
        throw new Error("Secure forwarding was cancelled because the account or Secure Messaging state changed.");
}

function conversationProtection(result: ConversationResult): ForwardProtection {
    if (isNativeFailure(result)) return { protected: true, ready: false, reason: failureReason(result) };
    if (result.status === "enabled") {
        return secureMessagingRuntimeReady()
            ? { protected: true, ready: true }
            : {
                protected: true,
                ready: false,
                reason: "Show encrypted content and enable the Secure Messaging plugin before forwarding.",
            };
    }
    if (result.status === "participant_changed") {
        return {
            protected: true,
            ready: false,
            reason: "The destination's participants changed. Review them and enable encryption again before forwarding.",
        };
    }
    if (result.status === "unverified_recipients") {
        return {
            protected: true,
            ready: false,
            reason: "Verify the destination recipients' encryption keys before forwarding.",
        };
    }
    if (result.status === "local_identity_changed") {
        return {
            protected: true,
            ready: false,
            reason: "Your encryption identity changed. Verify it with the recipients and enable encryption again before forwarding.",
        };
    }
    return { protected: false, ready: false };
}

async function inspectProtection(channelId: string, knownEncryptedMessage = false): Promise<ForwardProtection> {
    if (knownEncryptedMessage) {
        const ready = secureMessagingRuntimeReady();
        return {
            protected: true,
            ready,
            reason: ready ? undefined : "Show encrypted content and enable Secure Messaging before forwarding this message.",
        };
    }
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId) return { protected: true, ready: false, reason: "Discord has no authenticated user." };

    const channel = ChannelStore.getChannel(channelId);
    const snapshot = snapshotForChannel(channel, localUserId);
    if (typeof channel?.guild_id === "string" && SNOWFLAKE.test(channel.guild_id))
        return { protected: false, ready: false };

    const persisted: ChannelProtectionResult = await Native.getChannelProtection(localUserId, channelId);
    if (isNativeFailure(persisted)) return { protected: true, ready: false, reason: failureReason(persisted) };
    if (persisted.status !== "protected") return { protected: false, ready: false };
    if (snapshot) return conversationProtection(await Native.getConversation(localUserId, snapshot));
    return {
        protected: true,
        ready: false,
        reason: "The protected conversation is not loaded. Open it before forwarding.",
    };
}

function normalizeAttachmentSelection(value: unknown): Set<string> | null {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !SNOWFLAKE.test(id)))
        throw new Error("Discord supplied an invalid forwarded attachment selection.");
    return new Set(value);
}

function normalizeEmbedSelection(value: unknown): number[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some(index => !Number.isInteger(index) || index < 0))
        throw new Error("Discord supplied an invalid forwarded embed selection.");
    return [...new Set(value)];
}

function safeFilename(value: unknown, attachmentId: string): string {
    if (typeof value !== "string") return `attachment-${attachmentId}.bin`;
    const cleaned = value.replace(/[\0-\x1f\\/]/gu, "_").slice(0, 255);
    return cleaned || `attachment-${attachmentId}.bin`;
}

function safeMimeType(value: unknown): string {
    return typeof value === "string" && value.length <= 255 && /^[\x20-\x7e]*$/u.test(value)
        ? value || "application/octet-stream"
        : "application/octet-stream";
}

function finiteDuration(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 604_800
        ? value
        : null;
}

function attachmentDescription(value: unknown): string | null {
    return typeof value === "string" && value.length <= 1_024 && !value.includes("\0") ? value : null;
}

function attachmentWaveform(value: unknown): string | null {
    return typeof value === "string" && value.length <= 344 ? value : null;
}

function cloudUpload(destinationChannelId: string, forwarded: ForwardUpload): CloudUpload {
    const upload = new CloudUploader({ file: forwarded.file, platform: CloudUploadPlatform.WEB }, destinationChannelId);
    upload.spoiler = forwarded.spoiler;
    upload.description = forwarded.description;
    upload.durationSecs = forwarded.duration ?? undefined;
    upload.waveform = forwarded.waveform ?? undefined;
    return upload;
}

function messageStickerIds(message: Message): string[] {
    const raw = (message as Message & {
        stickerItems?: Array<{ id?: unknown; }>;
        sticker_items?: Array<{ id?: unknown; }>;
    }).stickerItems ?? (message as Message & { sticker_items?: Array<{ id?: unknown; }>; }).sticker_items ?? [];
    return [...new Set(raw
        .map(sticker => sticker?.id)
        .filter((id): id is string => typeof id === "string" && SNOWFLAKE.test(id)))];
}

function timestampMs(message: Message): number | null {
    const value = Number((message.timestamp as unknown as { valueOf?(): unknown; })?.valueOf?.());
    return Number.isFinite(value) && value > 0 ? value : null;
}

function authorLabel(message: Message): string {
    const author = message.author as Message["author"] & { global_name?: string; globalName?: string; };
    return author?.globalName || author?.global_name || author?.username || "Unknown sender";
}

function mentionResolvers(message: Message) {
    const guildId = (message as Message & { guild_id?: string; }).guild_id;
    return {
        user(userId: string) {
            const user = UserStore.getUser(userId) as { globalName?: string; global_name?: string; username?: string; } | undefined;
            return user?.globalName || user?.global_name || user?.username;
        },
        role(roleId: string) {
            return guildId ? GuildRoleStore.getRole(guildId, roleId)?.name : null;
        },
        channel(channelId: string) {
            return ChannelStore.getChannel(channelId)?.name;
        },
    };
}

function selectedAttachments(message: Message, selection: Set<string> | null): MessageAttachment[] {
    const attachments = message.attachments.filter(attachment => selection === null || selection.has(attachment.id));
    if (selection !== null && attachments.length !== selection.size)
        throw new Error("One or more selected attachments are no longer available.");
    if (attachments.length > MAX_ATTACHMENT_COUNT)
        throw new Error(`Secure Messaging supports at most ${MAX_ATTACHMENT_COUNT} forwarded attachments.`);
    const total = attachments.reduce((sum, attachment) => sum + Number(attachment.size), 0);
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_TOTAL_FORWARD_BYTES)
        throw new Error("The selected attachments exceed Secure Messaging's 500 MiB forwarding limit.");
    return attachments;
}

async function readBoundedResponse(response: Response, expectedSize: number): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > expectedSize)
        throw new Error("Discord returned more attachment data than expected.");
    if (!response.body) {
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength !== expectedSize) throw new Error("Discord returned an incomplete attachment.");
        return data;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > expectedSize) throw new Error("Discord returned more attachment data than expected.");
            chunks.push(next.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
    if (total !== expectedSize) throw new Error("Discord returned an incomplete attachment.");
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return data;
}

async function fetchCandidate(url: URL, attachment: MessageAttachment, channelId: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
        });
        if (!response.ok || !validatedDiscordAttachmentUrl(response.url, channelId, attachment.id))
            throw new Error("Discord refused the attachment download.");
        return await readBoundedResponse(response, attachment.size);
    } finally {
        clearTimeout(timeout);
    }
}

async function refreshedAttachmentUrls(
    attachment: MessageAttachment,
    channelId: string,
): Promise<URL[]> {
    const originals = [attachment.url, attachment.proxy_url]
        .map(value => validatedDiscordAttachmentUrl(value, channelId, attachment.id))
        .filter((url): url is URL => url !== null);
    if (originals.length === 0) return [];
    try {
        const response = await RestAPI.post({
            url: Constants.Endpoints.ATTACHMENTS_REFRESH_URLS,
            body: { attachment_urls: originals.map(url => url.toString()) },
            retries: 2,
        });
        const refreshed = Array.isArray(response?.body?.refreshed_urls) ? response.body.refreshed_urls : [];
        return refreshed
            .map((entry: { refreshed?: unknown; }) => validatedDiscordAttachmentUrl(entry?.refreshed, channelId, attachment.id))
            .filter((url: URL | null): url is URL => url !== null);
    } catch {
        return [];
    }
}

async function downloadPlainAttachment(attachment: MessageAttachment, channelId: string): Promise<ForwardUpload> {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX_ATTACHMENT_BYTES)
        throw new Error("A forwarded attachment has an invalid size.");
    const direct = [attachment.url, attachment.proxy_url]
        .map(value => validatedDiscordAttachmentUrl(value, channelId, attachment.id))
        .filter((url): url is URL => url !== null);
    let lastError: unknown;
    const tryUrls = async (urls: URL[]): Promise<Uint8Array | null> => {
        for (const url of urls) {
            try {
                return await fetchCandidate(url, attachment, channelId);
            } catch (error) {
                lastError = error;
            }
        }
        return null;
    };
    const bytes = await tryUrls(direct) ?? await tryUrls(await refreshedAttachmentUrls(attachment, channelId));
    if (!bytes) throw lastError instanceof Error ? lastError : new Error("The forwarded attachment could not be downloaded.");

    try {
        const file = new File([Uint8Array.from(bytes).buffer], safeFilename(attachment.filename, attachment.id), {
            lastModified: Date.now(),
            type: safeMimeType(attachment.content_type),
        });
        const value = attachment as MessageAttachment & {
            duration_secs?: unknown;
            waveform?: unknown;
            description?: unknown;
        };
        return {
            description: attachmentDescription(value.description),
            duration: finiteDuration(value.duration_secs),
            file,
            spoiler: Boolean(attachment.spoiler),
            waveform: attachmentWaveform(value.waveform),
        };
    } finally {
        bytes.fill(0);
    }
}

function decryptedUpload(
    attachment: { data: Uint8Array; id: string; metadata: AttachmentMetadata; },
): ForwardUpload {
    const copy = Uint8Array.from(attachment.data);
    try {
        return {
            description: attachment.metadata.description,
            duration: attachment.metadata.duration,
            file: new File([copy.buffer], attachment.metadata.name, {
                lastModified: Date.now(),
                type: attachment.metadata.mimeType || "application/octet-stream",
            }),
            spoiler: attachment.metadata.spoiler,
            waveform: attachment.metadata.waveform,
        };
    } finally {
        copy.fill(0);
    }
}

async function prepareEncryptedSource(
    message: Message,
    selection: Set<string> | null,
    selective: boolean,
): Promise<PreparedForward> {
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId) throw new Error("Discord has no authenticated user.");
    const decrypted = await decryptCachedMessage(localUserId, message);
    if (decrypted.status !== "decrypted") {
        if (isNativeFailure(decrypted)) throw new Error(failureReason(decrypted));
        throw new Error("The encrypted message could not be authenticated for forwarding.");
    }

    let { plaintext } = decrypted;
    const uploads: ForwardUpload[] = [];
    if (message.attachments.length > 0) {
        const attachmentResult = await Native.decryptIncomingAttachments(localUserId, await encryptedAttachmentInput(message));
        if (attachmentResult.status !== "decrypted") {
            if (isNativeFailure(attachmentResult)) throw new Error(failureReason(attachmentResult));
            throw new Error("The encrypted attachments could not be authenticated for forwarding.");
        }
        plaintext = attachmentResult.plaintext;
        try {
            const selected = attachmentResult.attachments.filter(attachment => selection === null || selection.has(attachment.id));
            if (selection !== null && selected.length !== selection.size)
                throw new Error("One or more selected encrypted attachments are no longer available.");
            if (selected.length > MAX_ATTACHMENT_COUNT)
                throw new Error(`Secure Messaging supports at most ${MAX_ATTACHMENT_COUNT} forwarded attachments.`);
            const total = selected.reduce((sum, attachment) => sum + attachment.data.byteLength, 0);
            if (!Number.isSafeInteger(total) || total > MAX_TOTAL_FORWARD_BYTES)
                throw new Error("The selected encrypted attachments exceed Secure Messaging's forwarding limit.");
            uploads.push(...selected.map(decryptedUpload));
        } finally {
            for (const attachment of attachmentResult.attachments) attachment.data.fill(0);
        }
    } else if (selection !== null && selection.size > 0) {
        throw new Error("The selected encrypted attachments are no longer available.");
    }

    return {
        plaintext,
        stickerIds: selective ? [] : decrypted.stickers.map((sticker: SecureStickerItem) => sticker.id),
        uploads,
    };
}

async function preparePlainSource(
    message: Message,
    selection: Set<string> | null,
    selective: boolean,
): Promise<PreparedForward> {
    const attachments = selectedAttachments(message, selection);
    const uploads: ForwardUpload[] = [];
    for (const attachment of attachments) uploads.push(await downloadPlainAttachment(attachment, message.channel_id));
    return {
        plaintext: message.content,
        stickerIds: selective ? [] : messageStickerIds(message),
        uploads,
    };
}

function selectedEmbedCount(embeds: readonly ForwardEmbed[], selection: number[] | undefined): number {
    if (selection?.some(index => index >= embeds.length))
        throw new Error("One or more selected embeds are no longer available.");
    return secureForwardEmbedText(embeds, selection).length > 0 ? 1 : 0;
}

function forwardContentMessage(message: Message): Message {
    const snapshot = message.messageSnapshots?.[0]?.message;
    if (!snapshot) return message;
    const reference = message.messageReference;
    if (isEncryptedMessage(snapshot.content)) {
        const original = reference && MessageStore.getMessage(reference.channel_id, reference.message_id);
        if (!original || original.content !== snapshot.content)
            throw new Error("Open the original encrypted conversation before forwarding this copied message.");
        // A snapshot has no authenticated author, nonce or message provenance of its own.
        return original;
    }
    return Object.assign(Object.create(Object.getPrototypeOf(message)), message, snapshot, {
        channel_id: reference?.channel_id ?? message.channel_id,
    }) as Message;
}

async function secureForward(message: Message, destinationChannelId: string, options: ForwardOptions = {}): Promise<void> {
    const expectedGeneration = generation;
    const localUserId = UserStore.getCurrentUser()?.id;
    assertForwardStillActive(expectedGeneration, localUserId);
    message = forwardContentMessage(message);
    const rawAttachmentSelection = normalizeAttachmentSelection(options.onlyAttachmentIds);
    const rawEmbedSelection = normalizeEmbedSelection(options.onlyEmbedIndices);
    const selective = options.onlyAttachmentIds !== undefined || options.onlyEmbedIndices !== undefined;
    const attachmentSelection = selective ? rawAttachmentSelection ?? new Set<string>() : null;
    const embedSelection = selective ? rawEmbedSelection ?? [] : undefined;
    const encryptedSource = isEncryptedMessage(message.content);
    if (encryptedSource && rawEmbedSelection && rawEmbedSelection.length > 0)
        throw new Error("Forward the whole encrypted message to include links from its authenticated text.");
    const sourceEmbeds = (encryptedSource ? [] : message.embeds ?? []) as unknown as ForwardEmbed[];
    const embeds = selective && options.embedIndicesAreImages ? secureForwardImageEmbeds(sourceEmbeds) : sourceEmbeds;
    const embedCount = selectedEmbedCount(embeds, embedSelection);
    const prepared = encryptedSource
        ? await prepareEncryptedSource(message, attachmentSelection, selective)
        : await preparePlainSource(message, attachmentSelection, selective);
    assertForwardStillActive(expectedGeneration, localUserId);
    const destination = await inspectProtection(destinationChannelId);
    assertForwardStillActive(expectedGeneration, localUserId);
    if (!destination.protected || !destination.ready)
        throw new Error("The destination is no longer ready for an encrypted forward.");
    if (selective && prepared.uploads.length === 0 && embedCount === 0)
        throw new Error("The selected forwarded content is no longer available.");
    if (!prepared.plaintext.trim() && prepared.uploads.length === 0 && prepared.stickerIds.length === 0 && embedCount === 0)
        throw new Error("The forwarded content is no longer available.");

    const forwardedContent = composeSecureForwardText({
        attachmentSelection: attachmentSelection === null ? undefined : [...attachmentSelection],
        authorLabel: authorLabel(message),
        content: prepared.plaintext,
        embedSelection,
        embeds,
        mentionResolvers: mentionResolvers(message),
        timestampMs: timestampMs(message),
    });
    const note = typeof options.withMessage === "string" ? options.withMessage.trim() : "";
    const content = [note, forwardedContent].filter(Boolean).join("\n\n");
    const uploads = prepared.uploads.map(upload => cloudUpload(destinationChannelId, upload));
    const plugin = secureMessagingPlugin();
    if (!plugin?.sendEncryptedForward) throw new Error("Secure Messaging's encrypted send is unavailable.");
    await plugin.sendEncryptedForward(destinationChannelId, content, uploads, prepared.stickerIds);
}

async function routeForward(
    expectedGeneration: number,
    message: Message,
    destinationChannelId: string,
    options?: ForwardOptions,
): Promise<boolean> {
    if (!running || expectedGeneration !== generation)
        throw new Error("Forwarding was cancelled because the plugin state changed.");
    if (!SNOWFLAKE.test(destinationChannelId)) throw new Error("Discord supplied an invalid forwarding destination.");
    const localUserId = UserStore.getCurrentUser()?.id;
    const encryptedSource = isEncryptedMessage(message.content) ||
        isEncryptedMessage(message.messageSnapshots?.[0]?.message.content ?? "");
    if (secureMessagingPlugin()?.started !== true) {
        if (encryptedSource) throw new Error("Enable Secure Messaging before forwarding an encrypted message.");
        return false;
    }
    const [source, destination] = await Promise.all([
        inspectProtection(message.channel_id, encryptedSource),
        inspectProtection(destinationChannelId),
    ]);
    if (!running || expectedGeneration !== generation || !localUserId || UserStore.getCurrentUser()?.id !== localUserId)
        throw new Error("Forwarding was cancelled because the account or plugin state changed.");
    const route = secureForwardRoute(source, destination);
    if (route === "native") return false;
    if (route === "blocked") {
        const reason = destination.protected && !destination.ready
            ? destination.reason
            : "Protected messages can only be forwarded into another enabled protected conversation.";
        throw new Error(reason ?? "Secure Messaging blocked the forward safely.");
    }
    if (source.protected && !source.ready)
        throw new Error(source.reason ?? "The source conversation is not ready for an encrypted forward.");

    showToast("Preparing encrypted forward…", Toasts.Type.MESSAGE);
    await secureForward(message, destinationChannelId, options);
    showToast("Forwarded as a new encrypted message.", Toasts.Type.SUCCESS);
    return true;
}

export default definePlugin({
    name: "SecureMessagingForwarding",
    description: "Routes Discord forwards into protected conversations through Secure Messaging as new encrypted copies.",
    authors: [EquicordDevs.creations],
    hidden: true,
    required: true,

    patches: [{
        // These actions are private to ForwardModal. Its bulk sender consumes allSettled results.
        find: '"Unable to find original channel for message"',
        replacement: {
            match: /async sendForward\((\i),(\i),(\i)\)\{/,
            replace: "$&if(await $self.tryForward($1,$2,$3))return;",
        },
    }],

    start() {
        running = true;
        generation++;
    },

    stop() {
        running = false;
        generation++;
    },

    tryForward(message: Message, destinationChannelId: string, options?: ForwardOptions): Promise<boolean> {
        return routeForward(generation, message, destinationChannelId, options);
    },
});
