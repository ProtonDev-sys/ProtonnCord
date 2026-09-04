/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldHideSecureEmbedOnlyPlaintext } from "../src/equicordplugins/secureMessaging.desktop/embedUrls";
import { canGroupSecureMessageContent, SecureMessageGroup, secureMessageGroupFlags, type SecureMessageGroupCandidate } from "../src/equicordplugins/secureMessaging.desktop/messageGrouping";
import type { DecryptIncomingResult } from "../src/equicordplugins/secureMessaging.desktop/native";
import {
    clearOptimisticOutgoingPlaintexts,
    getOptimisticOutgoingPlaintext,
    getOptimisticOutgoingPlaintextForGrouping,
    isProvisionalOutgoingMessage,
    optimisticOutgoingPlaintextCountForTest,
    rememberOptimisticOutgoingPlaintext,
    settleOptimisticOutgoingPlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/optimisticRendering";

const provisionalId = "1460000000000000000";
const canonicalId = "1460000000000000001";
const ciphertext = "PCEM3:optimistic-render-fixture";

const authenticated: Extract<DecryptIncomingResult, { status: "decrypted"; }> = {
    status: "decrypted", plaintext: "visible immediately", attachmentBundle: null,
    stickers: [], detachedTextIndex: null, counter: 1, envelopeId: "fixture",
};
const previous: SecureMessageGroupCandidate = {
    id: "previous", author: { id: "local" }, content: "PCEM3:previous", timestamp: new Date(0),
    attachments: [], components: [], embeds: [], reactions: [], stickerItems: [],
};
const outgoing = { ...previous, id: provisionalId, content: ciphertext, timestamp: new Date(1_000) };
for (const id of [provisionalId, canonicalId]) {
    outgoing.id = id;
    const messages = [previous, outgoing];
    for (const result of [null, authenticated]) {
        const canJoin = () => canGroupSecureMessageContent(authenticated) &&
            canGroupSecureMessageContent(result, "visible immediately");
        assert.equal(secureMessageGroupFlags(previous, messages, canJoin), SecureMessageGroup.Next,
            "the preceding bubble stays joined before and after outgoing authentication");
        assert.equal(secureMessageGroupFlags(outgoing, messages, canJoin), SecureMessageGroup.Previous,
            "provisional and canonical outgoing bubbles keep the same joined shape");
    }
}
assert.equal(canGroupSecureMessageContent(null), false, "pending incoming messages stay separate");
assert.equal(canGroupSecureMessageContent(null, "https://example.com/image"), false);
assert.equal(canGroupSecureMessageContent({ status: "failed", error: "cryptographic_operation_failed" }, "visible"), false,
    "optimistic plaintext must never override a failed authentication");
assert.equal(canGroupSecureMessageContent({ ...authenticated, stickers: [{ id: "1", name: "Wave", formatType: 1 }] }), false);
assert.equal(canGroupSecureMessageContent({ ...authenticated, plaintext: "https://example.com/image" }), false);
assert.equal(secureMessageGroupFlags({ ...outgoing, attachments: [{}] }, [previous, { ...outgoing, attachments: [{}] }], () => true), 0,
    "optimistic attachment rows stay separate");

clearOptimisticOutgoingPlaintexts();
rememberOptimisticOutgoingPlaintext(ciphertext, "visible immediately", true, 1_000);
assert.equal(getOptimisticOutgoingPlaintextForGrouping(ciphertext, 1_001), "visible immediately");
assert.equal(getOptimisticOutgoingPlaintext(ciphertext, 1_001), "visible immediately");
assert.equal(isProvisionalOutgoingMessage(provisionalId, provisionalId), true);
settleOptimisticOutgoingPlaintext(ciphertext, provisionalId, provisionalId);
assert.equal(
    getOptimisticOutgoingPlaintext(ciphertext, 1_002),
    "visible immediately",
    "the provisional optimistic row must not consume the plaintext needed by the canonical row",
);

assert.equal(isProvisionalOutgoingMessage(canonicalId, provisionalId), false);
settleOptimisticOutgoingPlaintext(ciphertext, canonicalId, provisionalId);
assert.equal(
    getOptimisticOutgoingPlaintext(ciphertext, 1_003),
    undefined,
    "the canonical authenticated row must release optimistic plaintext",
);

rememberOptimisticOutgoingPlaintext(ciphertext, "expires", false, 5_000);
assert.equal(getOptimisticOutgoingPlaintextForGrouping(ciphertext, 5_001), undefined,
    "media and edits without authenticated metadata must not join optimistically");
assert.equal(getOptimisticOutgoingPlaintext(ciphertext, 64_999), "expires");
assert.equal(getOptimisticOutgoingPlaintext(ciphertext, 65_000), undefined);

clearOptimisticOutgoingPlaintexts();
for (let index = 0; index < 160; index++)
    rememberOptimisticOutgoingPlaintext(`PCEM3:${index}`, String(index), false, 100_000 + index);
assert.equal(optimisticOutgoingPlaintextCountForTest(100_200), 128,
    "optimistic plaintext retention must stay bounded");
assert.equal(getOptimisticOutgoingPlaintext("PCEM3:0", 100_200), undefined,
    "oldest entries must be evicted first");
assert.equal(getOptimisticOutgoingPlaintext("PCEM3:159", 100_200), "159");

assert.equal(shouldHideSecureEmbedOnlyPlaintext("https://example.com/video", "pending"), false,
    "a pending embed must keep its URL visible instead of creating an empty message row");
assert.equal(shouldHideSecureEmbedOnlyPlaintext("https://example.com/video", "present"), true);
assert.equal(shouldHideSecureEmbedOnlyPlaintext("https://example.com/video", "absent"), false);

const renderer = readFileSync(new URL(
    "../src/equicordplugins/secureMessaging.desktop/index.tsx",
    import.meta.url,
), "utf8");
assert.match(renderer, /getOptimisticOutgoingPlaintext\(message\.content\)/u);
assert.match(renderer, /const detectedGroupStart = nativeGroupStart \?\?/u,
    "Discord's explicit continuation flag takes precedence over DOM observations");
assert.match(renderer, /candidate\.id === message\.id && nativeGroupStart !== undefined\s*\? nativeGroupStart/u,
    "the current row uses either native grouping value before layout effects run");
assert.match(renderer, /settleOptimisticOutgoingPlaintext\([\s\S]*discordMessageNonce\(message\)/u);
assert.doesNotMatch(renderer, /optimisticOutgoingPlaintexts\.delete/u,
    "render effects must not delete optimistic plaintext before checking the provisional nonce");

console.log("Secure Messaging optimistic rendering checks passed");
