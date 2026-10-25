// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyWindowsPayload } from "./windows-payload.mjs";

const payload = Buffer.from("validated desktop ASAR bytes");
function fixture() {
    const bytes = Buffer.alloc(1024);
    bytes.write("MZ"); bytes.writeUInt32LE(0x80, 0x3c);
    bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(240, 0x94);
    const optional = 0x98;
    bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(16, optional + 108);
    bytes.writeUInt32LE(0x2000, optional + 112 + 14 * 8); bytes.writeUInt32LE(72, optional + 112 + 14 * 8 + 4);
    const section = optional + 240;
    bytes.writeUInt32LE(0x2000, section + 12); bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(512, section + 20);
    bytes.writeUInt32LE(72, 512); bytes.writeUInt32LE(0x2050, 520); bytes.writeUInt32LE(16, 524);
    bytes.writeUInt32LE(0x2080, 536); bytes.writeUInt32LE(payload.length + 4, 540);
    bytes.writeUInt32LE(0x424a5342, 592);
    bytes.writeUInt32LE(payload.length, 640); payload.copy(bytes, 644);
    return bytes;
}

test("PE/CLR resource inspection binds the executable to the validated payload", () => {
    verifyWindowsPayload(fixture(), payload);
    assert.throws(() => verifyWindowsPayload(fixture(), Buffer.from("different ASAR")), /payload differs/u);
});

test("an MZ stub or malformed PE/CLR ranges cannot pass artifact validation", () => {
    assert.throws(() => verifyWindowsPayload(Buffer.from("MZ"), payload), /DOS header/u);
    for (const mutate of [
        bytes => bytes.writeUInt32LE(1020, 0x3c),
        bytes => bytes.writeUInt32LE(0, 0x80),
        bytes => bytes.writeUInt16LE(65535, 0x86),
        bytes => bytes.writeUInt32LE(0xffffff00, 536),
        bytes => bytes.writeUInt32LE(0, 592),
        bytes => bytes.writeUInt32LE(payload.length + 1, 640),
        bytes => { bytes[644] ^= 1; }
    ]) {
        const bytes = fixture(); mutate(bytes);
        assert.throws(() => verifyWindowsPayload(bytes, payload));
    }
});
