/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const { outputText } = transpileModule(readFileSync("src/api/DataStore/index.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});
const update = runInNewContext(`${outputText}\nexports.update;`, { exports: {} });

test("DataStore updates settle on read failure, abort, write failure, and commit", async () => {
    for (const outcome of ["read-error", "abort", "write-error", "updater-error", "commit"] as const) {
        const error = new Error(outcome);
        const request: { result: number; onsuccess?: () => void; } = { result: 4 };
        const transaction: { error: Error | null; onerror?: () => void; onabort?: () => void; oncomplete?: () => void; } = { error: null };
        const writes: number[] = [];
        let settled = false;
        let rejection: unknown;
        const pending = update("fixture", (value: number) => {
            if (outcome === "updater-error") throw error;
            return value + 1;
        }, async (_mode: string, callback: (store: object) => unknown) => callback({
            transaction,
            get: () => request,
            put(value: number) {
                if (outcome === "write-error") throw error;
                writes.push(value);
            }
        })).then(() => { settled = true; }, (reason: unknown) => { settled = true; rejection = reason; });

        if (outcome === "read-error" || outcome === "abort") {
            transaction.error = error;
            if (outcome === "abort") transaction.onabort?.();
            else transaction.onerror?.();
        } else {
            request.onsuccess?.();
            if (outcome === "commit") {
                await setImmediate();
                assert.equal(settled, false, "a successful put must wait for transaction commit");
            }
            transaction.oncomplete?.();
        }
        await setImmediate();
        assert.equal(settled, true, `${outcome} must settle the update promise`);
        await pending;
        assert.equal(rejection, outcome === "commit" ? undefined : error);
        assert.deepEqual(writes, outcome === "commit" ? [5] : []);
    }
});
