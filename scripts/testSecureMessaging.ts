import assert from "node:assert/strict";

import {
    attachmentBundleRoot,
    decryptAttachmentBytes,
    encodedImageDimensions,
    encryptAttachmentBytes,
    generateAttachmentBundleMaterial,
    parseSecurePlaintext,
    serializeSecurePlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/attachments";
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
    isEncryptedMessage,
    isKeyAnnouncement,
    KEY_ANNOUNCEMENT_PREFIX,
    MAX_DISCORD_MESSAGE_LENGTH,
    MAX_SELECTED_RECIPIENTS,
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
    authorizeWirePayload,
    clearWirePayloadAuthorizations,
    consumeAttachmentUploadReservations,
    consumeWirePayloadAuthorization,
} from "../src/equicordplugins/secureMessaging.desktop/wireAuthorizations";
import { availableSelectedRecipientIds } from "../src/equicordplugins/secureMessaging.desktop/conversationSelection";
import { discordEditedTimestamp } from "../src/equicordplugins/secureMessaging.desktop/messageMetadata";
import { KeyReviewGate } from "../src/equicordplugins/secureMessaging.desktop/keyReviewGate";

const ALICE_ID = "100000000000000001";
const BOB_ID = "100000000000000002";
const CAROL_ID = "100000000000000003";
const MALLORY_ID = "100000000000000004";
const CHANNEL_ID = "200000000000000001";
const OTHER_CHANNEL_ID = "200000000000000002";
const NOW = 1_800_000_000_000;
const MESSAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
        () => parseEncryptedEnvelope(wirePayload(ENCRYPTED_MESSAGE_PREFIX, value)),
        isError,
        label,
    );
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

