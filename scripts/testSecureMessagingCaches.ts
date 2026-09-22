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
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";

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
    expand?: (selection: string, refreshIds?: readonly string[]) => Promise<DecryptIncomingAttachmentsResult>;
    review?: () => Promise<AnnouncementReviewResult>;
    unfurl?: (urls: string[]) => Promise<object>;
    convert?: (embed: Exports) => Exports | null;
} = {}) {
    let userId = localUserId;
    let decryptCalls = 0;
    let reviewCalls = 0;
    let unfurlCalls = 0;
    const retryDelays: number[] = [];
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
        "@utils/misc": { sleep: async (delay: number) => { retryDelays.push(delay); } },
        "@webpack": {
            findByCodeLazy: () => (_channelId: string, _messageId: string, embed: Exports) =>
                options.convert ? options.convert(embed) : embed,
        },
        "@webpack/common": {
            Constants: { Endpoints: { UNFURL_EMBED_URLS: "/test-only/unfurl" } },
            RestAPI: {
                async post({ body }: { body: { urls: string[]; }; }) {
                    unfurlCalls++;
                    return options.unfurl ? options.unfurl(body.urls) : { body: { embeds: [rawEmbed] } };
                },
            },
            UserStore: { getCurrentUser: () => ({ id: userId }) },
        },
        "./attachmentCache": {
            decryptIncomingAttachmentsCached: (_userId: string, _message: Message, selection: string, refreshIds?: readonly string[]) =>
                options.expand ? options.expand(selection, refreshIds) : Promise.resolve(expanded()),
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
        retryDelays,
        switchAccount: () => { userId = "100000000000000003"; },
    };
}

const noop = () => undefined;

for (const hasManifest of [false, true]) {
    test(`${hasManifest ? "manifest" : "legacy"} detached text limits refresh to ${hasManifest ? "the text file" : "the authenticated bundle"}`, async () => {
        const value = message({ attachments: [1, 2].map(index => ({
            id: `40000000000000000${index}`, filename: "encrypted.pcaf", size: 100, spoiler: false,
            url: `https://cdn.discordapp.com/attachments/300000000000000001/40000000000000000${index}/encrypted.pcaf?ex=1`,
            proxy_url: `https://media.discordapp.net/attachments/300000000000000001/40000000000000000${index}/encrypted.pcaf?ex=1`
        })) });
        let expansions = 0;
        const h = harness({
            decrypt: async () => ({
                ...decrypted(), detachedTextIndex: 1,
                attachmentBundle: {
                    id: "A".repeat(22), key: "A".repeat(43), root: "A".repeat(43), count: 2,
                    ...(hasManifest && { manifest: value.attachments.map(() => ({ digest: "A".repeat(43), preview: false, spoiler: false, size: 10, name: null })) })
                }
            }),
            expand: async (selection, refreshIds) => {
                expansions++;
                assert.equal(selection, "text");
                assert.deepEqual(refreshIds && Array.from(refreshIds), hasManifest ? [value.attachments[1].id] : undefined);
                return expanded();
            }
        });
        assert.equal((await h.decrypt.decryptCachedMessage(localUserId, value)).status, "decrypted");
        assert.equal(expansions, 1);
    });
}

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

test("a ready encrypted preview does not wait through another URL's 4250ms retry backoff", async () => {
    const slow = Promise.withResolvers<object>();
    const h = harness({
        decrypt: async () => ({ ...decrypted(), plaintext: `${previewUrl} https://example.com/slow`, stickers: [] }),
        unfurl: urls => urls[0] === previewUrl ? Promise.resolve({ body: { embeds: [rawEmbed] } }) : slow.promise,
    });
    const value = message();
    let notifications = 0;
    const onReady = () => { notifications++; h.embeds.patchEncryptedMessageEmbeds(value, onReady); };
    h.embeds.patchEncryptedMessageEmbeds(value, onReady);
    await setImmediate();
    assert.equal(h.embeds.patchEncryptedMessageEmbeds(value, onReady).embeds[0]?.url, previewUrl);
    assert.equal(h.embeds.encryptedMessageInlineEmbedStatus(value), "present");
    assert.equal(notifications, 1);
    slow.resolve({ body: { embeds: [] } });
    await setImmediate();
    assert.deepEqual(h.retryDelays, [250, 1_000, 3_000], "the slow URL retains its existing retry policy");
    assert.equal(h.calls().unfurl, 5);
    assert.equal(notifications, 2, "reentrant listeners still receive final completion");
    assert.equal(h.embeds.patchEncryptedMessageEmbeds(value, onReady).embeds.length, 1);
});

test("encrypted previews keep URL order when the first URL finishes last", async () => {
    const first = Promise.withResolvers<object>();
    const secondUrl = "https://example.com/second";
    const h = harness({
        decrypt: async () => ({ ...decrypted(), plaintext: `${previewUrl} ${secondUrl}`, stickers: [] }),
        unfurl: urls => urls[0] === previewUrl ? first.promise : Promise.resolve({ body: { embeds: [{ type: "image", url: secondUrl }] } }),
    });
    const value = message();
    assert.deepEqual((await render(h, value)).embeds.map(embed => embed.url), [secondUrl]);
    first.resolve({ body: { embeds: [rawEmbed] } });
    await setImmediate();
    assert.deepEqual(h.embeds.patchEncryptedMessageEmbeds(value, noop).embeds.map(embed => embed.url), [previewUrl, secondUrl]);
});

