/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import {
    CAPABILITY_TTL_MS,
    CHALLENGE_TTL_MS,
    CompressionSession,
    CONTROL_MESSAGE_PREFIX,
    type PeerContext,
    PROBE_COOLDOWN_MS,
    RESPONSE_COOLDOWN_MS,
} from "../src/equicordplugins/messageCompression/session";

const alice: PeerContext = { channelId: "100", localId: "1", peerId: "2" };
const bob: PeerContext = { channelId: "100", localId: "2", peerId: "1" };

function rewrite(content: string, change: Record<string, unknown>): string {
    const frame = JSON.parse(content.split("\n")[0].slice(CONTROL_MESSAGE_PREFIX.length));
    return CONTROL_MESSAGE_PREFIX + JSON.stringify({ ...frame, ...change });
}

function hello(session: CompressionSession, peer = alice, now = 0): string {
    const content = session.prepareProbe(peer, now);
    assert(content, "an initial intentional send can prepare one probe");
    assert(content.length <= 2000, "controls fit an ordinary message");
    assert.match(content, /ProtonnCord/);
    return content;
}

function complete(a: CompressionSession, b: CompressionSession, now = 0) {
    const probe = hello(a, alice, now);
    const ack = b.handleControl(probe, bob, now + 1);
    assert(ack?.reply);
    assert.equal(ack.ready, false, "a hello alone never enables compressed sends");
    const confirm = a.handleControl(ack.reply, alice, now + 2);
    assert(confirm?.reply);
    assert.equal(confirm.ready, true, "a correct acknowledgement proves live decoder support");
    const ready = b.handleControl(confirm.reply, bob, now + 3);
    assert.equal(ready?.ready, true);
    assert.equal(ready?.reply, undefined, "confirmation does not cause a reply loop");
    return { probe, ack: ack.reply, confirm: confirm.reply };
}

function testNegotiationAndExpiry() {
    const a = new CompressionSession();
    const b = new CompressionSession();
    const exchange = complete(a, b);
    assert(a.isReady(alice, 4));
    assert(b.isReady(bob, 4));
    assert.equal(a.prepareProbe(alice, 4), null, "ready peers are not probed again");
    assert.equal(a.handleControl(exchange.ack, alice, 5)?.reply, undefined, "replayed acks do not loop");
    assert.equal(b.handleControl(exchange.confirm, bob, 5)?.reply, undefined);
    assert.equal(a.isReady(alice, CAPABILITY_TTL_MS + 2), false, "replay does not refresh capability expiry");
    assert.equal(b.isReady(bob, CAPABILITY_TTL_MS + 3), false);
    assert(a.prepareProbe(alice, CAPABILITY_TTL_MS + 4), "expired capabilities can be renegotiated");
}

function testUnsolicitedForgedAndForwardedControls() {
    const a = new CompressionSession();
    const b = new CompressionSession();
    const probe = hello(a);
    const ack = b.handleControl(probe, bob, 1)?.reply;
    assert(ack);
    assert.equal(new CompressionSession().handleControl(ack, alice, 2)?.ready, false, "an unsolicited ack cannot bootstrap readiness");
    assert.equal(a.handleControl(rewrite(ack, { replyTo: "0".repeat(32) }), alice, 2)?.ready, false);
    assert.equal(a.handleControl(ack, { ...alice, channelId: "101" }, 2), null, "a forwarded control cannot negotiate another channel");
    assert.equal(a.handleControl(ack, { ...alice, peerId: "3" }, 2), null, "the actual author must match the claimed sender");
    assert.equal(a.handleControl(rewrite(ack, { to: "3" }), alice, 2), null);
    assert.equal(a.handleControl(rewrite(ack, { from: "3" }), alice, 2), null);
    assert.equal(a.handleControl(rewrite(ack, { channel: "101" }), alice, 2), null);
    assert.equal(a.handleControl(rewrite(ack, { type: "confirm" }), alice, 2), null);
    assert.equal(a.isReady(alice, 2), false);
    assert.equal(a.handleControl(ack, alice, 3)?.ready, true, "invalid attempts leave the valid challenge usable");
}

