/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";

export function readHostInjector(data: Buffer): string {
    try {
        if (data.length < 16 || data.length > 128 * 1024 || data.readUInt32LE(0) !== 4) throw new Error();
        const headerSize = data.readUInt32LE(4);
        const jsonBytes = data.readUInt32LE(12);
        if (headerSize < 8 || headerSize % 4 || headerSize > data.length - 8
            || data.readUInt32LE(8) !== headerSize - 4 || !jsonBytes || jsonBytes > headerSize - 8) throw new Error();
        const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const { files } = JSON.parse(decode(data.subarray(16, 16 + jsonBytes)));
        if (!files || Object.keys(files).sort().join(",") !== "index.js,package.json") throw new Error();
        const read = (name: string) => {
            const entry = files[name];
            if (!entry || entry.unpacked || entry.link || typeof entry.offset !== "string" || !/^\d+$/u.test(entry.offset)
                || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error();
            const offset = Number(entry.offset);
            const start = 8 + headerSize + offset;
            if (!Number.isSafeInteger(offset) || start + entry.size > data.length) throw new Error();
            return decode(data.subarray(start, start + entry.size));
        };
        const manifest = JSON.parse(read("package.json"));
        if (manifest.name !== "discord" || manifest.main !== "index.js") throw new Error();
        return read("index.js");
    } catch {
        throw new Error("The packed Discord injector is not a supported Protonn Cord shim");
    }
}

export function createHostInjector(patcherPath: string): Buffer {
    const contents = [
        ["index.js", Buffer.from(`require(${JSON.stringify(patcherPath)})`)],
        ["package.json", Buffer.from('{\n\t"name": "discord",\n\t"main": "index.js"\n}')],
    ] as const;
    let offset = 0;
    const files = Object.fromEntries(contents.map(([name, data]) => {
        const entry = { size: data.length, offset: String(offset), integrity: {
            algorithm: "SHA256", hash: createHash("sha256").update(data).digest("hex"),
        } };
        offset += data.length;
        return [name, entry];
    }));
    const json = Buffer.from(JSON.stringify({ files }));
    const alignedSize = Math.ceil(json.length / 4) * 4;
    const header = Buffer.alloc(16 + alignedSize);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(8 + alignedSize, 4);
    header.writeUInt32LE(4 + alignedSize, 8);
    header.writeUInt32LE(json.length, 12);
    json.copy(header, 16);
    return Buffer.concat([header, ...contents.map(([, data]) => data)]);
}
