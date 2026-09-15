/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const sourcePath = "src/shared/SettingsStore.ts";
const baseline = execFileSync("git", ["show", `6c6222b1c:${sourcePath}`], { encoding: "utf8" });

function measure(source: string) {
    let allocations = 0;
    const CountingProxy = new Proxy(Proxy, {
        construct(target, args) {
            allocations++;
            return Reflect.construct(target, args);
        }
    });
    const compiled = transpileModule(source, {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
    }).outputText;
    const { SettingsStore } = runInNewContext(`${compiled}\nexports;`, { exports: {}, Proxy: CountingProxy });
    const data = JSON.parse(JSON.stringify({ plugins: { Fixture: { options: { value: 7 } } } }));
    const settings = new SettingsStore(data);
    let checksum = 0;
    const rounds = 7;
    const iterations = 100_000;
    const times: number[] = [];
    for (let round = 0; round < rounds; round++) {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) checksum += settings.store.plugins.Fixture.options.value;
        times.push(performance.now() - start);
    }
    assert.equal(checksum, rounds * iterations * 7);
    return { allocations, medianMs: times.sort((left, right) => left - right)[Math.floor(rounds / 2)], iterations };
}

const before = measure(baseline);
const after = measure(readFileSync(sourcePath, "utf8"));
assert.equal(after.allocations, 4, "one proxy per visited settings object, including cross-realm input");
assert.ok(before.allocations > after.allocations * 1000, "the benchmark must exercise repeated nested reads");
console.log(JSON.stringify({ before, after, allocationReductionPercent: 100 * (1 - after.allocations / before.allocations) }, null, 2));
