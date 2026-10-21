/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants, deflateRawSync } from "node:zlib";

import {
    COMPRESSED_MESSAGE_PREFIX,
    decodeCompressedMessage,
    encodeCompressedMessage,
    MAX_DECOMPRESSED_BYTES,
    MAX_WIRE_LENGTH,
} from "../src/equicordplugins/messageCompression/codec";

const HEADER_BYTES = 9;

function unpack(content: string): Buffer {
    assert.ok(content.startsWith(COMPRESSED_MESSAGE_PREFIX));
    return Buffer.from(content.slice(COMPRESSED_MESSAGE_PREFIX.length), "base64");
}

function pack(bytes: Uint8Array): string {
    return COMPRESSED_MESSAGE_PREFIX + Buffer.from(bytes).toString("base64");
}

function roundTrip(text: string, expectedCodec?: string) {
    const encoded = encodeCompressedMessage(text);
    assert.ok(encoded, `expected a useful encoding for ${text.slice(0, 60)}`);
    assert.equal(decodeCompressedMessage(encoded.content), text, "decoding must preserve every code point and whitespace character");
    assert.equal(encoded.originalBytes, Buffer.byteLength(text, "utf8"));
    assert.equal(encoded.encodedBytes, Buffer.byteLength(encoded.content, "utf8"), "savings must include the complete ASCII wire envelope");
    assert.ok(encoded.content.length <= MAX_WIRE_LENGTH);
    assert.ok(encoded.encodedBytes < encoded.originalBytes);
    assert.ok(encoded.content.length < text.length);
    assert.match(encoded.content, /^PCMC1:[A-Za-z0-9+/]+={0,2}$/);
    if (expectedCodec) assert.equal(encoded.codec, expectedCodec);
    assert.deepEqual(encodeCompressedMessage(text), encoded, "selection and serialization must be deterministic");
    return encoded;
}

function assertMalformed(content: string, reason: string) {
    assert.doesNotThrow(() => decodeCompressedMessage(content), reason);
    assert.equal(decodeCompressedMessage(content), null, reason);
}

function deterministicNoise(length: number): string {
    let state = 0x7138bc27;
    let text = "";
    for (let index = 0; index < length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        text += String.fromCharCode(32 + ((state >>> 0) % 95));
    }
    return text;
}

const repeat = roundTrip("a".repeat(4096), "repeat");
const arithmetic = roundTrip(`values: ${Array.from({ length: 500 }, (_, index) => index * 3 - 500).join(", ")}.`, "arithmetic");
const quadratic = roundTrip(`squares: ${Array.from({ length: 400 }, (_, index) => index * index - 7 * index + 3).join(" | ")}.`, "quadratic");
const unicode = roundTrip("\ufeffCafé e\u0301 中文 العربية 👩🏽‍💻 👨‍👩‍👧‍👦\0\r\n".repeat(60));
const narrative = roundTrip(Array.from({ length: 35 }, (_, index) => `The ${index % 3 ? "morning" : "evening"} conversation includes an exact sentence and entry ${index * 17}.`).join("\n"));
roundTrip(Array.from({ length: 60 }, (_, index) => `result[${index * index}]=${index % 5 ? "success" : "retry"};`).join("\r\n") + "\r\n");

for (const plain of ["", "hi", "a", "ordinary text", deterministicNoise(48)]) {
    assert.equal(encodeCompressedMessage(plain), null, "short or unhelpful encodings should keep ordinary sending");
    assert.equal(decodeCompressedMessage(plain), null);
}
assert.equal(encodeCompressedMessage(deterministicNoise(6000)), null, "a packet larger than the transport limit must not be offered");
assert.equal(encodeCompressedMessage("a".repeat(MAX_DECOMPRESSED_BYTES + 1)), null);
assert.equal(encodeCompressedMessage("😀".repeat(MAX_DECOMPRESSED_BYTES / 4 + 1)), null, "the decoded limit is measured in UTF-8 bytes");
assert.equal(encodeCompressedMessage("valid ".repeat(50) + "\ud800"), null, "a lone UTF-16 surrogate must not silently become a replacement character");
assert.equal(encodeCompressedMessage("\udc00" + "valid ".repeat(50)), null);
roundTrip("b".repeat(MAX_DECOMPRESSED_BYTES), "repeat");

for (const encoded of [repeat, arithmetic, quadratic, unicode, narrative]) {
    const bytes = unpack(encoded.content);
    assertMalformed(pack(bytes.subarray(0, bytes.length - 1)), "a truncated payload must be rejected");
    assertMalformed(pack(Buffer.concat([bytes, Buffer.from([0])])), "trailing payload bytes must be rejected");
    const checksum = Buffer.from(bytes);
    checksum[5] ^= 1;
    assertMalformed(pack(checksum), "corruption must not alter displayed text");
    const unknown = Buffer.from(bytes);
    unknown[0] = 255;
    assertMalformed(pack(unknown), "unknown codecs must be treated as ordinary text");
    const impossibleSize = Buffer.from(bytes);
    impossibleSize.writeUInt32LE(MAX_DECOMPRESSED_BYTES + 1, 1);
    assertMalformed(pack(impossibleSize), "declared expansion above the bound must be rejected before reconstruction");
}

