/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { createHash, randomUUID } from "crypto";
import { app, BrowserWindow, type IpcMainInvokeEvent, safeStorage } from "electron";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { createServer, type Server } from "net";
import { dirname, extname, join, resolve } from "path";
import { setTimeout as delay } from "timers/promises";

import {
    type AttachmentBundleDescriptor,
    attachmentBundleRoot,
    type AttachmentMetadata,
    decryptAttachmentBytes,
    DETACHED_TEXT_FILENAME,
    DETACHED_TEXT_MIME_TYPE,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_CIPHERTEXT_BYTES,
    MAX_ATTACHMENT_COUNT,
    MAX_DETACHED_TEXT_BYTES,
    MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES,
    parseSecurePlaintext,
    type SecureStickerItem,
} from "./attachments";
import {
    createKeyAnnouncement,
    decryptMessage as decryptProtocolMessage,
    encryptMessage as encryptProtocolMessage,
    fingerprintPublicKeys,
    formatFingerprint,
    generateIdentity,
    keyAnnouncementFromContent,
    publicIdentity,
    validateIdentityKeyPairs,
    verifyKeyAnnouncement,
} from "./crypto";
import {
    decodeBase64Url,
    type EncryptedEnvelope,
    extractMentionedUserIds,
    isEnvelopeId,
    isProtocolTimestamp,
    isSnowflake,
    MAX_DISCORD_MESSAGE_LENGTH,
    MAX_SELECTED_RECIPIENTS,
    parseEncryptedEnvelope,
    type PrivateIdentity,
    type PublicIdentity,
} from "./protocol";

export type VaultUnavailableReason = "encryption_unavailable" | "unsafe_linux_backend" | "vault_unreadable";
export type NativeFailure =
    | { status: "invalid_input"; error: string; }
    | { status: "unavailable"; reason: VaultUnavailableReason; }
    | {
        status: "failed";
        error: "attachment_download_failed" | "attachment_too_large" | "capacity_exceeded" | "counter_exhausted" |
        "cryptographic_operation_failed" | "message_too_long" | "screen_capture_protection_failed" | "storage_error";
    };

export interface IdentitySummary {
    createdAt: number;
    fingerprint: string;
    formattedFingerprint: string;
    userId: string;
}

export type IdentityResult = { status: "ready"; identity: IdentitySummary; } | NativeFailure;
export type RotateIdentityResult =
    | { status: "rotated"; identity: IdentitySummary; disabledConversationCount: number; }
    | { status: "fingerprint_mismatch"; identity: IdentitySummary; }
    | NativeFailure;
export type AnnouncementResult = { status: "created"; content: string; identity: IdentitySummary; } | NativeFailure;
export type AnnouncementReviewResult =
    | { status: "trust_required"; identity: IdentitySummary; reviewToken: string; }
    | { status: "trusted"; identity: IdentitySummary; }
    | { status: "key_changed"; identity: IdentitySummary; trustedIdentity: IdentitySummary; }
    | { status: "stale_announcement"; identity: IdentitySummary; trustedIdentity: IdentitySummary; }
    | { status: "invalid_announcement"; }
    | NativeFailure;
export type TrustResult =
    | { status: "trusted" | "already_trusted"; identity: IdentitySummary; }
    | { status: "fingerprint_mismatch" | "review_expired"; }
    | { status: "key_changed"; identity: IdentitySummary; trustedIdentity: IdentitySummary; }
    | { status: "stale_announcement"; identity: IdentitySummary; trustedIdentity: IdentitySummary; }
    | NativeFailure;
export type ForgetPeerResult =
    | { status: "forgotten"; disabledConversationCount: number; }
    | { status: "not_found"; }
    | NativeFailure;

export type ConversationKind = "DM" | "GROUP_DM";

export interface ConversationSnapshot {
    channelId: string;
    kind: ConversationKind;
    participantUserIds: string[];
}

export interface ConfigureConversationInput {
    enabled: boolean;
    selectedRecipientIds: string[];
    snapshot: ConversationSnapshot;
}

export interface EncryptOutgoingInput {
    mentionedUserIds?: string[];
    plaintext: string;
    snapshot: ConversationSnapshot;
}

export interface DecryptIncomingInput {
    channelId: string;
    content: string;
    discordAuthorId: string;
    discordEditedTimestamp: string | null;
    discordMessageId: string;
    discordNonce?: string | null;
}

export interface EncryptedAttachmentReference {
    id: string;
    proxyUrl: string;
    size: number;
    url: string;
}

export interface DecryptIncomingAttachmentsInput extends DecryptIncomingInput {
    attachments: EncryptedAttachmentReference[];
}

export type ParticipantSummary =
    | { status: "key_changed"; identity: IdentitySummary; }
    | { status: "trusted"; identity: IdentitySummary; }
    | { status: "untrusted"; userId: string; };

interface ConversationDetails {
    participants: ParticipantSummary[];
    selectedRecipientIds: string[];
    snapshot: ConversationSnapshot;
}

export type ConversationResult =
    | ({ status: "unconfigured" | "disabled" | "enabled"; } & ConversationDetails)
    | ({ status: "participant_changed"; previousParticipantUserIds: string[]; } & ConversationDetails)
    | ({ status: "unverified_recipients"; unverifiedRecipientIds: string[]; } & ConversationDetails)
    | NativeFailure;

export type ChannelProtectionResult =
    | { status: "unconfigured" | "disabled" | "protected"; }
    | NativeFailure;

export type ScreenCaptureProtectionResult =
    | { status: "applied"; enabled: boolean; windowCount: number; }
    | NativeFailure;

export type EncryptOutgoingResult =
    | { status: "encrypted"; content: string; counter: number; }
    | {
        status: "not_enabled";
        reason: "disabled" | "participant_changed" | "unconfigured" | "unverified_recipients";
        conversation: Exclude<ConversationResult, NativeFailure>;
    }
    | NativeFailure;

export type DecryptIncomingResult =
    | {
        status: "decrypted";
        attachmentBundle: AttachmentBundleDescriptor | null;
        detachedTextIndex: number | null;
        plaintext: string;
        stickers: SecureStickerItem[];
        counter: number;
        envelopeId: string;
    }
    | { status: "invalid_message" | "replay_detected" | "untrusted_author"; }
    | NativeFailure;

export type DecryptIncomingAttachmentsResult =
    | {
        status: "decrypted";
        attachments: Array<{ data: Uint8Array; id: string; metadata: AttachmentMetadata; }>;
        plaintext: string;
    }
    | { status: "invalid_message" | "replay_detected" | "untrusted_author"; }
    | NativeFailure;

export type DownloadIncomingAttachmentResult =
    | { status: "saved"; filename: string; }
    | { status: "invalid_message" | "replay_detected" | "untrusted_author"; }
    | NativeFailure;
export type LiveTestDownloadsDirectoryResult = { status: "ready"; path: string; } | NativeFailure;

interface TrustedPeerRecord {
    announcedAt: number;
    identity: PublicIdentity;
    keyChanged: boolean;
    keyChangedAt: number | null;
    publishedAt: number | null;
    trustedAt: number;
}

interface HistoricalPeerIdentityRecord {
    announcedAt: number;
    identity: PublicIdentity;
    retiredAt: number;
}

interface HistoricalPrivateIdentityRecord {
    identity: PrivateIdentity;
    retiredAt: number;
}

interface SelectedRecipientRecord {
    fingerprint: string;
    userId: string;
}

interface ConversationRecord {
    enabled: boolean;
    kind: ConversationKind;
    participantUserIds: string[];
    reviewRequired: "participant_changed" | "unverified_recipients" | null;
    selectedRecipients: SelectedRecipientRecord[];
    updatedAt: number;
}

interface ReplayRecord {
    channelId: string;
    contentDigest: string;
    counter: number;
    discordMessageId: string;
    discordMessageIdReplacementUsed: boolean;
    envelopeId: string;
    seenAt: number;
    senderFingerprint: string;
    senderUserId: string;
}

interface AccountRecord {
    conversations: Record<string, ConversationRecord>;
    identity: PrivateIdentity;
    identityHistory: Record<string, HistoricalPrivateIdentityRecord>;
    peerIdentityHistory: Record<string, Record<string, HistoricalPeerIdentityRecord>>;
    replayCache: ReplayRecord[];
    sendCounter: number;
    trustedPeers: Record<string, TrustedPeerRecord>;
}

interface VaultFile {
    accounts: Record<string, AccountRecord>;
    version: 1;
}

interface QuarantineJournal {
    entries: Array<{ detectedAt: number; pair: string; }>;
    version: 2;
}

interface PendingReview {
    announcedAt: number;
    expiresAt: number;
    identity: PublicIdentity;
    localUserId: string;
    publishedAt: number;
}

interface AccountContext {
    account: AccountRecord;
    created: boolean;
    vault: VaultFile;
}

interface ValidationSuccess<T> {
    ok: true;
    value: T;
}

interface ValidationFailure {
    error: string;
    ok: false;
}

type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

const VAULT_DIR = join(DATA_DIR, "secure-messaging");
const VAULT_PATH = join(VAULT_DIR, "vault.bin");
const QUARANTINE_PATH = join(VAULT_DIR, "quarantine.bin");
const VAULT_VERSION = 1 as const;
const QUARANTINE_VERSION = 2 as const;
const MAX_VAULT_BYTES = 16 * 1024 * 1024;
const MAX_QUARANTINE_BYTES = 8 * 1024 * 1024;
const MAX_ACCOUNTS = 16;
const MAX_TRUSTED_PEERS = 2_000;
const MAX_LOCAL_IDENTITY_HISTORY = 4;
const MAX_PEER_IDENTITY_HISTORY = 4;
const MAX_PEER_HISTORY_USERS = MAX_TRUSTED_PEERS;
const MAX_CONVERSATIONS = 2_000;
const MAX_REPLAY_RECORDS = 4_096;
const OPTIMISTIC_ID_ENVELOPE_WINDOW_MS = 30_000;
const CANONICAL_ID_ENVELOPE_LEAD_MS = 5 * 60_000;
const MAX_AUTHENTICATED_ATTACHMENT_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_AUTHENTICATED_ATTACHMENT_CACHE_ENTRIES = 128;
const AUTHENTICATED_ATTACHMENT_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING_REVIEWS = 100;
const MAX_QUARANTINED_PEERS = MAX_ACCOUNTS * MAX_TRUSTED_PEERS;
const REVIEW_LIFETIME_MS = 10 * 60 * 1_000;
const LOCK_WAIT_MS = 5_000;
const VAULT_PATH_HASH = createHash("sha256").update(resolve(VAULT_DIR).toLowerCase()).digest();
const VAULT_MUTEX_PIPE = `\\\\.\\pipe\\ProtonnCord-SecureMessaging-${VAULT_PATH_HASH.toString("hex")}`;
const VAULT_MUTEX_PORT = 49_152 + VAULT_PATH_HASH.readUInt16BE(0) % 16_384;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_48 = /^[A-Za-z0-9_-]{64}$/u;
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu;
const ALLOWED_RENDERER_ORIGINS = new Set([
    "https://canary.discord.com",
    "https://discord.com",
    "https://ptb.discord.com",
]);

interface AuthenticatedAttachmentCacheEntry {
    data: Uint8Array;
    downloadable: boolean;
    expiresAt: number;
    lastAccess: number;
    metadata: AttachmentMetadata;
}

const authenticatedAttachmentCache = new Map<string, AuthenticatedAttachmentCacheEntry>();
let authenticatedAttachmentCacheBytes = 0;
let authenticatedAttachmentCacheCleanupTimer: NodeJS.Timeout | null = null;
let staleTemporaryFilesCleaned = false;
const ALLOWED_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_ATTACHMENT_REDIRECTS = 3;

const pendingReviews = new Map<string, PendingReview>();
const volatileQuarantines = new Map<string, number>();
let persistedQuarantines = new Map<string, number>();
let cachedQuarantineSignature: string | null = null;
let cachedVault: VaultFile | null = null;
let cachedVaultSignature: string | null = null;
let operationQueue: Promise<void> = Promise.resolve();