for (const change of ["clear", "account", "suppression", "edit", "retry"] as const) {
    test(`${change} invalidation prevents a late sibling preview from publishing`, async () => {
        const slow = Promise.withResolvers<object>();
        let conversions = 0;
        const h = harness({
            decrypt: async () => ({ ...decrypted(), plaintext: `${previewUrl} https://example.com/slow`, stickers: [] }),
            unfurl: urls => urls[0] === previewUrl ? Promise.resolve({ body: { embeds: [rawEmbed] } }) : slow.promise,
            convert: embed => { conversions++; return embed; },
        });
        const value = message();
        h.embeds.patchEncryptedMessageEmbeds(value, noop);
        await setImmediate();
        assert.equal(conversions, 1);
        if (change === "clear") h.embeds.clearEncryptedEmbedCache();
        if (change === "account") h.switchAccount();
        if (change === "suppression") value.flags = 4 as Message["flags"];
        if (change === "edit") value.nonce = "200000000000000003";
        if (change === "retry") h.embeds.invalidateEncryptedMessageEmbeds(value);
        slow.resolve({ body: { embeds: [rawEmbed] } });
        await setImmediate();
        assert.equal(conversions, 1, "a stale entry cannot convert or publish the late response");
    });
}

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

test("repeated embed and sticker renders retain one completion callback per owner", async () => {
    const source = readFileSync("src/equicordplugins/secureMessaging.desktop/index.tsx", "utf8");
    const parsed = createSourceFile("index.tsx", source, ScriptTarget.ES2022, true);
    const helper = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === "encryptedRenderCallback");
    assert.ok(helper);
    const compiled = transpileModule(helper.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const getCallback = runInThisContext(`(() => { const encryptedRenderCallbacks = new WeakMap(); ${compiled}; return encryptedRenderCallback; })()`) as (owner: { forceUpdate(): void; }) => () => void;
    assert.match(source, /patchEncryptedMessageEmbeds\(message, encryptedRenderCallback\(owner\), ready\)/);
    assert.match(source, /patchEncryptedMessageStickers\(message, encryptedRenderCallback\(owner\), ready\)/);
    const pending = Promise.withResolvers<DecryptIncomingResult>();
    const h = harness({ cachedDecrypt: () => pending.promise });
    const value = message();
    let notifications = 0;
    const owner = { forceUpdate() { notifications++; } };
    const otherOwner = { forceUpdate() { notifications++; } };
    for (let render = 0; render < 100; render++) {
        h.embeds.patchEncryptedMessageEmbeds(value, getCallback(owner));
        h.embeds.patchEncryptedMessageStickers(value, getCallback(owner));
    }
    h.embeds.patchEncryptedMessageEmbeds(value, getCallback(otherOwner));
    pending.resolve({ ...decrypted(), plaintext: "Plain authenticated text", stickers: [] });
    await setImmediate();
    assert.equal(notifications, 2, "notify each mounted renderer once, even after repeated renders");
    assert.equal(h.calls().unfurl, 0);
});

for (const failure of [
    { status: "failed", error: "cryptographic_operation_failed" },
    { status: "unavailable", reason: "security_key_locked" },
] satisfies DecryptIncomingResult[]) {
    test(`manual retry replaces ${failure.status} once and shares pending work across mounted copies`, async () => {
        const pending = Promise.withResolvers<DecryptIncomingResult>();
        let retry = false;
        const h = harness({ decrypt: () => retry ? pending.promise : Promise.resolve(failure) });
        const value = message();
        assert.equal((await h.decrypt.decryptCachedMessage(localUserId, value)).status, failure.status);
        assert.equal(h.calls().decrypt, 4);
        retry = true;
        h.decrypt.invalidateFailedDecryption(localUserId, value);
        const first = h.decrypt.decryptCachedMessage(localUserId, value);
        h.decrypt.invalidateFailedDecryption(localUserId, value);
        const duplicate = h.decrypt.decryptCachedMessage(localUserId, value);
        assert.equal(first, duplicate);
        pending.resolve(decrypted());
        assert.equal((await first).status, "decrypted");
        assert.equal(h.calls().decrypt, 5);
    });
}

for (const result of [decrypted(), { status: "untrusted_author" }, { status: "replay_detected" }, { status: "invalid_message" }] satisfies DecryptIncomingResult[]) {
    test(`manual retry cannot invalidate ${result.status} results`, async () => {
        const h = harness({ decrypt: async () => result });
        const value = message();
        const original = h.decrypt.decryptCachedMessage(localUserId, value);
        await original;
        h.decrypt.invalidateFailedDecryption(localUserId, value);
        assert.equal(h.decrypt.decryptCachedMessage(localUserId, value), original);
        assert.equal(h.calls().decrypt, 1);
    });
}

test("retrying a failed message refreshes its derived media before the transient TTL expires", async () => {
    let failed = true;
    const h = harness({ decrypt: async () => failed ? { status: "failed", error: "cryptographic_operation_failed" } : decrypted() });
    const value = message();
    assert.deepEqual((await render(h, value)).embeds, []);
    assert.equal(h.calls().decrypt, 4);
    failed = false;
    h.decrypt.invalidateFailedDecryption(localUserId, value);
    const retried = h.decrypt.decryptCachedMessage(localUserId, value);
    h.embeds.invalidateEncryptedMessageEmbeds(value);
    assert.equal((await render(h, value)).embeds.length, 1);
    assert.equal(h.embeds.patchEncryptedMessageStickers(value, noop).stickerItems[0]?.id, sticker.id);
    assert.equal((await retried).status, "decrypted");
    assert.equal(h.calls().decrypt, 5, "the message and derived previews share the retry");
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
