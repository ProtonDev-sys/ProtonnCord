/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Reuse the full Test run without rebuilding its suite in each publishing job. */
export async function requireReleaseValidation({ repository, branch, sha, token }, {
    request = fetch,
    sleep = delay,
    now = Date.now,
    // The full suite includes a 45-minute Android job; allow its startup too.
    timeoutMs = 50 * 60_000,
} = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "")
        || !["main", "staging", "nightly"].includes(branch)
        || !/^[a-f0-9]{40}$/u.test(sha ?? "") || !token)
        throw new Error("Release validation requires a repository, supported branch, commit SHA and GitHub token.");

    const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/test.yml/runs`);
    url.search = new URLSearchParams({ branch, head_sha: sha, per_page: "100" }).toString();
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
        const response = await request(url, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Cache-Control": "no-cache" },
            signal: AbortSignal.timeout(30_000),
            redirect: "error",
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Cannot verify release tests: GitHub returned HTTP ${response.status}.`);
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.workflow_runs))
            throw new Error("Cannot verify release tests: invalid workflow response.");

        // PR merge refs and runs from another branch are not validation of this release.
        const runs = data.workflow_runs.filter(run => run
            && run.head_sha === sha && run.head_branch === branch
            && ["push", "workflow_dispatch"].includes(run.event)
            && run.path === ".github/workflows/test.yml");
        if (runs.some(run => !Number.isSafeInteger(run.id) || run.id < 1))
            throw new Error("Cannot verify release tests: invalid workflow run identity.");
        const latest = runs.sort((left, right) => right.id - left.id)[0];
        if (latest?.status === "completed") {
            if (latest.conclusion !== "success")
                throw new Error(`Full Test run ${latest.id} ended with ${latest.conclusion}; refusing to publish ${sha}.`);
            return latest.id;
        }
        await sleep(Math.min(15_000, Math.max(0, deadline - now())));
    }
    throw new Error(`Full Test validation for ${branch}@${sha} did not succeed within ${timeoutMs}ms.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    requireReleaseValidation({
        repository: process.env.GITHUB_REPOSITORY,
        branch: process.env.GITHUB_REF_NAME,
        sha: process.env.GITHUB_SHA,
        token: process.env.GITHUB_TOKEN,
    }).then(run => console.log(`Full Test run ${run} passed for this release revision.`)).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