class VaultOperationError extends Error {
    constructor(readonly code: "capacity_exceeded" | "cryptographic_operation_failed" | "storage_error" | VaultUnavailableReason) {
        super(code);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isTimestamp(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1_700_000_000_000 && (value as number) <= 9_999_999_999_999;
}

function isOrderedSnowflakeList(value: unknown, allowEmpty: boolean): value is string[] {
    if (!Array.isArray(value) || value.length > MAX_SELECTED_RECIPIENTS || (!allowEmpty && value.length === 0)) return false;
    let previous = "";
    for (const entry of value) {
        if (!isSnowflake(entry) || entry <= previous) return false;
        previous = entry;
    }
    return true;
}

function isEncodedKey(value: unknown, bytes: number): value is string {
    if (typeof value !== "string") return false;
    if (bytes === 32 ? !BASE64URL_32.test(value) : !BASE64URL_48.test(value)) return false;
    try {
        decodeBase64Url(value, bytes);
        return true;
    } catch {
        return false;
    }
}

function parsePrivateIdentity(value: unknown): PrivateIdentity | null {
    if (!isRecord(value) || !hasExactKeys(value, ["createdAt", "hpkePrivateKey", "hpkePublicKey", "signingPrivateKey", "signingPublicKey"]) ||
        !isTimestamp(value.createdAt) || !isEncodedKey(value.hpkePrivateKey, 32) || !isEncodedKey(value.hpkePublicKey, 32) ||
        !isEncodedKey(value.signingPrivateKey, 48) || !isEncodedKey(value.signingPublicKey, 32))
        return null;
    return {
        createdAt: value.createdAt,
        hpkePrivateKey: value.hpkePrivateKey,
        hpkePublicKey: value.hpkePublicKey,
        signingPrivateKey: value.signingPrivateKey,
        signingPublicKey: value.signingPublicKey,
    };
}

function parsePublicIdentity(value: unknown): PublicIdentity | null {
    if (!isRecord(value) || !hasExactKeys(value, ["fingerprint", "hpkePublicKey", "signingPublicKey", "userId"]) ||
        !isSnowflake(value.userId) || !isEncodedKey(value.fingerprint, 32) || !isEncodedKey(value.hpkePublicKey, 32) ||
        !isEncodedKey(value.signingPublicKey, 32))
        return null;
    return {
        fingerprint: value.fingerprint,
        hpkePublicKey: value.hpkePublicKey,
        signingPublicKey: value.signingPublicKey,
        userId: value.userId,
    };
}

function parseTrustedPeer(value: unknown, userId: string): TrustedPeerRecord | null {
    if (!isRecord(value) ||
        (!hasExactKeys(value, ["announcedAt", "identity", "keyChanged", "keyChangedAt", "publishedAt", "trustedAt"]) &&
            !hasExactKeys(value, ["announcedAt", "identity", "keyChanged", "keyChangedAt", "trustedAt"]) &&
            !hasExactKeys(value, ["announcedAt", "identity", "keyChanged", "trustedAt"]) &&
            !hasExactKeys(value, ["announcedAt", "identity", "trustedAt"])) ||
        !isTimestamp(value.announcedAt) ||
        (value.keyChanged !== undefined && typeof value.keyChanged !== "boolean") ||
        (value.keyChangedAt !== undefined && value.keyChangedAt !== null &&
            (!Number.isSafeInteger(value.keyChangedAt) || (value.keyChangedAt as number) < 0)) ||
        (value.publishedAt !== undefined && value.publishedAt !== null && !isTimestamp(value.publishedAt)) ||
        value.keyChangedAt != null && value.keyChanged !== true || !isTimestamp(value.trustedAt))
        return null;
    const identity = parsePublicIdentity(value.identity);
    if (!identity || identity.userId !== userId) return null;
    return {
        announcedAt: value.announcedAt,
        identity,
        keyChanged: value.keyChanged ?? false,
        keyChangedAt: typeof value.keyChangedAt === "number" ? value.keyChangedAt : null,
        publishedAt: typeof value.publishedAt === "number" ? value.publishedAt : null,
        trustedAt: value.trustedAt,
    };
}

function parseHistoricalPeerIdentity(value: unknown, userId: string, fingerprint: string): HistoricalPeerIdentityRecord | null {
    if (!isRecord(value) || !hasExactKeys(value, ["announcedAt", "identity", "retiredAt"]) ||
        !isTimestamp(value.announcedAt) || !Number.isSafeInteger(value.retiredAt) || (value.retiredAt as number) < 0)
        return null;
    const identity = parsePublicIdentity(value.identity);
    if (!identity || identity.userId !== userId || identity.fingerprint !== fingerprint) return null;
    return { announcedAt: value.announcedAt, identity, retiredAt: value.retiredAt as number };
}

function parseHistoricalPrivateIdentity(value: unknown): HistoricalPrivateIdentityRecord | null {
    if (!isRecord(value) || !hasExactKeys(value, ["identity", "retiredAt"]) ||
        !Number.isSafeInteger(value.retiredAt) || (value.retiredAt as number) < 0)
        return null;
    const identity = parsePrivateIdentity(value.identity);
    return identity ? { identity, retiredAt: value.retiredAt as number } : null;
}

function parseSelectedRecipient(value: unknown): SelectedRecipientRecord | null {
    if (!isRecord(value) || !hasExactKeys(value, ["fingerprint", "userId"]) ||
        !isSnowflake(value.userId) || !isEncodedKey(value.fingerprint, 32))
        return null;
    return { fingerprint: value.fingerprint, userId: value.userId };
}

function parseConversation(value: unknown): ConversationRecord | null {
    if (!isRecord(value) ||
        (!hasExactKeys(value, ["enabled", "kind", "participantUserIds", "reviewRequired", "selectedRecipients", "updatedAt"]) &&
            !hasExactKeys(value, ["enabled", "kind", "participantUserIds", "selectedRecipients", "updatedAt"])) ||
        typeof value.enabled !== "boolean" || (value.kind !== "DM" && value.kind !== "GROUP_DM") ||
        (value.reviewRequired !== undefined && value.reviewRequired !== null &&
            value.reviewRequired !== "participant_changed" && value.reviewRequired !== "unverified_recipients") ||
        !isOrderedSnowflakeList(value.participantUserIds, false) || !isTimestamp(value.updatedAt) || !Array.isArray(value.selectedRecipients) ||
        value.selectedRecipients.length > MAX_SELECTED_RECIPIENTS || (value.enabled && value.selectedRecipients.length === 0) ||
        (value.kind === "DM" && value.participantUserIds.length !== 1))
        return null;

    const participants = new Set(value.participantUserIds);
    const selectedRecipients: SelectedRecipientRecord[] = [];
    let previous = "";
    for (const rawRecipient of value.selectedRecipients) {
        const recipient = parseSelectedRecipient(rawRecipient);
        if (!recipient || recipient.userId <= previous || !participants.has(recipient.userId)) return null;
        previous = recipient.userId;
        selectedRecipients.push(recipient);
    }
    return {
        enabled: value.enabled,
        kind: value.kind,
        participantUserIds: value.participantUserIds,
        reviewRequired: value.reviewRequired ?? null,
        selectedRecipients,
        updatedAt: value.updatedAt,
    };
}

function parseReplayRecord(value: unknown): ReplayRecord | null {
    if (!isRecord(value) || (!hasExactKeys(value, [
        "channelId", "contentDigest", "counter", "discordMessageId", "discordMessageIdReplacementUsed", "envelopeId", "seenAt",
        "senderFingerprint", "senderUserId",
    ]) && !hasExactKeys(value, [
        "channelId", "contentDigest", "counter", "discordMessageId", "envelopeId", "seenAt", "senderFingerprint", "senderUserId",
    ])) || !isSnowflake(value.channelId) || !isEncodedKey(value.contentDigest, 32) ||
        !Number.isSafeInteger(value.counter) || (value.counter as number) < 1 || !isSnowflake(value.discordMessageId) ||
        (value.discordMessageIdReplacementUsed !== undefined && typeof value.discordMessageIdReplacementUsed !== "boolean") ||
        !isEnvelopeId(value.envelopeId) || !isTimestamp(value.seenAt) ||
        !isEncodedKey(value.senderFingerprint, 32) || !isSnowflake(value.senderUserId))
        return null;
    return {
        channelId: value.channelId,
        contentDigest: value.contentDigest,
        counter: value.counter as number,
        discordMessageId: value.discordMessageId,
        discordMessageIdReplacementUsed: value.discordMessageIdReplacementUsed ?? false,
        envelopeId: value.envelopeId,
        seenAt: value.seenAt,
        senderFingerprint: value.senderFingerprint,
        senderUserId: value.senderUserId,
    };
}

function parseAccount(value: unknown): AccountRecord | null {
    if (!isRecord(value) ||
        (!hasExactKeys(value, [
            "conversations", "identity", "identityHistory", "peerIdentityHistory", "replayCache", "sendCounter", "trustedPeers",
        ]) && !hasExactKeys(value, ["conversations", "identity", "replayCache", "sendCounter", "trustedPeers"])) ||
        !Number.isSafeInteger(value.sendCounter) || (value.sendCounter as number) < 0 || !Array.isArray(value.replayCache) ||
        value.replayCache.length > MAX_REPLAY_RECORDS || !isRecord(value.trustedPeers) || !isRecord(value.conversations))
        return null;
    const identity = parsePrivateIdentity(value.identity);
    if (!identity) return null;

    const rawIdentityHistory = value.identityHistory ?? {};
    if (!isRecord(rawIdentityHistory)) return null;
    const identityHistoryEntries = Object.entries(rawIdentityHistory);
    if (identityHistoryEntries.length > MAX_LOCAL_IDENTITY_HISTORY) return null;
    const identityHistory: Record<string, HistoricalPrivateIdentityRecord> = {};
    for (const [fingerprint, rawIdentity] of identityHistoryEntries) {
        if (!isEncodedKey(fingerprint, 32)) return null;
        const historicalIdentity = parseHistoricalPrivateIdentity(rawIdentity);
        if (!historicalIdentity) return null;
        identityHistory[fingerprint] = historicalIdentity;
    }

    const rawPeerIdentityHistory = value.peerIdentityHistory ?? {};
    if (!isRecord(rawPeerIdentityHistory)) return null;
    const peerHistoryEntries = Object.entries(rawPeerIdentityHistory);
    if (peerHistoryEntries.length > MAX_PEER_HISTORY_USERS) return null;
    const peerIdentityHistory: Record<string, Record<string, HistoricalPeerIdentityRecord>> = {};
    for (const [userId, rawHistory] of peerHistoryEntries) {
        if (!isSnowflake(userId) || !isRecord(rawHistory)) return null;
        const historyEntries = Object.entries(rawHistory);
        if (historyEntries.length === 0 || historyEntries.length > MAX_PEER_IDENTITY_HISTORY) return null;
        const history: Record<string, HistoricalPeerIdentityRecord> = {};
        for (const [fingerprint, rawIdentity] of historyEntries) {
            if (!isEncodedKey(fingerprint, 32)) return null;
            const historicalIdentity = parseHistoricalPeerIdentity(rawIdentity, userId, fingerprint);
            if (!historicalIdentity) return null;
            history[fingerprint] = historicalIdentity;
        }
        peerIdentityHistory[userId] = history;
    }

    const trustedPeerEntries = Object.entries(value.trustedPeers);
    if (trustedPeerEntries.length > MAX_TRUSTED_PEERS) return null;
    const trustedPeers: Record<string, TrustedPeerRecord> = {};
    for (const [userId, rawPeer] of trustedPeerEntries) {
        if (!isSnowflake(userId)) return null;
        const peer = parseTrustedPeer(rawPeer, userId);
        if (!peer) return null;
        trustedPeers[userId] = peer;
    }

    const conversationEntries = Object.entries(value.conversations);
    if (conversationEntries.length > MAX_CONVERSATIONS) return null;
    const conversations: Record<string, ConversationRecord> = {};
    for (const [channelId, rawConversation] of conversationEntries) {
        if (!isSnowflake(channelId)) return null;
        const conversation = parseConversation(rawConversation);
        if (!conversation) return null;
        conversations[channelId] = conversation;
    }

    const replayCache: ReplayRecord[] = [];
    for (const rawReplay of value.replayCache) {
        const replay = parseReplayRecord(rawReplay);
        if (!replay) return null;
        replayCache.push(replay);
    }
    return {
        conversations,
        identity,
        identityHistory,
        peerIdentityHistory,
        replayCache,
        sendCounter: value.sendCounter as number,
        trustedPeers,
    };
}

function parseVault(value: unknown): VaultFile | null {
    if (!isRecord(value) || !hasExactKeys(value, ["accounts", "version"]) || value.version !== VAULT_VERSION || !isRecord(value.accounts))
        return null;
    const entries = Object.entries(value.accounts);
    if (entries.length > MAX_ACCOUNTS) return null;
    const accounts: Record<string, AccountRecord> = {};
    for (const [userId, rawAccount] of entries) {
        if (!isSnowflake(userId)) return null;
        const account = parseAccount(rawAccount);
        if (!account) return null;
        accounts[userId] = account;
    }
    return { accounts, version: VAULT_VERSION };
}

function unavailableFailure(reason: VaultUnavailableReason): NativeFailure {
    return { status: "unavailable", reason };
}

function mapOperationFailure(error: unknown): NativeFailure {
    if (error instanceof VaultOperationError) {
        if (error.code === "encryption_unavailable" || error.code === "unsafe_linux_backend" || error.code === "vault_unreadable")
            return unavailableFailure(error.code);
        if (error.code === "capacity_exceeded") return { status: "failed", error: "capacity_exceeded" };
        if (error.code === "cryptographic_operation_failed") return cryptoFailure();
    }
    return { status: "failed", error: "storage_error" };
}

function validateStorageAvailability(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new VaultOperationError("encryption_unavailable");
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
        throw new VaultOperationError("unsafe_linux_backend");
}

function hasErrorCode(error: unknown, code: string): boolean {
    return isRecord(error) && error.code === code;
}

function quarantinePair(localUserId: string, peerUserId: string): string {
    return `${localUserId}:${peerUserId}`;
}

function isPeerQuarantined(localUserId: string, peerUserId: string): boolean {
    const pair = quarantinePair(localUserId, peerUserId);
    return volatileQuarantines.has(pair) || persistedQuarantines.has(pair);
}

function peerQuarantineDetectedAt(localUserId: string, peerUserId: string): number | null {
    const pair = quarantinePair(localUserId, peerUserId);
    const volatile = volatileQuarantines.get(pair);
    const persisted = persistedQuarantines.get(pair);
    if (volatile === undefined) return persisted ?? null;
    if (persisted === undefined) return volatile;
    return Math.min(volatile, persisted);
}

async function syncDirectory(path: string): Promise<void> {
    const directory = await open(path, "r");
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

async function syncVaultDirectoryEntry(): Promise<void> {
    // Windows cannot flush directory handles; the renamed encrypted file is flushed with a writable handle instead.
    if (process.platform === "win32") return;
    await syncDirectory(VAULT_DIR);
}

async function ensureVaultDirectory(): Promise<void> {
    await mkdir(VAULT_DIR, { recursive: true, mode: 0o700 });
    await chmod(VAULT_DIR, 0o700).catch(() => undefined);
    if (!staleTemporaryFilesCleaned) {
        const entries = await readdir(VAULT_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && /^(?:quarantine|vault)\.[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}\.tmp$/iu.test(entry.name))
                await rm(join(VAULT_DIR, entry.name), { force: true });
        }
        staleTemporaryFilesCleaned = true;
    }
    if (process.platform !== "win32") {
        await syncDirectory(DATA_DIR);
        await syncDirectory(dirname(DATA_DIR));
    }
}

async function syncEncryptedFile(path: string): Promise<void> {
    const encryptedFile = await open(path, "r+");
    try {
        await encryptedFile.sync();
    } finally {
        await encryptedFile.close();
    }
}

async function confirmEncryptedFileDurability(path: string): Promise<void> {
    if (process.platform === "win32") await syncEncryptedFile(path);
    else await syncVaultDirectoryEntry();
}

function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function validQuarantinePair(pair: unknown): pair is string {
    if (typeof pair !== "string") return false;
    const users = pair.split(":");
    return users.length === 2 && isSnowflake(users[0]) && isSnowflake(users[1]) && users[0] !== users[1];
}

function parseQuarantineJournal(value: unknown): Map<string, number> | null {
    if (!isRecord(value)) return null;
    if (hasExactKeys(value, ["pairs", "version"]) && value.version === 1 && Array.isArray(value.pairs) &&
        value.pairs.length <= MAX_QUARANTINED_PEERS) {
        const legacy = new Map<string, number>();
        for (const pair of value.pairs) {
            if (!validQuarantinePair(pair) || legacy.has(pair)) return null;
            legacy.set(pair, 0);
        }
        return legacy;
    }
    if (!hasExactKeys(value, ["entries", "version"]) || value.version !== QUARANTINE_VERSION ||
        !Array.isArray(value.entries) || value.entries.length > MAX_QUARANTINED_PEERS)
        return null;
    const entries = new Map<string, number>();
    let previous = "";
    for (const entry of value.entries) {
        if (!isRecord(entry) || !hasExactKeys(entry, ["detectedAt", "pair"]) || !validQuarantinePair(entry.pair) ||
            compareCodeUnits(entry.pair, previous) <= 0 || !Number.isSafeInteger(entry.detectedAt) || (entry.detectedAt as number) < 0)
            return null;
        previous = entry.pair;
        entries.set(entry.pair, entry.detectedAt as number);
    }
    return entries;
}

async function getFileSignature(path: string): Promise<string> {
    try {
        const value = await stat(path, { bigint: true });
        return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return "missing";
        throw new VaultOperationError("storage_error");
    }
}

async function synchronizeQuarantineJournal(): Promise<void> {
    const signature = await getFileSignature(QUARANTINE_PATH);
    if (cachedQuarantineSignature === signature) return;
    if (signature === "missing") {
        persistedQuarantines = new Map();
        cachedQuarantineSignature = signature;
        return;
    }

    const quarantineStat = await stat(QUARANTINE_PATH);
    if (!quarantineStat.isFile() || quarantineStat.size === 0 || quarantineStat.size > MAX_QUARANTINE_BYTES)
        throw new VaultOperationError("vault_unreadable");
    await confirmEncryptedFileDurability(QUARANTINE_PATH);
    try {
        const ciphertext = await readFile(QUARANTINE_PATH);
        const plaintext = safeStorage.decryptString(ciphertext);
        if (Buffer.byteLength(plaintext, "utf8") > MAX_QUARANTINE_BYTES)
            throw new VaultOperationError("vault_unreadable");
        const parsed: unknown = JSON.parse(plaintext);
        const entries = parseQuarantineJournal(parsed);
        if (!entries) throw new VaultOperationError("vault_unreadable");
        persistedQuarantines = structuredClone(entries);
        cachedQuarantineSignature = signature;
    } catch (error) {
        if (error instanceof VaultOperationError) throw error;
        throw new VaultOperationError("vault_unreadable");
    }
}

async function saveQuarantineJournal(entries: Map<string, number>): Promise<void> {
    if (entries.size > MAX_QUARANTINED_PEERS) throw new VaultOperationError("capacity_exceeded");
    const journal: QuarantineJournal = {
        entries: [...entries]
            .sort(([left], [right]) => compareCodeUnits(left, right))
            .map(([pair, detectedAt]) => ({ detectedAt, pair })),
        version: QUARANTINE_VERSION,
    };
    let ciphertext: Buffer;
    try {
        ciphertext = safeStorage.encryptString(JSON.stringify(journal));
    } catch {
        throw new VaultOperationError("storage_error");
    }
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_QUARANTINE_BYTES)
        throw new VaultOperationError("capacity_exceeded");

    await ensureVaultDirectory();
    const temporaryPath = join(VAULT_DIR, `quarantine.${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryPath, ciphertext, { flag: "wx", flush: true, mode: 0o600 });
        await rename(temporaryPath, QUARANTINE_PATH);
        if (process.platform === "win32") await syncEncryptedFile(QUARANTINE_PATH);
        await syncVaultDirectoryEntry();
        await chmod(QUARANTINE_PATH, 0o600).catch(() => undefined);
        cachedQuarantineSignature = await getFileSignature(QUARANTINE_PATH);
    } catch (error) {
        if (error instanceof VaultOperationError) throw error;
        throw new VaultOperationError("storage_error");
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    persistedQuarantines = structuredClone(entries);
}

async function quarantinePeer(localUserId: string, peerUserId: string, publishedAt: number): Promise<number> {
    const pair = quarantinePair(localUserId, peerUserId);
    const existing = peerQuarantineDetectedAt(localUserId, peerUserId);
    const detectedAt = existing === null ? publishedAt : Math.min(existing, publishedAt);
    const persisted = persistedQuarantines.get(pair);
    if (persisted !== undefined && persisted <= detectedAt) return persisted;
    volatileQuarantines.set(pair, detectedAt);
    const next = new Map(persistedQuarantines);
    next.set(pair, detectedAt);
    await saveQuarantineJournal(next);
    volatileQuarantines.delete(pair);
    return detectedAt;
}

async function clearPeerQuarantine(localUserId: string, peerUserId: string): Promise<void> {
    const pair = quarantinePair(localUserId, peerUserId);
    if (persistedQuarantines.has(pair)) {
        const next = new Map(persistedQuarantines);
        next.delete(pair);
        await saveQuarantineJournal(next);
    }
    persistedQuarantines.delete(pair);
    volatileQuarantines.delete(pair);
}

async function persistVolatileQuarantines(): Promise<void> {
    if (volatileQuarantines.size === 0) return;
    const merged = new Map(persistedQuarantines);
    let changed = false;
    for (const [pair, detectedAt] of volatileQuarantines) {
        const existing = merged.get(pair);
        if (existing !== undefined && existing <= detectedAt) continue;
        merged.set(pair, detectedAt);
        changed = true;
    }
    if (changed) await saveQuarantineJournal(merged);
    volatileQuarantines.clear();
}

async function getVaultSignature(): Promise<string> {
    return getFileSignature(VAULT_PATH);
}

async function synchronizeCachedVault(): Promise<void> {
    const signature = await getVaultSignature();
    if (cachedVaultSignature === signature) return;
    cachedVault = null;
    cachedVaultSignature = signature;
}

function listenForVaultMutex(): Promise<Server | null> {
    const server = createServer(socket => socket.destroy());
    server.unref();
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
            if (hasErrorCode(error, "EADDRINUSE")) resolve(null);
            else reject(new VaultOperationError("storage_error"));
        };
        server.once("error", onError);
        const onListening = () => {
            server.removeListener("error", onError);
            server.on("error", () => undefined);
            resolve(server);
        };
        if (process.platform === "win32") server.listen({ exclusive: true, path: VAULT_MUTEX_PIPE }, onListening);
        else server.listen({ exclusive: true, host: "127.0.0.1", port: VAULT_MUTEX_PORT }, onListening);
    });
}

async function acquireVaultLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
        const server = await listenForVaultMutex();
        if (server) {
            return () => new Promise(resolve => {
                server.close(() => resolve());
            });
        }
        if (Date.now() >= deadline) throw new VaultOperationError("storage_error");
        await delay(50);
    }
}

async function loadVault(): Promise<VaultFile> {
    if (cachedVault) return structuredClone(cachedVault);
    await ensureVaultDirectory();
    try {
        const vaultStat = await stat(VAULT_PATH);
        if (!vaultStat.isFile() || vaultStat.size === 0 || vaultStat.size > MAX_VAULT_BYTES)
            throw new VaultOperationError("vault_unreadable");
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
            cachedVault = { accounts: {}, version: VAULT_VERSION };
            cachedVaultSignature = "missing";
            return structuredClone(cachedVault);
        }
        throw error;
    }
    await confirmEncryptedFileDurability(VAULT_PATH);

    let plaintext: string;
    try {
        const ciphertext = await readFile(VAULT_PATH);
        if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_VAULT_BYTES)
            throw new VaultOperationError("vault_unreadable");
        plaintext = safeStorage.decryptString(ciphertext);
    } catch (error) {
        if (error instanceof VaultOperationError) throw error;
        throw new VaultOperationError("vault_unreadable");
    }
    if (Buffer.byteLength(plaintext, "utf8") > MAX_VAULT_BYTES) throw new VaultOperationError("vault_unreadable");

    try {
        const parsed: unknown = JSON.parse(plaintext);
        const vault = parseVault(parsed);
        if (!vault) throw new VaultOperationError("vault_unreadable");
        for (const [accountUserId, account] of Object.entries(vault.accounts)) {
            await validateIdentityKeyPairs(account.identity);
            for (const [fingerprint, historical] of Object.entries(account.identityHistory)) {
                await validateIdentityKeyPairs(historical.identity);
                if ((await publicIdentity(historical.identity, accountUserId)).fingerprint !== fingerprint)
                    throw new VaultOperationError("vault_unreadable");
            }
            for (const peer of Object.values(account.trustedPeers)) {
                const computed = await fingerprintPublicKeys(
                    peer.identity.userId,
                    peer.identity.signingPublicKey,
                    peer.identity.hpkePublicKey,
                );
                if (computed !== peer.identity.fingerprint) throw new VaultOperationError("vault_unreadable");
            }
            for (const history of Object.values(account.peerIdentityHistory)) {
                for (const [fingerprint, historical] of Object.entries(history)) {
                    const computed = await fingerprintPublicKeys(
                        historical.identity.userId,
                        historical.identity.signingPublicKey,
                        historical.identity.hpkePublicKey,
                    );
                    if (computed !== fingerprint) throw new VaultOperationError("vault_unreadable");
                }
            }
        }
        cachedVault = structuredClone(vault);
        cachedVaultSignature = await getVaultSignature();
        return structuredClone(vault);
    } catch (error) {
        if (error instanceof VaultOperationError) throw error;
        throw new VaultOperationError("vault_unreadable");
    }
}

async function saveVault(vault: VaultFile): Promise<void> {
    let ciphertext: Buffer;
    try {
        ciphertext = safeStorage.encryptString(JSON.stringify(vault));
    } catch {
        throw new VaultOperationError("storage_error");
    }
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_VAULT_BYTES)
        throw new VaultOperationError("capacity_exceeded");

    await ensureVaultDirectory();
    const temporaryPath = join(VAULT_DIR, `vault.${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryPath, ciphertext, { flag: "wx", flush: true, mode: 0o600 });
        await rename(temporaryPath, VAULT_PATH);
        if (process.platform === "win32") await syncEncryptedFile(VAULT_PATH);
        await syncVaultDirectoryEntry();
        await chmod(VAULT_PATH, 0o600).catch(() => undefined);
        cachedVaultSignature = await getVaultSignature();
    } catch (error) {
        if (error instanceof VaultOperationError) throw error;
        throw new VaultOperationError("storage_error");
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    cachedVault = structuredClone(vault);
}

async function runSerialized<T>(operation: () => Promise<T>): Promise<T | NativeFailure> {
    const execute = async (): Promise<T | NativeFailure> => {
        let releaseLock: (() => Promise<void>) | null = null;
        try {
            validateStorageAvailability();
            releaseLock = await acquireVaultLock();
            await synchronizeCachedVault();
            await synchronizeQuarantineJournal();
            await persistVolatileQuarantines();
            return await operation();
        } catch (error) {
            return mapOperationFailure(error);
        } finally {
            await releaseLock?.();
        }
    };
    const result = operationQueue.then(execute, execute);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
}

async function loadAccount(localUserId: string): Promise<AccountContext> {
    const vault = await loadVault();
    const existing = vault.accounts[localUserId];
    if (existing) {
        for (const [peerUserId, peer] of Object.entries(existing.trustedPeers)) {
            if (peer.keyChanged && peer.keyChangedAt === null) peer.keyChangedAt = 0;
            if (isPeerQuarantined(localUserId, peerUserId)) {
                peer.keyChanged = true;
                const detectedAt = peerQuarantineDetectedAt(localUserId, peerUserId) ?? 0;
                peer.keyChangedAt = peer.keyChangedAt === null ? detectedAt : Math.min(peer.keyChangedAt, detectedAt);
            }
        }
        return { account: existing, created: false, vault };
    }
    if (Object.keys(vault.accounts).length >= MAX_ACCOUNTS) throw new VaultOperationError("capacity_exceeded");
    let identity: PrivateIdentity;
    try {
        identity = await generateIdentity();
        await validateIdentityKeyPairs(identity);
    } catch {
        throw new VaultOperationError("cryptographic_operation_failed");
    }
    const account: AccountRecord = {
        conversations: {},
        identity,
        identityHistory: {},
        peerIdentityHistory: {},
        replayCache: [],
        sendCounter: 0,
        trustedPeers: {},
    };
    vault.accounts[localUserId] = account;
    return { account, created: true, vault };
}

function validateLocalUserId(value: unknown): ValidationResult<string> {
    return isSnowflake(value)
        ? { ok: true, value }
        : { ok: false, error: "localUserId must be a Discord snowflake" };
}

function validatePeerUserId(value: unknown, localUserId: string): ValidationResult<string> {
    if (!isSnowflake(value)) return { ok: false, error: "peerUserId must be a Discord snowflake" };
    if (value === localUserId) return { ok: false, error: "peerUserId must identify another Discord user" };
    return { ok: true, value };
}

function validateSnapshot(value: unknown, localUserId: string): ValidationResult<ConversationSnapshot> {
    if (!isRecord(value) || !hasExactKeys(value, ["channelId", "kind", "participantUserIds"]) || !isSnowflake(value.channelId) ||
        (value.kind !== "DM" && value.kind !== "GROUP_DM") || !Array.isArray(value.participantUserIds))
        return { ok: false, error: "snapshot must describe a Discord DM or group DM" };
    if (value.participantUserIds.length === 0 || value.participantUserIds.length > MAX_SELECTED_RECIPIENTS ||
        (value.kind === "DM" && value.participantUserIds.length !== 1))
        return { ok: false, error: `participantUserIds must contain 1 to ${MAX_SELECTED_RECIPIENTS} users` };

    const participants = new Set<string>();
    for (const participant of value.participantUserIds) {
        if (!isSnowflake(participant)) return { ok: false, error: "participantUserIds must contain Discord snowflakes" };
        if (participant === localUserId) return { ok: false, error: "participantUserIds must not include the local user" };
        if (participants.has(participant)) return { ok: false, error: "participantUserIds must not contain duplicates" };
        participants.add(participant);
    }
    return {
        ok: true,
        value: {
            channelId: value.channelId,
            kind: value.kind,
            participantUserIds: [...participants].sort((left, right) => left.localeCompare(right)),
        },
    };
}

function validateConfigureInput(value: unknown, localUserId: string): ValidationResult<ConfigureConversationInput> {
    if (!isRecord(value) || !hasExactKeys(value, ["enabled", "selectedRecipientIds", "snapshot"]) ||
        typeof value.enabled !== "boolean" || !Array.isArray(value.selectedRecipientIds))
        return { ok: false, error: "Invalid conversation configuration" };
    const snapshot = validateSnapshot(value.snapshot, localUserId);
    if (!snapshot.ok) return snapshot;
    if (value.selectedRecipientIds.length > MAX_SELECTED_RECIPIENTS || (value.enabled && value.selectedRecipientIds.length === 0))
        return { ok: false, error: `selectedRecipientIds must contain 1 to ${MAX_SELECTED_RECIPIENTS} users when encryption is enabled` };

    const participants = new Set(snapshot.value.participantUserIds);
    const selected = new Set<string>();
    for (const recipient of value.selectedRecipientIds) {
        if (!isSnowflake(recipient) || !participants.has(recipient))
            return { ok: false, error: "Every selected recipient must be in the current participant snapshot" };
        if (selected.has(recipient)) return { ok: false, error: "selectedRecipientIds must not contain duplicates" };
        selected.add(recipient);
    }
    return {
        ok: true,
        value: {
            enabled: value.enabled,
            selectedRecipientIds: [...selected].sort((left, right) => left.localeCompare(right)),
            snapshot: snapshot.value,
        },
    };
}

function validateEncryptInput(value: unknown, localUserId: string): ValidationResult<EncryptOutgoingInput> {
    if (!isRecord(value) ||
        (!hasExactKeys(value, ["plaintext", "snapshot"]) && !hasExactKeys(value, ["mentionedUserIds", "plaintext", "snapshot"])) ||
        typeof value.plaintext !== "string" ||
        value.plaintext.length === 0 || value.plaintext.length > MAX_DISCORD_MESSAGE_LENGTH)
        return { ok: false, error: `plaintext must contain 1 to ${MAX_DISCORD_MESSAGE_LENGTH} characters` };
    let mentionedUserIds: string[] | undefined;
    if ("mentionedUserIds" in value) {
        if (!Array.isArray(value.mentionedUserIds) || value.mentionedUserIds.length > MAX_SELECTED_RECIPIENTS)
            return { ok: false, error: `mentionedUserIds must contain at most ${MAX_SELECTED_RECIPIENTS} Discord users` };
        mentionedUserIds = [];
        let previousUserId = "";
        for (const userId of value.mentionedUserIds) {
            if (!isSnowflake(userId) || userId <= previousUserId)
                return { ok: false, error: "mentionedUserIds must be unique, sorted selected Discord users" };
            mentionedUserIds.push(userId);
            previousUserId = userId;
        }
    }
    const snapshot = validateSnapshot(value.snapshot, localUserId);
    if (!snapshot.ok) return snapshot;
    return { ok: true, value: { mentionedUserIds, plaintext: value.plaintext, snapshot: snapshot.value } };
}

function isCanonicalEditedTimestamp(value: unknown): value is string {
    if (typeof value !== "string" || value.length !== 24 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
        return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function discordSnowflakeTimestamp(discordMessageId: string): number {
    return Number((BigInt(discordMessageId) >> 22n) + 1_420_070_400_000n);
}

function validateDecryptInput(value: unknown): ValidationResult<DecryptIncomingInput> {
    if (!isRecord(value) || (!hasExactKeys(value, [
        "channelId", "content", "discordAuthorId", "discordEditedTimestamp", "discordMessageId", "discordNonce",
    ]) && !hasExactKeys(value, [
        "channelId", "content", "discordAuthorId", "discordEditedTimestamp", "discordMessageId",
    ])) ||
        !isSnowflake(value.channelId) || !isSnowflake(value.discordAuthorId) || !isSnowflake(value.discordMessageId) ||
        (value.discordNonce !== undefined && value.discordNonce !== null && !isSnowflake(value.discordNonce)) ||
        (value.discordEditedTimestamp !== null && !isCanonicalEditedTimestamp(value.discordEditedTimestamp)) ||
        typeof value.content !== "string" || value.content.length === 0 || value.content.length > MAX_DISCORD_MESSAGE_LENGTH)
        return { ok: false, error: "Invalid encrypted Discord message details" };
    return {
        ok: true,
        value: {
            channelId: value.channelId,
            content: value.content,
            discordAuthorId: value.discordAuthorId,
            discordEditedTimestamp: value.discordEditedTimestamp,
            discordMessageId: value.discordMessageId,
            discordNonce: value.discordNonce ?? null,
        },
    };
}

function validateAttachmentUrl(value: string, channelId: string, attachmentId: string): URL | null {
    if (value.length < 1 || value.length > 2_048) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !ALLOWED_ATTACHMENT_HOSTS.has(url.hostname)) return null;
    const match = /^\/attachments\/(\d{17,20})\/(\d{17,20})\/[^/]{1,512}$/u.exec(url.pathname);
    return match?.[1] === channelId && match[2] === attachmentId ? url : null;
}

function validateDecryptAttachmentsInput(value: unknown): ValidationResult<DecryptIncomingAttachmentsInput> {
    if (!isRecord(value) || (!hasExactKeys(value, [
        "attachments", "channelId", "content", "discordAuthorId", "discordEditedTimestamp", "discordMessageId", "discordNonce",
    ]) && !hasExactKeys(value, [
        "attachments", "channelId", "content", "discordAuthorId", "discordEditedTimestamp", "discordMessageId",
    ])) || !Array.isArray(value.attachments))
        return { ok: false, error: "Invalid encrypted Discord attachment details" };
    const message = validateDecryptInput({
        channelId: value.channelId,
        content: value.content,
        discordAuthorId: value.discordAuthorId,
        discordEditedTimestamp: value.discordEditedTimestamp,
        discordMessageId: value.discordMessageId,
        discordNonce: value.discordNonce,
    });
    if (!message.ok) return message;
    if (value.attachments.length < 1 || value.attachments.length > MAX_ATTACHMENT_COUNT)
        return { ok: false, error: `attachments must contain 1 to ${MAX_ATTACHMENT_COUNT} Discord attachments` };
    const attachments: EncryptedAttachmentReference[] = [];
    let totalSize = 0;
    for (const attachment of value.attachments) {
        if (!isRecord(attachment) || !hasExactKeys(attachment, ["id", "proxyUrl", "size", "url"]) ||
            !isSnowflake(attachment.id) || typeof attachment.url !== "string" || typeof attachment.proxyUrl !== "string" ||
            !Number.isSafeInteger(attachment.size) || (attachment.size as number) < 21 ||
            (attachment.size as number) > MAX_ATTACHMENT_CIPHERTEXT_BYTES ||
            !validateAttachmentUrl(attachment.url, message.value.channelId, attachment.id) ||
            !validateAttachmentUrl(attachment.proxyUrl, message.value.channelId, attachment.id))
            return { ok: false, error: "Invalid encrypted Discord attachment reference" };
        totalSize += attachment.size as number;
        if (totalSize > MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES)
            return { ok: false, error: "Encrypted Discord attachments exceed the total size limit" };
        attachments.push({
            id: attachment.id,
            proxyUrl: attachment.proxyUrl,
            size: attachment.size as number,
            url: attachment.url,
        });
    }
    return { ok: true, value: { ...message.value, attachments } };
}

async function downloadAttachmentUrl(
    initialUrl: URL,
    expectedSize: number,
    channelId: string,
    attachmentId: string,
    deadline: number,
): Promise<Uint8Array> {
    let current = initialUrl;
    for (let redirect = 0; redirect <= MAX_ATTACHMENT_REDIRECTS; redirect++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Encrypted attachment download timed out");
        const response = await fetch(current, {
            redirect: "manual",
            signal: AbortSignal.timeout(remaining),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            const next = location ? validateAttachmentUrl(new URL(location, current).toString(), channelId, attachmentId) : null;
            if (!next || redirect === MAX_ATTACHMENT_REDIRECTS) throw new Error("Unsafe encrypted attachment redirect");
            current = next;
            continue;
        }
        if (!response.ok || !response.body) throw new Error("Encrypted attachment download failed");
        const declaredLength = response.headers.get("content-length");
        if (declaredLength !== null && Number(declaredLength) !== expectedSize)
            throw new Error("Encrypted attachment length changed");
        const result = new Uint8Array(expectedSize);
        const reader = response.body.getReader();
        let length = 0;
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > expectedSize) {
                await reader.cancel();
                throw new Error("Encrypted attachment exceeded its declared size");
            }
            result.set(chunk.value, length - chunk.value.byteLength);
        }
        if (length !== expectedSize) throw new Error("Encrypted attachment was truncated");
        return result;
    }
    throw new Error("Encrypted attachment redirected too many times");
}

interface DownloadedEncryptedAttachment {
    ciphertext: Uint8Array;
    hadDownloadFailure: boolean;
    nextCandidateIndex: number;
}

class EncryptedAttachmentDownloadError extends Error {
    constructor(readonly hadDownloadFailure: boolean) {
        super("Encrypted attachment download failed");
    }
}

async function downloadEncryptedAttachment(
    reference: EncryptedAttachmentReference,
    channelId: string,
    startCandidateIndex = 0,
    deadline = Date.now() + ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
): Promise<DownloadedEncryptedAttachment> {
    const urls = [...new Set([reference.url, reference.proxyUrl])];
    let hadDownloadFailure = false;
    for (let index = startCandidateIndex; index < urls.length; index++) {
        const value = urls[index];
        const url = validateAttachmentUrl(value, channelId, reference.id);
        if (!url) continue;
        try {
            return {
                ciphertext: await downloadAttachmentUrl(url, reference.size, channelId, reference.id, deadline),
                hadDownloadFailure,
                nextCandidateIndex: index + 1,
            };
        } catch {
            hadDownloadFailure = true;
            continue;
        }
    }
    throw new EncryptedAttachmentDownloadError(hadDownloadFailure);
}

function truncateUtf8(value: string, maximumBytes: number): string {
    let result = "";
    for (const character of value) {
        if (Buffer.byteLength(result) + Buffer.byteLength(character) > maximumBytes) break;
        result += character;
    }
    return result;
}

function safeDownloadFilename(value: string, duplicate: number): string {
    let filename = value.normalize("NFC")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
        .replace(/[. ]+$/gu, "");
    if (!filename || filename === "." || filename === "..") filename = "encrypted-attachment";
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(filename)) filename = `_${filename}`;

    const extension = truncateUtf8(extname(filename), 32);
    const stem = filename.slice(0, filename.length - extname(filename).length);
    const suffix = duplicate === 0 ? "" : ` (${duplicate})`;
    return `${truncateUtf8(stem, 220 - Buffer.byteLength(extension) - Buffer.byteLength(suffix))}${suffix}${extension}`;
}

async function saveAuthenticatedAttachment(filename: string, data: Uint8Array): Promise<string> {
    if (data.byteLength < 1 || data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Invalid decrypted attachment size");
    const downloadsDirectory = resolve(app.getPath("downloads"));
    await mkdir(downloadsDirectory, { recursive: true });

    for (let duplicate = 0; duplicate < 10_000; duplicate++) {
        const candidateName = safeDownloadFilename(filename, duplicate);
        const candidatePath = resolve(join(downloadsDirectory, candidateName));
        if (dirname(candidatePath) !== downloadsDirectory) throw new Error("Unsafe attachment download path");

        let file;
        try {
            file = await open(candidatePath, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw error;
        }
        try {
            await file.writeFile(data);
            await file.sync();
            await file.close();
            return candidateName;
        } catch (error) {
            await file.close().catch(() => undefined);
            await rm(candidatePath, { force: true }).catch(() => undefined);
            throw error;
        }
    }
    throw new Error("Too many attachment filename collisions");
}

function comparableFilesystemPath(value: string): string {
    const absolute = resolve(value);
    return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

export async function getLiveTestDownloadsDirectory(
    event: IpcMainInvokeEvent,
): Promise<LiveTestDownloadsDirectoryResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const acknowledged = process.env.PROTONN_CORD_SECURE_MESSAGING_LIVE_TEST === "I_UNDERSTAND_THIS_IS_DISPOSABLE";
    const declaredDataDirectory = process.env.PROTONN_CORD_SECURE_MESSAGING_LIVE_DATA_DIR;
    if (!acknowledged || !declaredDataDirectory ||
        comparableFilesystemPath(declaredDataDirectory) !== comparableFilesystemPath(DATA_DIR) ||
        !/secure-messaging-live/iu.test(declaredDataDirectory))
        return invalidInput("The live-test Downloads directory is available only to an acknowledged disposable profile");
    return { status: "ready", path: resolve(app.getPath("downloads")) };
}

function authenticatedAttachmentCacheKey(
    localUserId: string,
    input: DecryptIncomingAttachmentsInput,
    attachmentId: string,
): string {
    return createHash("sha256")
        .update(localUserId, "utf8")
        .update("\0")
        .update(input.channelId, "utf8")
        .update("\0")
        .update(input.discordMessageId, "utf8")
        .update("\0")
        .update(input.discordAuthorId, "utf8")
        .update("\0")
        .update(input.discordEditedTimestamp ?? "")
        .update("\0")
        .update(createHash("sha256").update(input.content, "utf8").digest())
        .update("\0")
        .update(input.attachments.map(attachment => `${attachment.id}:${attachment.size}`).join("\0"), "utf8")
        .update("\0")
        .update(attachmentId, "utf8")
        .digest("base64url");
}

function removeAuthenticatedAttachmentCacheEntry(key: string, entry: AuthenticatedAttachmentCacheEntry): void {
    if (authenticatedAttachmentCache.get(key) !== entry) return;
    authenticatedAttachmentCache.delete(key);
    authenticatedAttachmentCacheBytes -= entry.data.byteLength;
    entry.data.fill(0);
}

function pruneAuthenticatedAttachmentCache(now: number, incomingBytes = 0): void {
    for (const [key, entry] of authenticatedAttachmentCache) {
        if (entry.expiresAt <= now) removeAuthenticatedAttachmentCacheEntry(key, entry);
    }
    while (authenticatedAttachmentCache.size >= MAX_AUTHENTICATED_ATTACHMENT_CACHE_ENTRIES ||
        authenticatedAttachmentCacheBytes + incomingBytes > MAX_AUTHENTICATED_ATTACHMENT_CACHE_BYTES) {
        let oldest: [string, AuthenticatedAttachmentCacheEntry] | null = null;
        for (const candidate of authenticatedAttachmentCache) {
            if (!oldest || candidate[1].lastAccess < oldest[1].lastAccess) oldest = candidate;
        }
        if (!oldest) break;
        removeAuthenticatedAttachmentCacheEntry(...oldest);
    }
}

function scheduleAuthenticatedAttachmentCacheCleanup(): void {
    if (authenticatedAttachmentCacheCleanupTimer !== null) clearTimeout(authenticatedAttachmentCacheCleanupTimer);
    authenticatedAttachmentCacheCleanupTimer = null;
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const entry of authenticatedAttachmentCache.values()) nextExpiry = Math.min(nextExpiry, entry.expiresAt);
    if (!Number.isFinite(nextExpiry)) return;
    authenticatedAttachmentCacheCleanupTimer = setTimeout(() => {
        authenticatedAttachmentCacheCleanupTimer = null;
        pruneAuthenticatedAttachmentCache(Date.now());
        scheduleAuthenticatedAttachmentCacheCleanup();
    }, Math.max(0, nextExpiry - Date.now()));
    authenticatedAttachmentCacheCleanupTimer.unref();
}

function cacheAuthenticatedAttachment(
    localUserId: string,
    input: DecryptIncomingAttachmentsInput,
    attachment: { data: Uint8Array; id: string; metadata: AttachmentMetadata; },
    downloadable = true,
): void {
    if (attachment.data.byteLength > MAX_AUTHENTICATED_ATTACHMENT_CACHE_BYTES) return;
    const key = authenticatedAttachmentCacheKey(localUserId, input, attachment.id);
    const previous = authenticatedAttachmentCache.get(key);
    if (previous) removeAuthenticatedAttachmentCacheEntry(key, previous);
    const now = Date.now();
    pruneAuthenticatedAttachmentCache(now, attachment.data.byteLength);
    const entry = {
        data: Uint8Array.from(attachment.data),
        downloadable,
        expiresAt: now + AUTHENTICATED_ATTACHMENT_CACHE_TTL_MS,
        lastAccess: now,
        metadata: { ...attachment.metadata },
    };
    authenticatedAttachmentCache.set(key, entry);
    authenticatedAttachmentCacheBytes += entry.data.byteLength;
    scheduleAuthenticatedAttachmentCacheCleanup();
}

function cachedAuthenticatedAttachment(
    localUserId: string,
    input: DecryptIncomingAttachmentsInput,
    attachmentId: string,
): { data: Uint8Array; downloadable: boolean; metadata: AttachmentMetadata; } | null {
    const now = Date.now();
    pruneAuthenticatedAttachmentCache(now);
    scheduleAuthenticatedAttachmentCacheCleanup();
    const entry = authenticatedAttachmentCache.get(authenticatedAttachmentCacheKey(localUserId, input, attachmentId));
    if (!entry) return null;
    entry.lastAccess = now;
    return { data: Uint8Array.from(entry.data), downloadable: entry.downloadable, metadata: { ...entry.metadata } };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function peerSummary(peer: TrustedPeerRecord): IdentitySummary {
    return {
        createdAt: peer.announcedAt,
        fingerprint: peer.identity.fingerprint,
        formattedFingerprint: formatFingerprint(peer.identity.fingerprint),
        userId: peer.identity.userId,
    };
}

async function ownIdentitySummary(identity: PrivateIdentity, userId: string): Promise<IdentitySummary> {
    const identityPublic = await publicIdentity(identity, userId);
    return {
        createdAt: identity.createdAt,
        fingerprint: identityPublic.fingerprint,
        formattedFingerprint: formatFingerprint(identityPublic.fingerprint),
        userId,
    };
}

function participantSummaries(account: AccountRecord, snapshot: ConversationSnapshot): ParticipantSummary[] {
    return snapshot.participantUserIds.map(userId => {
        const peer = account.trustedPeers[userId];
        if (!peer) return { status: "untrusted", userId };
        return { status: peer.keyChanged ? "key_changed" : "trusted", identity: peerSummary(peer) };
    });
}

function conversationDetails(account: AccountRecord, snapshot: ConversationSnapshot, selectedRecipientIds: string[]): ConversationDetails {
    return {
        participants: participantSummaries(account, snapshot),
        selectedRecipientIds,
        snapshot,
    };
}

function evaluateConversation(account: AccountRecord, snapshot: ConversationSnapshot): {
    changed: boolean;
    result: Exclude<ConversationResult, NativeFailure>;
} {
    const conversation = account.conversations[snapshot.channelId];
    if (!conversation) {
        return {
            changed: false,
            result: { status: "unconfigured", ...conversationDetails(account, snapshot, []) },
        };
    }
    const selectedRecipientIds = conversation.selectedRecipients.map(recipient => recipient.userId);
    const details = conversationDetails(account, snapshot, selectedRecipientIds);
    if (conversation.kind !== snapshot.kind || !sameStrings(conversation.participantUserIds, snapshot.participantUserIds)) {
        const changed = conversation.enabled || conversation.reviewRequired !== "participant_changed";
        conversation.enabled = false;
        conversation.reviewRequired = "participant_changed";
        return {
            changed,
            result: {
                status: "participant_changed",
                ...details,
                previousParticipantUserIds: conversation.participantUserIds,
            },
        };
    }

    const unverifiedRecipientIds = conversation.selectedRecipients
        .filter(recipient => {
            const peer = account.trustedPeers[recipient.userId];
            return !peer || peer.keyChanged || peer.identity.fingerprint !== recipient.fingerprint;
        })
        .map(recipient => recipient.userId);
    if (unverifiedRecipientIds.length > 0) {
        const changed = conversation.enabled || conversation.reviewRequired !== "unverified_recipients";
        conversation.enabled = false;
        conversation.reviewRequired = "unverified_recipients";
        return {
            changed,
            result: { status: "unverified_recipients", ...details, unverifiedRecipientIds },
        };
    }
    if (conversation.reviewRequired === "participant_changed") {
        return {
            changed: false,
            result: {
                status: "participant_changed",
                ...details,
                previousParticipantUserIds: conversation.participantUserIds,
            },
        };
    }
    if (conversation.reviewRequired === "unverified_recipients") {
        return {
            changed: false,
            result: { status: "unverified_recipients", ...details, unverifiedRecipientIds: [] },
        };
    }
    return {
        changed: false,
        result: { status: conversation.enabled ? "enabled" : "disabled", ...details },
    };
}

function expirePendingReviews(): void {
    const now = Date.now();
    for (const [token, review] of pendingReviews) {
        if (review.expiresAt <= now) pendingReviews.delete(token);
    }
}

function makePendingReviewCapacity(): void {
    while (pendingReviews.size >= MAX_PENDING_REVIEWS) {
        const oldestToken = pendingReviews.keys().next().value;
        if (typeof oldestToken !== "string") break;
        pendingReviews.delete(oldestToken);
    }
}

function clearPendingReviews(localUserId: string, peerUserId?: string): void {
    for (const [token, review] of pendingReviews) {
        if (review.localUserId === localUserId && (peerUserId === undefined || review.identity.userId === peerUserId))
            pendingReviews.delete(token);
    }
}

function disablePeerConversations(account: AccountRecord, peerUserId: string): number {
    let disabledConversationCount = 0;
    for (const conversation of Object.values(account.conversations)) {
        if (!conversation.enabled || !conversation.selectedRecipients.some(recipient => recipient.userId === peerUserId)) continue;
        conversation.enabled = false;
        conversation.reviewRequired = "unverified_recipients";
        conversation.updatedAt = Date.now();
        disabledConversationCount++;
    }
    return disabledConversationCount;
}

function retainLocalIdentity(account: AccountRecord, fingerprint: string): void {
    // Rotation has no Discord server event to anchor the cutoff. Historical self-decryption therefore
    // assumes the OS clock is not forward-skewed; callers must supply server time to remove that assumption.
    account.identityHistory[fingerprint] = {
        identity: structuredClone(account.identity),
        retiredAt: Math.max(0, Date.now()),
    };
    while (Object.keys(account.identityHistory).length > MAX_LOCAL_IDENTITY_HISTORY) {
        const oldest = Object.entries(account.identityHistory)
            .filter(([historicalFingerprint]) => historicalFingerprint !== fingerprint)
            .sort(([leftFingerprint, left], [rightFingerprint, right]) =>
                left.retiredAt - right.retiredAt || leftFingerprint.localeCompare(rightFingerprint))[0];
        if (!oldest) break;
        delete account.identityHistory[oldest[0]];
    }
}

function retainPeerIdentity(account: AccountRecord, peerUserId: string, peer: TrustedPeerRecord): void {
    // Key-change quarantine supplies an authoritative Discord publication time. A voluntary forget has
    // no server event, so its historical cutoff carries the same OS-clock assumption as local rotation.
    const retiredAt = peer.keyChangedAt ?? Math.max(0, Date.now());
    // A migrated key-change record without an authoritative cutoff is deliberately unreadable.
    // Do not let that fail-closed marker displace a bounded, readable historical identity.
    if (retiredAt === 0) return;
    const history = account.peerIdentityHistory[peerUserId] ?? {};
    history[peer.identity.fingerprint] = {
        announcedAt: peer.announcedAt,
        identity: structuredClone(peer.identity),
        retiredAt,
    };
    while (Object.keys(history).length > MAX_PEER_IDENTITY_HISTORY) {
        const oldest = Object.entries(history)
            .filter(([historicalFingerprint]) => historicalFingerprint !== peer.identity.fingerprint)
            .sort(([leftFingerprint, left], [rightFingerprint, right]) =>
                left.retiredAt - right.retiredAt || leftFingerprint.localeCompare(rightFingerprint))[0];
        if (!oldest) break;
        delete history[oldest[0]];
    }
    account.peerIdentityHistory[peerUserId] = history;

    const historyUsers = Object.entries(account.peerIdentityHistory);
    if (historyUsers.length <= MAX_PEER_HISTORY_USERS) return;
    const evictionCandidates = historyUsers.filter(([userId]) => userId !== peerUserId).sort(([leftUserId, left], [rightUserId, right]) => {
        const leftNewest = Math.max(...Object.values(left).map(identity => identity.retiredAt));
        const rightNewest = Math.max(...Object.values(right).map(identity => identity.retiredAt));
        return leftNewest - rightNewest || leftUserId.localeCompare(rightUserId);
    });
    const oldest = evictionCandidates[0];
    if (oldest) delete account.peerIdentityHistory[oldest[0]];
}

function makePeerIdentityCurrent(account: AccountRecord, peerUserId: string, fingerprint: string): void {
    const history = account.peerIdentityHistory[peerUserId];
    if (!history) return;
    delete history[fingerprint];
    if (Object.keys(history).length === 0) delete account.peerIdentityHistory[peerUserId];
}

function invalidInput(error: string): NativeFailure {
    return { status: "invalid_input", error };
}

function validateIpcCaller(event: IpcMainInvokeEvent): NativeFailure | null {
    try {
        const url = event.senderFrame?.url;
        if (typeof url === "string" && ALLOWED_RENDERER_ORIGINS.has(new URL(url).origin)) return null;
    } catch {
        return invalidInput("Secure messaging can only be called by the Discord renderer");
    }
    return invalidInput("Secure messaging can only be called by the Discord renderer");
}

function cryptoFailure(): NativeFailure {
    return { status: "failed", error: "cryptographic_operation_failed" };
}

export async function getIdentity(event: IpcMainInvokeEvent, localUserId: string): Promise<IdentityResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    return runSerialized(async (): Promise<IdentityResult> => {
        const context = await loadAccount(user.value);
        if (context.created) await saveVault(context.vault);
        try {
            return { status: "ready", identity: await ownIdentitySummary(context.account.identity, user.value) };
        } catch {
            return cryptoFailure();
        }
    });
}

export async function rotateIdentity(
    event: IpcMainInvokeEvent,
    localUserId: string,
    expectedFingerprint: string
): Promise<RotateIdentityResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    if (!isEncodedKey(expectedFingerprint, 32)) return invalidInput("expectedFingerprint must be a secure-messaging fingerprint");
    return runSerialized(async (): Promise<RotateIdentityResult> => {
        const context = await loadAccount(user.value);
        let currentSummary: IdentitySummary;
        try {
            currentSummary = await ownIdentitySummary(context.account.identity, user.value);
        } catch {
            return cryptoFailure();
        }
        if (currentSummary.fingerprint !== expectedFingerprint) {
            if (context.created) await saveVault(context.vault);
            return { status: "fingerprint_mismatch", identity: currentSummary };
        }

        let replacement: PrivateIdentity;
        let replacementSummary: IdentitySummary;
        try {
            replacement = await generateIdentity();
            await validateIdentityKeyPairs(replacement);
            replacementSummary = await ownIdentitySummary(replacement, user.value);
        } catch {
            return cryptoFailure();
        }
        retainLocalIdentity(context.account, currentSummary.fingerprint);
        context.account.identity = replacement;
        context.account.sendCounter = 0;
        let disabledConversationCount = 0;
        for (const conversation of Object.values(context.account.conversations)) {
            if (!conversation.enabled) continue;
            conversation.enabled = false;
            conversation.reviewRequired = "unverified_recipients";
            conversation.updatedAt = Date.now();
            disabledConversationCount++;
        }
        await saveVault(context.vault);
        clearPendingReviews(user.value);
        return { status: "rotated", identity: replacementSummary, disabledConversationCount };
    });
}

export async function createAnnouncement(event: IpcMainInvokeEvent, localUserId: string): Promise<AnnouncementResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    return runSerialized(async (): Promise<AnnouncementResult> => {
        const context = await loadAccount(user.value);
        if (context.created) await saveVault(context.vault);
        try {
            const [content, identity] = await Promise.all([
                createKeyAnnouncement(context.account.identity, user.value),
                ownIdentitySummary(context.account.identity, user.value),
            ]);
            return { status: "created", content, identity };
        } catch {
            return cryptoFailure();
        }
    });
}

