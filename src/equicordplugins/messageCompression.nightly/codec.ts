/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { deflateSync, inflateSync } from "fflate";

export const COMPRESSED_MESSAGE_PREFIX = "PCMC1:";
export const MAX_DECOMPRESSED_BYTES = 64 * 1024;
export const MAX_WIRE_LENGTH = 2000;

const HEADER_BYTES = 9;
const MAX_NUMBERS = 16 * 1024;
const MAX_INTEGER = 0x7fffffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CODEC_NAMES = ["deflate", "repeat", "arithmetic", "quadratic", "line-template"] as const;

export interface CompressedMessage {
    content: string;
    codec: string;
    originalBytes: number;
    encodedBytes: number;
}

interface Candidate {
    id: number;
    payload: Uint8Array;
}

function invalid(): never {
    throw new Error("Invalid compressed message");
}

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function toBase64(bytes: Uint8Array): string {
    let result = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const value = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        result += BASE64[(value >>> 18) & 63] + BASE64[(value >>> 12) & 63];
        result += i + 1 < bytes.length ? BASE64[(value >>> 6) & 63] : "=";
        result += i + 2 < bytes.length ? BASE64[value & 63] : "=";
    }
    return result;
}

function fromBase64(value: string): Uint8Array {
    if (!value.length || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid();
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const result = new Uint8Array(value.length / 4 * 3 - padding);
    let offset = 0;
    for (let i = 0; i < value.length; i += 4) {
        const a = BASE64.indexOf(value[i]);
        const b = BASE64.indexOf(value[i + 1]);
        const c = value[i + 2] === "=" ? 0 : BASE64.indexOf(value[i + 2]);
        const d = value[i + 3] === "=" ? 0 : BASE64.indexOf(value[i + 3]);
        const n = (a << 18) | (b << 12) | (c << 6) | d;
        if (offset < result.length) result[offset++] = (n >>> 16) & 255;
        if (offset < result.length) result[offset++] = (n >>> 8) & 255;
        if (offset < result.length) result[offset++] = n & 255;
    }
    if (toBase64(result) !== value) invalid();
    return result;
}

class Writer {
    readonly data: number[] = [];

    uint(value: number): void {
        if (!Number.isSafeInteger(value) || value < 0) invalid();
        do {
            const next = value % 128;
            value = Math.floor(value / 128);
            this.data.push(next | (value ? 128 : 0));
        } while (value);
    }

    signed(value: number): void {
        this.uint(value >= 0 ? value * 2 : -value * 2 - 1);
    }

    bytes(value: Uint8Array): void {
        this.uint(value.length);
        for (const byte of value) this.data.push(byte);
    }

    finish(): Uint8Array {
        return Uint8Array.from(this.data);
    }
}

class Reader {
    offset = 0;

    constructor(readonly data: Uint8Array) { }

    uint(): number {
        let result = 0;
        let multiplier = 1;
        for (let i = 0; i < 8; i++) {
            if (this.offset >= this.data.length) invalid();
            const byte = this.data[this.offset++];
            result += (byte & 127) * multiplier;
            if (!Number.isSafeInteger(result)) invalid();
            if (!(byte & 128)) {
                if (i && byte === 0) invalid();
                return result;
            }
            multiplier *= 128;
        }
        return invalid();
    }

    signed(): number {
        const value = this.uint();
        return value % 2 ? -(value + 1) / 2 : value / 2;
    }

    bytes(): Uint8Array {
        const length = this.uint();
        if (length > this.data.length - this.offset) invalid();
        const result = this.data.subarray(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }

    end(): void {
        if (this.offset !== this.data.length) invalid();
    }
}

// Validate the complete raw DEFLATE stream independently of fflate. In particular,
// inflateSync accepts trailing bytes, and a bounded output buffer alone does not
// prove that the declared output length covers the entire compressed stream.
class Bits {
    position = 0;

    constructor(readonly bytes: Uint8Array) { }

    read(count: number): number {
        if (this.position + count > this.bytes.length * 8) invalid();
        let result = 0;
        for (let i = 0; i < count; i++, this.position++) {
            result |= ((this.bytes[this.position >>> 3] >>> (this.position & 7)) & 1) << i;
        }
        return result;
    }
}

interface Huffman {
    codes: Map<number, number>;
    max: number;
}

function huffman(lengths: number[]): Huffman {
    const counts = new Array<number>(16).fill(0);
    let max = 0;
    for (const length of lengths) {
        if (!Number.isInteger(length) || length < 0 || length > 15) invalid();
        if (length) counts[length]++;
        max = Math.max(max, length);
    }
    let available = 1;
    for (let bits = 1; bits <= 15; bits++) {
        available = available * 2 - counts[bits];
        if (available < 0) invalid();
    }
    const next = new Array<number>(16).fill(0);
    let code = 0;
    for (let bits = 1; bits <= 15; bits++) next[bits] = code = (code + counts[bits - 1]) * 2;
    const codes = new Map<number, number>();
    lengths.forEach((length, symbol) => {
        if (length) codes.set((1 << length) | next[length]++, symbol);
    });
    return { codes, max };
}

function symbol(bits: Bits, tree: Huffman): number {
    let code = 0;
    for (let length = 1; length <= tree.max; length++) {
        code = code * 2 + bits.read(1);
        const value = tree.codes.get((1 << length) | code);
        if (value !== undefined) return value;
    }
    return invalid();
}

const FIXED_LITERALS = huffman(Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8));
const FIXED_DISTANCES = huffman(new Array<number>(32).fill(5));
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const DYNAMIC_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function validateDeflate(bytes: Uint8Array, expected: number): void {
    const bits = new Bits(bytes);
    let produced = 0;
    let final = 0;
    do {
        final = bits.read(1);
        const type = bits.read(2);
        if (type === 0) {
            bits.position = Math.ceil(bits.position / 8) * 8;
            const length = bits.read(16);
            if ((length ^ bits.read(16)) !== 0xffff) invalid();
            if (bits.position + length * 8 > bytes.length * 8) invalid();
            bits.position += length * 8;
            produced += length;
            if (produced > expected) invalid();
            continue;
        }
        if (type === 3) invalid();
        let literals = FIXED_LITERALS;
        let distances = FIXED_DISTANCES;
        if (type === 2) {
            const literalCount = bits.read(5) + 257;
            const distanceCount = bits.read(5) + 1;
            const codeCount = bits.read(4) + 4;
            if (literalCount > 286) invalid();
            const codeLengths = new Array<number>(19).fill(0);
            for (let i = 0; i < codeCount; i++) codeLengths[DYNAMIC_ORDER[i]] = bits.read(3);
            const codeTree = huffman(codeLengths);
            const lengths: number[] = [];
            const total = literalCount + distanceCount;
            while (lengths.length < total) {
                const code = symbol(bits, codeTree);
                if (code < 16) lengths.push(code);
                else {
                    if (code === 16 && !lengths.length) invalid();
                    const count = code === 16 ? bits.read(2) + 3 : code === 17 ? bits.read(3) + 3 : bits.read(7) + 11;
                    const value = code === 16 ? lengths[lengths.length - 1] : 0;
                    if (lengths.length + count > total) invalid();
                    for (let i = 0; i < count; i++) lengths.push(value);
                }
            }
            if (!lengths[256]) invalid();
            literals = huffman(lengths.slice(0, literalCount));
            distances = huffman(lengths.slice(literalCount));
        }
        while (true) {
            const value = symbol(bits, literals);
            if (value === 256) break;
            if (value < 256) produced++;
            else {
                if (value > 285) invalid();
                const index = value - 257;
                const length = LENGTH_BASE[index] + bits.read(LENGTH_EXTRA[index]);
                const distanceCode = symbol(bits, distances);
                if (distanceCode > 29) invalid();
                const distance = DISTANCE_BASE[distanceCode] + bits.read(DISTANCE_EXTRA[distanceCode]);
                if (distance > produced) invalid();
                produced += length;
            }
            if (produced > expected) invalid();
        }
    } while (!final);
    if (produced !== expected || Math.ceil(bits.position / 8) !== bytes.length) invalid();
    while (bits.position < bytes.length * 8) if (bits.read(1)) invalid();
}

function repeatCandidate(bytes: Uint8Array): Candidate | null {
    if (bytes.length < 2) return null;
    const prefix = new Uint32Array(bytes.length);
    for (let i = 1; i < bytes.length; i++) {
        let j = prefix[i - 1];
        while (j && bytes[i] !== bytes[j]) j = prefix[j - 1];
        if (bytes[i] === bytes[j]) j++;
        prefix[i] = j;
    }
    const period = bytes.length - prefix[bytes.length - 1];
    return period < bytes.length && bytes.length % period === 0 ? { id: 1, payload: bytes.slice(0, period) } : null;
}

function numericCandidate(text: string): Candidate | null {
    const matches = Array.from(text.matchAll(/-?\d+/g));
    if (matches.length < 3 || matches.length > MAX_NUMBERS) return null;
    const values = matches.map(match => Number(match[0]));
    if (values.some((value, i) => !Number.isSafeInteger(value) || Math.abs(value) > MAX_INTEGER || String(value) !== matches[i][0])) return null;
    const prefix = text.slice(0, matches[0].index);
    const separator = text.slice(matches[0].index! + matches[0][0].length, matches[1].index);
    for (let i = 2; i < matches.length; i++) {
        if (text.slice(matches[i - 1].index! + matches[i - 1][0].length, matches[i].index) !== separator) return null;
    }
    const suffix = text.slice(matches[matches.length - 1].index! + matches[matches.length - 1][0].length);
    const step = values[1] - values[0];
    const second = values[2] - values[1] - step;
    let difference = step;
    for (let i = 1; i < values.length; i++) {
        if (values[i] - values[i - 1] !== difference) return null;
        difference += second;
    }
    if (second && values.length < 4) return null;
    const writer = new Writer();
    writer.uint(values.length);
    writer.signed(values[0]);
    writer.signed(step);
    if (second) writer.signed(second);
    writer.bytes(encoder.encode(prefix));
    writer.bytes(encoder.encode(separator));
    writer.bytes(encoder.encode(suffix));
    return { id: second ? 3 : 2, payload: writer.finish() };
}

function lineCandidate(text: string): Candidate | null {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    if (!text.includes(newline)) return null;
    const trailing = text.endsWith(newline);
    const lines = (trailing ? text.slice(0, -newline.length) : text).split(newline);
    if (lines.length < 3 || lines.length > 4096 || lines.some(line => /[\r\n]/.test(line))) return null;
    const rows = lines.map(line => encoder.encode(line));
    let prefixLength = Math.min(...rows.map(row => row.length));
    for (const row of rows.slice(1)) {
        let i = 0;
        while (i < prefixLength && row[i] === rows[0][i]) i++;
        prefixLength = i;
    }
    let suffixLength = Math.min(...rows.map(row => row.length - prefixLength));
    for (const row of rows.slice(1)) {
        let i = 0;
        while (i < suffixLength && row[row.length - i - 1] === rows[0][rows[0].length - i - 1]) i++;
        suffixLength = i;
    }
    if (prefixLength + suffixLength < 3) return null;
    const writer = new Writer();
    writer.uint(lines.length);
    writer.uint((newline === "\r\n" ? 2 : 0) | (trailing ? 1 : 0));
    writer.bytes(rows[0].subarray(0, prefixLength));
    writer.bytes(rows[0].subarray(rows[0].length - suffixLength));
    for (const row of rows) writer.bytes(row.subarray(prefixLength, row.length - suffixLength));
    return { id: 4, payload: writer.finish() };
}

function reconstruct(id: number, payload: Uint8Array, expected: number): Uint8Array {
    if (id === 0) {
        validateDeflate(payload, expected);
        const result = inflateSync(payload, { out: new Uint8Array(expected + 1) });
        if (result.length !== expected) invalid();
        return result;
    }
    const result = new Uint8Array(expected);
    let offset = 0;
    const append = (bytes: Uint8Array) => {
        if (bytes.length > expected - offset) invalid();
        result.set(bytes, offset);
        offset += bytes.length;
    };
    if (id === 1) {
        if (!payload.length || payload.length >= expected || expected % payload.length) invalid();
        while (offset < expected) append(payload);
    } else {
        const reader = new Reader(payload);
        const count = reader.uint();
        if (id === 2 || id === 3) {
            if (count < (id === 3 ? 4 : 3) || count > MAX_NUMBERS) invalid();
            let value = reader.signed();
            let step = reader.signed();
            const second = id === 3 ? reader.signed() : 0;
            const prefix = reader.bytes();
            const separator = reader.bytes();
            const suffix = reader.bytes();
            reader.end();
            if (prefix.length + suffix.length + separator.length * (count - 1) + count > expected) invalid();
            append(prefix);
            for (let i = 0; i < count; i++) {
                if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_INTEGER) invalid();
                if (i) append(separator);
                append(encoder.encode(String(value)));
                value += step;
                step += second;
            }
            append(suffix);
        } else if (id === 4) {
            if (count < 3 || count > 4096) invalid();
            const flags = reader.uint();
            if (flags > 3) invalid();
            const prefix = reader.bytes();
            const suffix = reader.bytes();
            const newline = flags & 2 ? Uint8Array.of(13, 10) : Uint8Array.of(10);
            if ((prefix.length + suffix.length) * count + newline.length * (count - 1 + (flags & 1)) > expected) invalid();
            for (let i = 0; i < count; i++) {
                if (i) append(newline);
                append(prefix);
                append(reader.bytes());
                append(suffix);
            }
            if (flags & 1) append(newline);
            reader.end();
        } else invalid();
    }
    if (offset !== expected) invalid();
    return result;
}