async function main(): Promise<void> {
    const reviewGate = new KeyReviewGate();
    reviewGate.begin(ALICE_ID, BOB_ID);
    reviewGate.fail(ALICE_ID, BOB_ID, "new-key-message");
    reviewGate.finish(ALICE_ID, BOB_ID);
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), true, "failed key review stays fail-closed");
    reviewGate.succeed(ALICE_ID, BOB_ID, "old-key-message");
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), true, "another successful history review cannot clear a different failure");
    reviewGate.succeed(CAROL_ID, BOB_ID, "new-key-message");
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), true, "another local account cannot clear this account's failure");
    reviewGate.succeed(ALICE_ID, BOB_ID, "new-key-message");
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), false, "only the exact failed review retry clears its gate");
    reviewGate.begin(ALICE_ID, BOB_ID);
    reviewGate.begin(ALICE_ID, BOB_ID);
    reviewGate.finish(ALICE_ID, BOB_ID);
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), true, "concurrent review count remains pending until all work finishes");
    reviewGate.finish(ALICE_ID, BOB_ID);
    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), false);

    assert.equal(discordEditedTimestamp({ edited_timestamp: "2026-01-01T00:00:00+00:00" }), "2026-01-01T00:00:00.000Z");
    assert.equal(discordEditedTimestamp({ editedTimestamp: new Date("2026-01-02T03:04:05.006Z") }), "2026-01-02T03:04:05.006Z");
    assert.equal(discordEditedTimestamp({ edited_timestamp: null, editedTimestamp: new Date() }), null, "raw null takes precedence");
    assert.equal(discordEditedTimestamp({ edited_timestamp: "not-a-timestamp" }), "not-a-timestamp", "invalid non-null metadata fails native validation instead of becoming unedited");

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
    clearWirePayloadAuthorizations();

    const pngHeader = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64");
    assert.deepEqual(encodedImageDimensions(pngHeader), { height: 1, width: 1 }, "PNG dimensions are preserved for native rendering");
    assert.equal(encodedImageDimensions(new Uint8Array([0, 1, 2, 3])), null, "non-images do not receive fabricated dimensions");

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
    });
    assert.deepEqual(parseSecurePlaintext("legacy message"), { text: "legacy message", attachments: null });
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

    const plaintext = "Hello Bob and Carol 👋 — こんにちは — café — null:\u0000 — astral: 𠜎";
    const encrypted = await encryptMessage({
        channelId: CHANNEL_ID,
        identity: aliceIdentity,
        plaintext,
        recipients: [carolPublic, bobPublic, alicePublic, bobPublic],
        senderUserId: ALICE_ID,
        now: NOW + 10,
        messageId: MESSAGE_ID,
        counter: 7,
    });
    const envelope = parseEncryptedEnvelope(encrypted);

    assert.equal(isEncryptedMessage(encrypted), true);
    assert.equal(isEncryptedMessage(`${ENCRYPTED_MESSAGE_PREFIX}not-json`), true, "prefix detection does not imply validity");
    assert.equal(isEncryptedMessage(null), false);
    assert.equal(serializeEncryptedEnvelope(envelope), encrypted);
    assert.ok(encrypted.length <= MAX_DISCORD_MESSAGE_LENGTH, "valid wire payloads fit Discord's message limit");
    assert.equal(envelope.k, alicePublic.fingerprint);
    assert.equal(envelope.q, 7);
    assert.equal(envelope.i, MESSAGE_ID);
    assert.deepEqual(
        envelope.r.map(recipient => recipient.u),
        [ALICE_ID, BOB_ID, CAROL_ID],
        "recipients are deduplicated, sorted, and always include the sender",
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
    assert.deepEqual(parseEncryptedEnvelope(selfOnly).r.map(recipient => recipient.u), [ALICE_ID]);
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
        messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        counter: 10,
    };
    const [randomizedOne, randomizedTwo] = await Promise.all([
        encryptMessage(deterministicInput),
        encryptMessage(deterministicInput),
    ]);
    const randomizedEnvelopeOne = parseEncryptedEnvelope(randomizedOne);
    const randomizedEnvelopeTwo = parseEncryptedEnvelope(randomizedTwo);
    assert.notEqual(randomizedOne, randomizedTwo, "identical logical inputs do not repeat a wire ciphertext");
    assert.notEqual(randomizedEnvelopeOne.n, randomizedEnvelopeTwo.n, "AES-GCM nonces are fresh");
    assert.notEqual(randomizedEnvelopeOne.x, randomizedEnvelopeTwo.x, "content ciphertexts are randomized");
    assert.notDeepEqual(randomizedEnvelopeOne.r, randomizedEnvelopeTwo.r, "HPKE encapsulations are randomized");

    const [generatedIdOne, generatedIdTwo] = await Promise.all([
        encryptMessage({ ...deterministicInput, messageId: undefined, counter: 11 }),
        encryptMessage({ ...deterministicInput, messageId: undefined, counter: 12 }),
    ]);
    assert.notEqual(
        parseEncryptedEnvelope(generatedIdOne).i,
        parseEncryptedEnvelope(generatedIdTwo).i,
        "generated envelope IDs are unique",
    );

    const badSignature = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => {
        value.z = mutateBase64Url(value.z);
    });
    await assert.rejects(
        decryptMessage(makeDecryptInput(badSignature, bobIdentity, BOB_ID, alicePublic)),
        /signature is invalid/,
        "envelope signature tampering is rejected",
    );
    const nonCanonicalEnvelopeSignature = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => {
        value.z = makeNonCanonicalBase64Url(value.z);
    });
    await assert.rejects(
        decryptMessage(makeDecryptInput(nonCanonicalEnvelopeSignature, bobIdentity, BOB_ID, alicePublic)),
        /invalid|canonical/i,
        "alternate base64url spellings cannot bypass wire replay hashes",
    );
    const duplicateEnvelopeChannel = encrypted.replace(
        `${ENCRYPTED_MESSAGE_PREFIX}{`,
        `${ENCRYPTED_MESSAGE_PREFIX}{\"c\":\"${OTHER_CHANNEL_ID}\",`,
    );
    assert.throws(
        () => parseEncryptedEnvelope(duplicateEnvelopeChannel),
        /canonical/i,
        "duplicate envelope JSON members are rejected",
    );

    const unsignedContentTamper = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => {
        value.x = mutateBase64Url(value.x);
    });
    await assert.rejects(
        decryptMessage(makeDecryptInput(unsignedContentTamper, bobIdentity, BOB_ID, alicePublic)),
        /signature is invalid/,
        "ciphertext is covered by the sender signature",
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
        /copied from another channel/,
        "a valid envelope cannot be copied to another Discord channel",
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
        /sender does not match its Discord author/,
        "the observed Discord author must match the signed sender",
    );
    const authorTamper = mutateWirePayload(encrypted, ENCRYPTED_MESSAGE_PREFIX, value => {
        value.s = BOB_ID;
    });
    await assert.rejects(
        decryptMessage(makeDecryptInput(authorTamper, bobIdentity, BOB_ID, alicePublic)),
        /sender does not match its Discord author/,
        "tampering the envelope sender is rejected before decryption",
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
        value.k = mutateBase64Url(value.k);
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
    assert.throws(() => parseEncryptedEnvelope(`${ENCRYPTED_MESSAGE_PREFIX}{`), /Malformed secure-message JSON/);
    assert.throws(
        () => parseEncryptedEnvelope(`${ENCRYPTED_MESSAGE_PREFIX}${" ".repeat(MAX_DISCORD_MESSAGE_LENGTH)}`),
        /Unsupported secure-message payload/,
        "encrypted payloads over Discord's wire limit are rejected before JSON parsing",
    );
    expectEnvelopeParserFailure(null, "envelope root must be an object");
    expectEnvelopeParserFailure([], "envelope root cannot be an array");
    expectEnvelopeParserFailure({}, "envelope requires every exact field");

    const validEnvelopeObject = rawPayload(encrypted, ENCRYPTED_MESSAGE_PREFIX);
    const envelopeMutations: Array<[string, (value: MutableJson) => void]> = [
        ["missing envelope field", value => { delete value.z; }],
        ["extra envelope field", value => { value.extra = true; }],
        ["wrong envelope version", value => { value.v = 2; }],
        ["wrong envelope type", value => { value.t = "k"; }],
        ["invalid envelope UUID", value => { value.i = "not-a-uuid"; }],
        ["invalid channel snowflake", value => { value.c = "channel"; }],
        ["invalid sender snowflake", value => { value.s = "sender"; }],
        ["timestamp below range", value => { value.d = 1_699_999_999_999; }],
        ["fractional envelope timestamp", value => { value.d = NOW + 0.5; }],
        ["zero counter", value => { value.q = 0; }],
        ["fractional counter", value => { value.q = 1.5; }],
        ["unsafe counter", value => { value.q = Number.MAX_SAFE_INTEGER + 1; }],
        ["short sender fingerprint", value => { value.k = value.k.slice(1); }],
        ["empty recipient list", value => { value.r = []; }],
        ["non-array recipient list", value => { value.r = {}; }],
        ["non-object recipient", value => { value.r[0] = null; }],
        ["missing recipient field", value => { delete value.r[0].x; }],
        ["extra recipient field", value => { value.r[0].extra = true; }],
        ["invalid recipient snowflake", value => { value.r[0].u = "recipient"; }],
        ["short HPKE encapsulation", value => { value.r[0].e = value.r[0].e.slice(1); }],
        ["short wrapped key", value => { value.r[0].x = "A".repeat(21); }],
        ["oversized wrapped key", value => { value.r[0].x = "A".repeat(129); }],
        ["duplicate recipients", value => { value.r[1].u = value.r[0].u; }],
        ["unsorted recipients", value => { [value.r[0], value.r[1]] = [value.r[1], value.r[0]]; }],
        ["short nonce", value => { value.n = value.n.slice(1); }],
        ["short ciphertext", value => { value.x = "A".repeat(21); }],
        ["short envelope signature", value => { value.z = value.z.slice(1); }],
        ["invalid envelope signature alphabet", value => { value.z = `!${value.z.slice(1)}`; }],
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
            messageId: "not-a-uuid",
        }),
        /UUID/,
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
            () => parseEncryptedEnvelope(`${ENCRYPTED_MESSAGE_PREFIX}${fragment}`),
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

    console.log("secure-messaging cryptographic and protocol checks passed");
}

void main();
