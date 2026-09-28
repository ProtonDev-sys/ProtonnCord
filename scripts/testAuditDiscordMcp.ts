/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as policy from "../src/equicordplugins/discordMcp.desktop/policy";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function loadRenderer(native: object, common: object = {}) {
    const output = transpileModule(readFileSync("src/equicordplugins/discordMcp.desktop/index.ts", "utf8")
        + "\nexport { generateAttachmentWaveform, waveformCache, executeTool, handleBridgeRequest, bridgeLoop, inFlightRequests };", {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: false }
    }).outputText;
    const modules = {
        "./policy": policy,
        "@utils/types": { default: (value: unknown) => value },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack/common": common,
        "@plugins/voiceMessages/waveform": { generateWaveform: () => "waveform" },
        "../voiceMessageTranscriber.desktop/utils": { decodeAudio: async () => [] }
    };
    return runInNewContext(`${output}\nexports;`, {
        exports: {}, VencordNative: { pluginHelpers: { DiscordMCP: native } },
        Blob, Uint8Array, setTimeout, clearTimeout, AbortController,
        require: (name: string) => modules[name] ?? {}
    });
}

for (const resolved of [false, true]) {
    test(`Discord MCP evicted waveform failures preserve ${resolved ? "completed" : "pending"} replacements`, async () => {
        const requests: ReturnType<typeof deferred<any>>[] = [];
        const f = loadRenderer({ fetchDiscordAttachment() {
            const request = deferred<any>();
            requests.push(request);
            return request.promise;
        } });
        const attachment = { url: "fixture-original" };
        const old = f.generateAttachmentWaveform(attachment);
        const failed = assert.rejects(old, /old failure/);
        for (let i = 0; i < 25; i++) f.generateAttachmentWaveform({ url: `fixture-${i}` });
        const replacement = f.generateAttachmentWaveform(attachment);
        if (resolved) {
            requests.at(-1)!.resolve({ data: new Uint8Array(), contentType: "audio/ogg" });
            assert.equal(await replacement, "waveform");
        }
        requests[0].reject(new Error("old failure"));
        await failed;
        assert.equal(f.generateAttachmentWaveform({ url: "fixture-original" }), replacement);
        assert.equal(requests.length, 27);
        if (!resolved) requests.at(-1)!.resolve({ data: new Uint8Array(), contentType: "audio/ogg" });
        await replacement;
    });
}
