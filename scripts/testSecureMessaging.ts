import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { readFileSync } from "node:fs";

import type { CloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";

import {
    attachmentBundleRoot,
    DETACHED_TEXT_FILENAME,
    DETACHED_TEXT_MIME_TYPE,
    decryptAttachmentBytes,
    encodedImageDimensions,
    encryptedAttachmentCiphertextSize,
    encryptAttachmentBytes,
    generateAttachmentBundleMaterial,
    isValidAttachmentWaveform,
    parseSecurePlaintext,
    serializeSecurePlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/attachments";
import {
    EncryptedAttachmentUploadLimitError,
    prepareEncryptedAttachments,
} from "../src/equicordplugins/secureMessaging.desktop/attachmentUploads";
import { unchangedEncryptedAttachmentIds } from "../src/equicordplugins/secureMessaging.desktop/attachmentEditValidation";
import {
    createKeyAnnouncement,
    decryptMessage,
    encryptMessage,
    fingerprintPublicKeys,
    formatFingerprint,
    generateIdentity,
    publicIdentity,
    validateIdentityKeyPairs,
    verifyKeyAnnouncement,
} from "../src/equicordplugins/secureMessaging.desktop/crypto";
import {
    canonicalEncryptedEnvelope,
    decodeBase64Url,
    encodeBase64Url,
    ENCRYPTED_MESSAGE_PREFIX,
    extractMentionedUserIds,
    isEncryptedMessage,
    isKeyAnnouncement,
    KEY_ANNOUNCEMENT_PREFIX,
    LEGACY_ENCRYPTED_MESSAGE_PREFIX,
    MAX_DISCORD_MESSAGE_LENGTH,
    MAX_SELECTED_RECIPIENTS,
    PREVIOUS_ENCRYPTED_MESSAGE_PREFIX,
    PREVIOUS_ENCRYPTED_MESSAGE_VERSION,
    parseEncryptedEnvelope,
    parseKeyAnnouncement,
    serializeEncryptedEnvelope,
    serializeKeyAnnouncement,
} from "../src/equicordplugins/secureMessaging.desktop/protocol";
import type {
    EncryptedEnvelope,
    PrivateIdentity,
    PublicIdentity,
    UnsignedEncryptedEnvelope,
} from "../src/equicordplugins/secureMessaging.desktop/protocol";
import {
    authorizeAttachmentUploadReservations,
    authorizeScopedAttachmentUploadReservations,
    authorizeScopedWireEdit,
    authorizeScopedWirePayload,
    authorizeWireEdit,
    authorizeWirePayload,
    clearWirePayloadAuthorizations,
    consumeAttachmentUploadReservations,
    consumeScopedAttachmentUploadReservations,
    consumeScopedWireEditAuthorization,
    consumeScopedWirePayloadAuthorization,
    consumeWireEditAuthorization,
    consumeWirePayloadAuthorization,
    revokeAnyAttachmentUploadReservations,
} from "../src/equicordplugins/secureMessaging.desktop/wireAuthorizations";
import { availableSelectedRecipientIds } from "../src/equicordplugins/secureMessaging.desktop/conversationSelection";
import { discordEditedTimestamp, discordMessageNonce } from "../src/equicordplugins/secureMessaging.desktop/messageMetadata";
import {
    encryptedAllowedMentions,
    encryptedMessageMentionsUser,
} from "../src/equicordplugins/secureMessaging.desktop/mentionNotifications";
import {
    secureMessageGroupFlags,
    SecureMessageGroup,
    type SecureMessageGroupCandidate,
} from "../src/equicordplugins/secureMessaging.desktop/messageGrouping";
import { KeyReviewGate } from "../src/equicordplugins/secureMessaging.desktop/keyReviewGate";
import {
    extractSecureEmbedUrls,
    isSecureInlineMediaEmbedType,
    secureEmbedOnlyUrl,
    shouldHideSecureEmbedOnlyPlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/embedUrls";

const ALICE_ID = "100000000000000001";
const BOB_ID = "100000000000000002";
const CAROL_ID = "100000000000000003";
const MALLORY_ID = "100000000000000004";
const CHANNEL_ID = "200000000000000001";
const OTHER_CHANNEL_ID = "200000000000000002";
const NOW = 1_800_000_000_000;
const MESSAGE_ID = "qqqqqqqqqqqqqqqqqqqqqg";

type MutableJson = Record<string, any>;

function clone<T>(value: T): T {
    return structuredClone(value);
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
    return Uint8Array.from(value).buffer;
}

function mutateBase64Url(value: string): string {
    return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function makeNonCanonicalBase64Url(value: string): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(value.at(-1)!);
    assert.notEqual(lastIndex, -1);
    const unusedBits = value.length % 4 === 2 ? 4 : value.length % 4 === 3 ? 2 : 0;
    assert.ok(unusedBits > 0, "fixture has unused base64url bits");
    const mask = (1 << unusedBits) - 1;
    const replacement = (lastIndex & ~mask) | ((lastIndex + 1) & mask);
    assert.notEqual(replacement, lastIndex);
    return `${value.slice(0, -1)}${alphabet[replacement]}`;
}

function rawPayload(content: string, prefix: string): MutableJson {
    return JSON.parse(content.slice(prefix.length)) as MutableJson;
}

function wirePayload(prefix: string, value: unknown): string {
    return `${prefix}${JSON.stringify(value)}`;
}

function isError(error: unknown): error is Error {
    return error instanceof Error;
}

function mutateWirePayload(content: string, prefix: string, mutate: (value: MutableJson) => void): string {
    const value = rawPayload(content, prefix);
    mutate(value);
    return wirePayload(prefix, value);
}

async function resignEnvelope(identity: PrivateIdentity, envelope: EncryptedEnvelope): Promise<string> {
    const signingKey = await crypto.subtle.importKey(
        "pkcs8",
        arrayBuffer(decodeBase64Url(identity.signingPrivateKey)),
        { name: "Ed25519" },
        false,
        ["sign"],
    );
    const { z: _signature, ...unsigned } = envelope;
    const signature = await crypto.subtle.sign(
        "Ed25519",
        signingKey,
        arrayBuffer(canonicalEncryptedEnvelope(unsigned as UnsignedEncryptedEnvelope)),
    );
    return serializeEncryptedEnvelope({ ...unsigned, z: encodeBase64Url(signature) });
}

function makeDecryptInput(
    content: string,
    identity: PrivateIdentity,
    localUserId: string,
    senderIdentity: PublicIdentity,
    channelId = CHANNEL_ID,
    discordAuthorId = ALICE_ID,
) {
    return {
        channelId,
        content,
        discordAuthorId,
        identity,
        localUserId,
        senderIdentity,
    };
}

function expectKeyParserFailure(value: unknown, label: string): void {
    assert.throws(
        () => parseKeyAnnouncement(wirePayload(KEY_ANNOUNCEMENT_PREFIX, value)),
        isError,
        label,
    );
}

function expectEnvelopeParserFailure(value: unknown, label: string): void {
    assert.throws(
        () => parseEncryptedEnvelope(wirePayload(ENCRYPTED_MESSAGE_PREFIX, value), {
            channelId: CHANNEL_ID,
            discordAuthorId: ALICE_ID,
        }),
        isError,
        label,
    );
}

function parseTestEnvelope(content: string, channelId = CHANNEL_ID, discordAuthorId = ALICE_ID): EncryptedEnvelope {
    return parseEncryptedEnvelope(content, { channelId, discordAuthorId });
}

function seededGarbage(seed: number, length: number): string {
    const alphabet = "{}[],:\\\"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-!@#$%^&*() ";
    let state = seed >>> 0;
    let result = "";
    for (let index = 0; index < length; index++) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        result += alphabet[state % alphabet.length];
    }
    return result;
}

function groupedMessage(
    id: string,
    authorId: string,
    offset: number,
    overrides: Partial<SecureMessageGroupCandidate> = {},
): SecureMessageGroupCandidate {
    return {
        attachments: [],
        author: { id: authorId },
        components: [],
        content: `${ENCRYPTED_MESSAGE_PREFIX}fixture`,
        embeds: [],
        id,
        reactions: [],
        stickerItems: [],
        timestamp: new Date(NOW + offset),
        ...overrides,
    };
}

async function main(): Promise<void> {
    const rendererSource = readFileSync(
        new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url),
        "utf8",
    );
    const sidebarChatSource = readFileSync(
        new URL("../src/equicordplugins/sidebarChat/index.tsx", import.meta.url),
        "utf8",
    );
    const messageManagerPatch = rendererSource.match(
        /find: '"MessageManager"',[\s\S]{0,250}?match: \/(.+?)\/,[\s\S]{0,100}?replace: "([^"]+)"/,
    );
    assert.ok(messageManagerPatch, "protected DMs patch the shared MessageManager entry");
    assert.doesNotMatch(messageManagerPatch[1], /\.\+|\.\*/, "the no-fetch patch must remain bounded");
    const patchMatcher = new RegExp(messageManagerPatch[1].replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"));
    const managerFixture = 'let logger=new Logger("MessageManager");function M(e){let{isPreload,channelId,forceFetch}=e;return fetch(channelId)}return M({channelId:"42"});';
    const patchedManager = managerFixture.replace(
        patchMatcher,
        messageManagerPatch[2].replace("$self.shouldSuppressChatLoad", "guard"),
    );
    assert.notEqual(patchedManager, managerFixture, "the no-fetch patch applies without relying on destructuring order");
    const runPatchedManager = new Function("Logger", "guard", "fetch", patchedManager) as (
        logger: new (name: string) => object,
        guard: (channelId: string) => boolean,
        fetch: (channelId: string) => string,
    ) => unknown;
    let fetchCount = 0;
    const Logger = class { constructor(_name: string) { } };
    assert.equal(runPatchedManager(Logger, () => true, () => { fetchCount++; return "loaded"; }), undefined);
    assert.equal(fetchCount, 0, "a locked protected channel never reaches MessageManager fetch");
    assert.equal(runPatchedManager(Logger, () => false, () => { fetchCount++; return "loaded"; }), "loaded");
    assert.equal(fetchCount, 1, "an unlocked channel resumes normal MessageManager fetch");

    assert.match(rendererSource, /function installChatLoadGuard\(\)[\s\S]{0,900}actions\.fetchMessages = guardedFetchMessages/, "direct chat fetch actions share the same fail-closed guard");
    assert.match(rendererSource, /find: "Missing channel in Channel\.renderHeaderToolbar"[\s\S]{0,300}renderChatGate/, "protected DMs replace the whole chat before its message list and composer mount");
    assert.match(rendererSource, /protectedChannelIds === null[\s\S]{0,100}hardwareVaultLocked \? "locked" : "unavailable"/, "legacy access state remains fail-closed");
    assert.match(rendererSource, /<ConversationManager[\s\S]{0,200}unlockOnly/, "locked protected chats reuse the unlock-only conversation manager");
    assert.match(rendererSource, /let chatAccessGateEnabled = true;/, "enabled builds fail closed before the plugin start hook runs");
    assert.match(rendererSource, /function chatGateReason[\s\S]{0,200}!chatAccessGateEnabled/, "disabled lifecycle state cannot leave an injected chat gate active");
    const protectionResolver = rendererSource.slice(
        rendererSource.indexOf("async function resolveConversationProtection"),
        rendererSource.indexOf("function installAttachmentUploadGuard"),
    );
    const channelProtectionLookup = protectionResolver.indexOf("Native.getChannelProtection");
    const conversationLookup = protectionResolver.indexOf("Native.getConversation");
    assert.ok(
        channelProtectionLookup !== -1 && conversationLookup !== -1 && channelProtectionLookup < conversationLookup,
        "locked unprotected DMs are identified before the encrypted vault is opened",
    );
    const outgoingListenerSource = rendererSource.slice(
        rendererSource.indexOf("const outgoingListener"),
        rendererSource.indexOf("const editListener"),
    );
    assert.match(
        outgoingListenerSource,
        /resolveConversationProtection\(channelId\)[\s\S]{0,200}protection\.kind === "unprotected"\) return/,
        "ordinary DMs bypass encrypted send handling while the hardware vault is locked",
    );
    const attachmentUploadGuardSource = rendererSource.slice(
        rendererSource.indexOf("function installAttachmentUploadGuard"),
        rendererSource.indexOf("function uninstallAttachmentUploadGuard"),
    );
    assert.match(
        attachmentUploadGuardSource,
        /catch \(error\) \{\s*if \(approval\) throw error;/,
        "approved encrypted uploads surface protection failures instead of pretending to finish",
    );
    const attachmentReservationIndex = outgoingListenerSource.indexOf("authorizeScopedAttachmentUploadReservations");
    const attachmentApprovalIndex = outgoingListenerSource.indexOf("approvedAttachmentUploads.set");
    const attachmentStartIndex = outgoingListenerSource.indexOf("await Promise.all(uploads.map(upload => upload.upload()))");
    assert.ok(
        attachmentReservationIndex !== -1 && attachmentApprovalIndex > attachmentReservationIndex &&
        attachmentStartIndex > attachmentApprovalIndex,
        "encrypted attachments are authorized, approved, and explicitly started in order",
    );
    assert.match(
        outgoingListenerSource,
        /if \(preparedAttachments\) \{\s*options\.uploads = uploads;\s*options\.attachmentsToUpload = uploads;/,
        "every encrypted attachment set is handed back to Discord's upload pipeline",
    );
    assert.equal(
        sidebarChatSource.match(/if \(secureMessagingGated \|\| !channel\?\.id[\s\S]{0,200}?MessageActions\.fetchMessages/g)?.length,
        2,
        "sidebar and popout effects do not fetch while the secure gate is active",
    );
    assert.match(sidebarChatSource, /secureMessagingGated \? renderSecureMessagingChatGate\(channel\) : View/, "sidebar chats replace their direct Chat mount with the secure gate");
    assert.match(sidebarChatSource, /secureMessagingGated[\s\S]{0,150}renderSecureMessagingChatGate\(channel\)[\s\S]{0,150}<FullChannelView/, "popout chats replace their direct FullChannelView mount with the secure gate");

    const groupedMessages = [
        groupedMessage("group-1", ALICE_ID, 0),
        groupedMessage("group-2", ALICE_ID, 1_000),
        groupedMessage("group-3", ALICE_ID, 2_000),
    ];
    assert.equal(secureMessageGroupFlags(groupedMessages[0], groupedMessages), SecureMessageGroup.Next);
    assert.equal(
        secureMessageGroupFlags(groupedMessages[1], groupedMessages),
        SecureMessageGroup.Previous | SecureMessageGroup.Next,
    );
    assert.equal(secureMessageGroupFlags(groupedMessages[2], groupedMessages), SecureMessageGroup.Previous);
    assert.equal(
        secureMessageGroupFlags(groupedMessages[0], groupedMessages, () => false),
        0,
        "failed decryptions split secure cards",
    );
    const differentAuthor = [groupedMessages[0], groupedMessage("different-author", BOB_ID, 1_000)];
    assert.equal(secureMessageGroupFlags(differentAuthor[0], differentAuthor), 0, "different authors do not share a secure card");
    const replyBoundary = [groupedMessages[0], groupedMessage("reply", ALICE_ID, 1_000, { messageReference: {} })];
    assert.equal(secureMessageGroupFlags(replyBoundary[0], replyBoundary), 0, "reply previews split secure cards");
    const previousReplyBoundary = [groupedMessage("previous-reply", ALICE_ID, 0, { messageReference: {} }), groupedMessages[1]];
    assert.equal(secureMessageGroupFlags(previousReplyBoundary[0], previousReplyBoundary), SecureMessageGroup.Next,
        "a reply can join the following message in the same native group");
    assert.equal(secureMessageGroupFlags(previousReplyBoundary[1], previousReplyBoundary), SecureMessageGroup.Previous,
        "messages after replies continue the native group");
    assert.equal(secureMessageGroupFlags(previousReplyBoundary[1], previousReplyBoundary, () => true, () => true), 0,
        "a native group boundary after a reply still splits secure cards");
    const reactionBoundary = [groupedMessage("reacted", ALICE_ID, 0, { reactions: [{}] }), groupedMessages[1]];
    assert.equal(secureMessageGroupFlags(reactionBoundary[0], reactionBoundary), 0, "reactions stay below a closed secure card");
    const nextAttachmentBoundary = [groupedMessages[0], groupedMessage("attached", ALICE_ID, 1_000, { attachments: [{}] })];
    assert.equal(
        secureMessageGroupFlags(nextAttachmentBoundary[0], nextAttachmentBoundary),
        0,
        "a following attachment starts a separate secure card",
    );
    const timeBoundary = [groupedMessages[0], groupedMessage("later", ALICE_ID, 5 * 60 * 1_000)];
    assert.equal(secureMessageGroupFlags(timeBoundary[0], timeBoundary), 0, "separate Discord message groups stay separate");
    const nativeGroupBoundary = [groupedMessages[0], groupedMessages[1]];
    const isNativeGroupStart = (message: SecureMessageGroupCandidate) => message.id === groupedMessages[1].id;
    assert.equal(
        secureMessageGroupFlags(nativeGroupBoundary[0], nativeGroupBoundary, () => true, isNativeGroupStart),
        0,
        "a visible Discord author header closes the preceding secure card",
    );
    assert.equal(
        secureMessageGroupFlags(nativeGroupBoundary[1], nativeGroupBoundary, () => true, isNativeGroupStart),
        0,
        "a visible Discord author header starts an independent secure card",
    );
    assert.equal(
        secureMessageGroupFlags(nativeGroupBoundary[0], nativeGroupBoundary, () => true, () => null),
        0,
        "an unobserved neighboring row stays closed until its native layout is known",
    );

    assert.deepEqual(extractSecureEmbedUrls([
        "Links:",
        "https://example.com/path?x=1.",
        "https://cdn.example.com/image.PNG?size=2",
        "https://media.example.com/clip.webm",
        "https://example.com/path?x=1",
        "https://user:password@example.com/private",
    ].join(" ")), [
        "https://example.com/path?x=1",
        "https://cdn.example.com/image.PNG?size=2",
        "https://media.example.com/clip.webm",
    ]);
    assert.equal(
        extractSecureEmbedUrls(Array.from({ length: 12 }, (_, index) => `https://example.com/embed-${index}`).join(" ")).length,
        10,
        "encrypted messages preserve Discord's ten-embed limit",
    );
    const gifOnlyUrl = "https://media.tenor.com/example/video.mp4";
    assert.equal(secureEmbedOnlyUrl(gifOnlyUrl), gifOnlyUrl, "a sole media URL is recognized as embed-only plaintext");
    assert.equal(
        secureEmbedOnlyUrl("  " + gifOnlyUrl + "\n"),
        gifOnlyUrl,
        "surrounding whitespace does not turn a sole media URL into visible message text",
    );
    assert.equal(secureEmbedOnlyUrl("watch this " + gifOnlyUrl), null, "a caption keeps its media URL visible");
    assert.equal(secureEmbedOnlyUrl(gifOnlyUrl + " nice"), null, "trailing text keeps its media URL visible");
    assert.equal(secureEmbedOnlyUrl(gifOnlyUrl + "."), null, "message punctuation is not discarded as redundant embed text");
    assert.equal(secureEmbedOnlyUrl("<" + gifOnlyUrl + ">"), null, "Discord's explicit no-embed form remains visible");
    assert.equal(
        secureEmbedOnlyUrl(gifOnlyUrl + " https://example.com/second.gif"),
        null,
        "multiple media URLs remain visible as message text",
    );
    assert.equal(
        shouldHideSecureEmbedOnlyPlaintext(gifOnlyUrl, "pending"),
        false,
        "an embed-only URL remains visible until its native preview is ready",
    );
    assert.equal(
        shouldHideSecureEmbedOnlyPlaintext(gifOnlyUrl, "present"),
        true,
        "an embed-only URL stays hidden when Discord supplies inline media",
    );
    assert.equal(
        shouldHideSecureEmbedOnlyPlaintext(gifOnlyUrl, "absent"),
        false,
        "the URL returns when Discord cannot supply inline media",
    );
    assert.equal(
        shouldHideSecureEmbedOnlyPlaintext("caption " + gifOnlyUrl, "present"),
        false,
        "a caption and its link stay visible above inline media",
    );
    assert.equal(isSecureInlineMediaEmbedType("gifv"), true);
    assert.equal(isSecureInlineMediaEmbedType("image"), true);
    assert.equal(isSecureInlineMediaEmbedType("video"), true);
    assert.equal(isSecureInlineMediaEmbedType("article"), false, "rich link cards keep their source URL visible");
    const reviewGate = new KeyReviewGate();
    reviewGate.begin(ALICE_ID, BOB_ID, "new-key-message", 20);
    reviewGate.fail(ALICE_ID, BOB_ID, "new-key-message");
    reviewGate.finish(ALICE_ID, BOB_ID, "new-key-message");
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), true, "failed key review stays fail-closed");
    reviewGate.succeed(ALICE_ID, BOB_ID, "old-key-message");
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), true, "another successful history review cannot clear a different failure");
    reviewGate.succeed(CAROL_ID, BOB_ID, "new-key-message");
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), true, "another local account cannot clear this account's failure");
    reviewGate.succeed(ALICE_ID, BOB_ID, "new-key-message");
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), false, "only the exact failed review retry clears its gate");
    reviewGate.begin(ALICE_ID, BOB_ID, "retry-key-message", 30);
    reviewGate.begin(ALICE_ID, BOB_ID, "retry-key-message", 30);
    reviewGate.finish(ALICE_ID, BOB_ID, "retry-key-message");
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), true, "concurrent review count remains pending until all work finishes");
    reviewGate.finish(ALICE_ID, BOB_ID, "retry-key-message");
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), false);

    assert.equal(discordEditedTimestamp({ edited_timestamp: "2026-01-01T00:00:00+00:00" }), "2026-01-01T00:00:00.000Z");
    assert.equal(discordEditedTimestamp({ editedTimestamp: new Date("2026-01-02T03:04:05.006Z") }), "2026-01-02T03:04:05.006Z");
    assert.equal(discordEditedTimestamp({ edited_timestamp: null, editedTimestamp: new Date() }), null, "raw null takes precedence");
    assert.equal(discordEditedTimestamp({ edited_timestamp: "not-a-timestamp" }), "not-a-timestamp", "invalid non-null metadata fails native validation instead of becoming unedited");
    assert.equal(discordMessageNonce({ nonce: "1533116353970569440" }), "1533116353970569440");
    assert.equal(discordMessageNonce({ nonce: "not-a-snowflake" }), null, "invalid Discord nonces fail closed");

    const trustedBob = {
        status: "trusted" as const,
        identity: { createdAt: NOW, fingerprint: "A".repeat(43), formattedFingerprint: "AA", userId: BOB_ID },
    };
    const changedCarol = {
        status: "key_changed" as const,
        identity: { createdAt: NOW, fingerprint: "B".repeat(43), formattedFingerprint: "BB", userId: CAROL_ID },
    };
    assert.deepEqual(availableSelectedRecipientIds({
        status: "participant_changed",
        participants: [trustedBob],
        previousParticipantUserIds: [BOB_ID, CAROL_ID],
        selectedRecipientIds: [BOB_ID, CAROL_ID],
        snapshot: { channelId: CHANNEL_ID, kind: "GROUP_DM", participantUserIds: [BOB_ID] },
    }), [BOB_ID], "removed selected group recipients cannot remain invisibly selected");
    assert.deepEqual(availableSelectedRecipientIds({
        status: "unverified_recipients",
        participants: [trustedBob, changedCarol],
        selectedRecipientIds: [BOB_ID, CAROL_ID],
        snapshot: { channelId: CHANNEL_ID, kind: "GROUP_DM", participantUserIds: [BOB_ID, CAROL_ID] },
        unverifiedRecipientIds: [CAROL_ID],
    }), [BOB_ID], "changed keys are removed from the next explicit recipient selection");
    assert.deepEqual(availableSelectedRecipientIds({
        status: "unconfigured",
        participants: [trustedBob],
        selectedRecipientIds: [],
        snapshot: { channelId: CHANNEL_ID, kind: "DM", participantUserIds: [BOB_ID] },
    }), [BOB_ID], "a newly configured DM defaults to its one trusted recipient");

    clearWirePayloadAuthorizations();
    authorizeWirePayload(CHANNEL_ID, "PCEM1:authorized", 1_000);
    assert.equal(consumeWirePayloadAuthorization(CHANNEL_ID, "PCEM1:authorized", 1_001), true, "exact wire authorization is consumed");
    assert.equal(consumeWirePayloadAuthorization(CHANNEL_ID, "PCEM1:authorized", 1_002), false, "wire authorization is one-use");
    authorizeWirePayload(CHANNEL_ID, "PCEK1:authorized", 2_000);
    assert.equal(consumeWirePayloadAuthorization(OTHER_CHANNEL_ID, "PCEK1:authorized", 2_001), false, "wire authorization is channel-bound");
    assert.equal(consumeWirePayloadAuthorization(CHANNEL_ID, "PCEK1:authorized", 2_001), true, "a wrong-channel attempt does not consume authorization");
    authorizeWirePayload(CHANNEL_ID, "PCEM1:expired", 3_000);
    assert.equal(consumeWirePayloadAuthorization(CHANNEL_ID, "PCEM1:expired", 33_000), false, "stale wire authorization expires fail-closed");
    authorizeWirePayload(CHANNEL_ID, "PCEM1:counted", 4_000);
    authorizeWirePayload(CHANNEL_ID, "PCEM1:counted", 4_001);
    assert.equal(consumeWirePayloadAuthorization(CHANNEL_ID, "PCEM1:counted", 4_002), true);
    assert.equal(consumeWirePayloadAuthorization(CHANNEL_ID, "PCEM1:counted", 4_003), true);
    assert.equal(consumeWirePayloadAuthorization(CHANNEL_ID, "PCEM1:counted", 4_004), false, "authorization count cannot be over-consumed");
    const protectedFiles = [{ filename: "pc-bundle-0.pcaf", size: 123 }];
    authorizeWirePayload(CHANNEL_ID, "PCEM1:attachment", protectedFiles.map(file => file.filename), 5_000);
    assert.equal(
        consumeWirePayloadAuthorization(CHANNEL_ID, "PCEM1:attachment", [], 5_001),
        false,
        "an encrypted attachment authorization cannot be consumed without its exact filenames",
    );
    assert.equal(
        consumeWirePayloadAuthorization(CHANNEL_ID, "PCEM1:attachment", protectedFiles.map(file => file.filename), 5_002),
        true,
        "an exact encrypted attachment message authorization is one-use",
    );
    authorizeAttachmentUploadReservations(CHANNEL_ID, protectedFiles, 6_000);
    assert.equal(
        consumeAttachmentUploadReservations(CHANNEL_ID, [{ ...protectedFiles[0], size: 124 }], 6_001),
        false,
        "an incorrect upload size does not consume the encrypted attachment reservation",
    );
    assert.equal(consumeAttachmentUploadReservations(CHANNEL_ID, protectedFiles, 6_002), true);
    assert.equal(consumeAttachmentUploadReservations(CHANNEL_ID, protectedFiles, 6_003), false, "upload reservation is one-use");
    authorizeWireEdit(CHANNEL_ID, "100000000000000001", "PCEM2:edited", 7_000);
    assert.equal(
        consumeWireEditAuthorization(CHANNEL_ID, "100000000000000002", "PCEM2:edited", 7_001),
        false,
        "an encrypted edit authorization is message-bound",
    );
    assert.equal(
        consumeWireEditAuthorization(CHANNEL_ID, "100000000000000001", "PCEM2:edited", 7_002),
        true,
        "an exact encrypted edit authorization is one-use",
    );
    assert.equal(
        consumeWireEditAuthorization(CHANNEL_ID, "100000000000000001", "PCEM2:edited", 7_003),
        false,
        "an encrypted edit authorization cannot be replayed",
    );
    const originalScope = "bob:fingerprint-one";
    const changedScope = "bob:fingerprint-two";
    const scopedEditMessageId = "100000000000000003";
    authorizeScopedWirePayload(CHANNEL_ID, "PCEM2:scoped", [], originalScope, 8_000);
    assert.equal(
        consumeScopedWirePayloadAuthorization(CHANNEL_ID, "PCEM2:scoped", [], changedScope, 8_001),
        false,
        "a recipient-key change cannot consume a stale message capability",
    );
    assert.equal(consumeScopedWirePayloadAuthorization(CHANNEL_ID, "PCEM2:scoped", [], originalScope, 8_002), true);
    authorizeScopedWireEdit(CHANNEL_ID, scopedEditMessageId, "PCEM2:scoped-edit", originalScope, 9_000);
    assert.equal(
        consumeScopedWireEditAuthorization(CHANNEL_ID, scopedEditMessageId, "PCEM2:scoped-edit", changedScope, 9_001),
        false,
        "a recipient-key change cannot consume a stale edit capability",
    );
    assert.equal(consumeScopedWireEditAuthorization(CHANNEL_ID, scopedEditMessageId, "PCEM2:scoped-edit", originalScope, 9_002), true);
    authorizeScopedAttachmentUploadReservations(CHANNEL_ID, protectedFiles, originalScope, 10_000);
    assert.equal(
        consumeScopedAttachmentUploadReservations(CHANNEL_ID, protectedFiles, changedScope, 10_001),
        false,
        "a recipient-key change cannot consume a stale attachment capability",
    );
    assert.equal(
        revokeAnyAttachmentUploadReservations(CHANNEL_ID, protectedFiles, 10_002),
        true,
        "a disabled conversation can revoke its stale scoped attachment reservation",
    );
    assert.equal(consumeScopedAttachmentUploadReservations(CHANNEL_ID, protectedFiles, originalScope, 10_003), false);
    authorizeAttachmentUploadReservations(CHANNEL_ID, protectedFiles, 10_004);
    assert.equal(
        revokeAnyAttachmentUploadReservations(CHANNEL_ID, [protectedFiles[0], protectedFiles[0]], 10_005),
        false,
        "duplicate files cannot reuse one attachment reservation",
    );
    assert.equal(revokeAnyAttachmentUploadReservations(CHANNEL_ID, protectedFiles, 10_006), true);
    clearWirePayloadAuthorizations();

    const pngHeader = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64");
    assert.deepEqual(encodedImageDimensions(pngHeader), { height: 1, width: 1 }, "PNG dimensions are preserved for native rendering");
    assert.equal(encodedImageDimensions(new Uint8Array([0, 1, 2, 3])), null, "non-images do not receive fabricated dimensions");
    const originalAttachmentIds = ["100000000000000011", "100000000000000012"];
    assert.equal(
        unchangedEncryptedAttachmentIds(originalAttachmentIds.map(id => ({ id })), originalAttachmentIds),
        true,
        "an encrypted edit may retain the exact ordered attachment set",
    );
    assert.equal(
        unchangedEncryptedAttachmentIds([...originalAttachmentIds].reverse().map(id => ({ id })), originalAttachmentIds),
        false,
        "an encrypted edit cannot reorder index-bound attachment ciphertext",
    );
    assert.equal(
        unchangedEncryptedAttachmentIds([{ id: originalAttachmentIds[0] }], originalAttachmentIds),
        false,
        "an encrypted edit cannot remove an attachment",
    );
    assert.equal(
        unchangedEncryptedAttachmentIds([...originalAttachmentIds.map(id => ({ id })), { id: "100000000000000013" }], originalAttachmentIds),
        false,
        "an encrypted edit cannot append an attachment",
    );
    assert.equal(
        unchangedEncryptedAttachmentIds(undefined, originalAttachmentIds),
        true,
        "an edit body without an attachments field keeps the existing attachment set",
    );
    assert.equal(
        unchangedEncryptedAttachmentIds([null, { id: originalAttachmentIds[1] }], originalAttachmentIds),
        false,
        "an encrypted edit cannot supply a non-object attachment entry",
    );
    assert.equal(
        unchangedEncryptedAttachmentIds([{ id: "not-a-snowflake" }, { id: originalAttachmentIds[1] }], originalAttachmentIds),
        false,
        "an encrypted edit cannot supply a malformed attachment ID",
    );

    const firstAttachment = new TextEncoder().encode("private attachment bytes α");
    const secondAttachment = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const bundleMaterial = generateAttachmentBundleMaterial(2);
    const attachmentMetadata = {
        name: "private-note.txt",
        mimeType: "text/plain; charset=utf-8",
        size: firstAttachment.byteLength,
        spoiler: true,
        description: "private description",
        width: null,
        height: null,
        duration: null,
        waveform: null,
    };
    const encryptedAttachments = await Promise.all([
        encryptAttachmentBytes({
            bundleId: bundleMaterial.descriptor.id,
            channelId: CHANNEL_ID,
            count: 2,
            data: firstAttachment,
            index: 0,
            masterKey: bundleMaterial.keyBytes,
            metadata: attachmentMetadata,
            senderUserId: ALICE_ID,
        }),
        encryptAttachmentBytes({
            bundleId: bundleMaterial.descriptor.id,
            channelId: CHANNEL_ID,
            count: 2,
            data: secondAttachment,
            index: 1,
            masterKey: bundleMaterial.keyBytes,
            metadata: {
                ...attachmentMetadata,
                name: "pixels.bin",
                mimeType: "application/octet-stream",
                size: secondAttachment.byteLength,
                spoiler: false,
                description: null,
            },
            senderUserId: ALICE_ID,
        }),
    ]);
    assert.equal(
        new TextDecoder().decode(encryptedAttachments[0]).includes(attachmentMetadata.name),
        false,
        "encrypted attachment bytes do not expose the private filename",
    );
    const attachmentRoot = await attachmentBundleRoot(bundleMaterial.descriptor.id, encryptedAttachments);
    const securePlaintext = serializeSecurePlaintext("message with files", { ...bundleMaterial.descriptor, root: attachmentRoot });
    assert.deepEqual(parseSecurePlaintext(securePlaintext), {
        text: "message with files",
        attachments: { ...bundleMaterial.descriptor, root: attachmentRoot },
        detachedTextIndex: null,
        stickers: [],
    });
    const legacySecurePlaintext = `PCEA1:${JSON.stringify({
        v: 1,
        m: "message with files",
        a: {
            i: bundleMaterial.descriptor.id,
            k: bundleMaterial.descriptor.key,
            c: bundleMaterial.descriptor.count,
            r: attachmentRoot,
        },
    })}`;
    const attachmentPayloadBytesSaved = legacySecurePlaintext.length - securePlaintext.length;
    assert.ok(attachmentPayloadBytesSaved >= 20,
        `compact attachment descriptor should save at least 20 characters, saved ${attachmentPayloadBytesSaved}`);
    assert.deepEqual(parseSecurePlaintext(legacySecurePlaintext), parseSecurePlaintext(securePlaintext),
        "existing PCEA1 attachment descriptors remain parseable");
    assert.deepEqual(parseSecurePlaintext("legacy message"), {
        text: "legacy message",
        attachments: null,
        detachedTextIndex: null,
        stickers: [],
    });
    const sticker = { formatType: 3, id: "749054660769218631", name: "Wave" };
    assert.deepEqual(parseSecurePlaintext(serializeSecurePlaintext("", null, [sticker])), {
        text: "",
        attachments: null,
        detachedTextIndex: null,
        stickers: [sticker],
    }, "sticker metadata round-trips through the authenticated rich-content payload");
    const compactStickerPlaintext = serializeSecurePlaintext("", null, [sticker]);
    const legacyStickerPlaintext = `PCER1:${JSON.stringify({
        v: 1,
        m: "",
        a: null,
        s: [{ i: sticker.id, n: sticker.name, f: sticker.formatType }],
    })}`;
    const richPayloadBytesSaved = legacyStickerPlaintext.length - compactStickerPlaintext.length;
    assert.ok(richPayloadBytesSaved >= 20,
        `compact sticker descriptor should save at least 20 characters, saved ${richPayloadBytesSaved}`);
    assert.deepEqual(parseSecurePlaintext(legacyStickerPlaintext), parseSecurePlaintext(compactStickerPlaintext),
        "existing PCER1 sticker descriptors remain parseable");
    assert.deepEqual(parseSecurePlaintext(serializeSecurePlaintext("sticker and file", {
        ...bundleMaterial.descriptor,
        root: attachmentRoot,
    }, [sticker])), {
        text: "sticker and file",
        attachments: { ...bundleMaterial.descriptor, root: attachmentRoot },
        detachedTextIndex: null,
        stickers: [sticker],
    }, "stickers compose with encrypted attachment descriptors");
    assert.deepEqual(parseSecurePlaintext(serializeSecurePlaintext("PCER1:literal text")), {
        text: "PCER1:literal text",
        attachments: null,
        detachedTextIndex: null,
        stickers: [],
    }, "rich-content prefix collisions round-trip as ordinary text");
    const detachedTextPlaintext = serializeSecurePlaintext("", {
        ...bundleMaterial.descriptor,
        root: attachmentRoot,
    }, [sticker], 1);
    assert.ok(detachedTextPlaintext.startsWith("PCET1:"), "detached text uses its compact authenticated marker");
    assert.deepEqual(parseSecurePlaintext(detachedTextPlaintext), {
        text: "",
        attachments: { ...bundleMaterial.descriptor, root: attachmentRoot },
        detachedTextIndex: 1,
        stickers: [sticker],
    }, "detached message text composes with attachments and stickers");
    assert.deepEqual(parseSecurePlaintext(serializeSecurePlaintext("PCET1:literal text")), {
        text: "PCET1:literal text",
        attachments: null,
        detachedTextIndex: null,
        stickers: [],
    }, "detached-text prefix collisions round-trip as ordinary text");
    assert.throws(
        () => serializeSecurePlaintext("inline text", { ...bundleMaterial.descriptor, root: attachmentRoot }, [], 0),
        /Detached secure message text is invalid/,
        "detached text markers cannot ambiguously carry inline text",
    );
    assert.throws(
        () => serializeSecurePlaintext("", { ...bundleMaterial.descriptor, root: attachmentRoot }, [], 2),
        /Detached secure message text is invalid/,
        "detached text markers are bound to an existing bundle index",
    );
    const largeMessageText = `large encrypted body ${"text ".repeat(600)}`;
    const largeMessageFile = new File([largeMessageText], DETACHED_TEXT_FILENAME, { type: DETACHED_TEXT_MIME_TYPE });
    const largeMessageUpload = Object.assign(new EventEmitter(), {
        channelId: CHANNEL_ID,
        classification: "unknown",
        clip: null,
        contentHash: null,
        currentSize: largeMessageFile.size,
        description: null,
        durationSecs: undefined,
        etag: undefined,
        error: null,
        filename: largeMessageFile.name,
        id: "0",
        isImage: false,
        status: "NOT_STARTED" as const,
        isThumbnail: false,
        isVideo: false,
        uploadedFilename: "",
        responseUrl: "",
        item: { file: largeMessageFile, origin: "test", platform: CloudUploadPlatform.WEB },
        loaded: 0,
        mimeType: largeMessageFile.type,
        origin: "test",
        postCompressionSize: undefined,
        preCompressionSize: largeMessageFile.size,
        sensitive: false,
        spoiler: false,
        startTime: 0,
        uniqueId: "test",
        waveform: undefined,
        async upload() { },
        cancel() { },
        async delete() { },
        getSize() { return this.currentSize; },
        async maybeConvertToWebP() { },
        removeFromMsgDraft() { },
        setFilename(value: string) { this.filename = value; },
    }) satisfies CloudUpload;
    const largeMessageMetadata = {
        description: null,
        duration: null,
        height: null,
        mimeType: DETACHED_TEXT_MIME_TYPE,
        name: DETACHED_TEXT_FILENAME,
        size: largeMessageFile.size,
        spoiler: false,
        waveform: null,
        width: null,
    };
    const plannedLargeMessageBytes = encryptedAttachmentCiphertextSize(largeMessageMetadata);
    await assert.rejects(
        prepareEncryptedAttachments(
            [largeMessageUpload],
            "",
            CHANNEL_ID,
            ALICE_ID,
            [],
            0,
            plannedLargeMessageBytes - 1,
        ),
        (error: unknown) => error instanceof EncryptedAttachmentUploadLimitError &&
            error.encryptedBytes === plannedLargeMessageBytes && error.limitBytes === plannedLargeMessageBytes - 1,
        "the exact encrypted file size is rejected before an upload exceeds Discord's current limit",
    );
    assert.equal(largeMessageUpload.item.file, largeMessageFile, "failed size preflight leaves the plaintext draft upload untouched");
    const preparedLargeMessage = await prepareEncryptedAttachments(
        [largeMessageUpload],
        "",
        CHANNEL_ID,
        ALICE_ID,
        [],
        0,
    );
    const preparedLargeDescriptor = parseSecurePlaintext(preparedLargeMessage.plaintext);
    assert.equal(preparedLargeDescriptor.detachedTextIndex, 0);
    assert.ok(preparedLargeDescriptor.attachments);
    preparedLargeMessage.apply();
    const largeMessageCiphertext = new Uint8Array(await largeMessageUpload.item.file.arrayBuffer());
    assert.equal(preparedLargeMessage.totalUploadBytes, plannedLargeMessageBytes,
        "the complete encrypted upload size is known exactly before send");
    assert.equal(largeMessageCiphertext.byteLength, plannedLargeMessageBytes,
        "the preflighted ciphertext size matches the bytes handed to Discord");
    assert.equal(new TextDecoder().decode(largeMessageCiphertext).includes(largeMessageText), false,
        "detached text is never present in its uploaded ciphertext bytes");
    const openedLargeMessage = await decryptAttachmentBytes({
        bundleId: preparedLargeDescriptor.attachments.id,
        channelId: CHANNEL_ID,
        ciphertext: largeMessageCiphertext,
        count: preparedLargeDescriptor.attachments.count,
        index: 0,
        masterKey: decodeBase64Url(preparedLargeDescriptor.attachments.key, 32),
        senderUserId: ALICE_ID,
    });
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(openedLargeMessage.data), largeMessageText);
    assert.equal(openedLargeMessage.metadata.name, DETACHED_TEXT_FILENAME);
    assert.equal(openedLargeMessage.metadata.mimeType, DETACHED_TEXT_MIME_TYPE);

    const voiceWaveform = btoa(String.fromCharCode(...new Uint8Array([0, 16, 64, 128, 255])));
    assert.equal(isValidAttachmentWaveform(voiceWaveform), true, "Discord voice waveforms use canonical bounded base64");
    assert.equal(isValidAttachmentWaveform(voiceWaveform.replace(/=+$/u, "")), false, "non-canonical voice waveforms are rejected");
    const voiceBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 1, 2, 3, 4, 5]);
    const voiceFile = new File([voiceBytes], "voice-message.ogg", { type: "audio/ogg; codecs=opus" });
    const voiceUpload = Object.assign(new EventEmitter(), {
        channelId: CHANNEL_ID,
        classification: "unknown",
        clip: null,
        contentHash: null,
        currentSize: voiceFile.size,
        description: null,
        durationSecs: 1.25,
        etag: undefined,
        error: null,
        filename: voiceFile.name,
        id: "0",
        isImage: false,
        status: "NOT_STARTED" as const,
        isThumbnail: false,
        isVideo: false,
        uploadedFilename: "",
        responseUrl: "",
        item: { file: voiceFile, origin: "test", platform: CloudUploadPlatform.WEB },
        loaded: 0,
        mimeType: voiceFile.type,
        origin: "test",
        postCompressionSize: undefined,
        preCompressionSize: voiceFile.size,
        sensitive: false,
        spoiler: false,
        startTime: 0,
        uniqueId: "voice-test",
        waveform: voiceWaveform,
        async upload() { },
        cancel() { },
        async delete() { },
        getSize() { return this.currentSize; },
        async maybeConvertToWebP() { },
        removeFromMsgDraft() { },
        setFilename(value: string) { this.filename = value; },
    }) satisfies CloudUpload;
    const preparedVoice = await prepareEncryptedAttachments([voiceUpload], "", CHANNEL_ID, ALICE_ID);
    const voiceDescriptor = parseSecurePlaintext(preparedVoice.plaintext).attachments;
    assert.ok(voiceDescriptor, "encrypted voice messages carry an authenticated attachment descriptor");
    preparedVoice.apply();
    assert.equal(voiceUpload.durationSecs, undefined, "Discord does not receive voice duration for opaque ciphertext");
    assert.equal(voiceUpload.waveform, undefined, "Discord does not receive the encrypted voice waveform");
    assert.equal(voiceUpload.item.file.type, "application/octet-stream", "Discord uploads opaque voice ciphertext");
    const openedVoice = await decryptAttachmentBytes({
        bundleId: voiceDescriptor.id,
        channelId: CHANNEL_ID,
        ciphertext: new Uint8Array(await voiceUpload.item.file.arrayBuffer()),
        count: voiceDescriptor.count,
        index: 0,
        masterKey: decodeBase64Url(voiceDescriptor.key, 32),
        senderUserId: ALICE_ID,
    });
    assert.deepEqual(openedVoice.data, voiceBytes);
    assert.deepEqual(openedVoice.metadata, {
        description: null,
        duration: 1.25,
        height: null,
        mimeType: "audio/ogg; codecs=opus",
        name: "voice-message.ogg",
        size: voiceBytes.byteLength,
        spoiler: false,
        waveform: voiceWaveform,
        width: null,
    }, "voice duration and waveform are authenticated and restored for Discord's native player");
    const preparedVoiceRetry = await prepareEncryptedAttachments([voiceUpload], "", CHANNEL_ID, ALICE_ID);
    const voiceRetryDescriptor = parseSecurePlaintext(preparedVoiceRetry.plaintext).attachments;
    assert.ok(voiceRetryDescriptor);
    preparedVoiceRetry.apply();
    const openedVoiceRetry = await decryptAttachmentBytes({
        bundleId: voiceRetryDescriptor.id,
        channelId: CHANNEL_ID,
        ciphertext: new Uint8Array(await voiceUpload.item.file.arrayBuffer()),
        count: voiceRetryDescriptor.count,
        index: 0,
        masterKey: decodeBase64Url(voiceRetryDescriptor.key, 32),
        senderUserId: ALICE_ID,
    });
    assert.equal(openedVoiceRetry.metadata.duration, 1.25, "an encrypted voice retry retains its original authenticated duration");
    assert.equal(openedVoiceRetry.metadata.waveform, voiceWaveform, "an encrypted voice retry retains its original authenticated waveform");
    assert.deepEqual(openedVoiceRetry.data, voiceBytes, "an encrypted voice retry rebuilds from the original Ogg bytes");
    assert.throws(
        () => serializeSecurePlaintext("", null, [sticker, sticker]),
        /duplicates/,
        "duplicate sticker IDs are rejected",
    );
    const openedAttachment = await decryptAttachmentBytes({
        bundleId: bundleMaterial.descriptor.id,
        channelId: CHANNEL_ID,
        ciphertext: encryptedAttachments[0],
        count: 2,
        index: 0,
        masterKey: bundleMaterial.keyBytes,
        senderUserId: ALICE_ID,
    });
    assert.deepEqual(openedAttachment.metadata, attachmentMetadata);
    assert.deepEqual(openedAttachment.data, firstAttachment);
    await assert.rejects(
        decryptAttachmentBytes({
            bundleId: bundleMaterial.descriptor.id,
            channelId: CHANNEL_ID,
            ciphertext: encryptedAttachments[0],
            count: 2,
            index: 1,
            masterKey: bundleMaterial.keyBytes,
            senderUserId: ALICE_ID,
        }),
        /authentication failed/,
        "encrypted attachments cannot be reordered",
    );
    const tamperedAttachment = Uint8Array.from(encryptedAttachments[0]);
    tamperedAttachment[tamperedAttachment.length - 1] ^= 1;
    await assert.rejects(
        decryptAttachmentBytes({
            bundleId: bundleMaterial.descriptor.id,
            channelId: CHANNEL_ID,
            ciphertext: tamperedAttachment,
            count: 2,
            index: 0,
            masterKey: bundleMaterial.keyBytes,
            senderUserId: ALICE_ID,
        }),
        /authentication failed/,
        "encrypted attachment tampering is rejected",
    );
    bundleMaterial.keyBytes.fill(0);

    const [aliceIdentity, bobIdentity, carolIdentity, malloryIdentity] = await Promise.all([
        generateIdentity(NOW),
        generateIdentity(NOW + 1),
        generateIdentity(NOW + 2),
        generateIdentity(NOW + 3),
    ]);

    assert.notEqual(aliceIdentity.signingPublicKey, bobIdentity.signingPublicKey, "generated signing identities are unique");
    assert.notEqual(aliceIdentity.hpkePublicKey, bobIdentity.hpkePublicKey, "generated HPKE identities are unique");
    assert.equal(decodeBase64Url(aliceIdentity.signingPublicKey, 32).byteLength, 32);
    assert.equal(decodeBase64Url(aliceIdentity.hpkePublicKey, 32).byteLength, 32);
    await Promise.all([aliceIdentity, bobIdentity, carolIdentity, malloryIdentity].map(validateIdentityKeyPairs));
    await assert.rejects(
        validateIdentityKeyPairs({ ...aliceIdentity, signingPublicKey: bobIdentity.signingPublicKey }),
        /signing key pair does not match/,
        "a mismatched persisted Ed25519 public key is rejected",
    );
    await assert.rejects(
        validateIdentityKeyPairs({ ...aliceIdentity, hpkePublicKey: bobIdentity.hpkePublicKey }),
        /HPKE key pair does not match/,
        "a mismatched persisted X25519 public key is rejected",
    );

    const [aliceAnnouncement, bobAnnouncement, carolAnnouncement] = await Promise.all([
        createKeyAnnouncement(aliceIdentity, ALICE_ID),
        createKeyAnnouncement(bobIdentity, BOB_ID),
        createKeyAnnouncement(carolIdentity, CAROL_ID),
    ]);
    const [alicePublic, bobPublic, carolPublic, malloryPublic] = await Promise.all([
        verifyKeyAnnouncement(aliceAnnouncement, ALICE_ID),
        verifyKeyAnnouncement(bobAnnouncement, BOB_ID),
        verifyKeyAnnouncement(carolAnnouncement, CAROL_ID),
        publicIdentity(malloryIdentity, MALLORY_ID),
    ]);

    assert.equal(isKeyAnnouncement(aliceAnnouncement), true);
    assert.equal(isKeyAnnouncement(`${KEY_ANNOUNCEMENT_PREFIX}not-json`), true, "prefix detection is deliberately separate from validation");
    assert.equal(isKeyAnnouncement(42), false);
    assert.equal(isEncryptedMessage(aliceAnnouncement), false);
    assert.deepEqual(alicePublic, await publicIdentity(aliceIdentity, ALICE_ID));
    assert.equal(serializeKeyAnnouncement(parseKeyAnnouncement(aliceAnnouncement)), aliceAnnouncement);
    assert.equal(parseKeyAnnouncement(aliceAnnouncement).d, NOW);

    await assert.rejects(
        verifyKeyAnnouncement(aliceAnnouncement, BOB_ID),
        /does not match its Discord author/,
        "an announcement cannot be attributed to a different Discord author",
    );
    const reboundAnnouncement = mutateWirePayload(aliceAnnouncement, KEY_ANNOUNCEMENT_PREFIX, value => {
        value.u = BOB_ID;
    });
    await assert.rejects(
        verifyKeyAnnouncement(reboundAnnouncement, BOB_ID),
        /signature is invalid/,
        "changing both the payload user and claimed author cannot rebind a signature",
    );
    const changedAnnouncementContent = mutateWirePayload(aliceAnnouncement, KEY_ANNOUNCEMENT_PREFIX, value => {
        value.d++;
    });
    await assert.rejects(
        verifyKeyAnnouncement(changedAnnouncementContent, ALICE_ID),
        /signature is invalid/,
        "announcement content is signed",
    );
    const changedAnnouncementSignature = mutateWirePayload(aliceAnnouncement, KEY_ANNOUNCEMENT_PREFIX, value => {
        value.z = mutateBase64Url(value.z);
    });
    await assert.rejects(
        verifyKeyAnnouncement(changedAnnouncementSignature, ALICE_ID),
        /signature is invalid/,
        "announcement signature corruption is rejected",
    );
    const nonCanonicalAnnouncementSignature = mutateWirePayload(aliceAnnouncement, KEY_ANNOUNCEMENT_PREFIX, value => {
        value.z = makeNonCanonicalBase64Url(value.z);
    });
    await assert.rejects(
        verifyKeyAnnouncement(nonCanonicalAnnouncementSignature, ALICE_ID),
        /invalid|canonical/i,
        "alternate base64url spellings of the same signature are rejected",
    );
    const duplicateAnnouncementUser = aliceAnnouncement.replace(
        `${KEY_ANNOUNCEMENT_PREFIX}{`,
        `${KEY_ANNOUNCEMENT_PREFIX}{\"u\":\"${BOB_ID}\",`,
    );
    assert.throws(
        () => parseKeyAnnouncement(duplicateAnnouncementUser),
        /canonical/i,
        "duplicate JSON members are rejected even when the signed value appears last",
    );

    const aliceKeysBoundToBob = await publicIdentity(aliceIdentity, BOB_ID);
    assert.notEqual(
        alicePublic.fingerprint,
        aliceKeysBoundToBob.fingerprint,
        "the same public keys have different fingerprints for different Discord users",
    );
    assert.equal(
        alicePublic.fingerprint,
        await fingerprintPublicKeys(ALICE_ID, aliceIdentity.signingPublicKey, aliceIdentity.hpkePublicKey),
    );
    assert.match(formatFingerprint(alicePublic.fingerprint), /^[A-F\d]{4}( [A-F\d]{4}){15}$/u);
    await assert.rejects(
        fingerprintPublicKeys("not-a-snowflake", aliceIdentity.signingPublicKey, aliceIdentity.hpkePublicKey),
        /snowflake/,
    );

    const plaintext = `Hello <@${ALICE_ID}> and <@${BOB_ID}> 👋 — こんにちは — café — null:\u0000 — astral: 𠜎`;
    const encrypted = await encryptMessage({
        channelId: CHANNEL_ID,
        identity: aliceIdentity,
        plaintext,
        recipients: [carolPublic, bobPublic, alicePublic, bobPublic],
        senderUserId: ALICE_ID,
        now: NOW + 10,
        messageId: MESSAGE_ID,
        mentionedUserIds: [ALICE_ID, BOB_ID],
        counter: 7,
    });
    const envelope = parseTestEnvelope(encrypted);

    assert.equal(isEncryptedMessage(encrypted), true);
    assert.equal(isEncryptedMessage(`${ENCRYPTED_MESSAGE_PREFIX}not-json`), true, "prefix detection does not imply validity");
    assert.equal(isEncryptedMessage(null), false);
    assert.equal(serializeEncryptedEnvelope(envelope), encrypted);
    assert.ok(encrypted.length <= MAX_DISCORD_MESSAGE_LENGTH, "valid wire payloads fit Discord's message limit");
    assert.equal(envelope.k, alicePublic.fingerprint);
    assert.equal(envelope.q, 7);
    assert.equal(envelope.i, MESSAGE_ID);
    assert.deepEqual(envelope.m, [ALICE_ID, BOB_ID], "PCEM3 carries explicitly mentioned selected participants, including the author");
    assert.ok(encrypted.includes(JSON.stringify(`<@${ALICE_ID}>`)), "the authenticated wire carries author mention state immediately");
    assert.ok(encrypted.includes(JSON.stringify(`<@${BOB_ID}>`)), "the authenticated wire contains Discord mention syntax");
    assert.deepEqual(
        encryptedAllowedMentions(encrypted, { channelId: CHANNEL_ID, discordAuthorId: ALICE_ID }, {
            parse: ["everyone", "roles", "users"],
            replied_user: true,
        }),
        { parse: [], users: [BOB_ID], replied_user: true },
        "the REST allowlist permits only authenticated user notifications while preserving reply notification intent",
    );
    assert.equal(
        encryptedMessageMentionsUser(encrypted, { channelId: CHANNEL_ID, discordAuthorId: ALICE_ID }, ALICE_ID),
        true,
        "the sender's encrypted row can establish its mention highlight before decryption",
    );
    assert.equal(
        encryptedMessageMentionsUser(encrypted, { channelId: CHANNEL_ID, discordAuthorId: ALICE_ID }, CAROL_ID),
        false,
        "unmentioned selected participants do not receive a mentioned-message highlight",
    );
    assert.deepEqual(
        extractMentionedUserIds(`<@!${CAROL_ID}> <@${BOB_ID}> <@${BOB_ID}> <@&${ALICE_ID}>`),
        [BOB_ID, CAROL_ID],
        "user mentions are normalized, deduplicated, sorted, and role mentions are ignored",
    );
    assert.deepEqual(
        envelope.r.map(recipient => recipient.u),
        [ALICE_ID, BOB_ID, CAROL_ID],
        "recipients are deduplicated, sorted, and always include the sender",
    );
    const { m: _mentionedUserIds, ...envelopeWithoutMentions } = envelope;
    const previousEquivalent = serializeEncryptedEnvelope({
        ...envelopeWithoutMentions,
        v: PREVIOUS_ENCRYPTED_MESSAGE_VERSION,
    });
    assert.ok(previousEquivalent.startsWith(PREVIOUS_ENCRYPTED_MESSAGE_PREFIX));
    assert.equal(parseTestEnvelope(previousEquivalent).v, PREVIOUS_ENCRYPTED_MESSAGE_VERSION, "existing PCEM2 messages remain parseable");
    assert.ok(isEncryptedMessage(previousEquivalent), "PCEM2 encrypted messages remain detectable");
    assert.deepEqual(
        encryptedAllowedMentions(previousEquivalent, { channelId: CHANNEL_ID, discordAuthorId: ALICE_ID }, null),
        { parse: [], users: [] },
        "older encrypted envelopes cannot acquire phantom notification targets",
    );
    assert.equal(
        encryptedMessageMentionsUser(
            previousEquivalent,
            { channelId: CHANNEL_ID, discordAuthorId: ALICE_ID },
            ALICE_ID,
            plaintext,
        ),
        true,
        "verified plaintext supplies mention state for older envelopes",
    );
    const legacyEquivalent = serializeEncryptedEnvelope({
        ...envelopeWithoutMentions,
        v: 1,
        i: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const envelopeBytesSaved = legacyEquivalent.length - encrypted.length;
    assert.ok(envelopeBytesSaved >= 90, `compact envelope with two mention tokens should save at least 90 characters, saved ${envelopeBytesSaved}`);
    assert.equal(parseEncryptedEnvelope(legacyEquivalent).v, 1, "existing PCEM1 messages remain parseable");
    assert.ok(isEncryptedMessage(legacyEquivalent), "legacy encrypted messages remain detectable");
    assert.throws(
        () => parseEncryptedEnvelope(`${LEGACY_ENCRYPTED_MESSAGE_PREFIX}null`),
        /malformed encrypted envelope/iu,
        "a non-object PCEM1 root is rejected as malformed instead of throwing a property-access error",
    );

    for (const [label, identity, userId] of [
        ["sender", aliceIdentity, ALICE_ID],
        ["Bob", bobIdentity, BOB_ID],
        ["Carol", carolIdentity, CAROL_ID],
    ] as const) {
        const decrypted = await decryptMessage(makeDecryptInput(encrypted, identity, userId, alicePublic));
        assert.equal(decrypted.plaintext, plaintext, `${label} decrypts the exact Unicode plaintext`);
        assert.deepEqual(decrypted.envelope, envelope);
    }

    const selfOnly = await encryptMessage({
        channelId: CHANNEL_ID,
        identity: aliceIdentity,
        plaintext: "private note to self",
        recipients: [],
        senderUserId: ALICE_ID,
        now: NOW + 11,
        counter: 8,
    });
    assert.deepEqual(parseTestEnvelope(selfOnly).r.map(recipient => recipient.u), [ALICE_ID]);
    assert.equal(
        (await decryptMessage(makeDecryptInput(selfOnly, aliceIdentity, ALICE_ID, alicePublic))).plaintext,
        "private note to self",
    );

    await assert.rejects(
        decryptMessage(makeDecryptInput(encrypted, malloryIdentity, MALLORY_ID, alicePublic)),
        /not an encrypted-message recipient/,
        "an unselected outsider has no wrapped content key",
    );
    await assert.rejects(
        decryptMessage(makeDecryptInput(encrypted, malloryIdentity, BOB_ID, alicePublic)),
        isError,
        "knowing a selected user ID is insufficient without that recipient's HPKE private key",
    );

    const badFingerprint = { ...bobPublic, fingerprint: malloryPublic.fingerprint };
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "must not encrypt",
            recipients: [badFingerprint],
            senderUserId: ALICE_ID,
            counter: 9,
        }),
        /invalid fingerprint/,
        "recipient fingerprints are recomputed before encryption",
    );
    const conflictingBob = {
        userId: BOB_ID,
        signingPublicKey: carolPublic.signingPublicKey,
        hpkePublicKey: carolPublic.hpkePublicKey,
        fingerprint: await fingerprintPublicKeys(BOB_ID, carolPublic.signingPublicKey, carolPublic.hpkePublicKey),
    };
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "must not encrypt",
            recipients: [bobPublic, conflictingBob],
            senderUserId: ALICE_ID,
            counter: 9,
        }),
        /Conflicting keys/,
        "two keysets cannot be supplied for the same recipient",
    );

    const deterministicInput = {
        channelId: CHANNEL_ID,
        identity: aliceIdentity,
        plaintext: "same inputs still use fresh cryptographic randomness",
        recipients: [bobPublic],
        senderUserId: ALICE_ID,
        now: NOW + 20,
        messageId: "u7u7u7u7u7u7u7u7u7u7uw",
        counter: 10,
    };
    const [randomizedOne, randomizedTwo] = await Promise.all([
        encryptMessage(deterministicInput),
        encryptMessage(deterministicInput),
    ]);
    const randomizedEnvelopeOne = parseTestEnvelope(randomizedOne);
    const randomizedEnvelopeTwo = parseTestEnvelope(randomizedTwo);
    assert.notEqual(randomizedOne, randomizedTwo, "identical logical inputs do not repeat a wire ciphertext");
    assert.notEqual(randomizedEnvelopeOne.n, randomizedEnvelopeTwo.n, "AES-GCM nonces are fresh");
    assert.notEqual(randomizedEnvelopeOne.x, randomizedEnvelopeTwo.x, "content ciphertexts are randomized");
    assert.notDeepEqual(randomizedEnvelopeOne.r, randomizedEnvelopeTwo.r, "HPKE encapsulations are randomized");

    const [generatedIdOne, generatedIdTwo] = await Promise.all([
        encryptMessage({ ...deterministicInput, messageId: undefined, counter: 11 }),
        encryptMessage({ ...deterministicInput, messageId: undefined, counter: 12 }),
    ]);
    assert.notEqual(
        parseTestEnvelope(generatedIdOne).i,
        parseTestEnvelope(generatedIdTwo).i,
        "generated envelope IDs are unique",
    );

    const badSignature = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => {
        value[8] = mutateBase64Url(value[8]);
    });
    await assert.rejects(
        decryptMessage(makeDecryptInput(badSignature, bobIdentity, BOB_ID, alicePublic)),
        /signature is invalid/,
        "envelope signature tampering is rejected",
    );
    const nonCanonicalEnvelopeSignature = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => {
        value[8] = makeNonCanonicalBase64Url(value[8]);
    });
    await assert.rejects(
        decryptMessage(makeDecryptInput(nonCanonicalEnvelopeSignature, bobIdentity, BOB_ID, alicePublic)),
        /invalid|canonical/i,
        "alternate base64url spellings cannot bypass wire replay hashes",
    );
    const oversizedEnvelopeTuple = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => value.push("extra"));
    assert.throws(
        () => parseTestEnvelope(oversizedEnvelopeTuple),
        /malformed/i,
        "compact envelopes reject trailing boilerplate",
    );

    const unsignedContentTamper = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => {
        value[7] = mutateBase64Url(value[7]);
    });
    await assert.rejects(
        decryptMessage(makeDecryptInput(unsignedContentTamper, bobIdentity, BOB_ID, alicePublic)),
        /signature is invalid/,
        "ciphertext is covered by the sender signature",
    );
    const mentionTamper = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => {
        value[5][1] = `<@${CAROL_ID}>`;
    });
    await assert.rejects(
        decryptMessage(makeDecryptInput(mentionTamper, bobIdentity, BOB_ID, alicePublic)),
        /signature is invalid/,
        "Discord mentioned users are covered by the sender signature",
    );
    const contentTamperEnvelope = clone(envelope);
    contentTamperEnvelope.x = mutateBase64Url(contentTamperEnvelope.x);
    const signedContentTamper = await resignEnvelope(aliceIdentity, contentTamperEnvelope);
    await assert.rejects(
        decryptMessage(makeDecryptInput(signedContentTamper, bobIdentity, BOB_ID, alicePublic)),
        /authentication failed/,
        "AES-GCM rejects corrupted content even under a fresh valid sender signature",
    );

    const bobRecipientIndex = envelope.r.findIndex(recipient => recipient.u === BOB_ID);
    assert.notEqual(bobRecipientIndex, -1);
    const wrapTamperEnvelope = clone(envelope);
    wrapTamperEnvelope.r[bobRecipientIndex].x = mutateBase64Url(wrapTamperEnvelope.r[bobRecipientIndex].x);
    const signedWrapTamper = await resignEnvelope(aliceIdentity, wrapTamperEnvelope);
    await assert.rejects(
        decryptMessage(makeDecryptInput(signedWrapTamper, bobIdentity, BOB_ID, alicePublic)),
        isError,
        "HPKE rejects a corrupted recipient key wrap even when the envelope is re-signed",
    );

    const recipientTamperEnvelope = clone(envelope);
    recipientTamperEnvelope.r[recipientTamperEnvelope.r.length - 1].u = MALLORY_ID;
    const signedRecipientTamper = await resignEnvelope(aliceIdentity, recipientTamperEnvelope);
    await assert.rejects(
        decryptMessage(makeDecryptInput(signedRecipientTamper, bobIdentity, BOB_ID, alicePublic)),
        isError,
        "recipient IDs are bound into every HPKE context and the content AAD",
    );

    await assert.rejects(
        decryptMessage(makeDecryptInput(encrypted, bobIdentity, BOB_ID, alicePublic, OTHER_CHANNEL_ID)),
        /signature is invalid/,
        "the implicit Discord channel context prevents copying a compact envelope",
    );
    const channelTamperEnvelope = clone(envelope);
    channelTamperEnvelope.c = OTHER_CHANNEL_ID;
    const signedChannelTamper = await resignEnvelope(aliceIdentity, channelTamperEnvelope);
    await assert.rejects(
        decryptMessage(makeDecryptInput(signedChannelTamper, bobIdentity, BOB_ID, alicePublic, OTHER_CHANNEL_ID)),
        isError,
        "the channel is also cryptographically bound into HPKE and AES-GCM",
    );

    await assert.rejects(
        decryptMessage(makeDecryptInput(encrypted, bobIdentity, BOB_ID, alicePublic, CHANNEL_ID, BOB_ID)),
        /sender does not match its Discord author|mentioned user/,
        "the observed Discord author must match the signed sender",
    );
    const observedAuthorTamper = { ...alicePublic, userId: BOB_ID };
    await assert.rejects(
        decryptMessage(makeDecryptInput(encrypted, bobIdentity, BOB_ID, observedAuthorTamper, CHANNEL_ID, BOB_ID)),
        /unverified sender key|malformed|signature is invalid|mentioned user/,
        "the authenticated Discord author context cannot be changed",
    );

    const counterTamperEnvelope = clone(envelope);
    counterTamperEnvelope.q++;
    const signedCounterTamper = await resignEnvelope(aliceIdentity, counterTamperEnvelope);
    await assert.rejects(
        decryptMessage(makeDecryptInput(signedCounterTamper, bobIdentity, BOB_ID, alicePublic)),
        isError,
        "the message counter is bound into the HPKE context and content AAD",
    );
    const senderKeyTamper = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => {
        value[3] = mutateBase64Url(value[3]);
    });
    await assert.rejects(
        decryptMessage(makeDecryptInput(senderKeyTamper, bobIdentity, BOB_ID, alicePublic)),
        /unverified sender key/,
        "the envelope cannot silently switch its trusted sender fingerprint",
    );

    assert.throws(() => decodeBase64Url(""), /Invalid base64url/);
    assert.throws(() => decodeBase64Url("AA=="), /Invalid base64url/);
    assert.throws(() => decodeBase64Url("not+base64"), /Invalid base64url/);
    assert.throws(() => decodeBase64Url("AA", 32), /Expected 32 decoded bytes/);
    const binaryFixture = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const encodedFixture = encodeBase64Url(binaryFixture);
    assert.doesNotMatch(encodedFixture, /[+/=]/u);
    assert.deepEqual(decodeBase64Url(encodedFixture), binaryFixture);

    assert.throws(() => parseKeyAnnouncement("ordinary message"), /Unsupported secure-message payload/);
    assert.throws(() => parseKeyAnnouncement(`${KEY_ANNOUNCEMENT_PREFIX}{`), /Malformed secure-message JSON/);
    assert.throws(
        () => parseKeyAnnouncement(`${KEY_ANNOUNCEMENT_PREFIX}${" ".repeat(MAX_DISCORD_MESSAGE_LENGTH)}`),
        /Unsupported secure-message payload/,
        "key payloads over Discord's wire limit are rejected before JSON parsing",
    );
    expectKeyParserFailure(null, "key payload root must be an object");
    expectKeyParserFailure([], "key payload root cannot be an array");
    expectKeyParserFailure({}, "key payload requires every exact field");

    const validKeyObject = rawPayload(aliceAnnouncement, KEY_ANNOUNCEMENT_PREFIX);
    const keyMutations: Array<[string, (value: MutableJson) => void]> = [
        ["missing key field", value => { delete value.z; }],
        ["extra key field", value => { value.extra = true; }],
        ["wrong key version", value => { value.v = 2; }],
        ["wrong key type", value => { value.t = "m"; }],
        ["short key user snowflake", value => { value.u = "123"; }],
        ["non-string key user", value => { value.u = 100000000000000001; }],
        ["timestamp below range", value => { value.d = 1_699_999_999_999; }],
        ["timestamp above range", value => { value.d = 10_000_000_000_000; }],
        ["fractional timestamp", value => { value.d = NOW + 0.5; }],
        ["short signing public key", value => { value.s = value.s.slice(1); }],
        ["invalid signing public key alphabet", value => { value.s = `!${value.s.slice(1)}`; }],
        ["short HPKE public key", value => { value.e = value.e.slice(1); }],
        ["invalid HPKE public key alphabet", value => { value.e = `!${value.e.slice(1)}`; }],
        ["short announcement signature", value => { value.z = value.z.slice(1); }],
        ["invalid announcement signature alphabet", value => { value.z = `!${value.z.slice(1)}`; }],
    ];
    for (const [label, mutate] of keyMutations) {
        const candidate = clone(validKeyObject);
        mutate(candidate);
        expectKeyParserFailure(candidate, label);
    }

    assert.throws(() => parseEncryptedEnvelope("ordinary message"), /Unsupported secure-message payload/);
    assert.throws(() => parseTestEnvelope(`${ENCRYPTED_MESSAGE_PREFIX}[`), /Malformed secure-message JSON/);
    assert.throws(
        () => parseEncryptedEnvelope(`${ENCRYPTED_MESSAGE_PREFIX}[]`),
        /requires valid Discord context/,
        "compact envelopes cannot be interpreted without authenticated Discord metadata",
    );
    assert.throws(
        () => parseEncryptedEnvelope(`${LEGACY_ENCRYPTED_MESSAGE_PREFIX}{`),
        /Malformed secure-message JSON/,
        "legacy envelope parsing remains supported",
    );
    assert.throws(
        () => parseTestEnvelope(`${ENCRYPTED_MESSAGE_PREFIX}${" ".repeat(MAX_DISCORD_MESSAGE_LENGTH)}`),
        /Unsupported secure-message payload/,
        "encrypted payloads over Discord's wire limit are rejected before JSON parsing",
    );
    expectEnvelopeParserFailure(null, "envelope root must be an array");
    expectEnvelopeParserFailure([], "envelope tuple requires every exact field");
    expectEnvelopeParserFailure({}, "envelope root cannot be an object");

    const validEnvelopeObject = rawPayload(encrypted, ENCRYPTED_MESSAGE_PREFIX);
    const envelopeMutations: Array<[string, (value: MutableJson) => void]> = [
        ["missing envelope field", value => { value.pop(); }],
        ["extra envelope field", value => { value.push(null); }],
        ["invalid compact envelope ID", value => { value[0] = "not-an-id"; }],
        ["timestamp below range", value => { value[1] = 1_699_999_999_999; }],
        ["fractional envelope timestamp", value => { value[1] = NOW + 0.5; }],
        ["zero counter", value => { value[2] = 0; }],
        ["fractional counter", value => { value[2] = 1.5; }],
        ["unsafe counter", value => { value[2] = Number.MAX_SAFE_INTEGER + 1; }],
        ["short sender fingerprint", value => { value[3] = value[3].slice(1); }],
        ["empty recipient list", value => { value[4] = []; }],
        ["non-array recipient list", value => { value[4] = {}; }],
        ["non-array recipient", value => { value[4][0] = null; }],
        ["missing recipient field", value => { value[4][0].pop(); }],
        ["extra recipient field", value => { value[4][0].push("extra"); }],
        ["invalid recipient snowflake", value => { value[4][0][0] = "recipient"; }],
        ["short HPKE encapsulation", value => { value[4][0][1] = value[4][0][1].slice(1); }],
        ["short wrapped key", value => { value[4][0][2] = "A".repeat(21); }],
        ["oversized wrapped key", value => { value[4][0][2] = "A".repeat(129); }],
        ["duplicate recipients", value => { value[4][1][0] = value[4][0][0]; }],
        ["unsorted recipients", value => { [value[4][0], value[4][1]] = [value[4][1], value[4][0]]; }],
        ["non-array mentioned-user list", value => { value[5] = {}; }],
        ["non-canonical mention syntax", value => { value[5][0] = `<@!${ALICE_ID}>`; }],
        ["duplicate mentioned users", value => { value[5].push(value[5][0]); }],
        ["unsorted mentioned users", value => { [value[5][0], value[5][1]] = [value[5][1], value[5][0]]; }],
        ["mentioned user outside recipients", value => { value[5][0] = `<@${MALLORY_ID}>`; }],
        ["short nonce", value => { value[6] = value[6].slice(1); }],
        ["short ciphertext", value => { value[7] = "A".repeat(21); }],
        ["short envelope signature", value => { value[8] = value[8].slice(1); }],
        ["invalid envelope signature alphabet", value => { value[8] = `!${value[8].slice(1)}`; }],
    ];
    for (const [label, mutate] of envelopeMutations) {
        const candidate = clone(validEnvelopeObject);
        mutate(candidate);
        expectEnvelopeParserFailure(candidate, label);
    }

    assert.equal(MAX_DISCORD_MESSAGE_LENGTH, 2_000);
    assert.equal(MAX_SELECTED_RECIPIENTS, 24);
    assert.throws(
        () => serializeKeyAnnouncement({ ...parseKeyAnnouncement(aliceAnnouncement), z: "A".repeat(MAX_DISCORD_MESSAGE_LENGTH) }),
        /exceeds Discord's message limit/,
    );
    assert.throws(
        () => serializeEncryptedEnvelope({ ...envelope, x: "A".repeat(MAX_DISCORD_MESSAGE_LENGTH) }),
        /2,000 character limit/,
    );
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "",
            recipients: [bobPublic],
            senderUserId: ALICE_ID,
            counter: 20,
        }),
        /1 to 2,000 characters/,
    );
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "x".repeat(2_001),
            recipients: [bobPublic],
            senderUserId: ALICE_ID,
            counter: 20,
        }),
        /1 to 2,000 characters/,
    );
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "x".repeat(2_000),
            recipients: [],
            senderUserId: ALICE_ID,
            counter: 20,
        }),
        /2,000 character limit/,
        "plaintext at the API ceiling still cannot produce an oversized Discord wire message",
    );
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "invalid counter",
            recipients: [bobPublic],
            senderUserId: ALICE_ID,
            counter: 0,
        }),
        /positive safe integer/,
    );
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "invalid ID",
            recipients: [bobPublic],
            senderUserId: ALICE_ID,
            counter: 20,
            messageId: "not-a-compact-id",
        }),
        /16-byte base64url/,
    );
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "invalid time",
            recipients: [bobPublic],
            senderUserId: ALICE_ID,
            counter: 20,
            now: 1,
        }),
        /protocol timestamp/,
    );
    await assert.rejects(generateIdentity(1), /creation time/);
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "invalid counter",
            recipients: [bobPublic],
            senderUserId: ALICE_ID,
            counter: Number.MAX_SAFE_INTEGER + 1,
        }),
        /positive safe integer/,
    );

    const tooManyRecipients = await Promise.all(Array.from(
        { length: MAX_SELECTED_RECIPIENTS + 1 },
        (_, index) => publicIdentity(bobIdentity, `400000000000000${String(index).padStart(3, "0")}`),
    ));
    await assert.rejects(
        encryptMessage({
            channelId: CHANNEL_ID,
            identity: aliceIdentity,
            plaintext: "too many recipients",
            recipients: tooManyRecipients,
            senderUserId: ALICE_ID,
            counter: 21,
        }),
        /recipient|message exceeds/i,
        "over-selection cannot produce an accepted wire envelope",
    );

    for (let iteration = 0; iteration < 96; iteration++) {
        const fragment = seededGarbage(0x5ec0_0000 + iteration, 1 + (iteration * 37) % 96);
        assert.throws(
            () => parseKeyAnnouncement(`${KEY_ANNOUNCEMENT_PREFIX}${fragment}`),
            isError,
            `key parser rejects deterministic malformed fuzz case ${iteration}`,
        );
        assert.throws(
            () => parseTestEnvelope(`${ENCRYPTED_MESSAGE_PREFIX}${fragment}`),
            isError,
            `envelope parser rejects deterministic malformed fuzz case ${iteration}`,
        );
    }

    for (let iteration = 0; iteration < 24; iteration++) {
        const offset = Math.floor(iteration * (aliceAnnouncement.length - 1) / 23);
        const mutated = `${aliceAnnouncement.slice(0, offset)}${aliceAnnouncement.slice(offset + 1)}`;
        await assert.rejects(
            verifyKeyAnnouncement(mutated, ALICE_ID),
            isError,
            `single-byte-deletion announcement fuzz case ${iteration} is rejected`,
        );
    }
    for (let iteration = 0; iteration < 32; iteration++) {
        const offset = Math.floor(iteration * (encrypted.length - 1) / 31);
        const mutated = `${encrypted.slice(0, offset)}${encrypted.slice(offset + 1)}`;
        await assert.rejects(
            decryptMessage(makeDecryptInput(mutated, bobIdentity, BOB_ID, alicePublic)),
            isError,
            `single-byte-deletion envelope fuzz case ${iteration} is rejected`,
        );
    }

    console.log(`secure-messaging cryptographic and protocol checks passed; compact wire saved ${envelopeBytesSaved} envelope, ${attachmentPayloadBytesSaved} attachment-descriptor, and ${richPayloadBytesSaved} sticker-descriptor characters`);
}

void main();
