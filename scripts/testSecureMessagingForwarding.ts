/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseSecurePlaintext, serializeSecurePlaintext } from "../src/equicordplugins/secureMessaging.desktop/attachments";
import {
    composeSecureForwardText,
    parseSecureForwardText,
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
assert.equal(secureForwardEmbedText([
    { rawTitle: "Host card", rawDescription: "Host description", fields: [{ rawName: "Field", rawValue: "Value" }] },
]), "Host card\nHost description\nField\nValue");
assert.equal(secureForwardEmbedText([
    { images: [{ url: "https://example.com/first.png" }, { url: "https://example.com/second.png" }] },
    { images: [{ url: "https://example.com/selected.png" }] },
], [1]), "https://example.com/selected.png", "grouped images retain the selected host embed index");

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
const forwarded = {
    authorLabel: "A *sender*",
    timestampMs: 1_780_000_000_000,
    content: "source text @\u200bAlice\n\nhttps://example.com/watch?v=1",
};
assert.deepEqual(parseSecureForwardText(composed), forwarded);
assert.deepEqual(parseSecureForwardText(`My note\n\n${composed}`), { ...forwarded, note: "My note" });
assert.deepEqual(parseSecureForwardText("**Forwarded copy from File sender**"), {
    authorLabel: "File sender", timestampMs: null, content: "",
}, "file and sticker copies have forward metadata without body text");
for (const malformed of [
    "plain Forwarded copy from Alice",
    "**Forwarded copy from A *sender***",
    "**Forwarded copy from Alice**\nbody",
    "**Forwarded copy from Alice** • <t:8640000000001:f>",
    "**Forwarded copy from Alice** • <t:0:f>",
    `**Forwarded copy from ${"A".repeat(97)}**`,
    "\n\n**Forwarded copy from Alice**",
]) assert.equal(parseSecureForwardText(malformed), null);
const descriptor = { count: 1, id: "A".repeat(22), key: "A".repeat(43), root: "A".repeat(43) };
const forwardedSticker = { id: "749054660769218631", name: "Wave", formatType: 3 };
const decodedForward = parseSecurePlaintext(serializeSecurePlaintext(composed, descriptor, [forwardedSticker]));
assert.equal(decodedForward.text, composed, "the readable fallback remains intact for older clients");
assert.deepEqual(decodedForward.forward, forwarded);
assert.deepEqual(decodedForward.attachments, descriptor);
assert.deepEqual(decodedForward.stickers, [forwardedSticker]);
assert.equal(parseSecurePlaintext("ordinary secure text").forward, undefined);

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
assert.match(runtime, /find: '"Unable to find original channel for message"'/u);
assert.match(runtime, /if\(await \$self\.tryForward\(\$1,\$2,\$3\)\)return;/u);
assert.doesNotMatch(runtime, /replaceForwardExport|guardedSendForwards|waitFor\(/u,
    "the modal-private actions cannot be intercepted by searching webpack exports");
assert.match(runtime, /const selective = options\.onlyAttachmentIds !== undefined \|\| options\.onlyEmbedIndices !== undefined/u);
assert.match(runtime, /const attachmentSelection = selective \? rawAttachmentSelection \?\? new Set<string>\(\) : null/u);
assert.match(runtime, /const embedSelection = selective \? rawEmbedSelection \?\? \[\] : undefined/u);
assert.match(runtime, /secureForwardRoute\(source, destination\)/u);
assert.match(runtime, /await secureForward\(message, destinationChannelId, options\)/u);
assert.match(runtime, /await plugin\.sendEncryptedForward\(destinationChannelId/u);
assert.doesNotMatch(runtime, /message_reference:|messageReference:|alsoForwardToChannelId:/u,
    "secure forwarding must create a new encrypted message without a Discord source reference");
assert.doesNotMatch(runtime, /credentials:\s*["']include["']/u,
    "attachment downloads must not attach Discord renderer credentials");

console.log("Secure Messaging forwarding checks passed");
