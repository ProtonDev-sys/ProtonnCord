// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { canPromote, canPublish, readBuildArtifact, selectJobs, verifyArtifacts } from "./worker.mjs";
import { planDraftResume, planVersion, processEnvironment } from "./publish-browser.mjs";

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

test("untrusted artifact links cannot disclose files outside their build root", { skip: process.platform !== "linux" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-build-read-"));
    const root = join(directory, "build");
    try {
        await mkdir(root);
        await writeFile(join(directory, "private"), "outside build");
        await writeFile(join(root, "payload"), "validated");
        assert.equal((await readBuildArtifact(root, "payload")).toString(), "validated");
        await symlink(join(directory, "private"), join(root, "link"));
        await assert.rejects(readBuildArtifact(root, "link"));
        await symlink(directory, join(root, "parent"));
        await assert.rejects(readBuildArtifact(root, "parent/private"), /escapes/u);
        await assert.rejects(readBuildArtifact(root, "payload", 1), /Invalid/u);
        execFileSync("mkfifo", [join(root, "pipe")]);
        await assert.rejects(readBuildArtifact(root, "pipe"), /Invalid/u);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("browser retries preserve uploaded archives and reject unexpected remote files", () => {
    const uploaded = { id: 1, name: "extension-chrome.zip", state: "uploaded", size: 50 };
    const placeholder = { id: 2, name: "extension-firefox.zip", state: "starter", size: 0 };
    const plan = planDraftResume([uploaded, placeholder]);
    assert.deepEqual(plan.uploaded, [uploaded.name]);
    assert.deepEqual(plan.placeholders, [2]);
    assert.ok(!plan.missing.includes(uploaded.name));
    assert.throws(() => planDraftResume([uploaded, uploaded]), /duplicate/u);
    assert.throws(() => planDraftResume([{ ...uploaded, name: "unexpected" }]), /Unexpected/u);
    assert.throws(() => planDraftResume([{ ...placeholder, size: 1 }]), /Invalid/u);
});

test("unchanged package versions skip publication while explicit retries bind the original SHA", () => {
    const tags = [{ name: "v1.2.3", commit: { sha } }];
    assert.equal(planVersion(tags, "v1.2.3", "b".repeat(40), false).skip, true);
    assert.throws(() => planVersion(tags, "v1.2.3", "b".repeat(40), true), /different commit/u);
    assert.equal(planVersion(tags, "v1.2.4", "b".repeat(40), false).skip, false);
    const environment = processEnvironment({ PATH: "/tools", GH_TOKEN: "private", FIREFOX_JWT_SECRET: "private" });
    assert.equal(environment.PATH, "/tools");
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.FIREFOX_JWT_SECRET, undefined);
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
