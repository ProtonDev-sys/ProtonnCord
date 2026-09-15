/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { sealMobilePairing } from "../src/equicordplugins/secureMessaging.desktop/mobilePairing";

const DESKTOP = "src/equicordplugins/secureMessaging.desktop/";
const MOBILE = "mobile/plugins/secure-messaging/js/";
const USER = "100000000000000001";
const PEER = "100000000000000002";
const CHANNEL = "100000000000000003";
const OTHER_PEER = "100000000000000004";
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = <T>(value: T): T => structuredClone(value);

function evaluate(source: string, globals: Record<string, unknown> = {}) {
    const code = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, { exports: {}, Uint8Array, Buffer, TextEncoder, TextDecoder, structuredClone, ...globals });
}
function functionFixture(path: string, name: string, globals: Record<string, unknown> = {}) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, name);
    return evaluate(`${fn.getText(source)}\nexports.fixture = ${name};`, globals).fixture;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function rendererEdit(originalCounter: number, nextCounter: number) {
    let encryptCalls = 0;
    const edit = functionFixture(DESKTOP + "index.tsx", "encryptEditedMessage", {
        screenCaptureProtectionStatus: "ready", isNativeFailure: () => false, hasSelectedKeyReviewBlock: () => false,
        MessageStore: { getMessage: () => ({ author: { id: USER }, content: "ciphertext", attachments: [] }) },
        isEncryptedMessage: () => true,
        decryptCachedMessage: async () => ({ status: "decrypted", counter: originalCounter, detachedTextIndex: null, attachmentBundle: null, stickers: [] }),
        encryptedMentionedUserIds: () => [], serializeSecurePlaintext: (text: string) => text,
        Native: { encryptOutgoing: async () => { encryptCalls++; return { status: "encrypted", counter: nextCounter, content: "new encrypted text" }; } },
        prefetchEncryptedMessageEmbeds: async () => {}
    });
    return { run: () => edit({ localUserId: USER, snapshot: { channelId: CHANNEL } }, { status: "enabled" }, "message", "edited text"), encryptCalls: () => encryptCalls };
}

test("desktop rejects the actual mobile counter range before allocating an edit counter", async () => {
    const mobileCounter = functionFixture(MOBILE + "crypto.ts", "mobileCounterStart", { randomSource: () => new Uint8Array(4) });
    const edit = rendererEdit(mobileCounter(), Date.now() * 1000);
    await assert.rejects(edit.run, /Mobile cannot be edited on desktop/);
    assert.equal(edit.encryptCalls(), 0);
});

test("desktop permits monotonic local edits and rejects older restored-installation counters", async () => {
    assert.equal(await rendererEdit(15, 16).run(), "new encrypted text");
    await assert.rejects(rendererEdit(15, 15).run, /cannot be edited safely/);
    await assert.rejects(rendererEdit(15, 14).run, /cannot be edited safely/);
});

