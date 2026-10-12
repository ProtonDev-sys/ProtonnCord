/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createPatchTimingConfirmer, getPatchTimingLastIndex, type PatchTimingConfirmation } from "../src/debug/patchTiming";
import { canonicalizeMatch } from "../src/utils/patches";
import { declaration } from "./utils/discordClientFixture";

function clock(step = 1) {
    let value = 0;
    return { now: () => value += step, get value() { return value; } };
}

test("two fast identical replays retain the original string replacement's substitution semantics", () => {
    const confirm = createPatchTimingConfirmer(clock().now);
    for (const match of ["a", "", "(?<name>.*)$"]) {
        const input = `left ${match} right`;
        const replacement = "$`[$&]$'$$$1$<name>";
        assert.deepEqual(confirm(input, input.replace(match, replacement), match, replacement, 44.1, 0), {
            status: "outlier", samplesMs: [1, 1]
        });
    }
});

test("canonical regexes retain capture groups, flags, sticky position and the original matcher's post-call state", () => {
    for (const flags of ["", "g", "y", "gy", "diy", "uy", "vy"]) {
        const match = canonicalizeMatch(new RegExp("(?<letter>a)(b)", flags));
        match.lastIndex = flags.includes("y") && !flags.includes("g") ? 1 : 10;
        const initial = getPatchTimingLastIndex(match);
        if (match.global) match.lastIndex = 0;
        const input = "xAb ab";
        const replacement = "$<letter>!$2";
        const output = input.replace(match, replacement);
        const after = match.lastIndex;
        const result = createPatchTimingConfirmer(clock().now)(input, output, match, replacement, 15.9, initial);
        assert.equal(result.status, "outlier", flags);
        assert.deepEqual(result.samplesMs, [1, 1]);
        assert.equal(match.lastIndex, after, `${flags}: replay must not mutate the applied matcher`);
    }
    const plain = /a/g;
    assert.equal(createPatchTimingConfirmer(clock().now)("a a", "b b", plain, "b", 11, 0).status, "outlier");
});

test("a callback is applied only once and can never be classified as a timing outlier", () => {
    let calls = 0;
    const replacement = () => `value${++calls}`;
    const output = "value".replace("value", replacement);
    const result = createPatchTimingConfirmer(clock().now)("value", output, "value", replacement, 11, 0);
    assert.equal(calls, 1);
    assert.equal(result.status, "inconclusive");
    assert.deepEqual(result.samplesMs, []);
});

test("custom regexp hooks, subclasses, accessors and proxies are rejected without invoking them", () => {
    let calls = 0;
    const ownExec = /a/;
    ownExec.exec = () => { calls++; return null; };
    const ownReplace = /a/;
    ownReplace[Symbol.replace] = () => { calls++; return "b"; };
    const sourceGetter = Object.defineProperty(/a/, "source", { get() { calls++; return "a"; } });
    const formatGetter = Object.defineProperty(/a/, "toString", { get() { calls++; return () => "a"; } });
    class Subclass extends RegExp { }
    const proxy = new Proxy(/a/, {
        get() { calls++; throw new Error("Proxy getter must not run"); },
        getOwnPropertyDescriptor() { calls++; throw new Error("Proxy descriptor must not run"); },
        getPrototypeOf() { calls++; throw new Error("Proxy prototype must not run"); }
    });
    for (const match of [ownExec, ownReplace, sourceGetter, formatGetter, new Subclass("a"), proxy]) {
        const before = getPatchTimingLastIndex(match);
        const result = createPatchTimingConfirmer(clock().now)("a", "b", match, "b", 11, before);
        assert.equal(result.status, "inconclusive");
        assert.deepEqual(result.samplesMs, []);
    }
    assert.equal(calls, 0);
});

test("prototype execution hooks on regexes and primitive string matches are not replayed", () => {
    let calls = 0;
    const exec = Object.getOwnPropertyDescriptor(RegExp.prototype, "exec")!;
    try {
        Object.defineProperty(RegExp.prototype, "exec", { ...exec, value() { calls++; return null; } });
        const result = createPatchTimingConfirmer(clock().now)("a", "b", /a/, "b", 11, 0);
        assert.equal(result.status, "inconclusive");
    } finally { Object.defineProperty(RegExp.prototype, "exec", exec); }
    try {
        Object.defineProperty(String.prototype, Symbol.replace, { configurable: true, get() { calls++; return () => "b"; } });
        assert.equal(createPatchTimingConfirmer(clock().now)("a", "b", "a", "b", 11, 0).status, "inconclusive");
    } finally { Reflect.deleteProperty(String.prototype, Symbol.replace); }
    assert.equal(calls, 0);
});

test("repeated slow output, changed output and timing exceptions remain failures", () => {
    const slow = createPatchTimingConfirmer(clock(11).now)("a", "b", "a", "b", 11, 0);
    assert.equal(slow.status, "slow");
    assert.deepEqual(slow.samplesMs, [11]);
    const mismatch = createPatchTimingConfirmer(clock().now)("a", "different", "a", "b", 11, 0);
    assert.equal(mismatch.status, "inconclusive");
    assert.deepEqual(mismatch.samplesMs, [1]);
    const failure = createPatchTimingConfirmer(() => { throw new Error("Clock failed"); })("a", "b", "a", "b", 11, 0);
    assert.equal(failure.status, "inconclusive");
    assert.deepEqual(failure.samplesMs, []);
});

