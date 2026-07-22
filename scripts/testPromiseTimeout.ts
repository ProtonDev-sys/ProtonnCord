import assert from "node:assert/strict";

import { withTimeout } from "../src/debug/promiseTimeout";

async function main(): Promise<void> {
    assert.equal(await withTimeout(Promise.resolve("done"), 100, "unexpected timeout"), "done", "resolved work passes through");
    await assert.rejects(
        withTimeout(new Promise(() => { }), 5, "expected timeout"),
        /expected timeout/,
        "stalled work is bounded",
    );
    await assert.rejects(
        withTimeout(Promise.reject(new Error("source failure")), 100, "unexpected timeout"),
        /source failure/,
        "source failures pass through",
    );

    console.log("promise timeout checks passed");
}

void main();
