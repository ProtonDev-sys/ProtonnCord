/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { guardStdioBrokenPipe, isBrokenPipeError } from "../src/main/utils/stdio";

class TestStream extends EventEmitter {
    errorOnWrite: Error | null = null;
    writes: unknown[][] = [];

    write(...args: unknown[]): boolean {
        if (this.errorOnWrite) throw this.errorOnWrite;
        this.writes.push(args);
        return true;
    }
}

function streamError(code: string): Error & { code: string; } {
    return Object.assign(new Error(code), { code });
}

const brokenPipe = streamError("EPIPE");
const unexpected = streamError("EIO");

assert.equal(isBrokenPipeError(brokenPipe), true);
assert.equal(isBrokenPipeError(unexpected), false);
assert.equal(isBrokenPipeError(null), false);
assert.doesNotThrow(() => guardStdioBrokenPipe(undefined), "a GUI process without a standard stream must remain supported");

const guarded = new TestStream();
guardStdioBrokenPipe(guarded);
guardStdioBrokenPipe(guarded);
assert.equal(guarded.listenerCount("error"), 1, "installing the guard twice must remain idempotent");
guarded.errorOnWrite = brokenPipe;
assert.equal(guarded.write("discarded log"), true, "a synchronous broken-pipe write must be discarded");
assert.doesNotThrow(() => guarded.emit("error", brokenPipe), "an asynchronous broken-pipe event must be handled");

const writeFailure = new TestStream();
guardStdioBrokenPipe(writeFailure);
writeFailure.errorOnWrite = unexpected;
assert.throws(() => writeFailure.write("important failure"), error => error === unexpected,
    "unexpected synchronous stream failures must still surface");
assert.throws(() => writeFailure.emit("error", unexpected), error => error === unexpected,
    "an otherwise-unhandled unexpected stream failure must still surface");

const separatelyHandled = new TestStream();
let observedError: unknown;
separatelyHandled.on("error", error => { observedError = error; });
guardStdioBrokenPipe(separatelyHandled);
assert.doesNotThrow(() => separatelyHandled.emit("error", unexpected),
    "the guard must not override another listener's error policy");
assert.equal(observedError, unexpected);

const healthy = new TestStream();
guardStdioBrokenPipe(healthy);
assert.equal(healthy.write("normal log", 42), true);
assert.deepEqual(healthy.writes, [["normal log", 42]]);

console.log("main-process stdio broken-pipe checks passed");
