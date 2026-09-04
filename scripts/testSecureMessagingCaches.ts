/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInThisContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import type { Message } from "@vencord/discord-types";

import { discordEditedTimestamp, discordMessageNonce } from "../src/equicordplugins/secureMessaging.desktop/messageMetadata";
import type {
    AnnouncementReviewResult,
    DecryptIncomingAttachmentsResult,
    DecryptIncomingResult,
} from "../src/equicordplugins/secureMessaging.desktop/native";

type Exports = Record<string, unknown>;
type DecryptCache = typeof import("../src/equicordplugins/secureMessaging.desktop/decryptCache");
type EmbedCache = typeof import("../src/equicordplugins/secureMessaging.desktop/embedCache");
type ReviewCache = typeof import("../src/equicordplugins/secureMessaging.desktop/announcementReviewCache");

const localUserId = "100000000000000001";
const previewUrl = "https://example.com/preview";
const sticker = { id: "100000000000000010", name: "Wave", formatType: 1 };
const rawEmbed = { type: "image", url: previewUrl };
const decrypted = (): Extract<DecryptIncomingResult, { status: "decrypted"; }> => ({
    status: "decrypted",
    plaintext: previewUrl,
    detachedTextIndex: null,
    attachmentBundle: null,
    counter: 1,
    envelopeId: "test-envelope",
    stickers: [sticker],
});
const expanded = (): DecryptIncomingAttachmentsResult => ({ status: "decrypted", plaintext: previewUrl, attachments: [] });
const reviewed = (): AnnouncementReviewResult => ({
    status: "trusted",
    identity: { userId: localUserId, createdAt: 1, fingerprint: "A".repeat(43), formattedFingerprint: "AA" },
});

function message(overrides: Partial<Message> = {}): Message {
    return {
        id: "200000000000000001",
        channel_id: "300000000000000001",
        author: { id: "100000000000000002" },
        content: "PCEM3:fixture",
        nonce: "200000000000000002",
        flags: 0,
        attachments: [],
        embeds: [],
        stickerItems: [],
        ...overrides,
    } as Message;
}

function harness(options: {
    cachedDecrypt?: () => Promise<DecryptIncomingResult>;
    decrypt?: () => Promise<DecryptIncomingResult>;
    expand?: () => Promise<DecryptIncomingAttachmentsResult>;
    review?: () => Promise<AnnouncementReviewResult>;
    unfurl?: () => Promise<object>;
    convert?: (embed: Exports) => Exports | null;
} = {}) {
    let userId = localUserId;
    let decryptCalls = 0;
    let reviewCalls = 0;
    let unfurlCalls = 0;
    const modules = new Map<string, Exports>();
    const native = {
        async decryptIncoming() {
            decryptCalls++;
            return options.decrypt ? options.decrypt() : decrypted();
        },
        async reviewAnnouncement() {
            reviewCalls++;
            return options.review ? options.review() : reviewed();
        },
    };
    const mocks: Record<string, Exports> = {
        "@utils/misc": { sleep: async () => undefined },
        "@webpack": {
            findByCodeLazy: () => (_channelId: string, _messageId: string, embed: Exports) =>
                options.convert ? options.convert(embed) : embed,
        },
        "@webpack/common": {
            Constants: { Endpoints: { UNFURL_EMBED_URLS: "/test-only/unfurl" } },
            RestAPI: {
                async post() {
                    unfurlCalls++;
                    return options.unfurl ? options.unfurl() : { body: { embeds: [rawEmbed] } };
                },
            },
            UserStore: { getCurrentUser: () => ({ id: userId }) },
        },
        "./attachmentCache": {
            decryptIncomingAttachmentsCached: () => options.expand ? options.expand() : Promise.resolve(expanded()),
        },
        "./layoutStability": { preserveEncryptedMessageScroll: (_message: unknown, update: () => void) => update() },
        "./protocol": { isEncryptedMessage: (content: string) => content.startsWith("PCEM3:") },
    };
    function load(name: string): Exports {
        if (mocks[name]) return mocks[name];
        const existing = modules.get(name);
        if (existing) return existing;
        assert.match(name, /^\.\/[a-zA-Z]+$/u);
        const filename = resolve("src/equicordplugins/secureMessaging.desktop", `${name.slice(2)}.ts`);
        const { outputText } = transpileModule(readFileSync(filename, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
            fileName: filename,
        });
        const module = { exports: {} as Exports };
        modules.set(name, module.exports);
        const evaluate = runInThisContext(`(function(require,module,exports,VencordNative){${outputText}\n})`, { filename }) as (
            require: (specifier: string) => Exports,
            module: { exports: Exports; },
            exports: Exports,
            bridge: { pluginHelpers: { SecureMessaging: typeof native; }; },
        ) => void;
        evaluate(load, module, module.exports, { pluginHelpers: { SecureMessaging: native } });
        return module.exports;
    }
    const decryptCache = load("./decryptCache") as DecryptCache;
    if (options.cachedDecrypt) decryptCache.decryptCachedMessage = options.cachedDecrypt;
    return {
        embeds: load("./embedCache") as EmbedCache,
        decrypt: decryptCache,
        reviews: load("./announcementReviewCache") as ReviewCache,
        calls: () => ({ decrypt: decryptCalls, review: reviewCalls, unfurl: unfurlCalls }),
        switchAccount: () => { userId = "100000000000000003"; },
    };
}