test("phone pairing checks the account before native work and again before clipboard delivery", async () => {
    const path = DESKTOP + "index.tsx";
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    let handler: ts.ArrowFunction | undefined;
    function visit(node: ts.Node) {
        if (ts.isArrowFunction(node) && node.getText(source).includes("await Native.exportMobilePairing(context.localUserId)")) handler = node;
        ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(handler);
    let currentUser = OTHER_PEER;
    let calls = 0;
    const copied: string[] = [];
    const pending = deferred<{ status: string; token: string; }>();
    const action = evaluate(`exports.action = ${handler.getText(source)};`, {
        UserStore: { getCurrentUser: () => ({ id: currentUser }) }, context: { localUserId: USER },
        setBusy() {}, setError() {}, Native: { exportMobilePairing() { calls++; return pending.promise; } },
        isNativeFailure: () => false, copyToClipboard: (value: string) => copied.push(value), showToast() {}, Toasts: { Type: {} }
    }).action;
    await action();
    assert.equal(calls, 0);
    currentUser = USER;
    const operation = action();
    currentUser = OTHER_PEER;
    pending.resolve({ status: "ready", token: "PCMP1:synthetic-ciphertext" });
    await operation;
    assert.equal(calls, 1);
    assert.deepEqual(copied, []);
});

test("native phone snapshot keeps only verified ready conversations and emits ciphertext", async () => {
    const root = randomBytes(32);
    const fingerprint = randomBytes(32).toString("base64url");
    const trustedIdentity = { userId: PEER, fingerprint: "trusted" };
    const privateHistory = { hpkePrivateKey: "synthetic-private-history", signingPrivateKey: "synthetic-private-signing" };
    const readyConversation = { enabled: true, reviewRequired: null, participantUserIds: [PEER], selectedRecipients: [{ userId: PEER, fingerprint: "trusted" }] };
    const api = functionFixture(DESKTOP + "native.ts", "exportMobilePairing", {
        validateIpcCaller: () => null, validateLocalUserId: (value: string) => ({ ok: true, value }),
        runSerialized: async (operation: () => Promise<unknown>) => operation(), isOneKeySecurityKeyVaultActive: () => true,
        loadAccount: async () => ({ created: false, account: {
            identity: {}, trustedPeers: { [PEER]: { identity: trustedIdentity, keyChanged: false }, [OTHER_PEER]: { identity: { userId: OTHER_PEER }, keyChanged: true } },
            conversations: { [CHANNEL]: readyConversation, review: { ...readyConversation, reviewRequired: "changed" }, disabled: { ...readyConversation, enabled: false }, mismatched: { ...readyConversation, selectedRecipients: [{ userId: PEER, fingerprint: "wrong" }] } },
            identityHistory: { old: { identity: privateHistory, retiredAt: 1_800_000_000_000 } }, peerIdentityHistory: {},
            sendCounter: 42, replayCache: ["retained locally"]
        } }),
        publicIdentity: async () => ({ fingerprint: "current" }),
        createActiveOneKeyMobilePairing: (userId: string, value: unknown) => sealMobilePairing(root, fingerprint, userId, value)
    });
    const result = await api({}, USER);
    assert.equal(result.status, "ready");
    assert.doesNotMatch(result.token, /synthetic-private|retained locally/);
    const [, boundFingerprint, nonce, payload] = result.token.slice(6).split(".");
    const context = "ProtonnCord/SecureMessaging/mobile-pairing/v1";
    const key = Buffer.from(hkdfSync("sha256", root, Buffer.from(boundFingerprint, "base64url"), context, 32));
    const bytes = Buffer.from(payload, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
    decipher.setAAD(Buffer.from(JSON.stringify([context, USER, boundFingerprint])));
    decipher.setAuthTag(bytes.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
    try {
        const state = JSON.parse(plaintext.toString("utf8"));
        assert.deepEqual(Object.keys(state.trusted), [PEER]);
        assert.deepEqual(Object.keys(state.conversations), [CHANNEL]);
        assert.deepEqual(state.identityHistory[0].identity, privateHistory);
        assert.equal(state.sendCounter, undefined);
        assert.equal(state.replayCache, undefined);
    } finally { plaintext.fill(0); key.fill(0); root.fill(0); }
});

function mobileFixture() {
    const initial = {
        identity: { fingerprint: "current" }, counter: 2 ** 52 + 50,
        trusted: { [PEER]: { userId: PEER, fingerprint: "trusted" } }, pending: {},
        conversations: { [CHANNEL]: { members: [PEER], recipients: [PEER], needsReview: true } },
        identityHistory: [], peerIdentityHistory: {}, replay: []
    };
    const pairing: any = {
        currentFingerprint: "current", createdAt: Date.now(), trusted: clone(initial.trusted),
        conversations: { [CHANNEL]: { members: [PEER], recipients: [PEER] } },
        identityHistory: [], peerIdentityHistory: {}
    };
    const state = { saved: JSON.stringify({ version: 1, accounts: { [USER]: initial } }), fail: false, writes: 0 };
    const imports: Record<string, unknown> = {
        "@noble/ciphers/aes.js": { gcm: () => ({ encrypt: (value: Uint8Array) => Uint8Array.from(value), decrypt: (value: Uint8Array) => value }) },
        "./crypto": { publicIdentity: (identity: any) => identity, secureRandomBytes: (size: number) => new Uint8Array(size), mobileCounterStart: () => 2 ** 52 },
        "./oneKey": {}, "./mobilePairing": { openMobilePairing: () => clone(pairing) },
        "./identityBackup": { parseIdentity() {}, parsePublicIdentity() {} },
        "./protocol": {
            requireSnowflake: (value: string) => { assert.match(value, /^\d{17,20}$/); return value; },
            decode64: (value: string) => Buffer.from(value, "base64url"), encode64: (value: Uint8Array) => Buffer.from(value).toString("base64url"),
            utf8Bytes: (value: string) => new TextEncoder().encode(value), decodeUtf8: (value: Uint8Array) => new TextDecoder().decode(value)
        }
    };
    const Module = evaluate(readFileSync(MOBILE + "vaultState.ts", "utf8"), { require(name: string) { assert.ok(name in imports, name); return imports[name]; } });
    const backing = { read: async () => state.saved, write: async (value: string) => { state.writes++; if (state.fail) throw new Error("storage failure"); state.saved = value; } };
    const vault = new Module.MobileVault(backing);
    function unlockForPairing() { vault.root = new Uint8Array(32).fill(1); vault.rootFingerprint = Buffer.alloc(32, 1).toString("base64url"); }
    return { vault, pairing, state, backing, unlockForPairing };
}

test("pairing merges phone-only peer keys, keeps earliest shared cutoffs and preserves review latches", async () => {
    const f = mobileFixture(); await f.vault.load(); f.unlockForPairing();
    const account = f.vault.account(USER);
    account.peerIdentityHistory = {
        [PEER]: [{ identity: { fingerprint: "shared" }, retiredAt: 100 }, { identity: { fingerprint: "phone-only" }, retiredAt: 200 }],
        [OTHER_PEER]: [{ identity: { fingerprint: "other-phone-peer" }, retiredAt: 300 }]
    };
    f.pairing.peerIdentityHistory[PEER] = [{ identity: { fingerprint: "shared" }, retiredAt: 150 }, { identity: { fingerprint: "desktop-only" }, retiredAt: 400 }];
    const beforeCounter = account.counter;
    await f.vault.importPairing("synthetic", USER);
    const result = f.vault.account(USER);
    assert.deepEqual(Array.from(result.peerIdentityHistory[PEER], (entry: any) => [entry.identity.fingerprint, entry.retiredAt]), [["desktop-only", 400], ["phone-only", 200], ["shared", 100]]);
    assert.equal(result.peerIdentityHistory[OTHER_PEER][0].identity.fingerprint, "other-phone-peer");
    assert.equal(result.conversations[CHANNEL].needsReview, true);
    assert.equal(result.counter, beforeCounter);
    assert.deepEqual(Array.from(result.replay), []);
});

test("pairing keeps the existing four-key cap and rejects a merged contact history overflow without changing state", async () => {
    const f = mobileFixture(); await f.vault.load(); f.unlockForPairing();
    const account = f.vault.account(USER);
    account.peerIdentityHistory = { [PEER]: Array.from({ length: 4 }, (_, index) => ({ identity: { fingerprint: `phone-${index}` }, retiredAt: 100 + index })) };
    f.pairing.peerIdentityHistory[PEER] = [{ identity: { fingerprint: "newest" }, retiredAt: 500 }];
    await f.vault.importPairing("synthetic", USER);
    assert.deepEqual(Array.from(f.vault.account(USER).peerIdentityHistory[PEER], (entry: any) => entry.identity.fingerprint), ["newest", "phone-3", "phone-2", "phone-1"]);
    const current = f.vault.account(USER);
    current.peerIdentityHistory = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [String(200000000000000000n + BigInt(index)), []]));
    await assert.rejects(() => f.vault.importPairing("synthetic", USER), /history limit/);
    assert.equal(f.vault.account(USER), current);
});

test("pairing preserves absent phone contacts and leaves unchanged peer conversations ready", async () => {
    const f = mobileFixture(); await f.vault.load(); f.unlockForPairing();
    const account = f.vault.account(USER);
    account.conversations[CHANNEL].needsReview = false;
    account.trusted[OTHER_PEER] = { userId: OTHER_PEER, fingerprint: "phone-only-current" };
    account.conversations[OTHER_PEER] = { members: [OTHER_PEER], recipients: [OTHER_PEER] };
    await f.vault.importPairing("synthetic", USER);
    const merged = f.vault.account(USER);
    assert.equal(merged.trusted[PEER].fingerprint, "trusted");
    assert.equal(merged.trusted[OTHER_PEER].fingerprint, "phone-only-current");
    assert.equal(Boolean(merged.conversations[CHANNEL].needsReview), false);
    assert.equal(Boolean(merged.conversations[OTHER_PEER].needsReview), false);
    assert.equal(merged.peerIdentityHistory[PEER], undefined, "unchanged current keys are not retired");
});

test("a changed imported peer retires the displaced key and latches every affected conversation", async () => {
    for (const previousCutoff of [undefined, Date.now() - 5000]) {
        const f = mobileFixture(); await f.vault.load(); f.unlockForPairing();
        const account = f.vault.account(USER);
        account.trusted[PEER].fingerprint = "phone-current";
        account.conversations[CHANNEL].needsReview = false;
        account.conversations[OTHER_PEER] = { members: [PEER], recipients: [PEER] };
        if (previousCutoff !== undefined)
            account.peerIdentityHistory[PEER] = [{ identity: clone(account.trusted[PEER]), retiredAt: previousCutoff }];
        const beforeImport = Date.now();
        await f.vault.importPairing("synthetic", USER);
        const merged = f.vault.account(USER);
        assert.equal(merged.trusted[PEER].fingerprint, "trusted");
        assert.equal(merged.conversations[CHANNEL].needsReview, true);
        assert.equal(merged.conversations[OTHER_PEER].needsReview, true);
        const retired = merged.peerIdentityHistory[PEER].find((entry: any) => entry.identity.fingerprint === "phone-current");
        assert.ok(retired);
        if (previousCutoff !== undefined) assert.equal(retired.retiredAt, previousCutoff);
        else assert.ok(retired.retiredAt >= beforeImport && retired.retiredAt <= Date.now());
    }
});

test("merged contact and conversation caps reject before publishing state or writing storage", async () => {
    for (const kind of ["trusted", "conversations"]) {
        const f = mobileFixture(); await f.vault.load(); f.unlockForPairing();
        const account = f.vault.account(USER);
        account[kind] = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => {
            const id = String(300000000000000000n + BigInt(index));
            return [id, kind === "trusted" ? { userId: id, fingerprint: `phone-${index}` } : { members: [PEER], recipients: [PEER] }];
        }));
        const original = JSON.stringify(account);
        await assert.rejects(() => f.vault.importPairing("synthetic", USER), /contact limit|conversation limit/);
        assert.equal(f.vault.account(USER), account);
        assert.equal(JSON.stringify(account), original);
        assert.equal(f.state.writes, 0);
        assert.equal(f.vault.ready, true);
    }
});

