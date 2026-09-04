/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { Logger } from "../src/utils/Logger";
import { Queue } from "../src/utils/Queue";
import { TTLMap } from "../src/utils/TTLMap";

test("TTLMap expires once and removes the entry before notifying", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired: [string, number][] = [];
    const cache = new TTLMap<string, number>(100, (key, value) => {
        assert.equal(cache.has(key), false);
        expired.push([key, value]);
    });

    assert.equal(cache.set("a", 1), cache);
    t.mock.timers.tick(99);
    assert.equal(cache.get("a"), 1);
    assert.deepEqual(expired, []);
    t.mock.timers.tick(1);
    assert.equal(cache.size, 0);
    assert.deepEqual(expired, [["a", 1]]);
    t.mock.timers.tick(100);
    assert.deepEqual(expired, [["a", 1]]);
});

test("TTLMap replacement gets a full lifetime and only expires the latest value", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired: [string, number][] = [];
    const cache = new TTLMap<string, number>(100, (key, value) => expired.push([key, value]));

    cache.set("a", 1);
    t.mock.timers.tick(60);
    cache.set("a", 2);
    t.mock.timers.tick(40);
    assert.equal(cache.get("a"), 2);
    assert.deepEqual(expired, []);
    t.mock.timers.tick(59);
    assert.equal(cache.get("a"), 2);
    t.mock.timers.tick(1);
    assert.equal(cache.has("a"), false);
    assert.deepEqual(expired, [["a", 2]]);
});

test("TTLMap updating a key preserves Map insertion order", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const cache = new TTLMap<string, number>(100);

    cache.set("a", 1).set("b", 2).set("a", 3);
    assert.deepEqual([...cache], [["a", 3], ["b", 2]]);
    assert.equal(cache.size, 2);
});

test("TTLMap delete cancels every timer after repeated replacement", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired = t.mock.fn();
    const cache = new TTLMap<string, number>(100, expired);

    cache.set("a", 1).set("a", 2).set("a", 3);
    assert.equal(cache.delete("a"), true);
    assert.equal(cache.delete("a"), false);
    t.mock.timers.tick(1000);
    assert.equal(cache.size, 0);
    assert.equal(expired.mock.callCount(), 0);
});

test("TTLMap clear cancels replaced entries without expiration callbacks", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired = t.mock.fn();
    const cache = new TTLMap<string, number>(100, expired);

    cache.set("a", 1).set("b", 2);
    t.mock.timers.tick(50);
    cache.set("a", 3).set("b", 4);
    assert.equal(cache.clear(), undefined);
    cache.clear();
    t.mock.timers.tick(1000);
    assert.equal(cache.size, 0);
    assert.equal(expired.mock.callCount(), 0);
});

for (const operation of ["delete", "clear"] as const) {
    test(`TTLMap ${operation} followed by reinsertion cannot inherit an old timer`, t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const expired: number[] = [];
        const cache = new TTLMap<string, number>(100, (_key, value) => expired.push(value));

        cache.set("a", 1);
        t.mock.timers.tick(20);
        cache.set("a", 2);
        if (operation === "delete") cache.delete("a");
        else cache.clear();
        t.mock.timers.tick(20);
        cache.set("a", 3);
        t.mock.timers.tick(60);
        assert.equal(cache.get("a"), 3);
        assert.deepEqual(expired, []);
        t.mock.timers.tick(40);
        assert.equal(cache.size, 0);
        assert.deepEqual(expired, [3]);
    });
}

test("TTLMap expiration callbacks may reinsert the same key", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired: number[] = [];
    const cache = new TTLMap<string, number>(100, (key, value) => {
        expired.push(value);
        if (value === 1) cache.set(key, 2);
    });

    cache.set("a", 1);
    t.mock.timers.tick(100);
    assert.equal(cache.get("a"), 2);
    t.mock.timers.tick(100);
    assert.equal(cache.size, 0);
    assert.deepEqual(expired, [1, 2]);
});

test("TTLMap keys retain Map identity and SameValueZero semantics", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const left = {};
    const right = {};
    const cache = new TTLMap<object | number, string>(100);

    cache.set(left, "left").set(right, "right").set(NaN, "old");
    t.mock.timers.tick(50);
    cache.set(NaN, "new");
    assert.equal(cache.size, 3);
    t.mock.timers.tick(50);
    assert.equal(cache.has(left), false);
    assert.equal(cache.has(right), false);
    assert.equal(cache.get(NaN), "new");
    t.mock.timers.tick(50);
    assert.equal(cache.size, 0);
});

test("TTLMap supports undefined values and independent expiration times", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired: [string, number | undefined][] = [];
    const cache = new TTLMap<string, number | undefined>(100, (key, value) => expired.push([key, value]));

    cache.set("a", undefined);
    t.mock.timers.tick(50);
    cache.set("b", 2);
    assert.equal(cache.has("a"), true);
    t.mock.timers.tick(50);
    assert.equal(cache.has("a"), false);
    assert.equal(cache.get("b"), 2);
    assert.deepEqual(expired, [["a", undefined]]);
    t.mock.timers.tick(50);
    assert.equal(cache.size, 0);
    assert.deepEqual(expired, [["a", undefined], ["b", 2]]);
});