const noop = () => undefined;

async function render(h: ReturnType<typeof harness>, value: Message): Promise<Message> {
    h.embeds.patchEncryptedMessageEmbeds(value, noop);
    await setImmediate();
    return h.embeds.patchEncryptedMessageEmbeds(value, noop);
}

test("message-level embed suppression prevents unfurl requests without hiding stickers", async () => {
    const h = harness();
    const value = message({ flags: 4 });
    assert.deepEqual((await render(h, value)).embeds, []);
    assert.equal(h.calls().unfurl, 0);
    assert.equal(h.embeds.encryptedMessageInlineEmbedStatus(value), "absent");
    assert.equal(h.embeds.patchEncryptedMessageStickers(value, noop).stickerItems[0]?.id, sticker.id);
});

test("suppression changes take effect without an edited timestamp and can be reversed", async () => {
    const h = harness();
    const value = message();
    assert.equal((await render(h, value)).embeds.length, 1);
    const suppressed = message({ flags: 4 });
    assert.deepEqual((await render(h, suppressed)).embeds, []);
    assert.equal((await render(h, value)).embeds.length, 1);
    assert.equal(h.calls().unfurl, 1);
});

for (const [label, changed] of [
    ["nonce", { nonce: "200000000000000003" }],
    ["attachment metadata", { attachments: [{ id: "400000000000000001", size: 32 }] }],
] as const) {
    test(`preview authentication is refreshed after changed ${label}`, async () => {
        const h = harness();
        await render(h, message());
        await render(h, message(changed as Partial<Message>));
        assert.equal(h.calls().decrypt, 2);
    });
}

test("clearing decryption results also invalidates derived preview entries", async () => {
    const h = harness();
    const value = message();
    await render(h, value);
    h.decrypt.clearEncryptedMessageDecryptCache();
    await render(h, value);
    assert.equal(h.calls().decrypt, 2);
});

test("an account change during decryption cannot request previews for the previous account", async () => {
    const pending = Promise.withResolvers<DecryptIncomingResult>();
    const h = harness({ decrypt: () => pending.promise });
    h.embeds.patchEncryptedMessageEmbeds(message(), noop);
    h.switchAccount();
    pending.resolve(decrypted());
    await setImmediate();
    assert.equal(h.calls().unfurl, 0);
});

test("cache clearing during decryption discards pending preview work", async () => {
    const pending = Promise.withResolvers<DecryptIncomingResult>();
    const h = harness({ decrypt: () => pending.promise });
    let notifications = 0;
    h.embeds.patchEncryptedMessageEmbeds(message(), () => { notifications++; });
    h.embeds.clearEncryptedEmbedCache();
    pending.resolve(decrypted());
    await setImmediate();
    assert.equal(h.calls().unfurl, 0);
    assert.equal(notifications, 0);
});