export async function reviewAnnouncement(
    event: IpcMainInvokeEvent,
    localUserId: string,
    discordAuthorId: string,
    content: string,
    discordMessageId: string,
    discordEditedTimestamp: string | null,
): Promise<AnnouncementReviewResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    const peerId = validatePeerUserId(discordAuthorId, user.value);
    if (!peerId.ok) return invalidInput(peerId.error);
    if (typeof content !== "string" || content.length === 0 || content.length > MAX_DISCORD_MESSAGE_LENGTH)
        return invalidInput("content must contain one bounded key announcement");
    if (!isSnowflake(discordMessageId)) return invalidInput("discordMessageId must be a Discord snowflake");
    if (discordEditedTimestamp !== null && !isCanonicalEditedTimestamp(discordEditedTimestamp))
        return invalidInput("discordEditedTimestamp must be null or a canonical Discord timestamp");
    const createdAt = discordSnowflakeTimestamp(discordMessageId);
    const publishedAt = discordEditedTimestamp === null
        ? createdAt
        : Date.parse(discordEditedTimestamp);
    if (!isProtocolTimestamp(publishedAt) || publishedAt < createdAt)
        return invalidInput("announcement publication timestamp is out of bounds");

    return runSerialized(async (): Promise<AnnouncementReviewResult> => {
        const context = await loadAccount(user.value);
        if (context.created) await saveVault(context.vault);
        let identity: PublicIdentity;
        let announcedAt: number;
        try {
            identity = await verifyKeyAnnouncement(content, peerId.value);
            announcedAt = keyAnnouncementFromContent(content).d;
        } catch {
            return { status: "invalid_announcement" };
        }
        const summary: IdentitySummary = {
            createdAt: announcedAt,
            fingerprint: identity.fingerprint,
            formattedFingerprint: formatFingerprint(identity.fingerprint),
            userId: identity.userId,
        };
        const trusted = context.account.trustedPeers[peerId.value];
        if (trusted) {
            const sameIdentity = trusted.identity.fingerprint === identity.fingerprint;
            if (sameIdentity && !trusted.keyChanged)
                return { status: "trusted", identity: summary };
            const predatesTrustedIdentity = trusted.publishedAt !== null && publishedAt <= trusted.publishedAt;
            if (!trusted.keyChanged && predatesTrustedIdentity) {
                return {
                    status: "stale_announcement",
                    identity: summary,
                    trustedIdentity: peerSummary(trusted),
                };
            }
            if (trusted.keyChanged && (sameIdentity || predatesTrustedIdentity)) {
                return {
                    status: "key_changed",
                    identity: summary,
                    trustedIdentity: peerSummary(trusted),
                };
            }
            const detectedAt = await quarantinePeer(user.value, peerId.value, publishedAt);
            if (!trusted.keyChanged || trusted.keyChangedAt === null) {
                trusted.keyChanged = true;
                trusted.keyChangedAt ??= detectedAt;
                disablePeerConversations(context.account, peerId.value);
                await saveVault(context.vault);
            }
            return { status: "key_changed", identity: summary, trustedIdentity: peerSummary(trusted) };
        }

        expirePendingReviews();
        makePendingReviewCapacity();
        const reviewToken = randomUUID();
        pendingReviews.set(reviewToken, {
            announcedAt,
            expiresAt: Date.now() + REVIEW_LIFETIME_MS,
            identity,
            localUserId: user.value,
            publishedAt,
        });
        return { status: "trust_required", identity: summary, reviewToken };
    });
}