test("TTLMap matches a reference model over 10000 deterministic operations", t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const actualExpired: number[] = [];
    const cache = new TTLMap<number, number>(100, (_key, value) => actualExpired.push(value));
    const model = new Map<number, { value: number; expires: number; }>();
    let now = 0;
    let seed = 0x5eed;
    const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

    for (let step = 0; step < 10000; step++) {
        const operation = random() % 10;
        const key = random() % 8;
        if (operation < 5) {
            cache.set(key, step);
            model.set(key, { value: step, expires: now + 100 });
        } else if (operation < 7) {
            assert.equal(cache.delete(key), model.delete(key));
        } else if (operation === 7) {
            cache.clear();
            model.clear();
        } else {
            const elapsed = random() % 150;
            now += elapsed;
            const expectedExpired: number[] = [];
            for (const [entryKey, entry] of model) {
                if (entry.expires <= now) {
                    model.delete(entryKey);
                    expectedExpired.push(entry.value);
                }
            }
            t.mock.timers.tick(elapsed);
            assert.deepEqual(actualExpired.sort((a, b) => a - b), expectedExpired.sort((a, b) => a - b), `expiration at step ${step}`);
            actualExpired.length = 0;
        }
        assert.deepEqual([...cache], [...model].map(([entryKey, entry]) => [entryKey, entry.value]), `entries at step ${step}`);
    }
    cache.clear();
    t.mock.timers.tick(1000);
    assert.deepEqual(actualExpired, []);
});

test("Queue defers tasks and runs synchronous, promise and thenable results in order", async () => {
    const queue = new Queue();
    const seen: string[] = [];

    queue.push(() => seen.push("sync"));
    queue.push(async () => { seen.push("promise"); });
    const thenable: PromiseLike<number> = {
        then(onfulfilled, onrejected) {
            seen.push("thenable");
            return Promise.resolve(42).then(onfulfilled, onrejected);
        }
    };
    queue.push(() => thenable);
    queue.push(() => seen.push("last"));
    assert.deepEqual(seen, []);
    await setImmediate();
    assert.deepEqual(seen, ["sync", "promise", "thenable", "last"]);
    assert.equal(queue.size, 0);
});

test("Queue waits for the active task and size counts only pending work", async () => {
    const queue = new Queue();
    const gate = Promise.withResolvers<void>();
    const seen: string[] = [];

    queue.push(async () => {
        seen.push("start");
        await gate.promise;
        seen.push("finish");
    });
    queue.push(() => seen.push("next"));
    assert.equal(queue.size, 1);
    await setImmediate();
    assert.deepEqual(seen, ["start"]);
    assert.equal(queue.size, 1);
    gate.resolve();
    await setImmediate();
    assert.deepEqual(seen, ["start", "finish", "next"]);
    assert.equal(queue.size, 0);
});

test("Queue unshift prioritizes pending work without interrupting the active task", async () => {
    const queue = new Queue();
    const gate = Promise.withResolvers<void>();
    const seen: string[] = [];

    queue.push(() => gate.promise);
    queue.push(() => seen.push("tail"));
    queue.unshift(() => seen.push("priority one"));
    queue.unshift(() => seen.push("priority two"));
    await setImmediate();
    assert.deepEqual(seen, []);
    gate.resolve();
    await setImmediate();
    assert.deepEqual(seen, ["priority two", "priority one", "tail"]);
});

for (const maxSize of [1, 2, 5]) {
    for (const operation of ["push", "unshift"] as const) {
        test(`Queue ${operation} retains the correct end of a full queue of size ${maxSize}`, async () => {
            const queue = new Queue(maxSize);
            const gate = Promise.withResolvers<void>();
            const seen: number[] = [];

            queue.push(() => gate.promise);
            for (let i = 0; i < maxSize; i++) queue.push(() => seen.push(i));
            queue[operation](() => seen.push(maxSize));
            assert.equal(queue.size, maxSize);
            await setImmediate();
            assert.deepEqual(seen, []);
            gate.resolve();
            await setImmediate();
            const retained = Array.from({ length: maxSize - 1 }, (_, i) => operation === "push" ? i + 1 : i);
            assert.deepEqual(seen, operation === "push" ? [...retained, maxSize] : [maxSize, ...retained]);
            assert.equal(queue.size, 0);
        });
    }
}

test("Queue supports enqueueing from a task and restarts after draining", async () => {
    const queue = new Queue();
    const seen: string[] = [];

    queue.push(() => {
        seen.push("active");
        queue.push(() => seen.push("nested tail"));
        queue.unshift(() => seen.push("nested priority"));
    });
    queue.push(() => seen.push("original tail"));
    await setImmediate();
    assert.deepEqual(seen, ["active", "nested priority", "original tail", "nested tail"]);
    queue.unshift(() => seen.push("restarted"));
    await setImmediate();
    assert.equal(seen.at(-1), "restarted");
    assert.equal(queue.size, 0);
});

for (const failure of ["throw", "reject", "thenable"] as const) {
    test(`Queue reports a task ${failure} once without an unhandled rejection and continues`, async t => {
        const log = t.mock.method(Logger.prototype, "error", () => { });
        const queue = new Queue();
        const error = new Error(`Task ${failure}`);
        const seen: string[] = [];

        const thenable: PromiseLike<never> = {
            then(onfulfilled, onrejected) {
                return Promise.reject<never>(error).then(onfulfilled, onrejected);
            }
        };
        queue.push(() => {
            if (failure === "throw") throw error;
            if (failure === "reject") return Promise.reject(error);
            return thenable;
        });
        queue.push(() => seen.push("continued"));
        await setImmediate();
        assert.deepEqual(seen, ["continued"]);
        assert.equal(log.mock.callCount(), 1);
        assert.deepEqual(log.mock.calls[0].arguments, ["Failed to run queued task", error]);
        queue.push(() => seen.push("restarted"));
        await setImmediate();
        assert.deepEqual(seen, ["continued", "restarted"]);
        assert.equal(queue.size, 0);
    });
}
