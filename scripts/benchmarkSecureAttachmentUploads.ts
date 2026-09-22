/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { CloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as attachments from "../src/equicordplugins/secureMessaging.desktop/attachments";
import * as buffers from "../src/equicordplugins/secureMessaging.desktop/exactArrayBuffer";

// Run with: node --expose-gc --import tsx scripts/benchmarkSecureAttachmentUploads.ts
// Measures local encryption, hashing and File preparation; it performs no uploads.
// ArrayBuffer/RSS samples describe Node's allocation behavior, not a browser-wide
// memory guarantee. The copied-input comparison uses the previous framing path.
const source = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/attachmentUploads.ts", import.meta.url), "utf8");
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;

function prepareWith(copiedInput: boolean) {
    const exports = {} as typeof import("../src/equicordplugins/secureMessaging.desktop/attachmentUploads");
    const cryptoHelpers = {
        ...attachments,
        async encryptAttachmentBytes(input: Parameters<typeof attachments.encryptAttachmentBytes>[0]) {
            if (!copiedInput || !(input.data instanceof Blob)) return attachments.encryptAttachmentBytes(input);
            const data = new Uint8Array(await input.data.arrayBuffer());
            try {
                return await attachments.encryptAttachmentBytes({ ...input, data });
            } finally {
                data.fill(0);
            }
        },
    };
    runInNewContext(compiled, {
        exports, File, Uint8Array, ArrayBuffer,
        require(name: string) {
            if (name === "./attachments") return cryptoHelpers;
            if (name === "./exactArrayBuffer") return buffers;
            if (name === "@vencord/discord-types/enums") return { CloudUploadPlatform: { WEB: CloudUploadPlatform.WEB } };
            throw new Error(`Unexpected benchmark dependency: ${name}`);
        },
    });
    return exports.prepareEncryptedAttachments;
}

function upload(index: number, size: number): CloudUpload {
    const file = new File([new Uint8Array(size)], `file-${index}.bin`, { type: "application/octet-stream" });
    return {
        item: { file, platform: CloudUploadPlatform.WEB }, filename: file.name, status: "NOT_STARTED",
        isThumbnail: false, uploadedFilename: "", responseUrl: "", description: null, spoiler: false,
        setFilename(this: { filename: string; }, name: string) { this.filename = name; },
    } as unknown as CloudUpload;
}

function median(values: number[]) {
    return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

async function main() {
    const gc = globalThis.gc;
    assert.ok(gc, "Run node with --expose-gc to compare isolated preparation allocations");
    const modes = { copiedInput: prepareWith(true), fileInput: prepareWith(false) };
    const channelId = "200000000000000001";
    const senderId = "100000000000000001";
    for (const prepare of Object.values(modes)) await prepare([upload(0, 64 * 1024)], "", channelId, senderId);
    for (const [files, size] of [[1, 64 * 1024], [10, 2 * 1024 ** 2], [1, 64 * 1024 ** 2], [4, 16 * 1024 ** 2]]) {
        for (const [mode, prepare] of Object.entries(modes)) {
            const runs: Array<{ ms: number; buffers: number; rss: number; }> = [];
            for (let trial = 0; trial < 3; trial++) {
                gc();
                const uploads = Array.from({ length: files }, (_, index) => upload(index, size));
                gc();
                const before = process.memoryUsage();
                let peakBuffers = before.arrayBuffers;
                let peakRss = before.rss;
                const sample = () => {
                    const memory = process.memoryUsage();
                    peakBuffers = Math.max(peakBuffers, memory.arrayBuffers);
                    peakRss = Math.max(peakRss, memory.rss);
                };
                const timer = setInterval(sample, 1);
                const started = performance.now();
                try {
                    const result = await prepare(uploads, "", channelId, senderId);
                    sample();
                    runs.push({ ms: performance.now() - started, buffers: peakBuffers - before.arrayBuffers, rss: peakRss - before.rss });
                    assert.equal(result.files.length, files);
                    assert.equal(result.totalUploadBytes, result.files.reduce((total, file) => total + file.size, 0));
                    result.apply();
                    assert.ok(uploads.every(value => value.item.file.type === "application/octet-stream" && value.item.file.size > size));
                } finally {
                    clearInterval(timer);
                }
            }
            console.log(JSON.stringify({
                mode, files, fileMiB: size / 1024 ** 2,
                medianMs: +median(runs.map(run => run.ms)).toFixed(1),
                medianPeakArrayBuffersMiB: +(median(runs.map(run => run.buffers)) / 1024 ** 2).toFixed(1),
                medianPeakRssMiB: +(median(runs.map(run => run.rss)) / 1024 ** 2).toFixed(1),
            }));
        }
    }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