// Validate real raw DEFLATE streams from Node's independent zlib implementation,
// including all three block families. Reuse only the already-verified checksum
// and output-length header; Node, not the production encoder, supplies the data.
const deflateSource = Array.from({ length: 30 }, (_, index) => `packet ${index}: ${"the exact original text ".repeat(index % 4 + 1)}`).join("\n");
const header = unpack(roundTrip(deflateSource).content).subarray(0, HEADER_BYTES);
for (const options of [{ level: 0 }, { level: 6, strategy: constants.Z_FIXED }, { level: 9 }]) {
    const bytes = Buffer.concat([header, deflateRawSync(Buffer.from(deflateSource), options)]);
    bytes[0] = 0;
    const wire = pack(bytes);
    if (wire.length > MAX_WIRE_LENGTH) {
        // Stored blocks are large by design; a shorter source is covered below.
        assertMalformed(wire, "even valid DEFLATE cannot exceed the wire limit");
        continue;
    }
    assert.equal(decodeCompressedMessage(wire), deflateSource, "accept independent stored/fixed/dynamic DEFLATE streams");
    assertMalformed(pack(Buffer.concat([bytes, Buffer.from([0])])), "DEFLATE trailing data must not be silently ignored");
    assertMalformed(pack(Buffer.concat([bytes, deflateRawSync(Buffer.from("extra"))])), "concatenated DEFLATE streams must be rejected");
    const tooSmall = Buffer.from(bytes);
    tooSmall.writeUInt32LE(8, 1);
    assertMalformed(pack(tooSmall), "the full expanded stream must fit the declaration, not just its prefix");
}

const storedText = "The stored-block test retains its complete text. ".repeat(8);
const storedHeader = unpack(roundTrip(storedText).content).subarray(0, HEADER_BYTES);
const storedPacket = Buffer.concat([storedHeader, deflateRawSync(Buffer.from(storedText), { level: 0 })]);
storedPacket[0] = 0;
assert.equal(decodeCompressedMessage(pack(storedPacket)), storedText, "accept a valid uncompressed DEFLATE block inside the envelope");

// A hand-built line recipe makes its decoder coverage independent of whether
// DEFLATE happens to win encoder selection on this particular test fixture.
const linePrefix = Buffer.from("a long shared record prefix: ");
const lineSuffix = Buffer.from(" :a long shared record suffix");
const fields = [Buffer.from("alpha"), Buffer.from("beta"), Buffer.from("gamma")];
const lineText = fields.map(field => linePrefix.toString() + field.toString() + lineSuffix.toString()).join("\r\n") + "\r\n";
const lineHeader = unpack(roundTrip(lineText).content).subarray(0, HEADER_BYTES);
const linePayload = Buffer.concat([
    Buffer.from([3, 3, linePrefix.length]), linePrefix,
    Buffer.from([lineSuffix.length]), lineSuffix,
    ...fields.flatMap(field => [Buffer.from([field.length]), field]),
]);
const linePacket = Buffer.concat([lineHeader, linePayload]);
linePacket[0] = 4;
assert.equal(decodeCompressedMessage(pack(linePacket)), lineText, "decode a self-contained line template including its trailing CRLF");
assertMalformed(pack(Buffer.concat([linePacket, Buffer.from([0])])), "line recipes cannot hide trailing bytes");
const badFlags = Buffer.from(linePacket);
badFlags[HEADER_BYTES + 1] = 4;
assertMalformed(pack(badFlags), "line recipe flags are bounded");
const numericBytes = unpack(arithmetic.content);
const hugeCount = Buffer.concat([numericBytes.subarray(0, HEADER_BYTES), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])]);
assertMalformed(pack(hugeCount), "a malicious recipe count cannot cause unbounded iteration");

const bomb = Buffer.concat([unpack(repeat.content).subarray(0, HEADER_BYTES), deflateRawSync(Buffer.alloc(MAX_DECOMPRESSED_BYTES * 4, 97))]);
bomb[0] = 0;
assertMalformed(pack(bomb), "reject a small stream that expands far beyond its declared output");
for (const malformed of [
    COMPRESSED_MESSAGE_PREFIX,
    COMPRESSED_MESSAGE_PREFIX + "!!!!",
    COMPRESSED_MESSAGE_PREFIX + "AAAA=",
    COMPRESSED_MESSAGE_PREFIX + "A".repeat(MAX_WIRE_LENGTH),
    repeat.content + "\n",
    pack(Buffer.alloc(HEADER_BYTES)),
    "PCMC2:" + repeat.content.slice(COMPRESSED_MESSAGE_PREFIX.length),
]) assertMalformed(malformed, "malformed, oversized and unsupported framing must fail closed");

// Noncanonical padding carries no information and must not create alternative
// wire spellings that evade cache/corruption checks.
const padded = [repeat, arithmetic, quadratic, unicode, narrative].find(value => value.content.endsWith("="));
assert.ok(padded);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const padding = padded.content.endsWith("==") ? 2 : 1;
const lastData = padded.content.length - padding - 1;
const changedPadding = padded.content.slice(0, lastData)
    + alphabet[alphabet.indexOf(padded.content[lastData]) | 1]
    + padded.content.slice(lastData + 1);
assertMalformed(changedPadding, "unused Base64 padding bits must be canonical");

console.log("MessageCompression exact codec, bounds and malformed-input regressions passed.");
