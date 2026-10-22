/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ProtonnCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { decodeCompressedMessage, encodeCompressedMessage } from "../src/equicordplugins/messageCompression.nightly/codec";
import { messageCompressionSamples } from "./fixtures/messageCompressionSamples";

const encoder = new TextEncoder();
const results = messageCompressionSamples.map(({ name, text }) => {
    const encoded = encodeCompressedMessage(text);
    const transmitted = encoded?.content ?? text;
    assert.equal(encoded ? decodeCompressedMessage(transmitted) : transmitted, text, name);
    const originalBytes = encoder.encode(text).length;
    const transmittedBytes = encoder.encode(transmitted).length;
    return {
        sample: name,
        codec: encoded?.codec ?? "unchanged",
        originalBytes,
        transmittedBytes,
        savedBytes: originalBytes - transmittedBytes,
        savedPercent: Number((100 * (originalBytes - transmittedBytes) / originalBytes).toFixed(1)),
        originalCharacters: text.length,
        transmittedCharacters: transmitted.length,
        exactRoundTrip: true
    };
});

if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
else {
    console.log("Complete message-content UTF-8 bytes, including PCMC1 header and Base64.");
    console.log("Discord request metadata, transport framing and server storage are not measured.");
    console.table(results);
}