export async function trustReviewedKey(
    event: IpcMainInvokeEvent,
    localUserId: string,
    peerUserId: string,
    reviewToken: string,
    expectedFingerprint: string
): Promise<TrustResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    const peerId = validatePeerUserId(peerUserId, user.value);
    if (!peerId.ok) return invalidInput(peerId.error);
    if (typeof reviewToken !== "string" || !UUID.test(reviewToken)) return invalidInput("reviewToken is invalid");
    if (!isEncodedKey(expectedFingerprint, 32)) return invalidInput("expectedFingerprint must be a secure-messaging fingerprint");

    return runSerialized(async (): Promise<TrustResult> => {
        expirePendingReviews();
        const review = pendingReviews.get(reviewToken);
        if (!review || review.localUserId !== user.value || review.identity.userId !== peerId.value)
            return { status: "review_expired" };
        const complete = (result: TrustResult): TrustResult => {
            pendingReviews.delete(reviewToken);
            return result;
        };
        if (review.identity.fingerprint !== expectedFingerprint) return complete({ status: "fingerprint_mismatch" });

        const context = await loadAccount(user.value);
        if (context.created) await saveVault(context.vault);
        const existing = context.account.trustedPeers[peerId.value];
        const identity: IdentitySummary = {
            createdAt: review.announcedAt,
            fingerprint: review.identity.fingerprint,
            formattedFingerprint: formatFingerprint(review.identity.fingerprint),
            userId: review.identity.userId,
        };
        if (existing) {
            const sameIdentity = existing.identity.fingerprint === review.identity.fingerprint;
            if (sameIdentity && !existing.keyChanged)
                return complete({ status: "already_trusted", identity });
            const predatesTrustedIdentity = existing.publishedAt !== null && review.publishedAt <= existing.publishedAt;
            if (!existing.keyChanged && predatesTrustedIdentity) {
                return complete({
                    status: "stale_announcement",
                    identity,
                    trustedIdentity: peerSummary(existing),
                });
            }
            if (existing.keyChanged && (sameIdentity || predatesTrustedIdentity)) {
                return complete({
                    status: "key_changed",
                    identity,
                    trustedIdentity: peerSummary(existing),
                });
            }
            const detectedAt = await quarantinePeer(user.value, peerId.value, review.publishedAt);
            if (!existing.keyChanged || existing.keyChangedAt === null) {
                existing.keyChanged = true;
                existing.keyChangedAt ??= detectedAt;
                disablePeerConversations(context.account, peerId.value);
                await saveVault(context.vault);
            }
            return complete({ status: "key_changed", identity, trustedIdentity: peerSummary(existing) });
        }
        const completingInterruptedForget = isPeerQuarantined(user.value, peerId.value);
        if (Object.keys(context.account.trustedPeers).length >= MAX_TRUSTED_PEERS)
            throw new VaultOperationError("capacity_exceeded");

        context.account.trustedPeers[peerId.value] = {
            announcedAt: review.announcedAt,
            identity: review.identity,
            keyChanged: false,
            keyChangedAt: null,
            // This is the exact announcement the user approved. Same-key re-announcements must not
            // advance it, or reverse-order history scans could hide an intervening key replacement.
            publishedAt: review.publishedAt,
            trustedAt: Date.now(),
        };
        makePeerIdentityCurrent(context.account, peerId.value, review.identity.fingerprint);
        await saveVault(context.vault);
        if (completingInterruptedForget) await clearPeerQuarantine(user.value, peerId.value);
        return complete({ status: "trusted", identity });
    });
}

