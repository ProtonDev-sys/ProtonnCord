import assert from "node:assert/strict";
import { test } from "node:test";

import { type AttachmentMetadata, encryptedAttachmentCiphertextSize, MAX_ATTACHMENT_CIPHERTEXT_BYTES } from "../src/equicordplugins/secureMessaging.desktop/attachments";
import { assertEncryptedUploadSizes, EncryptedAttachmentTotalLimitError, EncryptedAttachmentUploadLimitError } from "../src/equicordplugins/secureMessaging.desktop/attachmentUploads";
import { DiscordUploadLimitUnavailableError, encryptedUploadLimitsDescription, formatUploadBytes, readDiscordUploadLimit } from "../src/equicordplugins/secureMessaging.desktop/uploadLimits";

test("Discord's live allowance is preserved across tier/experiment changes, including 1 GiB", () => {
    const user = {};
    for (const limit of [10, 20, 25, 50, 500, 1024].map(mib => mib * 1024 * 1024)) {
        assert.equal(readDiscordUploadLimit(user, current => { assert.equal(current, user); return limit; }), limit);
    }
});

test("missing users, invalid values and changed host modules never become a guessed allowance", () => {
    for (const value of [undefined, null, "10485760", NaN, Infinity, -1, 0, 20, 21.5, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(() => readDiscordUploadLimit({}, () => value), DiscordUploadLimitUnavailableError);
    assert.throws(() => readDiscordUploadLimit(null, () => { assert.fail("no account"); }), DiscordUploadLimitUnavailableError);
    assert.throws(() => readDiscordUploadLimit({}, () => { throw new Error("missing module"); }), DiscordUploadLimitUnavailableError);
});

test("per-file Discord checks allow multiple files whose combined size exceeds that account allowance", () => {
    const limit = 20 * 1024 * 1024;
    assert.doesNotThrow(() => assertEncryptedUploadSizes([{ filename: "a", size: limit }, { filename: "b", size: limit }], limit));
    assert.throws(() => assertEncryptedUploadSizes([{ filename: "a", size: limit + 1 }], limit), error => {
        assert.ok(error instanceof EncryptedAttachmentUploadLimitError);
        assert.equal(error.limitSource, "discord");
        assert.equal(error.encryptedBytes, limit + 1);
        assert.match(error.message, /20,971,521 bytes/);
        return true;
    });
});

test("larger Discord allowances still enforce separately identified file and aggregate safety caps", () => {
    const cap = MAX_ATTACHMENT_CIPHERTEXT_BYTES;
    assert.doesNotThrow(() => assertEncryptedUploadSizes([{ filename: "a", size: cap }], 1024 * 1024 * 1024));
    assert.throws(() => assertEncryptedUploadSizes([{ filename: "a", size: cap + 1 }], 1024 * 1024 * 1024), error => {
        assert.ok(error instanceof EncryptedAttachmentUploadLimitError);
        assert.equal(error.limitSource, "secure-messaging");
        assert.match(error.message, /Secure Messaging's safety limit/);
        assert.doesNotMatch(error.message, /Discord allows/);
        return true;
    });
    assert.throws(() => assertEncryptedUploadSizes([{ filename: "a", size: cap / 2 }, { filename: "b", size: cap / 2 + 1 }], cap), EncryptedAttachmentTotalLimitError);
});

test("size planning includes UTF-8 private metadata and framing even beyond the local cap", () => {
    const metadata: AttachmentMetadata = { name: "private-α.bin", mimeType: "application/octet-stream", size: MAX_ATTACHMENT_CIPHERTEXT_BYTES - 20, spoiler: true, description: "α", width: null, height: null, duration: null, waveform: null };
    const size = encryptedAttachmentCiphertextSize(metadata);
    assert.ok(size > MAX_ATTACHMENT_CIPHERTEXT_BYTES);
    assert.throws(() => assertEncryptedUploadSizes([{ filename: metadata.name, size }], 1024 * 1024 * 1024), EncryptedAttachmentUploadLimitError);
});

test("the displayed allowance distinguishes Discord from the effective and total safety limits", () => {
    const description = encryptedUploadLimitsDescription(1024 * 1024 * 1024);
    assert.match(description, /Discord reports 1024.00 MiB/);
    assert.match(description, /Encrypted files can use up to 500.00 MiB/);
    assert.match(description, /500.00 MiB \(524,288,000 bytes\) total/);
    assert.match(description, /10 attachments/);
    assert.match(encryptedUploadLimitsDescription(null), /unavailable; file sends are blocked/);
    assert.notEqual(formatUploadBytes(20 * 1024 * 1024), formatUploadBytes(20 * 1024 * 1024 + 1));
});