/** All recipes are self-contained; neither models nor conversation history are required. */
export function encodeCompressedMessage(text: string): CompressedMessage | null {
    if (!text.length || text.length > MAX_DECOMPRESSED_BYTES) return null;
    const original = encoder.encode(text);
    if (original.length > MAX_DECOMPRESSED_BYTES || decoder.decode(original) !== text) return null;
    const candidates: Candidate[] = [{ id: 0, payload: deflateSync(original, { level: 9 }) }];
    for (const candidate of [repeatCandidate(original), numericCandidate(text), lineCandidate(text)]) {
        if (candidate) candidates.push(candidate);
    }
    // Header and Base64 overhead are included, so an attractive recipe is never
    // selected merely because its unwrapped payload looks smaller.
    candidates.sort((a, b) => Math.ceil((HEADER_BYTES + a.payload.length) / 3) - Math.ceil((HEADER_BYTES + b.payload.length) / 3) || a.payload.length - b.payload.length || a.id - b.id);
    const candidate = candidates[0];
    const data = new Uint8Array(HEADER_BYTES + candidate.payload.length);
    const view = new DataView(data.buffer);
    data[0] = candidate.id;
    view.setUint32(1, original.length, true);
    view.setUint32(5, crc32(original), true);
    data.set(candidate.payload, HEADER_BYTES);
    const content = COMPRESSED_MESSAGE_PREFIX + toBase64(data);
    if (content.length > MAX_WIRE_LENGTH || content.length >= original.length || content.length >= text.length) return null;
    // Verify the entire selected packet, including framing and UTF-8, before use.
    if (decodeCompressedMessage(content) !== text) return null;
    return { content, codec: CODEC_NAMES[candidate.id], originalBytes: original.length, encodedBytes: content.length };
}

/** Invalid, oversized, unrelated, or corrupt input is deliberately treated as plain text. */
export function decodeCompressedMessage(content: string): string | null {
    if (!content.startsWith(COMPRESSED_MESSAGE_PREFIX) || content.length > MAX_WIRE_LENGTH) return null;
    try {
        const data = fromBase64(content.slice(COMPRESSED_MESSAGE_PREFIX.length));
        if (data.length <= HEADER_BYTES || data[0] >= CODEC_NAMES.length) invalid();
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const expected = view.getUint32(1, true);
        if (!expected || expected > MAX_DECOMPRESSED_BYTES) invalid();
        const bytes = reconstruct(data[0], data.subarray(HEADER_BYTES), expected);
        if (crc32(bytes) !== view.getUint32(5, true)) invalid();
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}