export async function forgetPeer(
    event: IpcMainInvokeEvent,
    localUserId: string,
    peerUserId: string
): Promise<ForgetPeerResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    const peerId = validatePeerUserId(peerUserId, user.value);
    if (!peerId.ok) return invalidInput(peerId.error);
    return runSerialized(async (): Promise<ForgetPeerResult> => {
        const context = await loadAccount(user.value);
        const quarantined = isPeerQuarantined(user.value, peerId.value);
        const existingPeer = context.account.trustedPeers[peerId.value];
        if (!existingPeer) {
            if (context.created) await saveVault(context.vault);
            if (!quarantined) return { status: "not_found" };
            await clearPeerQuarantine(user.value, peerId.value);
            clearPendingReviews(user.value, peerId.value);
            return { status: "forgotten", disabledConversationCount: 0 };
        }
        retainPeerIdentity(context.account, peerId.value, existingPeer);
        delete context.account.trustedPeers[peerId.value];
        const disabledConversationCount = disablePeerConversations(context.account, peerId.value);
        await saveVault(context.vault);
        if (quarantined) await clearPeerQuarantine(user.value, peerId.value);
        clearPendingReviews(user.value, peerId.value);
        return { status: "forgotten", disabledConversationCount };
    });
}

export async function getConversation(
    event: IpcMainInvokeEvent,
    localUserId: string,
    snapshot: ConversationSnapshot
): Promise<ConversationResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    const checkedSnapshot = validateSnapshot(snapshot, user.value);
    if (!checkedSnapshot.ok) return invalidInput(checkedSnapshot.error);
    return runSerialized(async (): Promise<ConversationResult> => {
        const context = await loadAccount(user.value);
        const evaluated = evaluateConversation(context.account, checkedSnapshot.value);
        if (context.created || evaluated.changed) await saveVault(context.vault);
        return evaluated.result;
    });
}