test("confirmation keeps the 10 ms limit and does not multiply extreme initial work", () => {
    for (const initial of [10, 100.01, 1000, NaN, Infinity]) {
        const result = createPatchTimingConfirmer(() => assert.fail("Ineligible timing must not be measured"))("a", "b", "a", "b", initial, 0);
        assert.equal(result.status, "inconclusive");
        assert.deepEqual(result.samplesMs, []);
    }
    assert.equal(createPatchTimingConfirmer(clock(10).now)("a", "b", "a", "b", 100, 0).status, "outlier");
    const laterSlow = createPatchTimingConfirmer((() => {
        const times = [0, 0, 0, 1, 1, 1, 12, 12];
        return () => times.shift() ?? 12;
    })())("a", "b", "a", "b", 11, 0);
    assert.equal(laterSlow.status, "slow");
    assert.deepEqual(laterSlow.samplesMs, [1, 11]);
});

test("the full reporter permits at most 20 confirmations and 200 ms of confirmation work", () => {
    const frozen = clock(0);
    const byCount = createPatchTimingConfirmer(frozen.now);
    for (let count = 0; count < 20; count++) assert.equal(byCount("a", "b", "a", "b", 11, 0).status, "outlier");
    const exhausted = byCount("a", "b", "a", "b", 11, 0);
    assert.equal(exhausted.status, "inconclusive");
    assert.deepEqual(exhausted.samplesMs, []);
    const elapsed = clock(6);
    const byTime = createPatchTimingConfirmer(elapsed.now);
    let result: PatchTimingConfirmation;
    let calls = 0;
    do { result = byTime("a", "b", "a", "b", 11, 0); calls++; } while (result.status === "outlier" && calls <= 20);
    assert.ok(calls < 20, "Wall-clock budget must apply independently of count");
    assert.equal(result.status, "inconclusive");
    const before = elapsed.value;
    assert.deepEqual(byTime("a", "b", "a", "b", 11, 0).samplesMs, []);
    assert.equal(elapsed.value, before, "An exhausted run must not start more work");
});

test("the real patch factory records original timing and sticky state without executing the module twice", () => {
    const timings: any[] = [];
    const patches: any[] = [];
    const original = function (module: { exports: string; }) { module.exports = "before"; };
    const normalized = `0,function${String(original).slice(String(original).indexOf("("))}`;
    const match = canonicalizeMatch(/"before"/y);
    match.lastIndex = normalized.indexOf('"before"');
    patches.push({ plugin: "Fixture", find: '"before"', replacement: [{ match, replace: '"after"' }] });
    const patchFactory = declaration("src/webpack/patchWebpack.ts", "patchFactory", {
        IS_REPORTER: true, IS_DEV: false, IS_COMPANION_TEST: false, patches, patchTimings: timings,
        getBuildNumber: () => -1, getPatchTimingLastIndex,
        confirmPatchTiming: createPatchTimingConfirmer(clock().now),
        traceFunctionWithResults: (_name: string, fn: Function) => (...args: unknown[]) => [fn(...args), 12.6],
        logger: { warn: assert.fail, error: assert.fail }, SYM_ORIGINAL_FACTORY: Symbol("original")
    });
    const patched = patchFactory("fixture", original);
    const module = { exports: "" };
    patched(module);
    assert.equal(module.exports, "after");
    assert.equal(timings.length, 1);
    assert.equal(timings[0][3], 12.6);
    assert.equal(timings[0][4].status, "outlier");
    assert.deepEqual(timings[0][4].samplesMs, [1, 1]);
});

test("the reporter retains every initial slow sample and only confirmed outliers omit the failing warning", async () => {
    const messages: { tag: string; level: string; args: unknown[]; }[] = [];
    const webpack: any = { wreq: { m: {} }, lazyWebpackSearchHistory: [] };
    const timings = [
        ["Outlier", "1", "a", 44.1, { status: "outlier", samplesMs: [1, 2] }],
        ["Repeated", "2", "a", 15.9, { status: "slow", samplesMs: [12] }],
        ["Callback", "3", "a", 10.8, { status: "inconclusive", samplesMs: [], reason: "callback" }],
        ["Legacy", "4", "a", 12.6],
        ["Fast", "5", "a", 10]
    ];
    const run = declaration("src/debug/runReporter.ts", "runReporter", {
        Logger: class {
            constructor(private tag: string) { }
            log(...args: unknown[]) { messages.push({ tag: this.tag, level: "log", args }); }
            warn(...args: unknown[]) { messages.push({ tag: this.tag, level: "warn", args }); }
        },
        addPatch: () => queueMicrotask(() => webpack._initReporter()), loadLazyChunks: async () => {},
        Webpack: webpack, Vencord: { Webpack: webpack }, setTimeout: (callback: () => void) => queueMicrotask(callback),
        patches: [], patchTimings: timings, IS_REPORTER: false, IS_COMPANION_TEST: false
    });
    await run();
    const confirmations = messages.filter(message => message.args[0] === "Patch timing confirmation:").map(message => JSON.parse(String(message.args[1])));
    assert.deepEqual(confirmations.map(item => item.initialMs), [44.1, 15.9, 10.8, 12.6]);
    assert.deepEqual(confirmations[0].samplesMs, [1, 2]);
    assert.equal(confirmations[3].status, "inconclusive");
    const warnings = messages.filter(message => message.tag === "WebpackPatcher" && message.level === "warn");
    assert.equal(warnings.length, 3);
    assert.match(String(warnings[0].args[0]), /Patch by Repeated took 15.9ms/);
    assert.match(String(warnings[1].args[0]), /Patch by Callback took 10.8ms/);
    assert.match(String(warnings[2].args[0]), /Patch by Legacy took 12.6ms/);
    assert.equal(messages.at(-1)?.args[0], "Finished test");
});