function testTimeoutsCooldownAndFailedDelivery() {
    const a = new CompressionSession();
    const b = new CompressionSession();
    const probe = hello(a);
    assert.equal(a.isReady(alice, 1), false, "preparing a probe without delivering it grants nothing");
    assert.equal(a.prepareProbe(alice, PROBE_COOLDOWN_MS - 1), null, "stock clients receive no frequent probes");
    const ack = b.handleControl(probe, bob, 1)?.reply;
    assert(ack);
    assert.equal(b.isReady(bob, 2), false, "an undelivered acknowledgement grants the responder nothing");
    assert.equal(b.handleControl(probe, bob, 2)?.reply, undefined, "duplicate hellos are rate limited");
    assert.equal(b.handleControl(probe, bob, RESPONSE_COOLDOWN_MS)?.reply, undefined);
    assert(b.handleControl(probe, bob, RESPONSE_COOLDOWN_MS + 1)?.reply, "a later hello can receive a fresh challenge");
    assert.equal(a.handleControl(ack, alice, CHALLENGE_TTL_MS)?.ready, false, "expired outgoing nonces cannot enable compression");
    assert(a.prepareProbe(alice, PROBE_COOLDOWN_MS));

    const c = new CompressionSession();
    const d = new CompressionSession();
    const delayedAck = d.handleControl(hello(c), bob, 1)?.reply;
    assert(delayedAck);
    const delayedConfirm = c.handleControl(delayedAck, alice, 2)?.reply;
    assert(delayedConfirm);
    assert.equal(d.handleControl(delayedConfirm, bob, CHALLENGE_TTL_MS + 1)?.ready, false, "expired incoming nonces are rejected");
}

function testSimultaneousStarts() {
    const a = new CompressionSession();
    const b = new CompressionSession();
    const aHello = hello(a, alice);
    const bHello = hello(b, bob);
    const aAck = a.handleControl(bHello, alice, 1)?.reply;
    const bAck = b.handleControl(aHello, bob, 1)?.reply;
    assert(aAck && bAck);
    const aConfirm = a.handleControl(bAck, alice, 2)?.reply;
    const bConfirm = b.handleControl(aAck, bob, 2)?.reply;
    assert(aConfirm && bConfirm, "hello response throttling does not suppress necessary confirmations");
    assert.equal(a.handleControl(bConfirm, alice, 3)?.ready, true);
    assert.equal(b.handleControl(aConfirm, bob, 3)?.ready, true);
}

function testResetAndMalformedInput() {
    const a = new CompressionSession();
    const b = new CompressionSession();
    const exchange = complete(a, b);
    a.clear();
    assert.equal(a.isReady(alice, 4), false);
    assert.equal(a.handleControl(exchange.ack, alice, 4)?.ready, false, "stale acks cannot restore state after restart");
    assert.equal(a.handleControl(exchange.confirm, alice, 4), null);
    assert.equal(b.isReady({ ...bob, localId: "3" }, 4), false);
    assert.equal(b.isReady(bob, 5), false, "an account change clears the previous account's capabilities");
    for (const malformed of ["ordinary text", CONTROL_MESSAGE_PREFIX, CONTROL_MESSAGE_PREFIX + "null", CONTROL_MESSAGE_PREFIX + "[]", CONTROL_MESSAGE_PREFIX + "{", CONTROL_MESSAGE_PREFIX + "x".repeat(2001)]) {
        assert.equal(a.handleControl(malformed, alice, 6), null);
    }
    assert.equal(a.handleControl(rewrite(exchange.ack, { v: 2 }), alice, 6), null);
    assert.equal(a.handleControl(rewrite(exchange.ack, { nonce: "short" }), alice, 6), null);
    assert.equal(a.handleControl(rewrite(exchange.ack, { extra: true }), alice, 6), null);
    assert.equal(a.prepareProbe({ ...alice, peerId: alice.localId }, 6), null);
    assert.equal(a.prepareProbe(alice, Infinity), null);
}

function testBoundedMemory() {
    const a = new CompressionSession();
    const b = new CompressionSession();
    const firstAck = b.handleControl(hello(a), bob, 1)?.reply;
    assert(firstAck);
    for (let i = 0; i < 256; i++) {
        hello(a, { channelId: String(1000 + i), localId: alice.localId, peerId: String(2000 + i) }, i + 2);
    }
    assert.equal(a.handleControl(firstAck, alice, 300)?.ready, false, "old pending state is evicted when the peer bound is exceeded");
    assert.equal(a.isReady(alice, 301), false);
}

testNegotiationAndExpiry();
testUnsolicitedForgedAndForwardedControls();
testTimeoutsCooldownAndFailedDelivery();
testSimultaneousStarts();
testResetAndMalformedInput();
testBoundedMemory();
console.log("Message compression session tests passed.");
