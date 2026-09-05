/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { crxToZip } from "../src/main/utils/crxToZip";
import { ensureSafePath } from "../src/main/utils/ensureSafePath";

const compile = (source: string) => transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText;

test("native settings accept objects and recover from invalid root values", () => {
    const source = readFileSync("src/main/settings.ts", "utf8");
    const code = source.slice(source.indexOf("function readSettings"), source.indexOf("export const RendererSettings"));
    for (const value of [null, [], 1, "text", { plugins: {} }]) {
        let logged = false;
        const readSettings = runInNewContext(`${compile(code)}\nreadSettings;`, {
            readFileSync: () => JSON.stringify(value), console: { error() { logged = true; } }
        });
        const result = readSettings("fixture", "unused.json");
        const valid = value !== null && typeof value === "object" && !Array.isArray(value);
        assert.equal(logged, !valid);
        assert.equal(JSON.stringify(result), JSON.stringify(valid ? value : {}));
    }
});

test("CRX wrappers preserve the ZIP payload for both supported versions", () => {
    const zip = Buffer.from([80, 75, 3, 4, 1, 2, 3]);
    assert.equal(crxToZip(zip), zip);
    for (const version of [2, 3]) {
        const header = Buffer.alloc(version === 2 ? 16 : 12);
        header.write("Cr24");
        header.writeUInt32LE(version, 4);
        header.writeUInt32LE(5, 8);
        if (version === 2) header.writeUInt32LE(3, 12);
        const prefix = Buffer.alloc(version === 2 ? 8 : 5);
        assert.deepEqual(crxToZip(Buffer.concat([header, prefix, zip])), zip);
    }
});

test("extension installation awaits loading and removes failed extraction before returning", async () => {
    const code = compile(readFileSync("src/main/utils/extensions.ts", "utf8"));
    const root = join(process.cwd(), "fixture-data");
    const expectedDirectory = join(root, "ExtensionCache", "fixture");
    for (const outcome of ["installed", "write-failed", "load-failed"] as const) {
        const events: string[] = [];
        const gate = Promise.withResolvers<void>();
        const error = new Error(outcome);
        const dependencies = {
            electron: { session: { defaultSession: { extensions: {
                async loadExtension(path: string) {
                    assert.equal(path, expectedDirectory);
                    events.push("load");
                    await gate.promise;
                    if (outcome === "load-failed") throw error;
                }
            } } } },
            fflate: { unzip(_data: Buffer, callback: (error: null, files: Record<string, Uint8Array>) => void) {
                callback(null, { "_metadata/ignored": new Uint8Array(), "nested/file.js": new Uint8Array(), "later.js": new Uint8Array() });
            } },
            fs: { constants: { F_OK: 0 } },
            "fs/promises": {
                async access() { throw new Error("Not cached"); },
                async mkdir() { },
                async writeFile(path: string) { events.push(path); if (outcome === "write-failed") throw error; },
                async rm(path: string) { assert.equal(path, expectedDirectory); events.push("cleanup"); }
            },
            path: { dirname, join }, "./constants": { DATA_DIR: root }, "./ensureSafePath": { ensureSafePath },
            "./crxToZip": { crxToZip: (data: Buffer) => data }, "./http": { fetchBuffer: async () => Buffer.alloc(0) }
        };
        const { installExt } = runInNewContext(`${code}\nexports;`, {
            exports: {}, process, require: (name: string) => {
                assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
                return dependencies[name];
            }
        });
        let settled = false;
        let rejection: unknown;
        const pending = installExt("fixture").then(() => { settled = true; }, (reason: unknown) => { settled = true; rejection = reason; });
        await setImmediate();
        if (outcome === "write-failed") {
            assert.equal(settled, true);
            assert.deepEqual(events, [join(expectedDirectory, "nested/file.js"), "cleanup"]);
        } else {
            assert.equal(settled, false, "installation must wait for Electron to finish loading");
            assert.deepEqual(events, [join(expectedDirectory, "nested/file.js"), join(expectedDirectory, "later.js"), "load"]);
        }
        gate.resolve();
        await pending;
        assert.equal(rejection, outcome === "installed" ? undefined : error);
    }
});