export async function getChannelProtection(
    event: IpcMainInvokeEvent,
    localUserId: string,
    channelId: string
): Promise<ChannelProtectionResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    if (!isSnowflake(channelId)) return invalidInput("channelId must be a Discord snowflake");
    return runSerialized(async (): Promise<ChannelProtectionResult> => {
        const vault = await loadVault();
        const conversation = vault.accounts[user.value]?.conversations[channelId];
        if (!conversation) return { status: "unconfigured" };
        return { status: conversation.enabled || conversation.reviewRequired !== null ? "protected" : "disabled" };
    });
}

export async function configureConversation(
    event: IpcMainInvokeEvent,
    localUserId: string,
    input: ConfigureConversationInput
): Promise<ConversationResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    const checkedInput = validateConfigureInput(input, user.value);
    if (!checkedInput.ok) return invalidInput(checkedInput.error);
    return runSerialized(async (): Promise<ConversationResult> => {
        const context = await loadAccount(user.value);
        if (!context.account.conversations[checkedInput.value.snapshot.channelId] &&
            Object.keys(context.account.conversations).length >= MAX_CONVERSATIONS)
            throw new VaultOperationError("capacity_exceeded");

        const selectedRecipients: SelectedRecipientRecord[] = [];
        const unverifiedRecipientIds: string[] = [];
        for (const recipientId of checkedInput.value.selectedRecipientIds) {
            const peer = context.account.trustedPeers[recipientId];
            if (!peer || peer.keyChanged) {
                unverifiedRecipientIds.push(recipientId);
                continue;
            }
            selectedRecipients.push({ fingerprint: peer.identity.fingerprint, userId: recipientId });
        }
        if (unverifiedRecipientIds.length > 0) {
            if (context.created) await saveVault(context.vault);
            return {
                status: "unverified_recipients",
                ...conversationDetails(context.account, checkedInput.value.snapshot, checkedInput.value.selectedRecipientIds),
                unverifiedRecipientIds,
            };
        }

        context.account.conversations[checkedInput.value.snapshot.channelId] = {
            enabled: checkedInput.value.enabled,
            kind: checkedInput.value.snapshot.kind,
            participantUserIds: checkedInput.value.snapshot.participantUserIds,
            reviewRequired: null,
            selectedRecipients,
            updatedAt: Date.now(),
        };
        await saveVault(context.vault);
        return {
            status: checkedInput.value.enabled ? "enabled" : "disabled",
            ...conversationDetails(context.account, checkedInput.value.snapshot, checkedInput.value.selectedRecipientIds),
        };
    });
}