test("failed pairing persistence retains displaced and absent current peers for explicit retry", async () => {
    const f = mobileFixture(); await f.vault.load(); f.unlockForPairing();
    const account = f.vault.account(USER);
    account.trusted[PEER].fingerprint = "phone-current";
    account.trusted[OTHER_PEER] = { userId: OTHER_PEER, fingerprint: "phone-only-current" };
    await f.vault.save();
    const stored = f.state.saved;
    const original = JSON.stringify(account);
    f.state.fail = true;
    await assert.rejects(() => f.vault.importPairing("synthetic", USER), /storage failure/);
    assert.equal(f.state.saved, stored);
    assert.equal(f.vault.ready, false);
    f.state.fail = false;
    await f.vault.save();
    assert.equal(f.vault.account(USER), account);
    assert.equal(JSON.stringify(account), original);
});

test("mobile retirement cutoffs match desktop for equality and adjacent timestamps", () => {
    const requireSnowflake = (id: string) => { assert.match(id, /^\d{17,20}$/); return id; };
    const mobile = evaluate(readFileSync(MOBILE + "history.ts", "utf8"), { require: () => ({ requireSnowflake }) });
    const desktop = functionFixture(DESKTOP + "native.ts", "predatesRetirement", { discordSnowflakeTimestamp: mobile.discordMessageTime });
    const cutoff = 1_800_000_000_000;
    const idAt = (time: number) => ((BigInt(time) - 1420070400000n) << 22n).toString();
    for (const [posted, signed, edited] of [[cutoff - 1, cutoff - 1, undefined], [cutoff, cutoff - 1, undefined], [cutoff - 1, cutoff, undefined], [cutoff - 1, cutoff - 1, cutoff], [cutoff - 1, cutoff - 1, cutoff - 1], [cutoff + 1, cutoff - 1, undefined]]) {
        const mobileResult = mobile.historicalMessageAllowed(idAt(posted!), signed, cutoff, edited);
        const desktopResult = desktop(idAt(posted!), edited === undefined ? null : new Date(edited).toISOString(), { d: signed }, cutoff);
        assert.equal(mobileResult, desktopResult);
    }
});

