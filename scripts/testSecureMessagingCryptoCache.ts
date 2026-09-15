/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import {
    clearCryptoCachesForTesting,
    decryptMessage,
    encryptMessage,
    fingerprintPublicKeys,
    generateIdentity,
    getCryptoCacheStatsForTesting,
    publicIdentity,
} from "../src/equicordplugins/secureMessaging.desktop/crypto";

const ALICE_ID = "100000000000000001";
const BOB_ID = "100000000000000002";
const CHANNEL_ID = "200000000000000001";
const NOW = 1_800_000_000_000;

async function main(): Promise<void> {
    const [aliceIdentity, bobIdentity, replacementIdentity] = await Promise.all([
        generateIdentity(NOW),
        generateIdentity(NOW + 1),
        generateIdentity(NOW + 2),
    ]);
    const [alicePublicIdentity, bobPublicIdentity] = await Promise.all([
        publicIdentity(aliceIdentity, ALICE_ID),
        publicIdentity(bobIdentity, BOB_ID),
    ]);

    clearCryptoCachesForTesting();
    const plaintext = `Cache regression <@${BOB_ID}> https://example.com/video.mp4`;
    const firstContent = await encryptMessage({
        channelId: CHANNEL_ID,
        counter: 1,
        identity: aliceIdentity,
        mentionedUserIds: [BOB_ID],
        now: NOW + 3,
        plaintext,
        recipients: [bobPublicIdentity],
        senderUserId: ALICE_ID,
    });
    const afterFirstEncrypt = getCryptoCacheStatsForTesting();
    assert.deepEqual(afterFirstEncrypt, {
        fingerprintDigests: 2,
        fingerprintEntries: 2,
        hpkePrivateKeyDeserializations: 0,
        hpkePublicKeyDeserializations: 2,
        hpkePublicKeyEntries: 2,
        signingPrivateKeyImports: 1,
        signingPublicKeyEntries: 0,
        signingPublicKeyImports: 0,
    });

    await encryptMessage({
        channelId: CHANNEL_ID,
        counter: 2,
        identity: aliceIdentity,
        mentionedUserIds: [BOB_ID],
        now: NOW + 4,
        plaintext,
        recipients: [bobPublicIdentity],
        senderUserId: ALICE_ID,
    });
    assert.deepEqual(getCryptoCacheStatsForTesting(), afterFirstEncrypt);

    const decryptInput = {
        channelId: CHANNEL_ID,
        content: firstContent,
        discordAuthorId: ALICE_ID,
        identity: bobIdentity,
        localUserId: BOB_ID,
        senderIdentity: alicePublicIdentity,
    };
    assert.equal((await decryptMessage(decryptInput)).plaintext, plaintext);
    const afterFirstDecrypt = getCryptoCacheStatsForTesting();
    assert.deepEqual(afterFirstDecrypt, {
        ...afterFirstEncrypt,
        hpkePrivateKeyDeserializations: 1,
        signingPublicKeyEntries: 1,
        signingPublicKeyImports: 1,
    });
    assert.equal((await decryptMessage(decryptInput)).plaintext, plaintext);
    assert.deepEqual(getCryptoCacheStatsForTesting(), afterFirstDecrypt);

    const originalPrivateKey = bobIdentity.hpkePrivateKey;
    bobIdentity.hpkePrivateKey = replacementIdentity.hpkePrivateKey;
    try {
        await assert.rejects(decryptMessage(decryptInput));
    } finally {
        bobIdentity.hpkePrivateKey = originalPrivateKey;
    }
    assert.equal(getCryptoCacheStatsForTesting().hpkePrivateKeyDeserializations, 2);

    clearCryptoCachesForTesting();
    for (let index = 0; index < 300; index++) {
        await fingerprintPublicKeys(
            (100000000000001000n + BigInt(index)).toString(),
            alicePublicIdentity.signingPublicKey,
            alicePublicIdentity.hpkePublicKey
        );
    }
    const boundedStats = getCryptoCacheStatsForTesting();
    assert.equal(boundedStats.fingerprintDigests, 300);
    assert.equal(boundedStats.fingerprintEntries, 256);

    process.stdout.write("Secure Messaging crypto cache tests passed.\n");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
