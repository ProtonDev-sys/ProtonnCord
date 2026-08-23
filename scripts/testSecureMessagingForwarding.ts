/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    composeSecureForwardText,
    sanitizeForwardMentions,
    secureForwardEmbedText,
    secureForwardRoute,
    validatedDiscordAttachmentUrl,
} from "../src/equicordplugins/secureMessaging.desktop/forwarding";

const unprotected = { protected: false, ready: false } as const;
const protectedReady = { protected: true, ready: true } as const;
const protectedBlocked = { protected: true, ready: false, reason: "not ready" } as const;

assert.equal(secureForwardRoute(unprotected, unprotected), "native");
assert.equal(secureForwardRoute(unprotected, protectedReady), "secure");
assert.equal(secureForwardRoute(protectedReady, protectedReady), "secure");
assert.equal(secureForwardRoute(protectedReady, unprotected), "blocked");
assert.equal(secureForwardRoute(unprotected, protectedBlocked), "blocked");

const sanitized = sanitizeForwardMentions(
    "hello <@123456789012345678> <@&223456789012345678> <#323456789012345678> @everyone @here",
    {
        user: () => "Alice",
        role: () => "Moderators",
        channel: () => "general",
    },
);
assert.equal(sanitized.includes("<@"), false);
assert.equal(sanitized.includes("@everyone"), false);
assert.equal(sanitized.includes("@here"), false);
assert.match(sanitized, /@\u200bAlice/u);
assert.match(sanitized, /@\u200bModerators/u);
assert.match(sanitized, /#general/u);

const embedText = secureForwardEmbedText([
    { title: "ignored when a URL exists", url: "https://example.com/video" },
    { title: "Text card", description: "description" },
], [0]);
assert.equal(embedText, "https://example.com/video");

const composed = composeSecureForwardText({
    authorLabel: "A *sender*",
    content: "source text <@123456789012345678>",
    embeds: [{ video: { url: "https://example.com/watch?v=1" } }],
    mentionResolvers: { user: () => "Alice" },
    timestampMs: 1_780_000_000_000,
});
assert.ok(composed.includes("Forwarded copy from A \\*sender\\*"),
    "forward header must escape source-author markdown");
assert.match(composed, /source text @\u200bAlice/u);
assert.match(composed, /https:\/\/example\.com\/watch\?v=1/u);
assert.doesNotMatch(composed, /message_reference|messageReference/u);

assert.ok(validatedDiscordAttachmentUrl(
    "https://cdn.discordapp.com/attachments/123456789012345678/223456789012345678/file.png?ex=1",
    "123456789012345678",
    "223456789012345678",
));
assert.equal(validatedDiscordAttachmentUrl(
    "https://evil.example/attachments/123456789012345678/223456789012345678/file.png",
    "123456789012345678",
    "223456789012345678",
), null);
assert.equal(validatedDiscordAttachmentUrl(
    "https://cdn.discordapp.com/attachments/999456789012345678/223456789012345678/file.png",
    "123456789012345678",
    "223456789012345678",
), null);

const runtime = readFileSync(new URL(
    "../src/equicordplugins/secureMessagingForwarding.desktop/index.ts",
    import.meta.url,
), "utf8");
assert.match(runtime, /actions\.sendForward = guardedSendForward/u);
assert.match(runtime, /actions\.sendForwards = guardedSendForwards/u);
assert.match(runtime, /for \(const destinationChannelId of new Set\(destinationChannelIds\)\)/u);
assert.match(runtime, /const selective = options\.onlyAttachmentIds !== undefined \|\| options\.onlyEmbedIndices !== undefined/u);
assert.match(runtime, /const attachmentSelection = selective \? rawAttachmentSelection \?\? new Set<string>\(\) : null/u);
assert.match(runtime, /const embedSelection = selective \? rawEmbedSelection \?\? \[\] : undefined/u);
assert.match(runtime, /secureForwardRoute\(source, destination\)/u);
assert.match(runtime, /await secureForward\(message, destinationChannelId, options\)/u);
assert.match(runtime, /await sendMessage\(destinationChannelId/u);
assert.doesNotMatch(runtime, /message_reference|messageReference|alsoForwardToChannelId/u,
    "secure forwarding must create a new encrypted message without a Discord source reference");
assert.doesNotMatch(runtime, /credentials:\s*["']include["']/u,
    "attachment downloads must not attach Discord renderer credentials");

console.log("Secure Messaging forwarding checks passed");