export async function encryptOutgoing(
    event: IpcMainInvokeEvent,
    localUserId: string,
    input: EncryptOutgoingInput
): Promise<EncryptOutgoingResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    const checkedInput = validateEncryptInput(input, user.value);
    if (!checkedInput.ok) return invalidInput(checkedInput.error);
    return runSerialized(async (): Promise<EncryptOutgoingResult> => {
        const context = await loadAccount(user.value);
        const evaluated = evaluateConversation(context.account, checkedInput.value.snapshot);
        if (evaluated.result.status !== "enabled") {
            if (context.created || evaluated.changed) await saveVault(context.vault);
            return {
                status: "not_enabled",
                reason: evaluated.result.status,
                conversation: evaluated.result,
            };
        }
        if (context.account.sendCounter >= Number.MAX_SAFE_INTEGER)
            return { status: "failed", error: "counter_exhausted" };

        const conversation = context.account.conversations[checkedInput.value.snapshot.channelId];
        if (!conversation) return { status: "failed", error: "cryptographic_operation_failed" };
        const recipients: PublicIdentity[] = [];
        for (const selected of conversation.selectedRecipients) {
            const peer = context.account.trustedPeers[selected.userId];
            if (!peer || peer.keyChanged || peer.identity.fingerprint !== selected.fingerprint)
                return {
                    status: "not_enabled",
                    reason: "unverified_recipients",
                    conversation: evaluateConversation(context.account, checkedInput.value.snapshot).result,
                };
            recipients.push(peer.identity);
        }

        const selectedRecipientIds = new Set([user.value, ...recipients.map(recipient => recipient.userId)]);
        let mentionedUserIds: string[];
        try {
            mentionedUserIds = checkedInput.value.mentionedUserIds ??
                extractMentionedUserIds(parseSecurePlaintext(checkedInput.value.plaintext).text)
                    .filter(userId => selectedRecipientIds.has(userId));
        } catch {
            return cryptoFailure();
        }
        if (mentionedUserIds.some(userId => !selectedRecipientIds.has(userId)))
            return invalidInput("Every mentioned user must be a selected encrypted participant");

        const counter = ++context.account.sendCounter;
        await saveVault(context.vault);
        try {
            const content = await encryptProtocolMessage({
                channelId: checkedInput.value.snapshot.channelId,
                counter,
                identity: context.account.identity,
                mentionedUserIds,
                plaintext: checkedInput.value.plaintext,
                recipients,
                senderUserId: user.value,
            });
            return { status: "encrypted", content, counter };
        } catch (error) {
            if (error instanceof Error && error.message.includes("message exceeds Discord"))
                return { status: "failed", error: "message_too_long" };
            return cryptoFailure();
        }
    });
}

function replayEnvelopeMatches(
    replay: ReplayRecord,
    input: DecryptIncomingInput,
    envelope: EncryptedEnvelope,
    contentDigest: string
): boolean {
    return replay.channelId === input.channelId && replay.contentDigest === contentDigest && replay.counter === envelope.q &&
        replay.envelopeId === envelope.i && replay.senderFingerprint === envelope.k &&
        replay.senderUserId === input.discordAuthorId;
}

function replayMatches(
    replay: ReplayRecord,
    input: DecryptIncomingInput,
    envelope: EncryptedEnvelope,
    contentDigest: string
): boolean {
    return replay.discordMessageId === input.discordMessageId &&
        replayEnvelopeMatches(replay, input, envelope, contentDigest);
}

function replayCollides(replay: ReplayRecord, input: DecryptIncomingInput, envelope: EncryptedEnvelope): boolean {
    return replay.discordMessageId === input.discordMessageId ||
        (replay.senderFingerprint === envelope.k && (replay.envelopeId === envelope.i || replay.counter === envelope.q));
}

function isConfirmedOptimisticMessage(
    replay: ReplayRecord,
    input: DecryptIncomingInput,
    envelope: EncryptedEnvelope,
    contentDigest: string,
    localUserId: string,
): boolean {
    return input.discordAuthorId === localUserId && input.discordNonce === replay.discordMessageId &&
        input.discordMessageId !== replay.discordMessageId && !replay.discordMessageIdReplacementUsed &&
        replayEnvelopeMatches(replay, input, envelope, contentDigest);
}

function isNonceLessConfirmedOptimisticMessage(
    replay: ReplayRecord,
    input: DecryptIncomingInput,
    envelope: EncryptedEnvelope,
    contentDigest: string,
    localUserId: string,
): boolean {
    if (input.discordAuthorId !== localUserId || input.discordNonce !== null ||
        input.discordMessageId === replay.discordMessageId || replay.discordMessageIdReplacementUsed ||
        !replayEnvelopeMatches(replay, input, envelope, contentDigest))
        return false;

    const provisionalTimestamp = discordSnowflakeTimestamp(replay.discordMessageId);
    const canonicalTimestamp = discordSnowflakeTimestamp(input.discordMessageId);
    return canonicalTimestamp < provisionalTimestamp &&
        canonicalTimestamp >= envelope.d - CANONICAL_ID_ENVELOPE_LEAD_MS && canonicalTimestamp <= envelope.d &&
        Math.abs(provisionalTimestamp - envelope.d) <= OPTIMISTIC_ID_ENVELOPE_WINDOW_MS &&
        Math.abs(replay.seenAt - envelope.d) <= OPTIMISTIC_ID_ENVELOPE_WINDOW_MS;
}

function isOptimisticLocalMessage(input: DecryptIncomingInput, localUserId: string): boolean {
    return input.discordAuthorId === localUserId && input.discordNonce === input.discordMessageId;
}

function predatesRetirement(
    discordMessageId: string,
    discordEditedTimestamp: string | null,
    envelope: EncryptedEnvelope,
    retiredAt: number,
): boolean {
    const messageTimestamp = discordSnowflakeTimestamp(discordMessageId);
    const editedTimestamp = discordEditedTimestamp === null ? null : Date.parse(discordEditedTimestamp);
    return messageTimestamp < retiredAt && (editedTimestamp === null || editedTimestamp < retiredAt) && envelope.d < retiredAt;
}

export async function decryptIncoming(
    event: IpcMainInvokeEvent,
    localUserId: string,
    input: DecryptIncomingInput
): Promise<DecryptIncomingResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    const checkedInput = validateDecryptInput(input);
    if (!checkedInput.ok) return invalidInput(checkedInput.error);
    return runSerialized(async (): Promise<DecryptIncomingResult> => {
        const context = await loadAccount(user.value);
        if (context.created) await saveVault(context.vault);

        let envelope: EncryptedEnvelope;
        try {
            envelope = parseEncryptedEnvelope(checkedInput.value.content, {
                channelId: checkedInput.value.channelId,
                discordAuthorId: checkedInput.value.discordAuthorId,
            });
        } catch {
            return { status: "invalid_message" };
        }

        if (envelope.c !== checkedInput.value.channelId || envelope.s !== checkedInput.value.discordAuthorId ||
            !envelope.r.some(recipient => recipient.u === user.value))
            return { status: "invalid_message" };

        let senderIdentity: PublicIdentity;
        let localIdentities: PrivateIdentity[];
        if (checkedInput.value.discordAuthorId === user.value) {
            try {
                const currentIdentity = await publicIdentity(context.account.identity, user.value);
                if (currentIdentity.fingerprint === envelope.k) {
                    senderIdentity = currentIdentity;
                    localIdentities = [context.account.identity];
                } else {
                    const historical = context.account.identityHistory[envelope.k];
                    if (!historical || !predatesRetirement(
                        checkedInput.value.discordMessageId,
                        checkedInput.value.discordEditedTimestamp,
                        envelope,
                        historical.retiredAt,
                    ))
                        return { status: "invalid_message" };
                    senderIdentity = await publicIdentity(historical.identity, user.value);
                    localIdentities = [historical.identity];
                }
            } catch {
                return cryptoFailure();
            }
        } else {
            const peer = context.account.trustedPeers[checkedInput.value.discordAuthorId];
            if (!peer || peer.keyChanged) return { status: "untrusted_author" };
            if (peer.identity.fingerprint === envelope.k) {
                senderIdentity = peer.identity;
            } else {
                const historical = context.account.peerIdentityHistory[checkedInput.value.discordAuthorId]?.[envelope.k];
                if (!historical || !predatesRetirement(
                    checkedInput.value.discordMessageId,
                    checkedInput.value.discordEditedTimestamp,
                    envelope,
                    historical.retiredAt,
                ))
                    return { status: "invalid_message" };
                senderIdentity = historical.identity;
            }
            localIdentities = [
                context.account.identity,
                ...Object.values(context.account.identityHistory)
                    .filter(historical => predatesRetirement(
                        checkedInput.value.discordMessageId,
                        checkedInput.value.discordEditedTimestamp,
                        envelope,
                        historical.retiredAt,
                    ))
                    .map(historical => historical.identity),
            ];
        }

        let plaintext: string | null = null;
        let attachmentBundle: AttachmentBundleDescriptor | null = null;
        let detachedTextIndex: number | null = null;
        let stickers: SecureStickerItem[] = [];
        for (const identity of localIdentities) {
            try {
                const decrypted = await decryptProtocolMessage({
                    channelId: checkedInput.value.channelId,
                    content: checkedInput.value.content,
                    discordAuthorId: checkedInput.value.discordAuthorId,
                    identity,
                    localUserId: user.value,
                    senderIdentity,
                });
                const securePlaintext = parseSecurePlaintext(decrypted.plaintext);
                plaintext = securePlaintext.text;
                attachmentBundle = securePlaintext.attachments;
                stickers = securePlaintext.stickers;
                detachedTextIndex = securePlaintext.detachedTextIndex;
                break;
            } catch {
                plaintext = null;
                attachmentBundle = null;
                detachedTextIndex = null;
                stickers = [];
            }
        }
        if (plaintext === null) return { status: "invalid_message" };

        const contentDigest = createHash("sha256").update(checkedInput.value.content, "utf8").digest("base64url");
        const collisions = context.account.replayCache.filter(replay => replayCollides(replay, checkedInput.value, envelope));
        const exactReplay = collisions.find(replay => replayMatches(replay, checkedInput.value, envelope, contentDigest));
        const exactReplayWasSuperseded = exactReplay != null && context.account.replayCache.some(replay =>
            replay.discordMessageId === exactReplay.discordMessageId && replay.senderUserId === exactReplay.senderUserId &&
            replay.counter > exactReplay.counter);
        if (exactReplay && !exactReplayWasSuperseded) {
            if (!exactReplay.discordMessageIdReplacementUsed && !isOptimisticLocalMessage(checkedInput.value, user.value)) {
                // Old vaults did not record whether an ID was optimistic. Seeing the same record under a
                // canonical message shape makes it permanently ineligible for a later ID replacement.
                exactReplay.discordMessageIdReplacementUsed = true;
                exactReplay.seenAt = Date.now();
                await saveVault(context.vault);
            }
            return { status: "decrypted", plaintext, attachmentBundle, detachedTextIndex, stickers, counter: envelope.q, envelopeId: envelope.i };
        }
        const optimisticReplay = collisions.find(replay =>
            isConfirmedOptimisticMessage(replay, checkedInput.value, envelope, contentDigest, user.value) ||
            isNonceLessConfirmedOptimisticMessage(replay, checkedInput.value, envelope, contentDigest, user.value));
        if (optimisticReplay) {
            // Discord first renders a locally authored message under its request nonce, then replaces that
            // optimistic ID with the server ID. Current Message records carry the original nonce. History may
            // omit it, so a tightly bounded older-canonical/newer-provisional timestamp ordering is the only
            // compatibility fallback. Either proof permits one transition and unrelated copies remain blocked.
            optimisticReplay.discordMessageId = checkedInput.value.discordMessageId;
            optimisticReplay.discordMessageIdReplacementUsed = true;
            optimisticReplay.seenAt = Date.now();
            await saveVault(context.vault);
            return { status: "decrypted", plaintext, attachmentBundle, detachedTextIndex, stickers, counter: envelope.q, envelopeId: envelope.i };
        }
        const sameDiscordMessage = collisions.filter(replay => replay.discordMessageId === checkedInput.value.discordMessageId);
        const reusedEnvelope = collisions.some(replay => replay.discordMessageId !== checkedInput.value.discordMessageId);
        if (reusedEnvelope) return { status: "replay_detected" };
        if (sameDiscordMessage.length > 0) {
            // A Discord edit must carry a freshly signed, monotonically newer envelope. Retaining the
            // superseded record as a tombstone makes an older edit a rollback and blocks copying it later.
            if (checkedInput.value.discordEditedTimestamp === null || sameDiscordMessage.some(replay =>
                replay.senderFingerprint === envelope.k && replay.counter >= envelope.q))
                return { status: "replay_detected" };
        }

        context.account.replayCache.push({
            channelId: checkedInput.value.channelId,
            contentDigest,
            counter: envelope.q,
            discordMessageId: checkedInput.value.discordMessageId,
            discordMessageIdReplacementUsed: !isOptimisticLocalMessage(checkedInput.value, user.value),
            envelopeId: envelope.i,
            seenAt: Date.now(),
            senderFingerprint: envelope.k,
            senderUserId: checkedInput.value.discordAuthorId,
        });
        if (context.account.replayCache.length > MAX_REPLAY_RECORDS)
            context.account.replayCache.splice(0, context.account.replayCache.length - MAX_REPLAY_RECORDS);
        await saveVault(context.vault);
        return { status: "decrypted", plaintext, attachmentBundle, detachedTextIndex, stickers, counter: envelope.q, envelopeId: envelope.i };
    });
}