test("authenticated stickers render before a slow unfurl and reentrant listeners still receive completion", async () => {
    const pending = Promise.withResolvers<object>();
    const h = harness({ unfurl: () => pending.promise });
    const value = message();
    let notifications = 0;
    const onReady = () => {
        notifications++;
        h.embeds.patchEncryptedMessageEmbeds(value, onReady);
    };
    h.embeds.patchEncryptedMessageStickers(value, onReady);
    await setImmediate();
    assert.equal(h.embeds.patchEncryptedMessageStickers(value, onReady).stickerItems[0]?.id, sticker.id);
    assert.equal(h.embeds.encryptedMessageInlineEmbedStatus(value), "pending");
    pending.resolve({ body: { embeds: [rawEmbed] } });
    await setImmediate();
    assert.equal(h.embeds.encryptedMessageInlineEmbedStatus(value), "present");
    assert.equal(notifications, 2);
});

test("a rejected detached-text expansion does not poison the preview cache forever", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    let fail = true;
    const h = harness({
        decrypt: async () => ({ ...decrypted(), detachedTextIndex: 0 }),
        expand: async () => {
            if (fail) throw new Error("temporary expansion failure");
            return expanded();
        },
    });
    const value = message();
    assert.deepEqual((await render(h, value)).embeds, []);
    fail = false;
    t.mock.timers.tick(30_001);
    assert.equal((await render(h, value)).embeds.length, 1);
});

test("failed embed conversion retries sooner than a successful preview", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    let fail = true;
    const h = harness({ convert: embed => fail ? null : embed });
    const value = message();
    assert.deepEqual((await render(h, value)).embeds, []);
    fail = false;
    t.mock.timers.tick(30_001);
    assert.equal((await render(h, value)).embeds.length, 1);
});

test("concurrent preview consumers share decryption and unfurl work", async () => {
    const h = harness();
    const value = message();
    for (let index = 0; index < 20; index++) {
        h.embeds.patchEncryptedMessageEmbeds(value, noop);
        h.embeds.patchEncryptedMessageStickers(value, noop);
    }
    await setImmediate();
    assert.deepEqual(h.calls(), { decrypt: 1, review: 0, unfurl: 1 });
    assert.equal(h.embeds.patchEncryptedMessageEmbeds(value, noop).embeds.length, 1);
});

test("protected rendering and ordinary messages do not start decryption", async () => {
    const h = harness();
    const plain = message({ content: "ordinary message" });
    assert.equal(h.embeds.patchEncryptedMessageEmbeds(plain, noop), plain);
    assert.deepEqual(h.embeds.patchEncryptedMessageEmbeds(message(), noop, false).embeds, []);
    assert.deepEqual(h.embeds.patchEncryptedMessageStickers(message(), noop, false).stickerItems, []);
    await setImmediate();
    assert.deepEqual(h.calls(), { decrypt: 0, review: 0, unfurl: 0 });
});

test("a settled key review is reused until its TTL expires", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const h = harness();
    const value = message();
    const first = h.reviews.reviewAnnouncementCached(localUserId, value);
    assert.equal(h.reviews.reviewAnnouncementCached(localUserId, value), first);
    await first;
    t.mock.timers.tick(29_999);
    await h.reviews.reviewAnnouncementCached(localUserId, value);
    assert.equal(h.calls().review, 1);
    t.mock.timers.tick(1);
    await h.reviews.reviewAnnouncementCached(localUserId, value);
    assert.equal(h.calls().review, 2);
});

for (const outcome of ["resolve", "reject"] as const) {
    test(`cleared key reviews cancel a late ${outcome} without disturbing a replacement`, async () => {
        const pending = Promise.withResolvers<AnnouncementReviewResult>();
        let first = true;
        const h = harness({ review: () => {
            if (!first) return Promise.resolve(reviewed());
            first = false;
            return pending.promise;
        } });
        const value = message();
        const old = h.reviews.reviewAnnouncementCached(localUserId, value);
        h.reviews.clearAnnouncementReviewCache();
        const fresh = h.reviews.reviewAnnouncementCached(localUserId, value);
        if (outcome === "resolve") pending.resolve(reviewed());
        else pending.reject(new Error("late IPC failure"));
        assert.equal((await old).status, "failed");
        await fresh;
        assert.equal(h.reviews.reviewAnnouncementCached(localUserId, value), fresh);
        assert.equal(h.calls().review, 2);
    });
}

test("active review failures remain observable and allow retry", async () => {
    let fail = true;
    const h = harness({ review: async () => {
        if (fail) throw new Error("active IPC failure");
        return reviewed();
    } });
    await assert.rejects(h.reviews.reviewAnnouncementCached(localUserId, message()), /active IPC failure/u);
    fail = false;
    await h.reviews.reviewAnnouncementCached(localUserId, message());
    assert.equal(h.calls().review, 2);
});