test("failed off/save cannot make a protected conversation fall through plaintext; reload recovers durable state", async () => {
    const f = mobileFixture(); await f.vault.load();
    const before = f.state.saved;
    delete f.vault.account(USER).conversations[CHANNEL];
    assert.equal(f.vault.protectedChannel(USER, CHANNEL), true, "live removal cannot bypass durable protection before save");
    f.state.fail = true;
    await assert.rejects(() => f.vault.save(), /storage failure/);
    assert.equal(f.state.saved, before);
    assert.equal(f.vault.ready, false);
    assert.throws(() => f.vault.protectedChannel(USER, CHANNEL), /could not be saved/);
    assert.throws(() => f.vault.account(USER), /could not be saved/);
    f.state.fail = false;
    await f.vault.load();
    assert.equal(f.vault.protectedChannel(USER, CHANNEL), true);
});

test("a pending off/save retains protection until the storage commit succeeds", async () => {
    const f = mobileFixture(); await f.vault.load();
    const committed = deferred<void>();
    f.backing.write = async (value: string) => { await committed.promise; f.state.saved = value; };
    delete f.vault.account(USER).conversations[CHANNEL];
    const saving = f.vault.save();
    await tick();
    assert.equal(f.vault.protectedChannel(USER, CHANNEL), true);
    committed.resolve();
    await saving;
    assert.equal(f.vault.protectedChannel(USER, CHANNEL), false);
});