function resolveDetachedMessageText(
    decrypted: Extract<DecryptIncomingResult, { status: "decrypted"; }>,
    attachments: Array<{ data: Uint8Array; id: string; metadata: AttachmentMetadata; }>,
    clearDetachedData = true,
): { attachments: Array<{ data: Uint8Array; id: string; metadata: AttachmentMetadata; }>; plaintext: string; } | null {
    if (decrypted.detachedTextIndex === null) return { attachments, plaintext: decrypted.plaintext };
    const detached = attachments[decrypted.detachedTextIndex];
    if (!detached || decrypted.plaintext.length > 0 || detached.data.byteLength < 1 ||
        detached.data.byteLength > MAX_DETACHED_TEXT_BYTES ||
        detached.metadata.name !== DETACHED_TEXT_FILENAME || detached.metadata.mimeType !== DETACHED_TEXT_MIME_TYPE ||
        detached.metadata.size !== detached.data.byteLength || detached.metadata.spoiler ||
        detached.metadata.description !== null || detached.metadata.width !== null || detached.metadata.height !== null ||
        detached.metadata.duration !== null)
        return null;
    try {
        const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(detached.data);
        if (plaintext.length === 0) return null;
        if (clearDetachedData) detached.data.fill(0);
        return {
            attachments: attachments.filter((_, index) => index !== decrypted.detachedTextIndex),
            plaintext,
        };
    } catch {
        return null;
    }
}

export async function decryptIncomingAttachments(
    event: IpcMainInvokeEvent,
    localUserId: string,
    input: DecryptIncomingAttachmentsInput,
): Promise<DecryptIncomingAttachmentsResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    const checkedInput = validateDecryptAttachmentsInput(input);
    if (!checkedInput.ok) return invalidInput(checkedInput.error);
    const { attachments, ...message } = checkedInput.value;
    const decrypted = await decryptIncoming(event, user.value, message);
    if (decrypted.status !== "decrypted") return decrypted;
    if (!decrypted.attachmentBundle || decrypted.attachmentBundle.count !== attachments.length)
        return { status: "invalid_message" };

    const bundle = decrypted.attachmentBundle;
    if (decrypted.detachedTextIndex !== null) {
        const cachedAttachments: Array<{ data: Uint8Array; id: string; metadata: AttachmentMetadata; }> = [];
        for (const attachment of attachments) {
            const cached = cachedAuthenticatedAttachment(user.value, checkedInput.value, attachment.id);
            if (!cached) break;
            cachedAttachments.push({ id: attachment.id, ...cached });
        }
        if (cachedAttachments.length === attachments.length) {
            const visible = resolveDetachedMessageText(decrypted, cachedAttachments);
            if (visible) return { status: "decrypted", plaintext: visible.plaintext, attachments: visible.attachments };
            for (const attachment of cachedAttachments) attachment.data.fill(0);
            return { status: "invalid_message" };
        }
        for (const attachment of cachedAttachments) attachment.data.fill(0);
    }
    const ciphertexts: Uint8Array[] = [];
    try {
        const masterKey = decodeBase64Url(bundle.key, 32);
        try {
            const outcomes = await Promise.all(attachments.map(async (attachment, index) => {
                let candidateIndex = 0;
                let hadAuthenticationFailure = false;
                let hadDownloadFailure = false;
                const deadline = Date.now() + ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
                while (true) {
                    let downloaded: DownloadedEncryptedAttachment;
                    try {
                        downloaded = await downloadEncryptedAttachment(attachment, message.channelId, candidateIndex, deadline);
                        hadDownloadFailure ||= downloaded.hadDownloadFailure;
                    } catch (error) {
                        hadDownloadFailure ||= error instanceof EncryptedAttachmentDownloadError && error.hadDownloadFailure;
                        return {
                            status: hadAuthenticationFailure && !hadDownloadFailure
                                ? "invalid" as const
                                : "download_failed" as const,
                        };
                    }
                    try {
                        return {
                            status: "decrypted" as const,
                            ciphertext: downloaded.ciphertext,
                            value: await decryptAttachmentBytes({
                                bundleId: bundle.id,
                                channelId: message.channelId,
                                ciphertext: downloaded.ciphertext,
                                count: bundle.count,
                                index,
                                masterKey,
                                senderUserId: message.discordAuthorId,
                            }),
                        };
                    } catch {
                        hadAuthenticationFailure = true;
                        downloaded.ciphertext.fill(0);
                        candidateIndex = downloaded.nextCandidateIndex;
                    }
                }
            }));
            const authenticated = outcomes.filter(outcome => outcome.status === "decrypted");
            const clearAuthenticatedOutcomes = () => {
                for (const outcome of authenticated) {
                    outcome.ciphertext.fill(0);
                    outcome.value.data.fill(0);
                }
            };
            if (outcomes.some(outcome => outcome.status === "download_failed")) {
                clearAuthenticatedOutcomes();
                return { status: "failed", error: "attachment_download_failed" };
            }
            if (outcomes.some(outcome => outcome.status !== "decrypted")) {
                clearAuthenticatedOutcomes();
                return { status: "invalid_message" };
            }

            ciphertexts.push(...authenticated.map(outcome => outcome.ciphertext));
            if (await attachmentBundleRoot(bundle.id, ciphertexts) !== bundle.root) {
                for (const outcome of authenticated) outcome.value.data.fill(0);
                return { status: "invalid_message" };
            }
            const resolved = authenticated.map((outcome, index) => ({
                id: attachments[index].id,
                ...outcome.value,
            }));
            const visible = resolveDetachedMessageText(decrypted, resolved, false);
            if (!visible) {
                for (const attachment of resolved) attachment.data.fill(0);
                return { status: "invalid_message" };
            }
            for (const [index, attachment] of resolved.entries())
                cacheAuthenticatedAttachment(user.value, checkedInput.value, attachment, index !== decrypted.detachedTextIndex);
            if (decrypted.detachedTextIndex !== null) resolved[decrypted.detachedTextIndex].data.fill(0);
            return { status: "decrypted", plaintext: visible.plaintext, attachments: visible.attachments };
        } finally {
            masterKey.fill(0);
        }
    } catch {
        return { status: "invalid_message" };
    } finally {
        for (const ciphertext of ciphertexts) ciphertext.fill(0);
    }
}

export async function downloadIncomingAttachment(
    event: IpcMainInvokeEvent,
    localUserId: string,
    input: DecryptIncomingAttachmentsInput,
    attachmentId: string,
): Promise<DownloadIncomingAttachmentResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    const user = validateLocalUserId(localUserId);
    if (!user.ok) return invalidInput(user.error);
    const checkedInput = validateDecryptAttachmentsInput(input);
    if (!checkedInput.ok) return invalidInput(checkedInput.error);
    if (!isSnowflake(attachmentId) || !checkedInput.value.attachments.some(attachment => attachment.id === attachmentId))
        return invalidInput("attachmentId must identify an encrypted Discord attachment in this message");

    const cached = cachedAuthenticatedAttachment(user.value, checkedInput.value, attachmentId);
    if (cached) {
        try {
            if (!cached.downloadable) return { status: "invalid_message" };
            return {
                status: "saved",
                filename: await saveAuthenticatedAttachment(cached.metadata.name, cached.data),
            };
        } catch {
            return { status: "failed", error: "storage_error" };
        } finally {
            cached.data.fill(0);
        }
    }

    const decrypted = await decryptIncomingAttachments(event, user.value, checkedInput.value);
    if (decrypted.status !== "decrypted") return decrypted;
    try {
        const attachment = decrypted.attachments.find(candidate => candidate.id === attachmentId);
        if (!attachment) return { status: "invalid_message" };
        return {
            status: "saved",
            filename: await saveAuthenticatedAttachment(attachment.metadata.name, attachment.data),
        };
    } catch {
        return { status: "failed", error: "storage_error" };
    } finally {
        for (const attachment of decrypted.attachments) attachment.data.fill(0);
    }
}

// Discord remains capturable at all times. Screenshot mode only hides decrypted DOM content.
const SCREENSHOT_MODE_CLASS = "pc-secure-screenshot-mode";
let screenCaptureProtectionEnabled = false;
let screenCaptureProtectionHealthy = false;
let newWindowHookInstalled = false;
let screenCaptureProtectionOperation: Promise<void> = Promise.resolve();

async function setEncryptedContentHidden(windows: BrowserWindow[], hidden: boolean): Promise<void> {
    const operation = hidden ? "add" : "remove";
    const closeDetachedMedia = hidden
        ? "for(const media of document.querySelectorAll('video,audio')){" +
        "const source=media.currentSrc||media.src||media.querySelector('source')?.src||'';if(source.startsWith('blob:'))media.pause();}" +
        "const exits=[];if(document.pictureInPictureElement&&document.exitPictureInPicture)" +
        "exits.push(document.exitPictureInPicture());if(document.fullscreenElement&&document.exitFullscreen)" +
        "exits.push(document.exitFullscreen());Promise.allSettled(exits).then(finish);"
        : "finish();";
    await Promise.all(windows.map(window => window.webContents.executeJavaScript(
        `new Promise(resolve=>{const finish=()=>{document.documentElement.classList.${operation}(${JSON.stringify(SCREENSHOT_MODE_CLASS)});` +
        "let settled=false;const complete=()=>{if(settled)return;settled=true;resolve();};" +
        "if(document.visibilityState==='visible'){requestAnimationFrame(()=>requestAnimationFrame(complete));setTimeout(complete,250);}" +
        `else complete();};${closeDetachedMedia}})`,
        true,
    )));
}

function markProtectionUnhealthyAfterWindowFailure(): void {
    screenCaptureProtectionHealthy = false;
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
        try {
            window.setContentProtection(false);
        } catch {
            // Best effort: never deliberately restore whole-window capture blocking.
        }
    }
    void setEncryptedContentHidden(windows, true).catch(() => undefined);
}

function installNewWindowProtectionHook(): void {
    if (newWindowHookInstalled) return;
    app.on("browser-window-created", (_event, window) => {
        try {
            window.setContentProtection(false);
            void setEncryptedContentHidden([window], !screenCaptureProtectionEnabled || !screenCaptureProtectionHealthy)
                .catch(markProtectionUnhealthyAfterWindowFailure);
        } catch {
            markProtectionUnhealthyAfterWindowFailure();
        }
    });
    newWindowHookInstalled = true;
}

async function applyScreenCaptureProtection(enabled: boolean): Promise<ScreenCaptureProtectionResult> {
    const previousEnabled = screenCaptureProtectionEnabled;
    const previousHealthy = screenCaptureProtectionHealthy;
    let windows: BrowserWindow[] = [];
    try {
        installNewWindowProtectionHook();
        windows = BrowserWindow.getAllWindows();
        if (!enabled) await setEncryptedContentHidden(windows, true);
        for (const window of windows) window.setContentProtection(false);
        if (enabled) await setEncryptedContentHidden(windows, false);
        screenCaptureProtectionEnabled = enabled;
        screenCaptureProtectionHealthy = true;
        return { status: "applied", enabled, windowCount: windows.length };
    } catch {
        let rollbackSucceeded = true;
        for (const window of windows) {
            try {
                window.setContentProtection(false);
            } catch {
                rollbackSucceeded = false;
            }
        }
        try {
            await setEncryptedContentHidden(windows, !previousEnabled || !previousHealthy);
        } catch {
            rollbackSucceeded = false;
        }
        screenCaptureProtectionEnabled = rollbackSucceeded ? previousEnabled : false;
        screenCaptureProtectionHealthy = rollbackSucceeded ? previousHealthy : false;
        return { status: "failed", error: "screen_capture_protection_failed" };
    }
}

export async function setScreenCaptureProtection(
    event: IpcMainInvokeEvent,
    enabled: boolean,
): Promise<ScreenCaptureProtectionResult> {
    const callerFailure = validateIpcCaller(event);
    if (callerFailure) return callerFailure;
    if (typeof enabled !== "boolean") return invalidInput("enabled must be a boolean");
    const operation = screenCaptureProtectionOperation.then(
        () => applyScreenCaptureProtection(enabled),
        () => applyScreenCaptureProtection(enabled),
    );
    screenCaptureProtectionOperation = operation.then(() => undefined, () => undefined);
    return operation;
}
