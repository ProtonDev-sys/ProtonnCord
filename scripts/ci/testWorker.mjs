// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canPromote, canPublish, selectJobs, verifyArtifacts } from "./worker.mjs";

const sha = "a".repeat(40);
const heads = { main: sha, staging: sha, nightly: sha };
const pr = { number: 1, user: { login: "ProtonDev-sys" }, base: { ref: "nightly" }, head: { sha, repo: { full_name: "ProtonDev-sys/ProtonnCord" } } };

test("public fork and non-owner pull requests never run on the private build PC", () => {
    const jobs = selectJobs(heads, [pr, { ...pr, number: 2, user: { login: "someone" } }, { ...pr, number: 3, head: { ...pr.head, repo: { full_name: "someone/fork" } } }]);
    assert.deepEqual(jobs.map(job => job.key), ["main", "staging", "nightly", "pr-1"]);
    assert.equal(jobs[3].publish, false);
    assert.equal(selectJobs({ main: "../bad" }, []).length, 0);
});

test("release retries reject changed artifacts and incomplete evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "ci-artifacts-"));
    try {
        await writeFile(join(root, "payload"), "validated");
        const manifest = { payload: createHash("sha256").update("validated").digest("hex") };
        await verifyArtifacts(root, manifest);
        await writeFile(join(root, "payload"), "changed");
        await assert.rejects(verifyArtifacts(root, manifest), /changed/u);
        await assert.rejects(verifyArtifacts(root, {}), /Missing/u);
        await assert.rejects(verifyArtifacts(root, { "../escape": manifest.payload }), /Invalid/u);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed retry cannot promote a previously published job", () => {
    const passed = { validated: true, published: true, complete: true, failed: false };
    assert.equal(canPromote(passed), true);
    for (const failure of [{ failed: true }, { complete: false }, { validated: false }, { published: false }])
        assert.equal(canPromote({ ...passed, ...failure }), false);
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