test("an explicit successful save retry clears the failure latch after committing its state", async () => {
    const f = mobileFixture(); await f.vault.load();
    delete f.vault.account(USER).conversations[CHANNEL];
    f.state.fail = true;
    await assert.rejects(() => f.vault.save());
    f.state.fail = false;
    await f.vault.save();
    assert.equal(f.vault.ready, true);
    assert.equal(f.vault.protectedChannel(USER, CHANNEL), false);
    assert.equal(JSON.parse(f.state.saved).accounts[USER].conversations[CHANNEL], undefined);
});

test("an already queued successful save cannot clear a preceding failure latch", async () => {
    const f = mobileFixture(); await f.vault.load();
    const firstWrite = deferred<void>();
    let writes = 0;
    f.backing.write = async (value: string) => { if (++writes === 1) await firstWrite.promise; f.state.saved = value; };
    const first = f.vault.save();
    const second = f.vault.save();
    const rejectedFirst = assert.rejects(first, /first write failed/);
    const rejectedSecond = assert.rejects(second, /earlier vault save failed/);
    await tick();
    firstWrite.reject(new Error("first write failed"));
    await Promise.all([rejectedFirst, rejectedSecond]);
    assert.equal(f.vault.ready, false);
    assert.throws(() => f.vault.protectedChannel(USER, CHANNEL), /could not be saved/);
    await f.vault.save();
    assert.equal(f.vault.ready, true);
});

test("snapshot serialization failure also keeps live protection closed", async () => {
    const f = mobileFixture(); await f.vault.load();
    const account = f.vault.account(USER);
    account.fixture = 1n;
    delete account.conversations[CHANNEL];
    await assert.rejects(() => f.vault.save(), /BigInt/);
    assert.equal(f.state.writes, 0);
    assert.throws(() => f.vault.protectedChannel(USER, CHANNEL), /could not be saved/);
    delete account.fixture;
    await f.vault.save();
    assert.equal(f.vault.ready, true);
});