for (const [label, value] of [
    ["invalid Date", new Date(NaN)],
    ["throwing date wrapper", { toISOString() { throw new RangeError("invalid date"); } }],
    ["null-returning date wrapper", { toISOString: () => null }],
    ["non-string date wrapper", { toISOString: () => 123 }],
] as const) {
    test(`${label} stays invalid instead of throwing or becoming unedited`, () => {
        assert.equal(discordEditedTimestamp({ editedTimestamp: value }), "invalid-edited-timestamp");
    });
}

test("a rejected cache promise receives a finite preview failure lifetime", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    let fail = true;
    const h = harness({ cachedDecrypt: async () => {
        if (fail) throw new Error("temporary cached decryption failure");
        return decrypted();
    } });
    const value = message();
    assert.deepEqual((await render(h, value)).embeds, []);
    fail = false;
    t.mock.timers.tick(30_001);
    assert.equal((await render(h, value)).embeds.length, 1);
});

test("a sticker-ready callback can invalidate the entry before any preview request", async () => {
    const h = harness();
    h.embeds.patchEncryptedMessageStickers(message(), () => h.embeds.clearEncryptedEmbedCache());
    await setImmediate();
    assert.equal(h.calls().unfurl, 0);
});

test("clearing during an unfurl prevents stale embeds from being published", async () => {
    const pending = Promise.withResolvers<object>();
    const h = harness({
        decrypt: async () => ({ ...decrypted(), stickers: [] }),
        unfurl: () => pending.promise,
    });
    let notifications = 0;
    const value = message();
    h.embeds.patchEncryptedMessageEmbeds(value, () => { notifications++; });
    await setImmediate();
    assert.equal(h.calls().unfurl, 1);
    h.embeds.clearEncryptedEmbedCache();
    pending.resolve({ body: { embeds: [rawEmbed] } });
    await setImmediate();
    assert.equal(notifications, 0);
    assert.equal(h.embeds.encryptedMessageInlineEmbedStatus(value), "pending");
});

for (const result of [
    { status: "untrusted_author" },
    { status: "replay_detected" },
    { status: "invalid_message" },
    { status: "failed", error: "cryptographic_operation_failed" },
    { status: "unavailable", reason: "security_key_locked" },
] satisfies DecryptIncomingResult[]) {
    test(`${result.status} cannot render stickers or request previews`, async () => {
        const h = harness({ decrypt: async () => result });
        const value = message();
        assert.deepEqual((await render(h, value)).embeds, []);
        assert.deepEqual(h.embeds.patchEncryptedMessageStickers(value, noop).stickerItems, []);
        assert.equal(h.calls().unfurl, 0);
    });
}

test("queued reviews are cancelled without invoking native code after invalidation", async () => {
    const pending = Promise.withResolvers<AnnouncementReviewResult>();
    const h = harness({ review: () => pending.promise });
    const work = Array.from({ length: 5 }, (_, index) => h.reviews.reviewAnnouncementCached(
        localUserId,
        message({ id: `20000000000000000${index}` }),
    ));
    assert.equal(h.calls().review, 4);
    h.reviews.clearAnnouncementReviewCache();
    pending.resolve(reviewed());
    for (const result of await Promise.all(work)) assert.equal(result.status, "failed");
    assert.equal(h.calls().review, 4);
});

test("valid timestamp normalization, raw-null precedence and nonce validation are preserved", () => {
    const value = "2026-09-04T12:34:56.000Z";
    assert.equal(discordEditedTimestamp({ editedTimestamp: new Date(value) }), value);
    assert.equal(discordEditedTimestamp({ edited_timestamp: "2026-09-04T13:34:56+01:00" }), value);
    assert.equal(discordEditedTimestamp({ edited_timestamp: null, editedTimestamp: new Date(NaN) }), null);
    assert.equal(discordEditedTimestamp({ editedTimestamp: "invalid" }), "invalid");
    assert.equal(discordMessageNonce({ nonce: "200000000000000001" }), "200000000000000001");
    assert.equal(discordMessageNonce({ nonce: "not-a-nonce" }), null);
});
