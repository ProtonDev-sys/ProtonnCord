/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
    decryptMessage,
    encryptMessage,
    generateIdentity,
    publicIdentity,
} from "../src/equicordplugins/secureMessaging.desktop/crypto";
import type {
    PrivateIdentity,
    PublicIdentity,
} from "../src/equicordplugins/secureMessaging.desktop/protocol";

const ALICE_ID = "100000000000000001";
const CHANNEL_ID = "200000000000000001";
const NOW = 1_800_000_000_000;
const MAX_RECIPIENTS = 24;
const PLAINTEXT = "Secure Messaging performance proof <@100000000000000002> https://example.com/video.mp4 natural encrypted text";

interface TimingSummary {
    iterations: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    totalMs: number;
}

function round(value: number): number {
    return Number(value.toFixed(3));
}

function percentile(sorted: number[], percentileValue: number): number {
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

async function measure(iterations: number, operation: () => Promise<void>): Promise<TimingSummary> {
    const samples: number[] = [];
    const totalStartedAt = performance.now();
    for (let index = 0; index < iterations; index++) {
        const startedAt = performance.now();
        await operation();
        samples.push(performance.now() - startedAt);
    }
    const totalMs = performance.now() - totalStartedAt;
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        iterations,
        meanMs: round(totalMs / iterations),
        p50Ms: round(percentile(sorted, 0.5)),
        p95Ms: round(percentile(sorted, 0.95)),
        totalMs: round(totalMs),
    };
}

function recipientId(index: number): string {
    return (100000000000000002n + BigInt(index)).toString();
}

async function createRecipients(): Promise<{
    identities: PrivateIdentity[];
    publicIdentities: PublicIdentity[];
}> {
    const identities = await Promise.all(Array.from(
        { length: MAX_RECIPIENTS },
        (_, index) => generateIdentity(NOW + index + 1),
    ));
    const publicIdentities = await Promise.all(identities.map((identity, index) =>
        publicIdentity(identity, recipientId(index)),
    ));
    return { identities, publicIdentities };
}

async function practicalRecipientCapacity(
    senderIdentity: PrivateIdentity,
    recipients: PublicIdentity[],
): Promise<number> {
    let capacity = 0;
    for (let recipientCount = 1; recipientCount <= recipients.length; recipientCount++) {
        try {
            await encryptMessage({
                channelId: CHANNEL_ID,
                counter: recipientCount,
                identity: senderIdentity,
                mentionedUserIds: [recipients[0].userId],
                now: NOW,
                plaintext: PLAINTEXT,
                recipients: recipients.slice(0, recipientCount),
                senderUserId: ALICE_ID,
            });
            capacity = recipientCount;
        } catch (error) {
            if (error instanceof Error && error.message.includes("exceeds Discord's 2,000 character limit")) break;
            throw error;
        }
    }
    return capacity;
}

async function benchmarkRecipientCount(
    senderIdentity: PrivateIdentity,
    senderPublicIdentity: PublicIdentity,
    recipientIdentities: PrivateIdentity[],
    recipients: PublicIdentity[],
): Promise<void> {
    const recipientCount = recipients.length;
    const encryptIterations = recipientCount === 1 ? 20 : recipientCount <= 8 ? 10 : 5;
    let counter = 100;
    const encrypt = async () => {
        await encryptMessage({
            channelId: CHANNEL_ID,
            counter: counter++,
            identity: senderIdentity,
            mentionedUserIds: [recipients[0].userId],
            now: NOW,
            plaintext: PLAINTEXT,
            recipients,
            senderUserId: ALICE_ID,
        });
    };
    await encrypt();
    await encrypt();
    const encryption = await measure(encryptIterations, encrypt);
    const content = await encryptMessage({
        channelId: CHANNEL_ID,
        counter: counter++,
        identity: senderIdentity,
        mentionedUserIds: [recipients[0].userId],
        now: NOW,
        plaintext: PLAINTEXT,
        recipients,
        senderUserId: ALICE_ID,
    });
    const decrypt = async () => {
        const result = await decryptMessage({
            channelId: CHANNEL_ID,
            content,
            discordAuthorId: ALICE_ID,
            identity: recipientIdentities[0],
            localUserId: recipients[0].userId,
            senderIdentity: senderPublicIdentity,
        });
        assert.equal(result.plaintext, PLAINTEXT);
    };
    await decrypt();
    await decrypt();
    const decryption = await measure(40, decrypt);
    process.stdout.write(`${JSON.stringify({
        benchmark: "secure-messaging-crypto",
        decryption,
        encryption,
        node: process.version,
        recipientCount,
    })}\n`);
}

async function main(): Promise<void> {
    const senderIdentity = await generateIdentity(NOW);
    const senderPublicIdentity = await publicIdentity(senderIdentity, ALICE_ID);
    const { identities, publicIdentities } = await createRecipients();
    const capacity = await practicalRecipientCapacity(senderIdentity, publicIdentities);
    assert.ok(capacity > 0);
    process.stdout.write(`${JSON.stringify({
        benchmark: "secure-messaging-capacity",
        configuredRecipientLimit: MAX_RECIPIENTS,
        node: process.version,
        practicalRecipientCapacity: capacity,
        plaintextLength: PLAINTEXT.length,
    })}\n`);
    const recipientCounts = [...new Set([1, Math.min(8, capacity), capacity])];
    for (const recipientCount of recipientCounts) {
        await benchmarkRecipientCount(
            senderIdentity,
            senderPublicIdentity,
            identities.slice(0, recipientCount),
            publicIdentities.slice(0, recipientCount),
        );
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
