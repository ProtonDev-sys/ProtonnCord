/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldHideSecureEmbedOnlyPlaintext } from "../src/equicordplugins/secureMessaging.desktop/embedUrls";
import {
    clearOptimisticOutgoingPlaintexts,
    getOptimisticOutgoingPlaintext,
    isProvisionalOutgoingMessage,
    optimisticOutgoingPlaintextCountForTest,
    rememberOptimisticOutgoingPlaintext,
    settleOptimisticOutgoingPlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/optimisticRendering";

const provisionalId = "1460000000000000000";
const canonicalId = "1460000000000000001";
const ciphertext = "PCEM3:optimistic-render-fixture";

clearOptimisticOutgoingPlaintexts();
rememberOptimisticOutgoingPlaintext(ciphertext, "visible immediately", 1_000);
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

rememberOptimisticOutgoingPlaintext(ciphertext, "expires", 5_000);
assert.equal(getOptimisticOutgoingPlaintext(ciphertext, 64_999), "expires");
assert.equal(getOptimisticOutgoingPlaintext(ciphertext, 65_000), undefined);

clearOptimisticOutgoingPlaintexts();
for (let index = 0; index < 160; index++)
    rememberOptimisticOutgoingPlaintext(`PCEM3:${index}`, String(index), 100_000 + index);
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
assert.match(renderer, /settleOptimisticOutgoingPlaintext\([\s\S]*discordMessageNonce\(message\)/u);
assert.doesNotMatch(renderer, /optimisticOutgoingPlaintexts\.delete/u,
    "render effects must not delete optimistic plaintext before checking the provisional nonce");

console.log("Secure Messaging optimistic rendering checks passed");
