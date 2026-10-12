/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { load } from "yaml-js";

import { requireReleaseValidation } from "./requireReleaseValidation.mjs";

const context = { repository: "fixture/client", branch: "nightly", sha: "a".repeat(40), token: "fixture-token" };
const passed = { id: 42, head_sha: context.sha, head_branch: context.branch, event: "push", path: ".github/workflows/test.yml", status: "completed", conclusion: "success" };

function harness(responses: unknown[]) {
    let time = 0;
    let requests = 0;
    return {
        now: () => time,
        timeoutMs: 30_000,
        async sleep<T = void>(ms = 1, value?: T) { time += ms; return value as T; },
        async request(input: Parameters<typeof fetch>[0], options?: RequestInit) {
            const url = new URL(input instanceof Request ? input.url : input);
            assert.ok(options);
            assert.equal(url.origin, "https://api.github.com");
            assert.equal(url.pathname, "/repos/fixture/client/actions/workflows/test.yml/runs");
            assert.equal(url.searchParams.get("head_sha"), context.sha);
            assert.equal(url.searchParams.get("branch"), "nightly");
            assert.equal(options.redirect, "error");
            assert.equal((options.headers as Record<string, string>).Authorization, "Bearer fixture-token");
            assert.equal((options.headers as Record<string, string>)["Cache-Control"], "no-cache");
            assert.ok(options.signal instanceof AbortSignal);
            const response = responses[Math.min(requests++, responses.length - 1)];
            if (response instanceof Error) throw response;
            return new Response(JSON.stringify(response));
        },
    };
}

test("release waits for the full suite on the exact branch and revision", async () => {
    const run = await requireReleaseValidation(context, harness([
        { workflow_runs: [] },
        { workflow_runs: [passed] },
    ]));
    assert.equal(run, 42);
});

test("an old success cannot hide a newer failed, cancelled, skipped or pending run", async () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", null]) {
        await assert.rejects(requireReleaseValidation(context, harness([{ workflow_runs: [
            passed, { ...passed, id: 43, conclusion },
        ] }])), /refusing to publish/u);
    }
    assert.equal(await requireReleaseValidation(context, harness([
        { workflow_runs: [passed, { ...passed, id: 43, status: "in_progress", conclusion: null }] },
        { workflow_runs: [{ ...passed, id: 43 }] },
    ])), 43);
});

test("another commit, branch, PR or workflow never satisfies release validation", async () => {
    const wrongRuns = [
        { ...passed, head_sha: "b".repeat(40) },
        { ...passed, head_branch: "main" },
        { ...passed, event: "pull_request" },
        { ...passed, path: ".github/workflows/build.yml" },
    ];
    await assert.rejects(requireReleaseValidation(context, harness([{ workflow_runs: wrongRuns }])), /did not succeed/u);
    assert.equal(await requireReleaseValidation(context, harness([{ workflow_runs: [{ ...passed, event: "workflow_dispatch" }] }])), 42);
});

test("unavailable or malformed CI evidence fails closed", async () => {
    for (const response of [null, {}, { workflow_runs: {} }, { workflow_runs: [{ ...passed, id: "42" }] }, new Error("Offline")]) {
        await assert.rejects(requireReleaseValidation(context, harness([response])));
    }
    await assert.rejects(requireReleaseValidation(context, {
        ...harness([]), request: async () => new Response("Forbidden", { status: 403 }),
    }), /HTTP 403/u);
    for (const invalid of [{ branch: "feature/test" }, { sha: "nightly" }, { repository: "../fixture/client" }, { token: "" }]) {
        await assert.rejects(requireReleaseValidation({ ...context, ...invalid }, {
            request: async () => assert.fail("invalid context must not contact GitHub"),
        }), /requires/u);
    }
});

test("desktop and mobile publication require validation before any release mutation", () => {
    for (const [file, jobName, publishName] of [
        ["build.yml", "Build", "Upload Protonn Cord update channel"],
        ["mobile.yml", "publish", "Publish immutable build then update nightly index"],
    ]) {
        const workflow = load(readFileSync(`.github/workflows/${file}`, "utf8"));
        const job = workflow.jobs[jobName];
        const gate = job.steps.findIndex((step: any) => step.run === "node scripts/requireReleaseValidation.mjs");
        const publish = job.steps.findIndex((step: any) => step.name === publishName);
        assert.ok(gate >= 0 && publish > gate, `${file} must validate before publishing`);
        assert.equal(job.steps[gate].env.GITHUB_TOKEN, "${{ github.token }}");
        assert.equal((job.permissions ?? workflow.permissions).actions, "read");
        assert.equal(workflow.env?.GITHUB_TOKEN, undefined, "build tools must not inherit the publishing token");
    }
});
