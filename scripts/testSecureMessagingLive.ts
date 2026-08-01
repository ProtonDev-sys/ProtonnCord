/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import puppeteer, { Page } from "puppeteer-core";

import {
    createKeyAnnouncement,
    decryptMessage,
    generateIdentity,
    verifyKeyAnnouncement,
} from "../src/equicordplugins/secureMessaging.desktop/crypto";
import {
    attachmentBundleRoot,
    decryptAttachmentBytes,
    parseSecurePlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/attachments";
import { decodeBase64Url } from "../src/equicordplugins/secureMessaging.desktop/protocol";

const TEST_CHANNEL_ID = "895063026686885909";
const EXPECTED_RECIPIENT_ID = "710514340855545878";
// Synthetic peer-announcement fixture; this snowflake decodes to 2026-01-01T00:00:00.000Z.
// The announcement is never posted, so the fixture supplies stable Discord provenance without creating another live message.
const SYNTHETIC_ANNOUNCEMENT_MESSAGE_ID = "1456074443980800000";
const DEBUG_URL = process.env.DISCORD_DEBUG_URL ?? "http://127.0.0.1:9222";
const ENCRYPTED_PREFIX = "PCEM2:";
const DISPOSABLE_ACKNOWLEDGEMENT = "I_UNDERSTAND_THIS_IS_DISPOSABLE";
const DISPOSABLE_FLAG_ENV = "PROTONN_CORD_SECURE_MESSAGING_LIVE_TEST";
const DISPOSABLE_DATA_DIR_ENV = "PROTONN_CORD_SECURE_MESSAGING_LIVE_DATA_DIR";
const CLIENT_DATA_DIR_ENV = "PROTONN_CORD_USER_DATA_DIR";
const PRESTARTED_PLUGIN_ENV = "PROTONN_CORD_SECURE_MESSAGING_PRESTARTED";
const PAGE_MESSAGE_REGISTRY = "__protonnCordSecureMessagingLiveMessageIds";
const PAGE_COMPOSER_PROOF = "__protonnCordSecureMessagingComposerProof";
const PAGE_DOWNLOAD_PROOF = "__protonnCordSecureMessagingDownloadProof";
const PROOF_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFUlEQVR4nGP8z8Dwn4GBgYEJRKAwADE7AgRVI0g0AAAAAElFTkSuQmCC";
const PROOF_PNG_FILENAME = `encrypted-proof-pixel-${process.pid}-${Date.now()}.png`;
const PROOF_WEBM_BASE64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKxEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggKb7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhAj0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WICC4QuYTfNmKcgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QF9eEA4JCwgRC6gRCagQJVsIRVuYEBElTDZ0B/c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2Mi4zLjEwMHNz2mPAi2PFiAguELmE3zZiZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4xMS4xMDAgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAB9DtnVA7eeBAKOrgQAAgIJJg0IAAPAA9gA4JBwYSgAAMGAAABC///cdr////1/f////8irAAKOTgQBkAIYAQJKcAFAAAAMgAABCQKOTgQDIAIYAQJKcAE7gAAMgAABCQKOTgQEsAIYAQJKcAFAAAAMgAABCQKOTgQGQAIYAQJKcAE1AAAMgAABCQKOTgQH0AIYAQJKcAFAAAAMgAABCQKOTgQJYAIYAQJKcAE7gAAMgAABCQKOTgQK8AIYAQJKcAFAAAAMgAABCQKOTgQMgAIYAQJKcAEogAAMgAABCQKOTgQOEAIYAQJKcAFAAAAMgAABCQBxTu2uRu4+zgQC3iveBAfGCAajwgQM=";
const PROOF_WEBM_FILENAME = `encrypted-proof-video-${process.pid}-${Date.now()}.webm`;
const PROOF_GENERIC_BASE64 = "ZW5jcnlwdGVkIGdlbmVyaWMgYXR0YWNobWVudCBwcm9vZlxu";
const PROOF_GENERIC_FILENAME = `encrypted-proof-file-${process.pid}-${Date.now()}.txt`;

interface RawDiscordMessage {
    attachments: RawDiscordAttachment[];
    authorId: string;
    channelId: string;
    content: string;
    editedTimestamp: string | null;
    id: string;
}

interface RawDiscordAttachment {
    contentType: string | null;
    filename: string;
    id: string;
    proxyUrl: string;
    size: number;
    url: string;
}

interface LivePreflight {
    localAnnouncement: string;
    localFingerprint: string;
    localUserId: string;
    recipientReviewToken: string;
    reviewedRecipientFingerprint: string;
    vaultReady: boolean;
}

interface CleanupProof {
    channelProtectionStatus: string;
    conversationStatus: string;
    participantStatus: string;
    selectedRecipientIds: string[];
    testMessagesDeleted: boolean;
}

function comparablePath(path: string): string {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

function requireDisposableDataDirectory(): string {
    assert.equal(
        process.env[DISPOSABLE_FLAG_ENV],
        DISPOSABLE_ACKNOWLEDGEMENT,
        `${DISPOSABLE_FLAG_ENV} must equal ${JSON.stringify(DISPOSABLE_ACKNOWLEDGEMENT)}`,
    );

    const declaredDataDir = process.env[DISPOSABLE_DATA_DIR_ENV];
    const clientDataDir = process.env[CLIENT_DATA_DIR_ENV];
    assert.ok(declaredDataDir, `${DISPOSABLE_DATA_DIR_ENV} must name the disposable test data directory`);
    assert.ok(clientDataDir, `${CLIENT_DATA_DIR_ENV} must explicitly route the client to the disposable test data directory`);
    assert.equal(isAbsolute(declaredDataDir), true, `${DISPOSABLE_DATA_DIR_ENV} must be an absolute path`);
    assert.equal(isAbsolute(clientDataDir), true, `${CLIENT_DATA_DIR_ENV} must be an absolute path`);
    assert.equal(
        comparablePath(declaredDataDir),
        comparablePath(clientDataDir),
        `${DISPOSABLE_DATA_DIR_ENV} and ${CLIENT_DATA_DIR_ENV} must resolve to the same directory`,
    );

    const absolute = resolve(declaredDataDir);
    assert.match(
        basename(absolute),
        /secure-messaging-live/iu,
        "the disposable data-directory basename must contain 'secure-messaging-live'",
    );
    return absolute;
}

function asError(error: unknown, context?: string): Error {
    const cause = error instanceof Error ? error : new Error(String(error));
    return context ? new Error(`${context}: ${cause.message}`) : cause;
}

async function assertNoExistingSecureMessagingVault(dataDir: string): Promise<void> {
    const vaultPath = resolve(dataDir, "secure-messaging", "vault.bin");
    try {
        await stat(vaultPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    throw new Error(`Refusing to reuse a SecureMessaging data directory that already contains ${vaultPath}`);
}

async function connectWithRetry() {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            return await puppeteer.connect({ browserURL: DEBUG_URL, defaultViewport: null });
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw lastError;
}

async function getDiscordPage(pages: Page[]): Promise<Page> {
    const deadline = Date.now() + 30_000;
    let candidates = pages;
    while (Date.now() < deadline) {
        const page = candidates.find(candidate => !candidate.isClosed() && candidate.url().includes("discord.com/channels")) ??
            candidates.find(candidate => !candidate.isClosed());
        if (page) {
            try {
                if (await page.evaluate(() => Boolean((globalThis as any).Vencord?.Plugins?.plugins))) return page;
            } catch {
                // Discord replaces its startup frame; reacquire the renderer page until it settles.
            }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        candidates = page ? await page.browser().pages() : candidates;
    }
    throw new Error("Discord did not expose a stable Protonn Cord renderer page");
}

async function assertConnectedClientUsesDisposableDataDir(page: Page, expectedDataDir: string): Promise<void> {
    const settingsDir = await page.evaluate(async () => {
        const getSettingsDir = (globalThis as any).VencordNative?.settings?.getSettingsDir;
        if (typeof getSettingsDir !== "function") throw new Error("The connected client cannot report its settings directory");
        return getSettingsDir();
    });
    assert.equal(
        comparablePath(dirname(settingsDir)),
        comparablePath(expectedDataDir),
        "the connected Discord client is not using the declared disposable Protonn Cord data directory",
    );
}

async function initializeMessageRegistry(page: Page): Promise<void> {
    await page.evaluate(registryName => {
        (globalThis as any)[registryName] = [];
    }, PAGE_MESSAGE_REGISTRY);
}

async function assertSecureMessagingInitialState(page: Page, expectStarted: boolean): Promise<void> {
    if (expectStarted) {
        await page.waitForFunction(() => {
            const vencord = (globalThis as any).Vencord;
            return Boolean(vencord?.Plugins?.plugins?.SecureMessaging?.started) &&
                vencord?.Settings?.plugins?.SecureMessaging?.enabled === true;
        }, { timeout: 30_000 });
    }
    await page.evaluate(expected => {
        const vencord = (globalThis as any).Vencord;
        const plugin = vencord?.Plugins?.plugins?.SecureMessaging;
        if (!plugin) throw new Error("SecureMessaging is missing from the installed client bundle");
        if (Boolean(plugin.started) !== expected)
            throw new Error(`SecureMessaging initial started state was ${Boolean(plugin.started)} instead of ${expected}`);
        const pluginSettings = Object.prototype.hasOwnProperty.call(vencord.Settings?.plugins ?? {}, "SecureMessaging")
            ? vencord.Settings.plugins.SecureMessaging
            : undefined;
        if (Boolean(pluginSettings?.enabled) !== expected)
            throw new Error(`SecureMessaging initial enabled setting was ${Boolean(pluginSettings?.enabled)} instead of ${expected}`);
    }, expectStarted);
}

async function assertMessageEventsSendPatch(page: Page): Promise<void> {
    await page.waitForFunction(() => document.querySelector('[role="textbox"]'), { timeout: 30_000 });
    const result = await page.evaluate(() => {
        const editor = document.querySelector('[role="textbox"]');
        const fiberKey = editor && Object.keys(editor).find(key => key.startsWith("__reactFiber$"));
        let fiber = fiberKey ? (editor as any)[fiberKey] : null;
        while (fiber) {
            const handleSendMessage = fiber.stateNode?.handleSendMessage;
            if (typeof handleSendMessage === "function") {
                const source = Function.prototype.toString.call(handleSendMessage);
                return source.split("Vencord.Api.MessageEvents._handlePreSend").length - 1;
            }
            fiber = fiber.return;
        }
        return 0;
    });
    assert.equal(result, 1, "the current chat-input send path must invoke MessageEvents exactly once");
}

async function preflightPristineState(page: Page, announcement: string, pluginPrestarted: boolean): Promise<LivePreflight> {
    return page.evaluate(async ({ announcement, announcementMessageId, channelId, pluginPrestarted, recipientId }) => {
        const global = globalThis as any;
        const vencord = global.Vencord;
        const common = vencord.Webpack.Common;
        const plugin = vencord.Plugins.plugins.SecureMessaging;
        if (!plugin) throw new Error("SecureMessaging is missing from the installed client bundle");
        const native = global.VencordNative?.pluginHelpers?.SecureMessaging;
        if (!native) throw new Error("SecureMessaging native IPC helpers are unavailable");
        if (Boolean(plugin.started) !== pluginPrestarted)
            throw new Error("SecureMessaging changed its started state after the initial preflight");
        const pluginSettings = Object.prototype.hasOwnProperty.call(vencord.Settings?.plugins ?? {}, "SecureMessaging")
            ? vencord.Settings.plugins.SecureMessaging
            : undefined;
        if (Boolean(pluginSettings?.enabled) !== pluginPrestarted)
            throw new Error("SecureMessaging changed its enabled setting after the initial preflight");

        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user");
        if (localUserId === recipientId) throw new Error("The authorized recipient unexpectedly matches the local account");

        const channel = common.ChannelStore.getChannel(channelId);
        if (!channel?.isDM?.()) throw new Error("The authorized test channel is not a loaded DM");
        const recipients: unknown[] = Array.isArray(channel.recipients) ? channel.recipients : [];
        const participantUserIds = [...new Set(recipients
            .filter((value: unknown): value is string => typeof value === "string" && value !== localUserId))]
            .sort((left, right) => left.localeCompare(right));
        if (participantUserIds.length !== 1 || participantUserIds[0] !== recipientId)
            throw new Error("The authorized test DM does not belong to the expected recipient");

        const persisted = await native.getChannelProtection(localUserId, channelId);
        if (persisted.status !== "unconfigured") {
            throw new Error(
                `Refusing to mutate an existing SecureMessaging conversation: persisted status is ${persisted.status}`,
            );
        }

        const snapshot = { channelId, kind: "DM", participantUserIds: [recipientId] };
        const conversation = await native.getConversation(localUserId, snapshot);
        if (conversation.status !== "unconfigured")
            throw new Error(`Refusing to mutate an existing SecureMessaging conversation: status is ${conversation.status}`);
        if (!Array.isArray(conversation.selectedRecipientIds) || conversation.selectedRecipientIds.length !== 0)
            throw new Error("Refusing to replace existing selected SecureMessaging recipients");
        const participant = conversation.participants?.find((candidate: any) => candidate.userId === recipientId);
        if (!participant || participant.status !== "untrusted") {
            throw new Error(
                `Refusing to replace existing peer trust or a changed key: participant status is ${participant?.status ?? "missing"}`,
            );
        }

        const identity = await native.getIdentity(localUserId);
        if (identity.status !== "ready") throw new Error(`Local OS-protected identity is unavailable: ${identity.status}`);
        const localAnnouncement = await native.createAnnouncement(localUserId);
        if (localAnnouncement.status !== "created") throw new Error(`Could not create local announcement: ${localAnnouncement.status}`);

        const review = await native.reviewAnnouncement(
            localUserId,
            recipientId,
            announcement,
            announcementMessageId,
            null,
        );
        if (review.status !== "trust_required") {
            throw new Error(
                `Refusing to forget or replace a pre-existing peer key: announcement review returned ${review.status}`,
            );
        }

        return {
            localAnnouncement: localAnnouncement.content,
            localFingerprint: identity.identity.fingerprint,
            localUserId,
            recipientReviewToken: review.reviewToken,
            reviewedRecipientFingerprint: review.identity.fingerprint,
            vaultReady: identity.status === "ready",
        };
    }, {
        announcement,
        announcementMessageId: SYNTHETIC_ANNOUNCEMENT_MESSAGE_ID,
        channelId: TEST_CHANNEL_ID,
        pluginPrestarted,
        recipientId: EXPECTED_RECIPIENT_ID,
    });
}

async function trustSyntheticRecipient(page: Page, reviewToken: string, fingerprint: string) {
    return page.evaluate(async ({ fingerprint, recipientId, reviewToken }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user");
        return native.trustReviewedKey(localUserId, recipientId, reviewToken, fingerprint);
    }, { fingerprint, recipientId: EXPECTED_RECIPIENT_ID, reviewToken });
}

async function configureSyntheticConversation(page: Page) {
    return page.evaluate(async ({ channelId, recipientId }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user");
        return native.configureConversation(localUserId, {
            enabled: true,
            selectedRecipientIds: [recipientId],
            snapshot: { channelId, kind: "DM", participantUserIds: [recipientId] },
        });
    }, { channelId: TEST_CHANNEL_ID, recipientId: EXPECTED_RECIPIENT_ID });
}

async function disableSyntheticConversationForTransition(page: Page) {
    return page.evaluate(async ({ channelId, recipientId }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user");
        return native.configureConversation(localUserId, {
            enabled: false,
            selectedRecipientIds: [],
            snapshot: { channelId, kind: "DM", participantUserIds: [recipientId] },
        });
    }, { channelId: TEST_CHANNEL_ID, recipientId: EXPECTED_RECIPIENT_ID });
}

async function verifyUnprotectedMessageLifecycle(page: Page, label: string, evictForwardSource = false): Promise<{
    editedPlaintextPreserved: boolean;
    forwardSourceEvicted: boolean;
    forwarded: boolean;
    messageIds: string[];
    plaintextPreserved: boolean;
}> {
    return page.evaluate(async ({ channelId, evictForwardSource, label, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const originalPlaintext = `${label} normal send ${crypto.randomUUID()}`;
        const editedPlaintext = `${label} normal edit ${crypto.randomUUID()}`;
        const post = await common.RestAPI.post({
            url: common.Constants.Endpoints.MESSAGES(channelId),
            body: {
                allowed_mentions: { parse: [] },
                attachments: [],
                channel_id: channelId,
                content: originalPlaintext,
                nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
            },
        });
        if (!post.body?.id) throw new Error(`${label} normal send did not return a Discord message`);
        (global[registryName] ??= []).push(String(post.body.id));

        const patch = await common.RestAPI.patch({
            url: common.Constants.Endpoints.MESSAGE(channelId, post.body.id),
            body: { content: editedPlaintext },
        });
        if (!patch.body?.id) throw new Error(`${label} normal edit did not return a Discord message`);

        const originalGetChannel = common.ChannelStore.getChannel;
        const originalGetMessage = common.MessageStore.getMessage;
        let forward;
        try {
            if (evictForwardSource) {
                common.ChannelStore.getChannel = (id: string) => id === channelId ? undefined : originalGetChannel(id);
                common.MessageStore.getMessage = (sourceChannelId: string, messageId: string) =>
                    sourceChannelId === channelId && messageId === String(post.body.id)
                        ? undefined
                        : originalGetMessage(sourceChannelId, messageId);
            }
            forward = await common.RestAPI.post({
                url: common.Constants.Endpoints.MESSAGES(channelId),
                body: {
                    allowed_mentions: { parse: [] },
                    attachments: [],
                    channel_id: channelId,
                    content: "",
                    message_reference: {
                        channel_id: channelId,
                        message_id: post.body.id,
                        type: 1,
                    },
                    nonce: common.SnowflakeUtils.fromTimestamp(Date.now() + 1),
                    sticker_ids: [],
                    type: 0,
                },
            });
        } finally {
            common.ChannelStore.getChannel = originalGetChannel;
            common.MessageStore.getMessage = originalGetMessage;
        }
        if (!forward.body?.id) throw new Error(`${label} normal forward did not return a Discord message`);
        (global[registryName] ??= []).push(String(forward.body.id));
        return {
            editedPlaintextPreserved: patch.body.content === editedPlaintext,
            forwardSourceEvicted: evictForwardSource,
            forwarded: Array.isArray(forward.body.message_snapshots) && forward.body.message_snapshots.length > 0,
            messageIds: [String(post.body.id), String(forward.body.id)],
            plaintextPreserved: post.body.content === originalPlaintext,
        };
    }, { channelId: TEST_CHANNEL_ID, evictForwardSource, label, registryName: PAGE_MESSAGE_REGISTRY });
}

async function verifyOldEncryptedActionsBlockedWhileDisabled(page: Page, message: RawDiscordMessage): Promise<{
    editBlocked: boolean;
    forwardBlocked: boolean;
}> {
    return page.evaluate(async ({ channelId, message, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        let editError = "";
        let forwardError = "";
        try {
            await common.RestAPI.patch({
                url: common.Constants.Endpoints.MESSAGE(channelId, message.id),
                body: { content: "disabled encrypted edit must not reach Discord" },
            });
        } catch (error) {
            editError = String(error);
        }
        try {
            const response = await common.RestAPI.post({
                url: common.Constants.Endpoints.MESSAGES(channelId),
                body: {
                    attachments: [],
                    channel_id: channelId,
                    content: "",
                    message_reference: { channel_id: channelId, message_id: message.id, type: 1 },
                    nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                    sticker_ids: [],
                    type: 0,
                },
            });
            if (response.body?.id) (global[registryName] ??= []).push(String(response.body.id));
        } catch (error) {
            forwardError = String(error);
        }
        return {
            editBlocked: /blocked editing an encrypted message|cannot be edited/iu.test(editError),
            forwardBlocked: /blocked forwarding/iu.test(forwardError),
        };
    }, { channelId: TEST_CHANNEL_ID, message, registryName: PAGE_MESSAGE_REGISTRY });
}

async function startSecureMessagingPlugin(page: Page): Promise<{ pluginStarted: boolean; startResult: unknown; }> {
    return page.evaluate(async () => {
        const vencord = (globalThis as any).Vencord;
        const plugin = vencord?.Plugins?.plugins?.SecureMessaging;
        if (!plugin) throw new Error("SecureMessaging is missing from the installed client bundle");
        if (plugin.started) throw new Error("SecureMessaging unexpectedly started after the pristine-state check");
        const startResult = await Promise.resolve(vencord.Plugins.startPlugin(plugin));
        return { pluginStarted: Boolean(plugin.started), startResult };
    });
}

async function waitForScreenCaptureProtection(page: Page): Promise<string> {
    try {
        await page.waitForFunction(() => {
            const plugin = (globalThis as any).Vencord?.Plugins?.plugins?.SecureMessaging;
            return plugin?.getScreenCaptureProtectionStatus?.() === "ready";
        }, { timeout: 30_000 });
    } catch (error) {
        const diagnostics = await page.evaluate(async () => {
            const global = globalThis as any;
            const plugin = global.Vencord?.Plugins?.plugins?.SecureMessaging;
            const native = global.VencordNative?.pluginHelpers?.SecureMessaging;
            let directProbe: unknown = "unavailable";
            if (typeof native?.setScreenCaptureProtection === "function") {
                directProbe = await Promise.race([
                    Promise.resolve(native.setScreenCaptureProtection(true)).catch((probeError: unknown) => ({
                        error: String(probeError),
                    })),
                    new Promise(resolve => setTimeout(() => resolve("timed_out_after_5_seconds"), 5_000)),
                ]);
            }
            return {
                directProbe,
                nativeHelperKeys: native ? Object.keys(native).sort() : [],
                pluginPresent: Boolean(plugin),
                pluginStarted: Boolean(plugin?.started),
                rootCaptureClassApplied: document.documentElement.classList.contains("pc-secure-screenshot-mode"),
                status: plugin?.getScreenCaptureProtectionStatus?.(),
            };
        });
        throw new Error(`Screen-capture protection did not become ready: ${JSON.stringify(diagnostics)} (${String(error)})`);
    }
    return page.evaluate(() => (globalThis as any).Vencord.Plugins.plugins.SecureMessaging.getScreenCaptureProtectionStatus());
}

async function verifyScreenshotMode(
    page: Page,
    message: RawDiscordMessage,
    plaintext: string,
    videoMessage: RawDiscordMessage,
) {
    await page.evaluate(({ channelId, messageId }) => {
        const row = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const image = row?.querySelector<HTMLImageElement>("img[src^='blob:']");
        if (!image) throw new Error("The encrypted image is unavailable for the media-modal screenshot proof");
        image.click();
    }, { channelId: message.channelId, messageId: message.id });
    await page.waitForFunction(({ channelId, messageId }) => {
        const row = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        return [...document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img[src^='blob:'], video[src^='blob:']")]
            .some(media => !row?.contains(media) && media.getBoundingClientRect().width > 0);
    }, { timeout: 10_000 }, { channelId: message.channelId, messageId: message.id });

    return page.evaluate(async ({ message, plaintext, videoMessage }) => {
        const plugin = (globalThis as any).Vencord?.Plugins?.plugins?.SecureMessaging;
        if (!plugin || typeof plugin.setScreenshotMode !== "function")
            throw new Error("SecureMessaging screenshot mode is unavailable");
        const imageRow = document.getElementById(`chat-messages-${message.channelId}-${message.id}`);
        const modalMedia = [...document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img[src^='blob:'], video[src^='blob:']")]
            .find(media => !imageRow?.contains(media) && media.getBoundingClientRect().width > 0);
        if (!modalMedia) throw new Error("The encrypted-media modal disappeared before screenshot mode was enabled");
        let screenshotModeEnabled = false;
        const videoRow = document.getElementById(`chat-messages-${videoMessage.channelId}-${videoMessage.id}`);
        const playingVideo = videoRow?.querySelector<HTMLVideoElement>("video");
        if (!playingVideo) throw new Error("The encrypted video is unavailable for the screenshot-mode playback proof");
        playingVideo.loop = true;
        playingVideo.muted = true;
        playingVideo.currentTime = 0;
        await playingVideo.play();
        try {
            screenshotModeEnabled = await plugin.setScreenshotMode(true);
            if (!screenshotModeEnabled) {
                const modalStyle = modalMedia.isConnected ? getComputedStyle(modalMedia) : null;
                throw new Error(`SecureMessaging refused to enable screenshot mode: ${JSON.stringify({
                    modalConnected: modalMedia.isConnected,
                    modalDisplay: modalStyle?.display ?? null,
                    modalVisibility: modalStyle?.visibility ?? null,
                    playingVideoPaused: playingVideo.paused,
                    protectionStatus: plugin.getScreenCaptureProtectionStatus?.(),
                    rootCaptureClassApplied: document.documentElement.classList.contains("pc-secure-screenshot-mode"),
                })}`);
            }
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            const row = document.getElementById(`chat-messages-${message.channelId}-${message.id}`);
            const attachmentSiblings = row?.querySelectorAll<HTMLElement>('[id^="message-accessories-"] > :not(.pc-secure-card)') ?? [];
            const visibleBlobMedia = [...document.querySelectorAll<HTMLImageElement | HTMLMediaElement>("img, video, audio")]
                .filter(media => {
                    const source = media instanceof HTMLMediaElement
                        ? media.currentSrc || media.src || media.querySelector<HTMLSourceElement>("source")?.src || ""
                        : media.src;
                    if (!source.startsWith("blob:")) return false;
                    const style = getComputedStyle(media);
                    return style.display !== "none" && style.visibility !== "hidden" && media.getBoundingClientRect().width > 0;
                });
            const modalStyle = modalMedia.isConnected ? getComputedStyle(modalMedia) : null;
            return {
                attachmentPixelsHidden: [...attachmentSiblings].every(element => getComputedStyle(element).display === "none"),
                encryptedPlaceholderVisible: row?.innerText.includes("Screenshot mode is on") ?? false,
                mediaModalClosed: !modalMedia.isConnected || modalStyle?.display === "none" ||
                    modalStyle?.visibility === "hidden" || modalMedia.getBoundingClientRect().width === 0,
                playingVideoStopped: playingVideo.paused || !playingVideo.isConnected,
                rootCaptureClassApplied: document.documentElement.classList.contains("pc-secure-screenshot-mode"),
                plaintextHidden: !(row?.innerText ?? "").includes(plaintext),
                visibleBlobMediaCount: visibleBlobMedia.length,
            };
        } finally {
            if (screenshotModeEnabled || plugin.getScreenCaptureProtectionStatus?.() === "failed") {
                const restored = await plugin.setScreenshotMode(false);
                if (!restored) throw new Error("SecureMessaging did not restore encrypted-content visibility");
            }
        }
    }, { message, plaintext, videoMessage });
}

async function verifyRenderedReplyPreview(
    page: Page,
    reply: RawDiscordMessage,
    referencedCiphertext: string,
    referencedPlaintext: string,
) {
    await page.waitForFunction(
        ({ channelId, messageId, plaintext }) => {
            const row = document.getElementById(`chat-messages-${channelId}-${messageId}`);
            return row?.innerText.includes(plaintext) ?? false;
        },
        { timeout: 30_000 },
        { channelId: reply.channelId, messageId: reply.id, plaintext: referencedPlaintext },
    );
    return page.evaluate(({ channelId, ciphertext, messageId, plaintext }) => {
        const row = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const rowText = row?.innerText ?? "";
        return {
            ciphertextHidden: !rowText.includes(ciphertext) && !rowText.includes("PCEM1:") && !rowText.includes("PCEM2:"),
            plaintextVisible: rowText.includes(plaintext),
        };
    }, {
        channelId: reply.channelId,
        ciphertext: referencedCiphertext,
        messageId: reply.id,
        plaintext: referencedPlaintext,
    });
}

async function assertPersistedProtectionAndMissingChannelFailClosed(page: Page): Promise<{
    channelStoreRestored: boolean;
    missingChannelBlocked: boolean;
    persistedStatus: string;
    safelyMocked: boolean;
}> {
    return page.evaluate(async ({ channelId, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user");
        const persisted = await native.getChannelProtection(localUserId, channelId);
        if (persisted.status !== "protected")
            throw new Error(`Persisted native channel protection is not active: ${persisted.status}`);

        const channelStore = common.ChannelStore;
        const originalGetChannel = channelStore.getChannel;
        if (typeof originalGetChannel !== "function") throw new Error("ChannelStore.getChannel is unavailable");

        let safelyMocked = false;
        let channelStoreRestored = false;
        let missingChannelError = "";
        try {
            channelStore.getChannel = function (candidateChannelId: string) {
                if (candidateChannelId === channelId) return undefined;
                return originalGetChannel.call(this, candidateChannelId);
            };
            safelyMocked = channelStore.getChannel(channelId) == null;
            if (!safelyMocked) throw new Error("ChannelStore.getChannel could not be safely shadowed");

            try {
                const response = await common.RestAPI.post({
                    url: common.Constants.Endpoints.MESSAGES(channelId),
                    body: { content: "" },
                });
                const messageId = response?.body?.id;
                if (typeof messageId === "string") (global[registryName] ??= []).push(messageId);
            } catch (error) {
                missingChannelError = String(error);
            }
        } finally {
            channelStore.getChannel = originalGetChannel;
            channelStoreRestored = channelStore.getChannel === originalGetChannel && channelStore.getChannel(channelId) != null;
        }

        return {
            channelStoreRestored,
            missingChannelBlocked: /protected conversation snapshot is unavailable/iu.test(missingChannelError),
            persistedStatus: persisted.status,
            safelyMocked,
        };
    }, { channelId: TEST_CHANNEL_ID, registryName: PAGE_MESSAGE_REGISTRY });
}

async function assertFailClosedBoundaries(page: Page): Promise<{
    attachmentBlocked: boolean;
    attachmentReservationBlocked: boolean;
    editBlocked: boolean;
    forwardingBlocked: boolean;
    forwardingError: string;
    prefixedPayloadBlocked: boolean;
}> {
    return page.evaluate(async ({ channelId, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const messageUrl = common.Constants.Endpoints.MESSAGES(channelId);
        const editUrl = common.Constants.Endpoints.MESSAGE(channelId, "100000000000000001");
        const attachmentReservationUrl = common.Constants.Endpoints.MESSAGE_CREATE_ATTACHMENT_UPLOAD?.(channelId) ??
            `/channels/${channelId}/attachments`;

        let attachmentError = "";
        try {
            const response = await common.RestAPI.post({
                url: messageUrl,
                body: { content: "must never be sent", attachments: [{ id: "0" }] },
            });
            const messageId = response?.body?.id;
            if (typeof messageId === "string") (global[registryName] ??= []).push(messageId);
        } catch (error) {
            attachmentError = String(error);
        }
        const editError = await common.RestAPI.patch({
            url: editUrl,
            body: { content: "must never be edited" },
        }).then(() => "", (error: unknown) => String(error));
        const forwardingError = await common.RestAPI.post({
            url: messageUrl,
            body: {
                attachments: [],
                content: "",
                message_reference: {
                    channel_id: channelId,
                    message_id: "100000000000000001",
                    type: 1,
                },
            },
        }).then(() => "", (error: unknown) => String(error));
        let prefixedPayloadError = "";
        try {
            const response = await common.RestAPI.post({
                url: messageUrl,
                body: { content: "PCEM1:not-encrypted-plaintext", attachments: [] },
            });
            const messageId = response?.body?.id;
            if (typeof messageId === "string") (global[registryName] ??= []).push(messageId);
        } catch (error) {
            prefixedPayloadError = String(error);
        }
        let attachmentReservationError = "";
        try {
            const response = await common.RestAPI.post({
                url: attachmentReservationUrl,
                body: {
                    content: "must never reach an attachment reservation",
                    files: [{ filename: "blocked.txt", file_size: 1, id: "0" }],
                },
            });
            const messageId = response?.body?.id;
            if (typeof messageId === "string") (global[registryName] ??= []).push(messageId);
        } catch (error) {
            attachmentReservationError = String(error);
        }

        return {
            attachmentBlocked: /blocked a malformed or unsupported programmatic send/iu.test(attachmentError),
            attachmentReservationBlocked: /blocked an unauthorized attachment upload reservation/iu.test(attachmentReservationError),
            editBlocked: /blocked an edit because the original message is unavailable/iu.test(editError),
            forwardingBlocked: /blocked forwarding into or out of a protected conversation/iu.test(forwardingError),
            forwardingError,
            prefixedPayloadBlocked: /blocked (?:an unauthorized prefixed programmatic payload|stale encrypted content after the conversation changed)/iu
                .test(prefixedPayloadError),
        };
    }, { channelId: TEST_CHANNEL_ID, registryName: PAGE_MESSAGE_REGISTRY });
}

async function prepareThroughRuntimeMessageEvents(page: Page, plaintext: string): Promise<{
    cancelled: boolean;
    content: string;
    plaintextWasTransformed: boolean;
}> {
    return page.evaluate(async ({ channelId, encryptedPrefix, plaintext }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const messageEvents = global.Vencord.Api?.MessageEvents;
        if (typeof messageEvents?._handlePreSend !== "function")
            throw new Error("The runtime MessageEvents pre-send dispatcher is unavailable");
        const channel = common.ChannelStore.getChannel(channelId);
        if (!channel) throw new Error("The authorized test channel is not loaded");

        const message = {
            content: plaintext,
            invalidEmojis: [],
            tts: false,
            validNonShortcutEmojis: [],
        };
        const contentOptions = {
            channelId,
            command: null,
            content: plaintext,
            isGif: false,
            stickers: [],
            uploads: [],
        };
        const options = {
            ...contentOptions,
            allowedMentions: { parse: [], repliedUser: false },
            location: "SecureMessaging live harness",
            stickerIds: [],
        };
        const props = {
            channel,
            content: plaintext,
            hasAttachments: false,
            hasStickers: false,
            openWarningPopout: null,
        };
        const cancelled = await messageEvents._handlePreSend(channelId, message, options, props, contentOptions);
        return {
            cancelled: Boolean(cancelled),
            content: message.content,
            plaintextWasTransformed: message.content !== plaintext && message.content.startsWith(encryptedPrefix),
        };
    }, { channelId: TEST_CHANNEL_ID, encryptedPrefix: ENCRYPTED_PREFIX, plaintext });
}

async function sendThroughActualComposer(page: Page, plaintext: string): Promise<{
    message: RawDiscordMessage;
    messagePostCount: number;
    messageStoreCiphertextMatched: boolean;
}> {
    await page.evaluate(({ channelId, proofName, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const rest = common.RestAPI;
        const originalPost = rest.post;
        const endpoint = common.Constants.Endpoints.MESSAGES(channelId);
        const proof = {
            messagePostCount: 0,
            originalPost,
            response: null as any,
        };
        global[proofName] = proof;
        rest.post = async function (request: Record<string, unknown>, ...args: unknown[]) {
            const isMessagePost = request?.url === endpoint;
            if (isMessagePost) proof.messagePostCount++;
            const response = await originalPost.call(rest, request, ...args);
            if (isMessagePost && response?.body?.id) {
                proof.response = response.body;
                (global[registryName] ??= []).push(String(response.body.id));
            }
            return response;
        };
    }, {
        channelId: TEST_CHANNEL_ID,
        proofName: PAGE_COMPOSER_PROOF,
        registryName: PAGE_MESSAGE_REGISTRY,
    });

    try {
        const composer = await page.waitForSelector('[role="textbox"][contenteditable="true"][data-slate-editor="true"]', {
            timeout: 30_000,
            visible: true,
        });
        if (!composer) throw new Error("Discord's real chat composer is unavailable");
        await composer.click();
        await page.keyboard.down("Control");
        await page.keyboard.press("A");
        await page.keyboard.up("Control");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(plaintext);
        await page.keyboard.press("Enter");
        await page.waitForFunction(
            proofName => Boolean((globalThis as any)[proofName]?.response?.id),
            { timeout: 30_000 },
            PAGE_COMPOSER_PROOF,
        );
        return await page.evaluate(({ proofName }) => {
            const global = globalThis as any;
            const common = global.Vencord.Webpack.Common;
            const proof = global[proofName];
            const response = proof.response;
            const stored = common.MessageStore.getMessage(String(response.channel_id), String(response.id));
            return {
                message: {
                    attachments: [],
                    authorId: String(response.author.id),
                    channelId: String(response.channel_id),
                    content: String(response.content),
                    editedTimestamp: typeof response.edited_timestamp === "string" ? response.edited_timestamp : null,
                    id: String(response.id),
                },
                messagePostCount: proof.messagePostCount,
                messageStoreCiphertextMatched: stored?.content === response.content,
            };
        }, { proofName: PAGE_COMPOSER_PROOF });
    } finally {
        await page.evaluate(proofName => {
            const global = globalThis as any;
            const proof = global[proofName];
            if (proof?.originalPost) global.Vencord.Webpack.Common.RestAPI.post = proof.originalPost;
            delete global[proofName];
        }, PAGE_COMPOSER_PROOF);
    }
}

async function sendAuthorizedRuntimePayload(page: Page, content: string): Promise<{
    attachmentBearingPayloadBlocked: boolean;
    message: RawDiscordMessage;
    oneShotReplayBlocked: boolean;
}> {
    return page.evaluate(async ({ channelId, content, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const url = common.Constants.Endpoints.MESSAGES(channelId);
        const baseBody = {
            allowed_mentions: { parse: [], replied_user: false },
            channel_id: channelId,
            content,
            nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
            sticker_ids: [],
            type: 0,
        };

        let attachmentError = "";
        try {
            const unexpected = await common.RestAPI.post({
                url,
                body: { ...baseBody, attachments: [{ filename: "blocked.txt", id: "0" }] },
            });
            const unexpectedId = unexpected?.body?.id;
            if (typeof unexpectedId === "string") (global[registryName] ??= []).push(unexpectedId);
        } catch (error) {
            attachmentError = String(error);
        }

        const response = await common.RestAPI.post({ url, body: { ...baseBody, attachments: [] } });
        const message = response.body;
        if (!message?.id) throw new Error("Discord REST did not return the authorized runtime-listener message");
        (global[registryName] ??= []).push(String(message.id));

        let replayError = "";
        try {
            const unexpected = await common.RestAPI.post({
                url,
                body: {
                    ...baseBody,
                    attachments: [],
                    nonce: common.SnowflakeUtils.fromTimestamp(Date.now() + 1),
                },
            });
            const unexpectedId = unexpected?.body?.id;
            if (typeof unexpectedId === "string") (global[registryName] ??= []).push(unexpectedId);
        } catch (error) {
            replayError = String(error);
        }

        return {
            attachmentBearingPayloadBlocked: /blocked an unauthorized prefixed programmatic payload/iu.test(attachmentError),
            message: {
                attachments: [],
                authorId: String(message.author.id),
                channelId: String(message.channel_id),
                content: String(message.content),
                editedTimestamp: typeof message.edited_timestamp === "string" ? message.edited_timestamp : null,
                id: String(message.id),
            },
            oneShotReplayBlocked: /blocked an unauthorized prefixed programmatic payload/iu.test(replayError),
        };
    }, { channelId: TEST_CHANNEL_ID, content, registryName: PAGE_MESSAGE_REGISTRY });
}

async function sendAuthorizedAfterOfflineFailure(page: Page, content: string): Promise<{
    connectionFailureObserved: boolean;
    message: RawDiscordMessage;
    nonceEnforced: boolean;
}> {
    let failedAttempt: { error: string; request: Record<string, unknown>; } | undefined;
    await page.setOfflineMode(true);
    try {
        failedAttempt = await page.evaluate(async ({ channelId, content }) => {
            const common = (globalThis as any).Vencord.Webpack.Common;
            const request = {
                url: common.Constants.Endpoints.MESSAGES(channelId),
                body: {
                    allowed_mentions: { parse: [], replied_user: false },
                    attachments: [],
                    channel_id: channelId,
                    content,
                    nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                    sticker_ids: [],
                    type: 0,
                },
                retries: 0,
            };
            let error = "";
            try {
                await common.RestAPI.post(request);
            } catch (reason) {
                error = String(reason);
            }
            return { error, request };
        }, { channelId: TEST_CHANNEL_ID, content });
    } finally {
        await page.setOfflineMode(false);
    }
    if (!failedAttempt?.error) throw new Error("Discord unexpectedly completed a message POST while the browser was offline");
    const failedBody = failedAttempt.request.body as Record<string, unknown> | undefined;
    const nonceEnforced = failedBody?.enforce_nonce === true &&
        (typeof failedBody.nonce === "string" || typeof failedBody.nonce === "number");
    await page.waitForFunction(() => navigator.onLine, { timeout: 10_000 });
    const message = await page.evaluate(async ({ registryName, request }) => {
        const global = globalThis as any;
        const response = await global.Vencord.Webpack.Common.RestAPI.post(request);
        if (!response.body?.id) throw new Error("Discord did not accept the restored encrypted authorization after reconnecting");
        (global[registryName] ??= []).push(String(response.body.id));
        return {
            attachments: [],
            authorId: String(response.body.author.id),
            channelId: String(response.body.channel_id),
            content: String(response.body.content),
            editedTimestamp: typeof response.body.edited_timestamp === "string" ? response.body.edited_timestamp : null,
            id: String(response.body.id),
        };
    }, { registryName: PAGE_MESSAGE_REGISTRY, request: failedAttempt.request });
    return { connectionFailureObserved: true, message, nonceEnforced };
}

async function editEncryptedMessageThroughRuntime(
    page: Page,
    original: RawDiscordMessage,
    originalPlaintext: string,
    editedPlaintext: string,
    retainAttachmentIds: string[] = [],
): Promise<{
    editorPlaintextVisible: boolean;
    message: RawDiscordMessage;
    plaintextWasTransformed: boolean;
    replayBlocked: boolean;
}> {
    await page.waitForFunction(({ channelId, messageId }) =>
        Boolean((globalThis as any).Vencord?.Webpack?.Common?.MessageStore?.getMessage?.(channelId, messageId)),
    { timeout: 30_000 }, { channelId: original.channelId, messageId: original.id });

    return page.evaluate(async ({ channelId, editedPlaintext, encryptedPrefix, messageId, originalPlaintext, retainAttachmentIds }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const messageEvents = global.Vencord.Api?.MessageEvents;
        const stored = common.MessageStore.getMessage(channelId, messageId);
        if (!stored) throw new Error("The encrypted edit target is absent from MessageStore");

        // Discord's visible context-menu edit button and up-arrow shortcut both use the
        // record action, so exercise that exact path rather than only the lower-level action.
        common.MessageActions.startEditMessageRecord(stored.channel_id, stored, "secure-messaging-live-proof");
        const editorDeadline = Date.now() + 10_000;
        let editorPlaintextVisible = false;
        while (Date.now() < editorDeadline) {
            const editor = [...document.querySelectorAll<HTMLElement>('[role="textbox"]')]
                .find(candidate => candidate.textContent?.includes(originalPlaintext));
            if (editor) {
                editorPlaintextVisible = !(editor.textContent ?? "").includes(encryptedPrefix);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        common.MessageActions.endEditMessage?.(stored.channel_id, stored.id);

        if (typeof messageEvents?._handlePreEdit !== "function")
            throw new Error("The runtime MessageEvents pre-edit dispatcher is unavailable");
        const edit = {
            content: editedPlaintext,
            invalidEmojis: [],
            tts: false,
            validNonShortcutEmojis: [],
        };
        const cancelled = await messageEvents._handlePreEdit(stored.channel_id, stored.id, edit);
        if (cancelled) throw new Error("Secure Messaging cancelled a valid encrypted edit");
        if (!edit.content.startsWith(encryptedPrefix) || edit.content.includes(editedPlaintext))
            throw new Error("Secure Messaging did not transform edited plaintext before REST");

        const body: Record<string, unknown> = { content: edit.content };
        if (retainAttachmentIds.length > 0)
            body.attachments = retainAttachmentIds.map(id => ({ id }));
        const response = await common.RestAPI.patch({
            url: common.Constants.Endpoints.MESSAGE(stored.channel_id, stored.id),
            body,
        });
        const message = response.body;
        if (!message?.id || typeof message.edited_timestamp !== "string")
            throw new Error("Discord REST did not return the encrypted edited message");

        const replayError = await common.RestAPI.patch({
            url: common.Constants.Endpoints.MESSAGE(stored.channel_id, stored.id),
            body,
        }).then(() => "", (error: unknown) => String(error));

        return {
            editorPlaintextVisible,
            message: {
                attachments: (message.attachments ?? []).map((attachment: any) => ({
                    contentType: typeof attachment.content_type === "string" ? attachment.content_type : null,
                    filename: String(attachment.filename),
                    id: String(attachment.id),
                    proxyUrl: String(attachment.proxy_url),
                    size: Number(attachment.size),
                    url: String(attachment.url),
                })),
                authorId: String(message.author.id),
                channelId: String(message.channel_id),
                content: String(message.content),
                editedTimestamp: message.edited_timestamp,
                id: String(message.id),
            },
            plaintextWasTransformed: edit.content !== editedPlaintext,
            replayBlocked: /blocked an unauthorized prefixed programmatic edit/iu.test(replayError),
        };
    }, {
        channelId: original.channelId,
        encryptedPrefix: ENCRYPTED_PREFIX,
        editedPlaintext,
        messageId: original.id,
        originalPlaintext,
        retainAttachmentIds,
    });
}

async function sendAuthorizedRuntimeReply(page: Page, content: string, referencedMessageId: string): Promise<RawDiscordMessage> {
    return page.evaluate(async ({ channelId, content, referencedMessageId, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const response = await common.RestAPI.post({
            url: common.Constants.Endpoints.MESSAGES(channelId),
            body: {
                allowed_mentions: { parse: [], replied_user: false },
                attachments: [],
                channel_id: channelId,
                content,
                message_reference: {
                    channel_id: channelId,
                    message_id: referencedMessageId,
                },
                nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
            },
        });
        const message = response.body;
        if (!message?.id) throw new Error("Discord REST did not return the authorized encrypted reply");
        (global[registryName] ??= []).push(String(message.id));
        return {
            attachments: [],
            authorId: String(message.author.id),
            channelId: String(message.channel_id),
            content: String(message.content),
            editedTimestamp: typeof message.edited_timestamp === "string" ? message.edited_timestamp : null,
            id: String(message.id),
        };
    }, { channelId: TEST_CHANNEL_ID, content, referencedMessageId, registryName: PAGE_MESSAGE_REGISTRY });
}

async function sendEncryptedAttachmentThroughRuntime(page: Page, plaintext: string, fixture = {
    base64: PROOF_PNG_BASE64,
    filename: PROOF_PNG_FILENAME,
    mimeType: "image/png",
}): Promise<{
    ciphertextHidFileBytes: boolean;
    ciphertextHidFilename: boolean;
    eagerPlaintextUploadDeferred: boolean;
    encryptedFilename: string;
    message: RawDiscordMessage;
    plaintextWasTransformed: boolean;
    retryRegeneratedFromOriginal: boolean;
    wireContentLength: number;
}> {
    return page.evaluate(async ({ channelId, encryptedPrefix, fileBase64, filename, mimeType, plaintext, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const messageEvents = global.Vencord.Api?.MessageEvents;
        if (typeof messageEvents?._handlePreSend !== "function")
            throw new Error("The runtime MessageEvents pre-send dispatcher is unavailable");
        const channel = common.ChannelStore.getChannel(channelId);
        if (!channel) throw new Error("The authorized test channel is not loaded");

        const fileBytes = Uint8Array.from(atob(fileBase64), value => value.charCodeAt(0));
        const file = new File([fileBytes], filename, { type: mimeType });
        const upload = new common.CloudUploader({ file, platform: 1 }, channelId);
        await upload.upload();
        const eagerPlaintextUploadDeferred = upload.status === "NOT_STARTED" &&
            upload.uploadedFilename == null && upload.responseUrl == null;
        if (!eagerPlaintextUploadDeferred)
            throw new Error("Secure Messaging did not defer Discord's eager plaintext attachment upload");
        const message = {
            content: plaintext,
            invalidEmojis: [],
            tts: false,
            validNonShortcutEmojis: [],
        };
        const contentOptions = {
            channelId,
            command: null,
            content: plaintext,
            isGif: false,
            stickers: [],
            uploads: [upload],
        };
        const options = {
            ...contentOptions,
            allowedMentions: { parse: [], repliedUser: false },
            location: "SecureMessaging encrypted-attachment live harness",
            stickerIds: [],
        };
        const props = {
            channel,
            content: plaintext,
            hasAttachments: true,
            hasStickers: false,
            openWarningPopout: null,
        };
        const cancelled = await messageEvents._handlePreSend(channelId, message, options, props, contentOptions);
        if (cancelled) throw new Error("Secure Messaging cancelled a valid encrypted attachment send");
        if (!message.content.startsWith(encryptedPrefix) || message.content.includes(plaintext))
            throw new Error("Secure Messaging did not transform attachment-message plaintext before upload");
        if (!(upload.item.file instanceof File) || !upload.filename.endsWith(".pcaf") || upload.item.file.type !== "application/octet-stream")
            throw new Error("Secure Messaging did not replace the pending file with an opaque encrypted upload");

        const firstAttemptContent = message.content;
        const firstAttemptFilename = upload.filename;
        const firstAttemptCiphertext = new Uint8Array(await upload.item.file.arrayBuffer());
        message.content = plaintext;
        const retryCancelled = await messageEvents._handlePreSend(channelId, message, options, props, contentOptions);
        if (retryCancelled) throw new Error("Secure Messaging cancelled an encrypted attachment retry after a failed send attempt");
        if (!(upload.item.file instanceof File) || !upload.filename.endsWith(".pcaf") || upload.item.file.type !== "application/octet-stream")
            throw new Error("Secure Messaging did not rebuild an opaque upload for an encrypted attachment retry");
        const retryCiphertext = new Uint8Array(await upload.item.file.arrayBuffer());
        const retryRegeneratedFromOriginal = firstAttemptContent !== message.content &&
            firstAttemptFilename !== upload.filename &&
            (firstAttemptCiphertext.length !== retryCiphertext.length ||
                firstAttemptCiphertext.some((value, index) => value !== retryCiphertext[index]));
        if (!retryRegeneratedFromOriginal)
            throw new Error("Secure Messaging reused stale attachment ciphertext after a failed send attempt");

        const ciphertext = retryCiphertext;
        let ciphertextHidFileBytes = true;
        outer: for (let offset = 0; offset <= ciphertext.length - fileBytes.length; offset++) {
            for (let index = 0; index < fileBytes.length; index++) {
                if (ciphertext[offset + index] !== fileBytes[index]) continue outer;
                }
            ciphertextHidFileBytes = false;
            break;
        }
        const ciphertextHidFilename = !new TextDecoder().decode(ciphertext).includes(filename);

        await new Promise<void>((resolve, reject) => {
            upload.on("complete", resolve);
            upload.on("error", (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
            try {
                upload.upload();
            } catch (error) {
                reject(error);
            }
        });
        if (typeof upload.uploadedFilename !== "string" || upload.uploadedFilename.length === 0)
            throw new Error("Discord did not return an encrypted attachment upload token");

        const response = await common.RestAPI.post({
            url: common.Constants.Endpoints.MESSAGES(channelId),
            body: {
                allowed_mentions: { parse: [], replied_user: false },
                attachments: [{ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename }],
                channel_id: channelId,
                content: message.content,
                nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
            },
        });
        const sent = response.body;
        if (!sent?.id || !Array.isArray(sent.attachments) || sent.attachments.length !== 1)
            throw new Error("Discord REST did not return the encrypted attachment message");
        (global[registryName] ??= []).push(String(sent.id));

        return {
            ciphertextHidFileBytes,
            ciphertextHidFilename,
            eagerPlaintextUploadDeferred,
            encryptedFilename: String(upload.filename),
            message: {
                attachments: sent.attachments.map((attachment: any) => ({
                    contentType: typeof attachment.content_type === "string" ? attachment.content_type : null,
                    filename: String(attachment.filename),
                    id: String(attachment.id),
                    proxyUrl: String(attachment.proxy_url),
                    size: Number(attachment.size),
                    url: String(attachment.url),
                })),
                authorId: String(sent.author.id),
                channelId: String(sent.channel_id),
                content: String(sent.content),
                editedTimestamp: typeof sent.edited_timestamp === "string" ? sent.edited_timestamp : null,
                id: String(sent.id),
            },
            plaintextWasTransformed: message.content !== plaintext,
            retryRegeneratedFromOriginal,
            wireContentLength: message.content.length,
        };
    }, {
        channelId: TEST_CHANNEL_ID,
        encryptedPrefix: ENCRYPTED_PREFIX,
        fileBase64: fixture.base64,
        filename: fixture.filename,
        mimeType: fixture.mimeType,
        plaintext,
        registryName: PAGE_MESSAGE_REGISTRY,
    });
}

async function sendThroughRestGuard(page: Page, plaintext: string): Promise<RawDiscordMessage> {
    return page.evaluate(async ({ channelId, plaintext, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const response = await common.RestAPI.post({
            url: common.Constants.Endpoints.MESSAGES(channelId),
            body: {
                allowed_mentions: { parse: [], replied_user: false },
                attachments: [],
                channel_id: channelId,
                content: plaintext,
                nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
            },
        });
        const message = response.body;
        if (!message?.id) throw new Error("Discord REST did not return the sent message");
        (global[registryName] ??= []).push(String(message.id));
        return {
            attachments: [],
            authorId: String(message.author.id),
            channelId: String(message.channel_id),
            content: String(message.content),
            editedTimestamp: typeof message.edited_timestamp === "string" ? message.edited_timestamp : null,
            id: String(message.id),
        };
    }, { channelId: TEST_CHANNEL_ID, plaintext, registryName: PAGE_MESSAGE_REGISTRY });
}

async function verifyRenderedMessage(page: Page, message: RawDiscordMessage, plaintext: string) {
    await page.waitForFunction(({ channelId, messageId, plaintext }) => {
        const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        return item?.querySelector(".pc-secure-card-plaintext")?.textContent?.includes(plaintext);
    }, { timeout: 30_000 }, { channelId: message.channelId, messageId: message.id, plaintext });

    return page.evaluate(({ channelId, messageId, plaintext }) => {
        const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const rawContent = item?.querySelector<HTMLElement>("[class*='messageContent']");
        const plaintextCard = item?.querySelector<HTMLElement>(".pc-secure-card-plaintext");
        return {
            plaintextVisible: plaintextCard?.textContent?.includes(plaintext) ?? false,
            rawCiphertextHidden: rawContent ? getComputedStyle(rawContent).display === "none" : false,
            verifiedHeader: item?.querySelector(".pc-secure-card-header")?.textContent?.includes("Verified encrypted message") ?? false,
        };
    }, { channelId: message.channelId, messageId: message.id, plaintext });
}

async function verifyRenderedEncryptedAttachment(page: Page, message: RawDiscordMessage, plaintext: string) {
    try {
        await page.waitForFunction(({ channelId, messageId, plaintext }) => {
            const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
            const image = item?.querySelector<HTMLImageElement>("img[src^='blob:']");
            return item?.querySelector(".pc-secure-card-plaintext")?.textContent?.includes(plaintext) &&
                image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
        }, { timeout: 20_000 }, { channelId: message.channelId, messageId: message.id, plaintext });
    } catch {
        // The structured diagnostic below is more useful than Puppeteer's generic timeout.
    }

    const proof = await page.evaluate(async ({ channelId, encryptedFilename, messageId, plaintext, pngBase64 }) => {
        const global = globalThis as any;
        const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const image = item?.querySelector<HTMLImageElement>("img[src^='blob:']");
        const storedMessage = global.Vencord?.Webpack?.Common?.MessageStore?.getMessage?.(channelId, messageId);
        const passiveOwner = { forceUpdate: Function.prototype };
        const projectedMessage = storedMessage
            ? global.Vencord?.Plugins?.plugins?.SecureMessaging?.patchEncryptedAttachments?.(storedMessage, passiveOwner)
            : null;
        const projectedAttachment = projectedMessage?.attachments?.[0];
        let downloadedBase64 = "";
        if (typeof projectedAttachment?.url === "string" && projectedAttachment.url.startsWith("blob:")) {
            const response = await fetch(projectedAttachment.url);
            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 8_192)
                binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
            downloadedBase64 = btoa(binary);
        }
        const refreshedMessage = storedMessage?.set?.("attachments", storedMessage.attachments.map((attachment: any) => {
            const url = new URL(attachment.url);
            url.searchParams.set("ex", "0");
            const proxyUrl = new URL(attachment.proxy_url);
            proxyUrl.searchParams.set("ex", "0");
            return { ...attachment, url: url.toString(), proxy_url: proxyUrl.toString() };
        }));
        const refreshedProjection = refreshedMessage
            ? global.Vencord?.Plugins?.plugins?.SecureMessaging?.patchEncryptedAttachments?.(refreshedMessage, passiveOwner)
            : null;
        let imageObscured = false;
        for (let ancestor: HTMLElement | null = image?.parentElement ?? null; ancestor && ancestor !== item; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.filter.includes("brightness(0)") || ancestor.className.includes("hiddenExplicit")) {
                imageObscured = true;
                break;
            }
        }
        return {
            html: item?.innerHTML.slice(0, 8_000) ?? "",
            images: [...(item?.querySelectorAll<HTMLImageElement>("img") ?? [])].map(candidate => ({
                complete: candidate.complete,
                height: candidate.naturalHeight,
                src: candidate.src.slice(0, 200),
                width: candidate.naturalWidth,
            })),
            imageHeight: image?.naturalHeight ?? 0,
            imageObscured,
            imageUsesLocalAuthenticatedUrl: image?.src.startsWith("blob:") ?? false,
            imageWidth: image?.naturalWidth ?? 0,
            localContentScanVersion: projectedMessage?.attachments?.[0]?.content_scan_version ?? null,
            downloadBytesMatch: downloadedBase64 === pngBase64,
            downloadFilename: projectedAttachment?.filename ?? "",
            downloadMimeType: projectedAttachment?.content_type ?? "",
            plaintextVisible: item?.querySelector(".pc-secure-card-plaintext")?.textContent?.includes(plaintext) ?? false,
            rawEncryptedFilenameHidden: !(item?.textContent ?? "").includes(encryptedFilename),
            signedUrlRefreshCacheStable: refreshedProjection?.attachments?.[0]?.url === projectedAttachment?.url,
            text: item?.textContent?.slice(0, 2_000) ?? "",
        };
    }, {
        channelId: message.channelId,
        encryptedFilename: message.attachments[0]?.filename ?? "",
        messageId: message.id,
        plaintext,
        pngBase64: PROOF_PNG_BASE64,
    });
    if (!proof.imageUsesLocalAuthenticatedUrl || proof.imageWidth < 1 || proof.imageHeight < 1)
        throw new Error(`Encrypted attachment native-render diagnostic: ${JSON.stringify(proof)}`);
    return proof;
}

function isDownloadFilenameVariant(candidate: string, expectedFilename: string): boolean {
    if (candidate === expectedFilename) return true;
    const extension = extname(expectedFilename);
    const stem = extension ? expectedFilename.slice(0, -extension.length) : expectedFilename;
    if (!candidate.startsWith(`${stem} (`) || !candidate.endsWith(`)${extension}`)) return false;
    return /^\d+$/.test(candidate.slice(stem.length + 2, -(extension.length + 1)));
}

async function waitForDownloadedFile(downloadPath: string, timeoutMs = 30_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            return await readFile(downloadPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    throw new Error(`The intercepted download did not appear within ${timeoutMs}ms: ${downloadPath}`);
}

async function verifyRenderedEncryptedVideo(page: Page, message: RawDiscordMessage, plaintext: string) {
    try {
        await page.waitForFunction(({ channelId, messageId, plaintext }) => {
            const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
            const video = item?.querySelector<HTMLVideoElement>("video");
            return item?.querySelector(".pc-secure-card-plaintext")?.textContent?.includes(plaintext) &&
                video && video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0 && video.videoHeight > 0;
        }, { timeout: 30_000 }, { channelId: message.channelId, messageId: message.id, plaintext });
    } catch (error) {
        const diagnostic = await page.evaluate(({ channelId, messageId }) => {
            const global = globalThis as any;
            const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
            const storedMessage = global.Vencord?.Webpack?.Common?.MessageStore?.getMessage?.(channelId, messageId);
            const attachment = storedMessage
                ? global.Vencord?.Plugins?.plugins?.SecureMessaging?.getEncryptedMediaAttachments?.(storedMessage)?.[0]
                : null;
            return {
                attachment,
                buttons: [...(item?.querySelectorAll<HTMLElement>("button, [role='button']") ?? [])].map(button => ({
                    ariaLabel: button.getAttribute("aria-label"),
                    text: button.textContent?.slice(0, 120) ?? "",
                })),
                html: item?.innerHTML.slice(0, 12_000) ?? "",
                rowExists: Boolean(item),
                text: item?.textContent?.slice(0, 2_000) ?? "",
                videos: [...(item?.querySelectorAll<HTMLVideoElement>("video") ?? [])].map(video => ({
                    currentSrc: video.currentSrc,
                    duration: video.duration,
                    height: video.videoHeight,
                    readyState: video.readyState,
                    src: video.src,
                    width: video.videoWidth,
                })),
            };
        }, { channelId: message.channelId, messageId: message.id });
        throw new Error(`Encrypted video native-render diagnostic: ${JSON.stringify(diagnostic)}`, { cause: error });
    }

    await page.evaluate(async ({ channelId, messageId }) => {
        const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const video = item?.querySelector<HTMLVideoElement>("video");
        if (!video) throw new Error("The authenticated inline video element is missing");
        video.muted = true;
        video.currentTime = 0;
        await video.play();
    }, { channelId: message.channelId, messageId: message.id });
    await page.waitForFunction(({ channelId, messageId }) => {
        const video = document.getElementById(`chat-messages-${channelId}-${messageId}`)?.querySelector<HTMLVideoElement>("video");
        return video && (video.currentTime > 0.01 || video.ended);
    }, { timeout: 10_000 }, { channelId: message.channelId, messageId: message.id });

    const downloadsDirectory = await page.evaluate(async () => {
        const result = await (globalThis as any).VencordNative.pluginHelpers.SecureMessaging.getLiveTestDownloadsDirectory();
        if (result.status !== "ready") throw new Error(`The disposable client did not expose its Downloads directory: ${result.status}`);
        return result.path as string;
    });
    const videoDownloadPath = resolve(downloadsDirectory, PROOF_WEBM_FILENAME);
    await assert.rejects(
        readFile(videoDownloadPath),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        "the unique video proof target must not exist before clicking the player",
    );

    const proof = await page.evaluate(({ channelId, messageId, plaintext }) => {
        const global = globalThis as any;
        const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const video = item?.querySelector<HTMLVideoElement>("video");
        if (!video) throw new Error("The authenticated inline video element disappeared during playback");
        video.pause();

        const storedMessage = global.Vencord?.Webpack?.Common?.MessageStore?.getMessage?.(channelId, messageId);
        const projectedAttachment = storedMessage
            ? global.Vencord?.Plugins?.plugins?.SecureMessaging?.getEncryptedMediaAttachments?.(storedMessage)?.[0]
            : null;
        video.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
        const source = video.currentSrc || video.src || video.querySelector<HTMLSourceElement>("source")?.src || "";
        return {
            duration: video.duration,
            height: video.videoHeight,
            localContentScanVersion: projectedAttachment?.content_scan_version ?? null,
            playbackTime: video.currentTime,
            plaintextVisible: item?.querySelector(".pc-secure-card-plaintext")?.textContent?.includes(plaintext) ?? false,
            projectedDuration: projectedAttachment?.duration_secs ?? null,
            projectedHeight: projectedAttachment?.height ?? null,
            projectedMimeType: projectedAttachment?.content_type ?? "",
            projectedProxyUrl: projectedAttachment?.proxy_url ?? "",
            projectedUrl: projectedAttachment?.url ?? "",
            projectedWidth: projectedAttachment?.width ?? null,
            source,
            width: video.videoWidth,
        };
    }, { channelId: message.channelId, messageId: message.id, plaintext });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const mediaClickDownloadCalls = (await readdir(downloadsDirectory))
        .filter(candidate => isDownloadFilenameVariant(candidate, PROOF_WEBM_FILENAME)).length;
    return { ...proof, mediaClickDownloadCalls };
}

async function verifyAuthenticatedDownloadButton(page: Page, message: RawDiscordMessage): Promise<{
    buttonLabel: string;
    downloadPath: string;
}> {
    const downloadsDirectory = await page.evaluate(async () => {
        const native = (globalThis as any).VencordNative.pluginHelpers.SecureMessaging;
        const downloadsDirectory = await native.getLiveTestDownloadsDirectory();
        if (downloadsDirectory.status !== "ready")
            throw new Error(`The disposable client did not expose its Downloads directory: ${downloadsDirectory.status}`);
        return downloadsDirectory.path as string;
    });
    assert.equal(isAbsolute(downloadsDirectory), true, "Electron must report an absolute Downloads directory");
    const downloadPath = resolve(downloadsDirectory, PROOF_PNG_FILENAME);
    assert.equal(dirname(downloadPath), resolve(downloadsDirectory), "the live proof filename must remain inside Downloads");
    await assert.rejects(
        readFile(downloadPath),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        "the unique PNG proof target must not exist before clicking Download",
    );

    const buttonLabel = await page.evaluate(({ channelId, messageId }) => {
        const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const button = item?.querySelector<HTMLButtonElement>(".pc-secure-download");
        if (!button) throw new Error("The authenticated encrypted-attachment download button is missing");
        const label = button.textContent ?? "";
        button.click();
        return label;
    }, { channelId: message.channelId, messageId: message.id });

    const bytes = await waitForDownloadedFile(downloadPath);
    assert.equal(bytes.toString("base64"), PROOF_PNG_BASE64, "the Downloads file must contain authenticated plaintext bytes");
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const matchingFiles = (await readdir(downloadsDirectory))
        .filter(candidate => isDownloadFilenameVariant(candidate, PROOF_PNG_FILENAME));
    assert.deepEqual(matchingFiles, [PROOF_PNG_FILENAME], "the Download button must produce exactly one saved file");
    return { buttonLabel, downloadPath };
}

async function verifyNativeAttachmentAnchorDownload(
    page: Page,
    message: RawDiscordMessage,
    expectedFilename: string,
    expectedBase64: string,
): Promise<{ downloadPath: string; intercepted: boolean; }> {
    await page.waitForFunction(({ channelId, messageId }) => {
        const row = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        return [...(row?.querySelectorAll<HTMLAnchorElement>("a[href^='blob:']") ?? [])]
            .some(candidate => !candidate.querySelector("img, video, audio"));
    }, { timeout: 30_000 }, { channelId: message.channelId, messageId: message.id });
    const downloadsDirectory = await page.evaluate(async () => {
        const native = (globalThis as any).VencordNative.pluginHelpers.SecureMessaging;
        const downloadsDirectory = await native.getLiveTestDownloadsDirectory();
        if (downloadsDirectory.status !== "ready")
            throw new Error(`The disposable client did not expose its Downloads directory: ${downloadsDirectory.status}`);
        return downloadsDirectory.path as string;
    });
    const downloadPath = resolve(downloadsDirectory, expectedFilename);
    assert.equal(dirname(downloadPath), resolve(downloadsDirectory));
    await assert.rejects(
        readFile(downloadPath),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        "the unique live-test download target must not exist before the click",
    );

    const intercepted = await page.evaluate(({ channelId, messageId }) => {
        const row = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const link = [...(row?.querySelectorAll<HTMLAnchorElement>("a[href^='blob:']") ?? [])]
            .find(candidate => !candidate.querySelector("img, video, audio"));
        if (!link) throw new Error("Discord's native encrypted generic-file download link is missing");
        return !link.dispatchEvent(new MouseEvent("click", {
            bubbles: true,
            button: 0,
            cancelable: true,
        }));
    }, { channelId: message.channelId, messageId: message.id });
    assert.equal(intercepted, true, "the native generic-file link must never navigate to an Open As dialog");

    const downloaded = await waitForDownloadedFile(downloadPath);
    assert.equal(downloaded.toString("base64"), expectedBase64);

    await new Promise(resolve => setTimeout(resolve, 1_000));
    const matchingFiles = (await readdir(downloadsDirectory))
        .filter(candidate => isDownloadFilenameVariant(candidate, expectedFilename));
    assert.deepEqual(matchingFiles, [expectedFilename], "the intercepted link must produce exactly one saved file");
    return { downloadPath, intercepted };
}

async function verifyCrossAccountRenderCacheIsolation(page: Page, message: RawDiscordMessage) {
    return page.evaluate(async ({ alternateUserId, message }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const plugin = global.Vencord.Plugins.plugins.SecureMessaging;
        const stored = common.MessageStore.getMessage(message.channelId, message.id);
        if (!stored) throw new Error("the encrypted attachment message is missing from MessageStore");
        const owner = { forceUpdate() {} };
        const localProjection = plugin.patchEncryptedAttachments(stored, owner);
        const localUrl = localProjection.attachments?.[0]?.url;
        if (typeof localUrl !== "string" || !localUrl.startsWith("blob:"))
            throw new Error("the authenticated local attachment blob is unavailable for account-isolation testing");

        const originalGetCurrentUser = common.UserStore.getCurrentUser;
        let accountSwitched = false;
        let alternateAttachmentsHidden = false;
        try {
            common.UserStore.getCurrentUser = () => ({ id: alternateUserId });
            accountSwitched = common.UserStore.getCurrentUser()?.id === alternateUserId;
            alternateAttachmentsHidden = plugin.patchEncryptedAttachments(stored, owner).attachments.length === 0;
        } finally {
            common.UserStore.getCurrentUser = originalGetCurrentUser;
            plugin.patchEncryptedAttachments(stored, owner);
        }
        let blobRevoked = false;
        try {
            await fetch(localUrl);
        } catch {
            blobRevoked = true;
        }
        return { accountSwitched, alternateAttachmentsHidden, blobRevoked };
    }, { alternateUserId: EXPECTED_RECIPIENT_ID, message });
}

async function verifyNativeRejectionPaths(page: Page, message: RawDiscordMessage, plaintext: string) {
    return page.evaluate(async ({ message, plaintext }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser().id;
        const alternativeLastDigit = message.id.endsWith("9") ? "8" : "9";
        const replacementMessageId = `${message.id.slice(0, -1)}${alternativeLastDigit}`;
        const tamperedLastCharacter = message.content.endsWith("A") ? "B" : "A";
        const tamperedContent = `${message.content.slice(0, -1)}${tamperedLastCharacter}`;

        const exactRerender = await native.decryptIncoming(localUserId, {
            channelId: message.channelId,
            content: message.content,
            discordAuthorId: message.authorId,
            discordEditedTimestamp: message.editedTimestamp,
            discordMessageId: message.id,
        });
        const copiedSenderEnvelope = await native.decryptIncoming(localUserId, {
            channelId: message.channelId,
            content: message.content,
            discordAuthorId: message.authorId,
            discordEditedTimestamp: message.editedTimestamp,
            discordMessageId: replacementMessageId,
        });
        const tampered = await native.decryptIncoming(localUserId, {
            channelId: message.channelId,
            content: tamperedContent,
            discordAuthorId: message.authorId,
            discordEditedTimestamp: message.editedTimestamp,
            discordMessageId: `${message.id.slice(0, -2)}77`,
        });

        return {
            exactPlaintext: exactRerender.status === "decrypted" ? exactRerender.plaintext : "",
            exactStatus: exactRerender.status,
            copiedSenderEnvelopeStatus: copiedSenderEnvelope.status,
            tamperedStatus: tampered.status,
            expectedPlaintext: plaintext,
        };
    }, { message, plaintext });
}

async function collectRegisteredMessageIds(page: Page): Promise<string[]> {
    return page.evaluate(registryName => {
        const registry = (globalThis as any)[registryName];
        return Array.isArray(registry) ? registry.filter((value: unknown) => typeof value === "string") : [];
    }, PAGE_MESSAGE_REGISTRY);
}

async function deleteOwnTestMessages(page: Page, messageIds: string[]): Promise<boolean> {
    if (messageIds.length === 0) return true;
    return page.evaluate(async ({ channelId, messageIds, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        let remainingTestIds = [...messageIds];
        const deletionErrors = new Map<string, string>();
        for (let attempt = 0; attempt < 3 && remainingTestIds.length > 0; attempt++) {
            for (const messageId of remainingTestIds) {
                try {
                    await common.RestAPI.del({ url: common.Constants.Endpoints.MESSAGE(channelId, messageId) });
                    deletionErrors.delete(messageId);
                } catch (error) {
                    const detail = error instanceof Error
                        ? error.message
                        : (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
                    deletionErrors.set(messageId, detail);
                }
            }
            const response = await common.RestAPI.get({
                url: common.Constants.Endpoints.MESSAGES(channelId),
                query: { limit: 100 },
            });
            const remainingIds = new Set((response.body ?? []).map((message: any) => String(message.id)));
            remainingTestIds = remainingTestIds.filter(messageId => remainingIds.has(messageId));
            if (remainingTestIds.length > 0) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
        global[registryName] = remainingTestIds;
        if (remainingTestIds.length > 0) {
            const details = remainingTestIds.map(messageId => `${messageId}: ${deletionErrors.get(messageId) ?? "still present"}`);
            throw new Error(`SecureMessaging live-message cleanup failed: ${details.join("; ")}`);
        }
        return true;
    }, { channelId: TEST_CHANNEL_ID, messageIds, registryName: PAGE_MESSAGE_REGISTRY });
}

async function disableSyntheticConversation(page: Page) {
    return page.evaluate(async ({ channelId, recipientId }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user during conversation cleanup");
        return native.configureConversation(localUserId, {
            enabled: false,
            selectedRecipientIds: [],
            snapshot: { channelId, kind: "DM", participantUserIds: [recipientId] },
        });
    }, { channelId: TEST_CHANNEL_ID, recipientId: EXPECTED_RECIPIENT_ID });
}

async function forgetSyntheticRecipient(page: Page) {
    return page.evaluate(async recipientId => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user during trust cleanup");
        return native.forgetPeer(localUserId, recipientId);
    }, EXPECTED_RECIPIENT_ID);
}

async function inspectCleanSyntheticState(page: Page, expectedConversationStatus: "disabled" | "unconfigured") {
    return page.evaluate(async ({ channelId, expectedConversationStatus, recipientId }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user during cleanup verification");
        const snapshot = { channelId, kind: "DM", participantUserIds: [recipientId] };
        const [conversation, channelProtection] = await Promise.all([
            native.getConversation(localUserId, snapshot),
            native.getChannelProtection(localUserId, channelId),
        ]);
        return {
            channelProtectionStatus: channelProtection.status,
            conversationStatus: conversation.status,
            expectedConversationStatus,
            participantStatus: conversation.participants?.[0]?.status ?? "missing",
            selectedRecipientIds: conversation.selectedRecipientIds ?? [],
        };
    }, { channelId: TEST_CHANNEL_ID, expectedConversationStatus, recipientId: EXPECTED_RECIPIENT_ID });
}

async function stopSecureMessagingPlugin(page: Page) {
    return page.evaluate(async () => {
        const vencord = (globalThis as any).Vencord;
        const plugin = vencord?.Plugins?.plugins?.SecureMessaging;
        if (!plugin) throw new Error("SecureMessaging is unavailable during plugin cleanup");
        if (!plugin.started) throw new Error("SecureMessaging stopped unexpectedly before cleanup");
        const stopResult = await Promise.resolve(vencord.Plugins.stopPlugin(plugin));
        return { pluginStopped: !plugin.started, stopResult };
    });
}

async function main(): Promise<void> {
    const expectedDataDir = requireDisposableDataDirectory();
    const pluginPrestarted = process.env[PRESTARTED_PLUGIN_ENV] === "1";
    if (!pluginPrestarted) await assertNoExistingSecureMessagingVault(expectedDataDir);
    const temporaryRecipient = await generateIdentity();
    const recipientAnnouncement = await createKeyAnnouncement(temporaryRecipient, EXPECTED_RECIPIENT_ID);
    const recipientPublicIdentity = await verifyKeyAnnouncement(recipientAnnouncement, EXPECTED_RECIPIENT_ID);
    const browser = await connectWithRetry();
    const sentMessageIds = new Set<string>();
    const cleanupErrors: Error[] = [];
    let cleanupProof: CleanupProof | undefined;
    let page: Page | undefined;
    let primaryError: unknown;
    let syntheticConversationCreated = false;
    let syntheticTrustCreated = false;
    let pluginStartedByHarness = false;
    const downloadedProofPaths = new Set<string>();
    let report: Record<string, unknown> | undefined;

    try {
        page = await getDiscordPage(await browser.pages());
        await assertConnectedClientUsesDisposableDataDir(page, expectedDataDir);
        await assertSecureMessagingInitialState(page, pluginPrestarted);
        await page.goto(`https://discord.com/channels/@me/${TEST_CHANNEL_ID}`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        await page.waitForFunction(
            () => Boolean((globalThis as any).Vencord?.Webpack?.Common?.UserStore?.getCurrentUser?.()),
            { timeout: 30_000 },
        );
        await assertMessageEventsSendPatch(page);
        await initializeMessageRegistry(page);

        const preflight = await preflightPristineState(page, recipientAnnouncement, pluginPrestarted);
        assert.equal(preflight.vaultReady, true);
        assert.equal(preflight.reviewedRecipientFingerprint, recipientPublicIdentity.fingerprint);
        const localPublicIdentity = await verifyKeyAnnouncement(preflight.localAnnouncement, preflight.localUserId);
        assert.equal(localPublicIdentity.fingerprint, preflight.localFingerprint);

        const pluginStart = pluginPrestarted
            ? { pluginStarted: true, startResult: "enabled before Discord loaded so webpack attachment patches were installed" }
            : await startSecureMessagingPlugin(page);
        pluginStartedByHarness = !pluginPrestarted && pluginStart.pluginStarted;
        assert.equal(pluginStart.pluginStarted, true, `SecureMessaging failed to start: ${String(pluginStart.startResult)}`);
        const screenCaptureProtection = await waitForScreenCaptureProtection(page);
        assert.equal(screenCaptureProtection, "ready", "screen-capture protection must be active before any decryption or protected send");

        const unconfiguredLifecycle = await verifyUnprotectedMessageLifecycle(page, "unconfigured DM", true);
        for (const messageId of unconfiguredLifecycle.messageIds) sentMessageIds.add(messageId);
        assert.equal(unconfiguredLifecycle.plaintextPreserved, true, "an unconfigured DM must send ordinary plaintext unchanged");
        assert.equal(unconfiguredLifecycle.editedPlaintextPreserved, true, "an unconfigured DM must edit ordinary plaintext unchanged");
        assert.equal(unconfiguredLifecycle.forwardSourceEvicted, true, "the normal-forward proof must evict its source message and channel");
        assert.equal(unconfiguredLifecycle.forwarded, true, "an unconfigured DM must allow ordinary Discord forwarding");

        const trust = await trustSyntheticRecipient(
            page,
            preflight.recipientReviewToken,
            preflight.reviewedRecipientFingerprint,
        );
        syntheticTrustCreated = trust.status === "trusted";
        assert.equal(
            trust.status,
            "trusted",
            `the disposable recipient must be newly trusted, never reused or auto-forgotten (received ${trust.status})`,
        );

        const configured = await configureSyntheticConversation(page);
        syntheticConversationCreated = configured.status === "enabled";
        assert.equal(configured.status, "enabled", `protected DM configuration failed: ${configured.status}`);
        assert.deepEqual(configured.selectedRecipientIds, [EXPECTED_RECIPIENT_ID]);

        const composerPlaintext = `Secure Messaging actual composer proof ${crypto.randomUUID()}`;
        const composerProof = await sendThroughActualComposer(page, composerPlaintext);
        sentMessageIds.add(composerProof.message.id);
        assert.equal(composerProof.messagePostCount, 1, "the real chat composer must create exactly one Discord message POST");
        assert.equal(composerProof.messageStoreCiphertextMatched, true, "MessageStore must retain the server's ciphertext envelope");
        assert.ok(composerProof.message.content.startsWith(ENCRYPTED_PREFIX), "the real chat composer must store ciphertext on Discord");
        assert.equal(composerProof.message.content.includes(composerPlaintext), false, "the real chat composer must never send its unique plaintext");
        const composerDecrypted = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: composerProof.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(composerDecrypted.plaintext, composerPlaintext, "the selected recipient must decrypt the actual composer message");

        const persistedProof = await assertPersistedProtectionAndMissingChannelFailClosed(page);
        assert.equal(persistedProof.persistedStatus, "protected", "native persisted protection lookup must identify the test DM");
        assert.equal(persistedProof.safelyMocked, true, "ChannelStore must be safely mockable for the missing-snapshot proof");
        assert.equal(persistedProof.missingChannelBlocked, true, "a protected persisted channel must fail closed without ChannelStore");
        assert.equal(persistedProof.channelStoreRestored, true, "ChannelStore.getChannel must be restored after the fail-closed proof");

        const failClosed = await assertFailClosedBoundaries(page);
        assert.equal(failClosed.attachmentBlocked, true, "protected attachments must fail before reaching Discord");
        assert.equal(failClosed.attachmentReservationBlocked, true, "attachment upload slots must be blocked before file bytes reach Discord");
        assert.equal(failClosed.editBlocked, true, "protected edits must fail before reaching Discord");
        assert.equal(
            failClosed.forwardingBlocked,
            true,
            `Discord forwarding must fail once before a protected send reaches Discord: ${failClosed.forwardingError}`,
        );
        assert.equal(failClosed.prefixedPayloadBlocked, true, "a fake encrypted-message prefix must not bypass the REST guard");

        const runtimePlaintext = `Secure Messaging runtime-listener proof ${crypto.randomUUID()} α`;
        const runtimePrepared = await prepareThroughRuntimeMessageEvents(page, runtimePlaintext);
        assert.equal(runtimePrepared.cancelled, false, "the secure listener should stop later listeners without cancelling valid text");
        assert.equal(runtimePrepared.plaintextWasTransformed, true, "the runtime MessageEvents listener must transform plaintext before REST");
        assert.ok(runtimePrepared.content.startsWith(ENCRYPTED_PREFIX));
        assert.equal(runtimePrepared.content.includes(runtimePlaintext), false);

        const runtimeProof = await sendAuthorizedRuntimePayload(page, runtimePrepared.content);
        sentMessageIds.add(runtimeProof.message.id);
        assert.equal(
            runtimeProof.attachmentBearingPayloadBlocked,
            true,
            "an encrypted text authorization must not authorize a different attachment-bearing payload",
        );
        assert.equal(
            runtimeProof.oneShotReplayBlocked,
            true,
            "attachment rejection must preserve authorization for one clean send, and that send must consume it",
        );
        assert.equal(runtimeProof.message.authorId, preflight.localUserId);
        assert.equal(runtimeProof.message.channelId, TEST_CHANNEL_ID);
        assert.equal(
            runtimeProof.message.content,
            runtimePrepared.content,
            "REST must pass the runtime listener's authorized ciphertext exactly instead of encrypting plaintext itself",
        );
        const runtimeDecrypted = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: runtimeProof.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(runtimeDecrypted.plaintext, runtimePlaintext, "the selected recipient must decrypt the runtime-listener send exactly");

        const reconnectPlaintext = `Secure Messaging reconnect proof ${crypto.randomUUID()} η`;
        const reconnectPrepared = await prepareThroughRuntimeMessageEvents(page, reconnectPlaintext);
        assert.equal(reconnectPrepared.cancelled, false, "the reconnect proof must prepare a protected message");
        const reconnectProof = await sendAuthorizedAfterOfflineFailure(page, reconnectPrepared.content);
        sentMessageIds.add(reconnectProof.message.id);
        assert.equal(reconnectProof.connectionFailureObserved, true, "the first encrypted POST must fail while the browser is offline");
        assert.equal(reconnectProof.nonceEnforced, true, "every retryable encrypted POST must use Discord's stable enforced nonce deduplication");
        assert.equal(reconnectProof.message.content, reconnectPrepared.content, "reconnect retry must send the exact authorized ciphertext once");
        assert.equal(reconnectProof.message.content.includes(reconnectPlaintext), false, "reconnect retry must never expose plaintext");
        const reconnectDecrypted = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: reconnectProof.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(reconnectDecrypted.plaintext, reconnectPlaintext, "the selected recipient must decrypt the post-reconnect retry");

        const replyPlaintext = `Secure Messaging encrypted-reply proof ${crypto.randomUUID()} δ`;
        const preparedReply = await prepareThroughRuntimeMessageEvents(page, replyPlaintext);
        assert.equal(preparedReply.cancelled, false, "the secure listener must accept an ordinary reply");
        assert.equal(preparedReply.plaintextWasTransformed, true, "reply text must be encrypted before REST");
        const replyMessage = await sendAuthorizedRuntimeReply(page, preparedReply.content, runtimeProof.message.id);
        sentMessageIds.add(replyMessage.id);
        const recipientReply = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: replyMessage.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(recipientReply.plaintext, replyPlaintext, "the selected recipient must decrypt the reply exactly");

        const attachmentPlaintext = `Secure Messaging encrypted-attachment proof ${crypto.randomUUID()} γ`;
        const attachmentSend = await sendEncryptedAttachmentThroughRuntime(page, attachmentPlaintext);
        sentMessageIds.add(attachmentSend.message.id);
        assert.equal(attachmentSend.plaintextWasTransformed, true, "attachment-message plaintext must be encrypted before upload");
        assert.equal(attachmentSend.eagerPlaintextUploadDeferred, true, "Discord's eager plaintext upload must be deferred until send encryption");
        assert.equal(attachmentSend.ciphertextHidFileBytes, true, "the opaque Discord upload must not contain the original PNG bytes");
        assert.equal(attachmentSend.ciphertextHidFilename, true, "the opaque Discord upload must not expose the original filename");
        assert.equal(
            attachmentSend.retryRegeneratedFromOriginal,
            true,
            "retrying a failed attachment send must generate fresh ciphertext from the original file",
        );
        assert.match(attachmentSend.encryptedFilename, /^pc-[A-Za-z0-9_-]{22}-0\.pcaf$/u);
        assert.equal(attachmentSend.message.attachments.length, 1);
        assert.equal(attachmentSend.message.attachments[0].filename, attachmentSend.encryptedFilename);
        assert.ok(
            attachmentSend.message.attachments[0].contentType === null ||
                attachmentSend.message.attachments[0].contentType === "application/octet-stream",
            "Discord must not classify the stored ciphertext as the original image type",
        );
        assert.equal(attachmentSend.message.content.includes(PROOF_PNG_FILENAME), false);
        assert.equal(attachmentSend.message.content.includes(attachmentPlaintext), false);

        const recipientAttachmentEnvelope = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: attachmentSend.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        const recipientAttachmentPlaintext = parseSecurePlaintext(recipientAttachmentEnvelope.plaintext);
        assert.equal(recipientAttachmentPlaintext.text, attachmentPlaintext);
        assert.ok(recipientAttachmentPlaintext.attachments, "the selected recipient must receive the encrypted attachment descriptor");
        const rawAttachmentResponse = await fetch(attachmentSend.message.attachments[0].url);
        assert.equal(rawAttachmentResponse.ok, true, "Discord must return the stored encrypted attachment bytes");
        const rawAttachmentBytes = new Uint8Array(await rawAttachmentResponse.arrayBuffer());
        assert.equal(rawAttachmentBytes.byteLength, attachmentSend.message.attachments[0].size);
        assert.equal(
            await attachmentBundleRoot(recipientAttachmentPlaintext.attachments.id, [rawAttachmentBytes]),
            recipientAttachmentPlaintext.attachments.root,
            "the selected recipient must authenticate the exact ordered Discord attachment set",
        );
        const recipientAttachmentMasterKey = decodeBase64Url(recipientAttachmentPlaintext.attachments.key, 32);
        const recipientAttachment = await decryptAttachmentBytes({
            bundleId: recipientAttachmentPlaintext.attachments.id,
            channelId: TEST_CHANNEL_ID,
            ciphertext: rawAttachmentBytes,
            count: recipientAttachmentPlaintext.attachments.count,
            index: 0,
            masterKey: recipientAttachmentMasterKey,
            senderUserId: preflight.localUserId,
        });
        recipientAttachmentMasterKey.fill(0);
        assert.equal(recipientAttachment.metadata.name, PROOF_PNG_FILENAME);
        assert.equal(recipientAttachment.metadata.mimeType, "image/png");
        assert.equal(recipientAttachment.metadata.width, 2);
        assert.equal(recipientAttachment.metadata.height, 3);
        assert.equal(Buffer.from(recipientAttachment.data).toString("base64"), PROOF_PNG_BASE64);

        const videoPlaintext = `Secure Messaging encrypted-video proof ${crypto.randomUUID()} υ`;
        const videoSend = await sendEncryptedAttachmentThroughRuntime(page, videoPlaintext, {
            base64: PROOF_WEBM_BASE64,
            filename: PROOF_WEBM_FILENAME,
            mimeType: "video/webm",
        });
        sentMessageIds.add(videoSend.message.id);
        assert.equal(videoSend.plaintextWasTransformed, true, "video-message plaintext must be encrypted before upload");
        assert.equal(videoSend.eagerPlaintextUploadDeferred, true, "Discord must never eagerly upload the plaintext video");
        assert.equal(videoSend.ciphertextHidFileBytes, true, "the opaque Discord upload must not contain the original WebM bytes");
        assert.equal(videoSend.ciphertextHidFilename, true, "the opaque Discord upload must not expose the original video filename");
        assert.equal(videoSend.retryRegeneratedFromOriginal, true, "retrying an encrypted video must rebuild it from the original WebM");
        assert.equal(videoSend.message.content.includes(PROOF_WEBM_FILENAME), false);
        assert.equal(videoSend.message.content.includes(videoPlaintext), false);

        const recipientVideoEnvelope = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: videoSend.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        const recipientVideoPlaintext = parseSecurePlaintext(recipientVideoEnvelope.plaintext);
        assert.equal(recipientVideoPlaintext.text, videoPlaintext);
        assert.ok(recipientVideoPlaintext.attachments, "the selected recipient must receive the encrypted video descriptor");
        const rawVideoResponse = await fetch(videoSend.message.attachments[0].url);
        assert.equal(rawVideoResponse.ok, true, "Discord must return the stored encrypted video bytes");
        const rawVideoBytes = new Uint8Array(await rawVideoResponse.arrayBuffer());
        assert.equal(
            await attachmentBundleRoot(recipientVideoPlaintext.attachments.id, [rawVideoBytes]),
            recipientVideoPlaintext.attachments.root,
            "the selected recipient must authenticate the exact encrypted video attachment",
        );
        const recipientVideoMasterKey = decodeBase64Url(recipientVideoPlaintext.attachments.key, 32);
        const recipientVideo = await decryptAttachmentBytes({
            bundleId: recipientVideoPlaintext.attachments.id,
            channelId: TEST_CHANNEL_ID,
            ciphertext: rawVideoBytes,
            count: recipientVideoPlaintext.attachments.count,
            index: 0,
            masterKey: recipientVideoMasterKey,
            senderUserId: preflight.localUserId,
        });
        recipientVideoMasterKey.fill(0);
        assert.equal(recipientVideo.metadata.name, PROOF_WEBM_FILENAME);
        assert.equal(recipientVideo.metadata.mimeType, "video/webm");
        assert.equal(recipientVideo.metadata.width, 16, "video width must be authenticated before the opaque upload begins");
        assert.equal(recipientVideo.metadata.height, 16, "video height must be authenticated before the opaque upload begins");
        assert.ok(
            recipientVideo.metadata.duration !== null && recipientVideo.metadata.duration >= 0.9 && recipientVideo.metadata.duration <= 1.1,
            `video duration must be authenticated before upload (received ${recipientVideo.metadata.duration})`,
        );
        assert.equal(Buffer.from(recipientVideo.data).toString("base64"), PROOF_WEBM_BASE64);

        const genericPlaintext = `Secure Messaging encrypted-generic-file proof ${crypto.randomUUID()} ξ`;
        const genericSend = await sendEncryptedAttachmentThroughRuntime(page, genericPlaintext, {
            base64: PROOF_GENERIC_BASE64,
            filename: PROOF_GENERIC_FILENAME,
            mimeType: "text/plain",
        });
        sentMessageIds.add(genericSend.message.id);
        assert.equal(genericSend.plaintextWasTransformed, true, "generic-file message plaintext must be encrypted before upload");
        assert.equal(genericSend.eagerPlaintextUploadDeferred, true, "Discord must never eagerly upload a plaintext generic file");
        assert.equal(genericSend.ciphertextHidFileBytes, true, "the opaque upload must not contain the generic-file plaintext bytes");
        assert.equal(genericSend.ciphertextHidFilename, true, "the opaque upload must not expose the generic filename");
        assert.equal(genericSend.retryRegeneratedFromOriginal, true, "retrying a generic file must rebuild from the original bytes");

        const editedAttachmentPlaintext = `Secure Messaging edited attachment proof ${crypto.randomUUID()} ε`;
        const attachmentEditProof = await editEncryptedMessageThroughRuntime(
            page,
            attachmentSend.message,
            attachmentPlaintext,
            editedAttachmentPlaintext,
            attachmentSend.message.attachments.map(attachment => attachment.id),
        );
        assert.equal(attachmentEditProof.editorPlaintextVisible, true, "the encrypted attachment editor must open with plaintext, never ciphertext");
        assert.equal(attachmentEditProof.plaintextWasTransformed, true, "edited attachment text must be re-encrypted before REST");
        assert.equal(attachmentEditProof.replayBlocked, true, "an authorized encrypted attachment edit must remain one-use");
        assert.equal(attachmentEditProof.message.attachments.length, 1, "editing text must retain the encrypted attachment");
        const recipientEditedAttachmentEnvelope = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: attachmentEditProof.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        const recipientEditedAttachment = parseSecurePlaintext(recipientEditedAttachmentEnvelope.plaintext);
        assert.equal(recipientEditedAttachment.text, editedAttachmentPlaintext);
        assert.deepEqual(
            recipientEditedAttachment.attachments,
            recipientAttachmentPlaintext.attachments,
            "an encrypted text edit must retain the exact authenticated attachment bundle descriptor",
        );
        attachmentSend.message = attachmentEditProof.message;

        const restPlaintext = `Secure Messaging REST-guard proof ${crypto.randomUUID()} β`;
        const restMessage = await sendThroughRestGuard(page, restPlaintext);
        sentMessageIds.add(restMessage.id);
        assert.equal(restMessage.authorId, preflight.localUserId);
        assert.equal(restMessage.channelId, TEST_CHANNEL_ID);
        assert.ok(restMessage.content.startsWith(ENCRYPTED_PREFIX), "programmatic send must store ciphertext on Discord");
        assert.equal(restMessage.content.includes(restPlaintext), false, "programmatic plaintext must not be present in Discord's stored content");
        const restDecrypted = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: restMessage.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(restDecrypted.plaintext, restPlaintext, "the selected recipient must decrypt the guarded REST send exactly");

        const editedRestPlaintext = `Secure Messaging edited-text proof ${crypto.randomUUID()} ζ`;
        const textEditProof = await editEncryptedMessageThroughRuntime(
            page,
            restMessage,
            restPlaintext,
            editedRestPlaintext,
        );
        assert.equal(textEditProof.editorPlaintextVisible, true, "the encrypted editor must show the original plaintext without ciphertext flicker");
        assert.equal(textEditProof.plaintextWasTransformed, true, "edited plaintext must be encrypted before REST");
        assert.equal(textEditProof.replayBlocked, true, "an encrypted edit authorization must be one-use");
        assert.ok(textEditProof.message.editedTimestamp, "Discord must record an authoritative edited timestamp");
        const recipientEditedText = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: textEditProof.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(recipientEditedText.plaintext, editedRestPlaintext, "the selected recipient must decrypt the edited text exactly");

        const renderProof = await verifyRenderedMessage(page, runtimeProof.message, runtimePlaintext);
        assert.equal(renderProof.plaintextVisible, true, "locally decrypted plaintext must render");
        assert.equal(renderProof.rawCiphertextHidden, true, "raw Discord ciphertext must be hidden in the message row");
        assert.equal(renderProof.verifiedHeader, true, "rendered message must identify authenticated encrypted content");

        const replyPreviewProof = await verifyRenderedReplyPreview(
            page,
            replyMessage,
            runtimeProof.message.content,
            runtimePlaintext,
        );
        assert.equal(replyPreviewProof.plaintextVisible, true, "an encrypted reply preview must show the referenced plaintext");
        assert.equal(replyPreviewProof.ciphertextHidden, true, "an encrypted reply preview must never show the referenced ciphertext envelope");

        const attachmentRenderProof = await verifyRenderedEncryptedAttachment(page, attachmentSend.message, editedAttachmentPlaintext);
        assert.equal(attachmentRenderProof.plaintextVisible, true, "encrypted attachment text must render locally");
        assert.equal(attachmentRenderProof.imageUsesLocalAuthenticatedUrl, true, "Discord's native renderer must receive a local authenticated blob URL");
        assert.equal(attachmentRenderProof.imageWidth, 2, "Discord's native image renderer must decode the original width");
        assert.equal(attachmentRenderProof.imageHeight, 3, "Discord's native image renderer must decode the original height");
        assert.equal(attachmentRenderProof.imageObscured, false, "decrypted E2EE media must not be mistaken for a pending Discord content scan");
        assert.equal(attachmentRenderProof.localContentScanVersion, -1, "decrypted E2EE media must carry Discord's local unscanned sentinel");
        assert.equal(attachmentRenderProof.rawEncryptedFilenameHidden, true, "the opaque Discord filename must not be shown to the user");
        assert.equal(attachmentRenderProof.downloadBytesMatch, true, "the projected Discord attachment must download the exact authenticated plaintext bytes");
        assert.equal(attachmentRenderProof.downloadFilename, PROOF_PNG_FILENAME, "the projected download must restore the authenticated filename");
        assert.equal(attachmentRenderProof.downloadMimeType, "image/png", "safe raster images must retain their native Discord preview type");
        assert.equal(attachmentRenderProof.signedUrlRefreshCacheStable, true, "signed Discord URL refreshes must not invalidate decrypted blobs or flicker");

        const videoRenderProof = await verifyRenderedEncryptedVideo(page, videoSend.message, videoPlaintext);
        assert.equal(videoRenderProof.plaintextVisible, true, "encrypted video text must render locally");
        assert.equal(videoRenderProof.projectedMimeType, "video/webm", "authenticated WebM media must retain Discord's native video type");
        assert.equal(videoRenderProof.projectedWidth, 16, "the projected video must retain its authenticated width");
        assert.equal(videoRenderProof.projectedHeight, 16, "the projected video must retain its authenticated height");
        assert.ok(
            videoRenderProof.projectedDuration >= 0.9 && videoRenderProof.projectedDuration <= 1.1,
            `the projected video must retain its authenticated duration (received ${videoRenderProof.projectedDuration})`,
        );
        assert.equal(videoRenderProof.width, 16, "Discord's native video player must decode the original width");
        assert.equal(videoRenderProof.height, 16, "Discord's native video player must decode the original height");
        assert.ok(videoRenderProof.duration >= 0.9 && videoRenderProof.duration <= 1.1, "Discord's native player must load WebM metadata");
        assert.ok(videoRenderProof.playbackTime > 0.01, "Discord's native player must advance encrypted WebM playback");
        assert.equal(videoRenderProof.source.startsWith("blob:"), true, "the native video player must use only the authenticated local blob");
        assert.equal(videoRenderProof.projectedUrl.startsWith("blob:"), true, "the projected video URL must be a local authenticated blob");
        assert.equal(videoRenderProof.projectedProxyUrl, videoRenderProof.projectedUrl, "video URL and proxy URL must reference the same authenticated blob");
        assert.equal(videoRenderProof.projectedUrl.endsWith("#"), true, "the projected blob URL must preserve Discord's attachment URL shape");
        assert.equal(videoRenderProof.localContentScanVersion, -1, "decrypted video must carry Discord's local unscanned sentinel");
        assert.equal(videoRenderProof.mediaClickDownloadCalls, 0, "video controls must never trigger the encrypted-file download interceptor");

        const nativeAnchorDownload = await verifyNativeAttachmentAnchorDownload(
            page,
            genericSend.message,
            PROOF_GENERIC_FILENAME,
            PROOF_GENERIC_BASE64,
        );
        downloadedProofPaths.add(nativeAnchorDownload.downloadPath);
        assert.equal(nativeAnchorDownload.intercepted, true, "Discord's native file card must save instead of opening an external Open As flow");

        const authenticatedDownload = await verifyAuthenticatedDownloadButton(page, attachmentSend.message);
        downloadedProofPaths.add(authenticatedDownload.downloadPath);
        assert.equal(
            authenticatedDownload.buttonLabel.includes(PROOF_PNG_FILENAME),
            true,
            "the authenticated download control must show the restored filename",
        );
        const cacheIsolation = await verifyCrossAccountRenderCacheIsolation(page, attachmentSend.message);
        assert.equal(cacheIsolation.accountSwitched, true, "the account-isolation proof must replace the active account identity");
        assert.equal(cacheIsolation.alternateAttachmentsHidden, true, "another signed-in account must not inherit decrypted attachment blobs");
        assert.equal(cacheIsolation.blobRevoked, true, "an account change must revoke the previous account's plaintext blob URL");

        const screenshotModeProof = await verifyScreenshotMode(
            page,
            attachmentSend.message,
            editedAttachmentPlaintext,
            videoSend.message,
        );
        assert.equal(screenshotModeProof.rootCaptureClassApplied, true, "screenshot mode must apply its capture-safe root class");
        assert.equal(screenshotModeProof.plaintextHidden, true, "screenshot mode must hide decrypted text");
        assert.equal(screenshotModeProof.attachmentPixelsHidden, true, "screenshot mode must hide decrypted attachment pixels");
        assert.equal(screenshotModeProof.encryptedPlaceholderVisible, true, "screenshot mode must leave a clear protected placeholder");
        assert.equal(screenshotModeProof.mediaModalClosed, true, "screenshot mode must close an open encrypted-media modal");
        assert.equal(screenshotModeProof.playingVideoStopped, true, "screenshot mode must stop decrypted video playback");
        assert.equal(screenshotModeProof.visibleBlobMediaCount, 0, "screenshot mode must hide blob-backed media across the renderer");
        assert.equal(await waitForScreenCaptureProtection(page), "ready", "encrypted-content visibility must restore after the screenshot-mode proof");

        const rejectionProof = await verifyNativeRejectionPaths(page, runtimeProof.message, runtimePlaintext);
        assert.equal(rejectionProof.exactStatus, "decrypted", "an exact React rerender must remain idempotent");
        assert.equal(rejectionProof.exactPlaintext, rejectionProof.expectedPlaintext);
        assert.equal(
            rejectionProof.copiedSenderEnvelopeStatus,
            "replay_detected",
            "a locally authored envelope copied under another Discord message ID must remain a replay",
        );
        assert.equal(rejectionProof.tamperedStatus, "invalid_message", "tampered ciphertext must be rejected");

        const stalePlaintext = `Secure Messaging stale-state proof ${crypto.randomUUID()} ι`;
        const stalePrepared = await prepareThroughRuntimeMessageEvents(page, stalePlaintext);
        assert.equal(stalePrepared.cancelled, false, "the stale-state proof must prepare while protection is enabled");
        const disabledTransition = await disableSyntheticConversationForTransition(page);
        assert.equal(disabledTransition.status, "disabled", "the protected DM must disable for the ordinary-message transition proof");
        assert.deepEqual(disabledTransition.selectedRecipientIds, []);
        const staleSendBlocked = await page.evaluate(async ({ channelId, content, registryName }) => {
            const global = globalThis as any;
            const common = global.Vencord.Webpack.Common;
            let error = "";
            try {
                const response = await common.RestAPI.post({
                    url: common.Constants.Endpoints.MESSAGES(channelId),
                    body: {
                        attachments: [],
                        channel_id: channelId,
                        content,
                        nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                        sticker_ids: [],
                        type: 0,
                    },
                });
                if (response.body?.id) (global[registryName] ??= []).push(String(response.body.id));
            } catch (reason) {
                error = String(reason);
            }
            return /blocked stale encrypted content/iu.test(error);
        }, { channelId: TEST_CHANNEL_ID, content: stalePrepared.content, registryName: PAGE_MESSAGE_REGISTRY });
        assert.equal(staleSendBlocked, true, "a state change between encryption and REST must block the stale ciphertext");
        const disabledLifecycle = await verifyUnprotectedMessageLifecycle(page, "disabled DM");
        for (const messageId of disabledLifecycle.messageIds) sentMessageIds.add(messageId);
        assert.equal(disabledLifecycle.plaintextPreserved, true, "a disabled DM must send ordinary plaintext unchanged");
        assert.equal(disabledLifecycle.editedPlaintextPreserved, true, "a disabled DM must edit ordinary plaintext unchanged");
        assert.equal(disabledLifecycle.forwarded, true, "a disabled DM must allow ordinary Discord forwarding");
        const disabledEncryptedActions = await verifyOldEncryptedActionsBlockedWhileDisabled(page, runtimeProof.message);
        assert.equal(disabledEncryptedActions.editBlocked, true, "an old encrypted message must remain non-editable while protection is disabled");
        assert.equal(disabledEncryptedActions.forwardBlocked, true, "an old encrypted message must remain non-forwardable while protection is disabled");
        const reenabledTransition = await configureSyntheticConversation(page);
        assert.equal(reenabledTransition.status, "enabled", "the protected DM must re-enable after the ordinary-message transition proof");
        assert.deepEqual(reenabledTransition.selectedRecipientIds, [EXPECTED_RECIPIENT_ID]);

        const lifecycleStop = await stopSecureMessagingPlugin(page);
        assert.equal(lifecycleStop.pluginStopped, true, "stopping Secure Messaging must deactivate every runtime guard");
        const stoppedLifecycle = await verifyUnprotectedMessageLifecycle(page, "plugin stopped");
        for (const messageId of stoppedLifecycle.messageIds) sentMessageIds.add(messageId);
        assert.equal(stoppedLifecycle.plaintextPreserved, true, "ordinary sends must work after the plugin stops");
        assert.equal(stoppedLifecycle.editedPlaintextPreserved, true, "ordinary edits must work after the plugin stops");
        assert.equal(stoppedLifecycle.forwarded, true, "ordinary forwards must work after the plugin stops");
        const lifecycleRestart = await startSecureMessagingPlugin(page);
        assert.equal(lifecycleRestart.pluginStarted, true, "Secure Messaging must restart cleanly after its guards are removed");
        assert.equal(await waitForScreenCaptureProtection(page), "ready", "screen protection must recover after plugin restart");
        const restartPlaintext = `Secure Messaging restart proof ${crypto.randomUUID()} θ`;
        const restartPrepared = await prepareThroughRuntimeMessageEvents(page, restartPlaintext);
        assert.equal(restartPrepared.cancelled, false, "the restarted pre-send listener must accept a protected message");
        const restartProof = await sendAuthorizedRuntimePayload(page, restartPrepared.content);
        sentMessageIds.add(restartProof.message.id);
        const restartDecrypted = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: restartProof.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(restartDecrypted.plaintext, restartPlaintext, "the restarted listener must encrypt exactly once");

        report = {
            attachmentBlocked: failClosed.attachmentBlocked,
            attachmentReservationBlocked: failClosed.attachmentReservationBlocked,
            actualComposer: {
                decryptedBySelectedRecipient: composerDecrypted.plaintext === composerPlaintext,
                messagePostCount: composerProof.messagePostCount,
                messageStoreCiphertextMatched: composerProof.messageStoreCiphertextMatched,
                plaintextAbsentFromWire: !composerProof.message.content.includes(composerPlaintext),
            },
            encryptedAttachment: {
                ciphertextHidFileBytes: attachmentSend.ciphertextHidFileBytes,
                ciphertextHidFilename: attachmentSend.ciphertextHidFilename,
                decryptedBySelectedRecipient: recipientAttachment.metadata.name === PROOF_PNG_FILENAME,
                eagerPlaintextUploadDeferred: attachmentSend.eagerPlaintextUploadDeferred,
                nativeImageHeight: attachmentRenderProof.imageHeight,
                nativeImageObscured: attachmentRenderProof.imageObscured,
                nativeImageRendererUsed: attachmentRenderProof.imageUsesLocalAuthenticatedUrl,
                nativeImageWidth: attachmentRenderProof.imageWidth,
                localContentScanVersion: attachmentRenderProof.localContentScanVersion,
                downloadBytesMatch: attachmentRenderProof.downloadBytesMatch,
                downloadedToDownloadsDirectory: true,
                downloadFilename: attachmentRenderProof.downloadFilename,
                originalFilenameRestored: recipientAttachment.metadata.name,
                rawEncryptedFilenameHidden: attachmentRenderProof.rawEncryptedFilenameHidden,
                retryRegeneratedFromOriginal: attachmentSend.retryRegeneratedFromOriginal,
                signedUrlRefreshCacheStable: attachmentRenderProof.signedUrlRefreshCacheStable,
                video: {
                    authenticatedDuration: recipientVideo.metadata.duration,
                    authenticatedHeight: recipientVideo.metadata.height,
                    authenticatedWidth: recipientVideo.metadata.width,
                    mediaControlsUnintercepted: videoRenderProof.mediaClickDownloadCalls === 0,
                    nativePlaybackAdvanced: videoRenderProof.playbackTime > 0.01,
                    nativeVideoRendererUsed: videoRenderProof.source.startsWith("blob:"),
                },
                wireContentLength: attachmentSend.wireContentLength,
            },
            authorizedAttachmentBlockedBeforeCapabilityConsumption: runtimeProof.attachmentBearingPayloadBlocked,
            encryptedEdits: {
                attachmentDescriptorRetained: JSON.stringify(recipientEditedAttachment.attachments) === JSON.stringify(recipientAttachmentPlaintext.attachments),
                attachmentEditorPlaintext: attachmentEditProof.editorPlaintextVisible,
                attachmentRetained: attachmentEditProof.message.attachments.length === 1,
                textDecryptedBySelectedRecipient: recipientEditedText.plaintext === editedRestPlaintext,
                textEditorPlaintext: textEditProof.editorPlaintextVisible,
                oneShotAuthorization: textEditProof.replayBlocked && attachmentEditProof.replayBlocked,
            },
            unauthorizedEditBlocked: failClosed.editBlocked,
            unsupportedForwardBlocked: failClosed.forwardingBlocked,
            localIdentityFingerprintMatched: true,
            missingChannelStoreFailedClosed: persistedProof.missingChannelBlocked,
            nativeTamperRejected: rejectionProof.tamperedStatus === "invalid_message",
            oneShotAuthorizationConsumed: runtimeProof.oneShotReplayBlocked,
            connectionFailureRecovery: {
                decryptedBySelectedRecipient: reconnectDecrypted.plaintext === reconnectPlaintext,
                firstAttemptFailedOffline: reconnectProof.connectionFailureObserved,
                nonceDeduplicationEnforced: reconnectProof.nonceEnforced,
                plaintextAbsentFromWire: !reconnectProof.message.content.includes(reconnectPlaintext),
            },
            crossAccountCacheIsolation: cacheIsolation,
            persistedNativeProtectionLookup: persistedProof.persistedStatus,
            pluginStarted: pluginStart.pluginStarted,
            prefixedPayloadBypassBlocked: failClosed.prefixedPayloadBlocked,
            rawCiphertextHidden: renderProof.rawCiphertextHidden,
            rendererPlaintextVerified: renderProof.plaintextVisible && renderProof.verifiedHeader,
            replyPreview: replyPreviewProof,
            copiedSenderReplayBlocked: rejectionProof.copiedSenderEnvelopeStatus === "replay_detected",
            screenCaptureProtection,
            screenshotMode: screenshotModeProof,
            stopRestartLifecycle: {
                ordinaryLifecycleWhileStopped: stoppedLifecycle,
                restartedEncryptedMessageDecrypted: restartDecrypted.plaintext === restartPlaintext,
                restartedOneShotAuthorization: restartProof.oneShotReplayBlocked,
            },
            unprotectedTransitions: {
                disabled: disabledLifecycle,
                oldEncryptedActionsBlocked: disabledEncryptedActions,
                reenabled: reenabledTransition.status === "enabled",
                stalePreparedSendBlocked: staleSendBlocked,
                unconfigured: unconfiguredLifecycle,
            },
            restGuard: {
                decryptedBySelectedRecipient: restDecrypted.plaintext === restPlaintext,
                messageId: restMessage.id,
                plaintextAbsentFromWire: !restMessage.content.includes(restPlaintext),
                wirePrefix: restMessage.content.slice(0, ENCRYPTED_PREFIX.length),
            },
            runtimeMessageEvents: {
                decryptedBySelectedRecipient: runtimeDecrypted.plaintext === runtimePlaintext,
                exactListenerCiphertextReachedDiscord: runtimeProof.message.content === runtimePrepared.content,
                messageId: runtimeProof.message.id,
                plaintextTransformedBeforeRest: runtimePrepared.plaintextWasTransformed,
                wirePrefix: runtimeProof.message.content.slice(0, ENCRYPTED_PREFIX.length),
            },
            temporaryRecipientFingerprintMatched: true,
            vaultReady: preflight.vaultReady,
        };
    } catch (error) {
        primaryError = error;
    }

    const captureCleanup = async (name: string, action: () => Promise<void>): Promise<void> => {
        try {
            await action();
        } catch (error) {
            cleanupErrors.push(asError(error, name));
        }
    };

    for (const proofPath of downloadedProofPaths) {
        await captureCleanup("deleting the authenticated Downloads proof", async () => {
            await rm(proofPath, { force: true });
        });
    }

    let allKnownMessageIds = [...sentMessageIds];
    if (page) {
        await captureCleanup("collecting the live-message cleanup registry", async () => {
            allKnownMessageIds = [...new Set([...allKnownMessageIds, ...await collectRegisteredMessageIds(page!)])];
        });
        await captureCleanup("deleting and verifying all live-proof messages", async () => {
            const deleted = await deleteOwnTestMessages(page!, allKnownMessageIds);
            assert.equal(deleted, true, "all live-proof messages must be absent after deletion");
        });

        if (syntheticConversationCreated) {
            await captureCleanup("disabling the synthetic conversation configuration", async () => {
                const disabled = await disableSyntheticConversation(page!);
                assert.equal(disabled.status, "disabled", `conversation cleanup returned ${disabled.status}`);
                assert.deepEqual(disabled.selectedRecipientIds, [], "cleanup must remove every synthetic recipient selection");
            });
        }
        if (syntheticTrustCreated) {
            await captureCleanup("forgetting the newly-created synthetic peer trust", async () => {
                const forgotten = await forgetSyntheticRecipient(page!);
                assert.equal(
                    forgotten.status,
                    "forgotten",
                    `synthetic trust cleanup must forget exactly this run's new key (received ${forgotten.status})`,
                );
            });
        }
        if (syntheticConversationCreated || syntheticTrustCreated) {
            await captureCleanup("verifying synthetic trust and configuration removal", async () => {
                const expectedStatus = syntheticConversationCreated ? "disabled" : "unconfigured";
                const clean = await inspectCleanSyntheticState(page!, expectedStatus);
                assert.equal(clean.conversationStatus, expectedStatus, "no enabled or review-required synthetic configuration may remain");
                assert.equal(clean.channelProtectionStatus, expectedStatus, "persisted channel protection must be inactive after cleanup");
                assert.deepEqual(clean.selectedRecipientIds, [], "no synthetic selected recipient may remain");
                assert.equal(clean.participantStatus, "untrusted", "no synthetic peer trust may remain");
                cleanupProof = {
                    channelProtectionStatus: clean.channelProtectionStatus,
                    conversationStatus: clean.conversationStatus,
                    participantStatus: clean.participantStatus,
                    selectedRecipientIds: clean.selectedRecipientIds,
                    testMessagesDeleted: true,
                };
            });
        }
        if (pluginStartedByHarness) {
            await captureCleanup("stopping the SecureMessaging plugin started by the harness", async () => {
                const stopped = await stopSecureMessagingPlugin(page!);
                assert.equal(stopped.pluginStopped, true, `SecureMessaging failed to stop: ${String(stopped.stopResult)}`);
            });
        }
    } else if (allKnownMessageIds.length > 0 || syntheticConversationCreated || syntheticTrustCreated || pluginStartedByHarness) {
        cleanupErrors.push(new Error("the Discord page became unavailable before required live-state cleanup"));
    }

    await captureCleanup("disconnecting the DevTools client", async () => {
        await browser.disconnect();
    });

    const errors = [primaryError == null ? undefined : asError(primaryError), ...cleanupErrors]
        .filter((error): error is Error => error != null);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
        throw new AggregateError(errors, "SecureMessaging live proof failed and one or more cleanup operations also failed");

    assert.ok(report, "the live proof completed without producing a report");
    assert.ok(cleanupProof, "the live proof completed without a synthetic-state cleanup proof");
    console.log(JSON.stringify({
        ...report,
        cleanup: cleanupProof,
        disposableDataDirectory: expectedDataDir,
        disposableDirectoryMustBeDeletedAfterDiscordStops: true,
    }, null, 2));
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
