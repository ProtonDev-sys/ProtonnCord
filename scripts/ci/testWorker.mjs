// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { canPublish, selectJobs } from "./worker.mjs";

const sha = "a".repeat(40);
const heads = { main: sha, staging: sha, nightly: sha };
const pr = { number: 1, user: { login: "ProtonDev-sys" }, base: { ref: "nightly" }, head: { sha, repo: { full_name: "ProtonDev-sys/ProtonnCord" } } };

test("public fork and non-owner pull requests never run on the private build PC", () => {
    const jobs = selectJobs(heads, [pr, { ...pr, number: 2, user: { login: "someone" } }, { ...pr, number: 3, head: { ...pr.head, repo: { full_name: "someone/fork" } } }]);
    assert.deepEqual(jobs.map(job => job.key), ["main", "staging", "nightly", "pr-1"]);
    assert.equal(jobs[3].publish, false);
    assert.equal(selectJobs({ main: "../bad" }, []).length, 0);
});

test("publication needs successful validation of the same current branch SHA", () => {
    const job = selectJobs(heads, [pr])[2];
    const passed = { validated: true, sha };
    assert.equal(canPublish(job, passed, sha), true);
    assert.equal(canPublish(job, { ...passed, validated: false }, sha), false);
    assert.equal(canPublish(job, { ...passed, sha: "b".repeat(40) }, sha), false);
    assert.equal(canPublish(job, passed, "b".repeat(40)), false);
    assert.equal(canPublish(selectJobs(heads, [pr])[3], passed, sha), false);
});
