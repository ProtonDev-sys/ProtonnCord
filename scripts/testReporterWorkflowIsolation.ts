/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strict as assert } from "assert";
import { readFile } from "fs/promises";
import { runInNewContext } from "node:vm";

async function main() {
    const workflow = await readFile(new URL("../.github/workflows/reportBrokenPlugins.yml", import.meta.url), "utf8");
    const reporter = await readFile(new URL("./generateReport.ts", import.meta.url), "utf8");

    const generate = workflow.slice(workflow.indexOf("    generate:"), workflow.indexOf("    publish:"));
    const publish = workflow.slice(workflow.indexOf("    publish:"));

    assert.match(generate, /^        runs-on: ubuntu-latest$/mu,
        "selectable source must run on a fresh hosted runner with Chrome");
    assert.match(publish, /^        runs-on: ubuntu-latest$/mu,
        "credentialed publication must use a separate fresh hosted runner");
    assert.match(generate, /persist-credentials: false/, "selectable code must not retain checkout credentials");
    assert.doesNotMatch(generate, /secrets\./, "selectable code must run without repository secrets");
    assert.match(generate, /REPORT_WEBHOOK_BODY_FILE=/, "reporting code must emit an inert artifact");
    assert.match(generate, /ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/,
        "scheduled reports must test the triggering default-branch commit instead of a stale upstream branch");
    assert.match(publish, /github\.event\.repository\.default_branch/, "secret use must be limited to the default workflow ref");
    assert.match(publish, /environment: reporter-webhook/, "secret use must support protected-environment approval");
    assert.doesNotMatch(publish, /actions\/checkout|pnpm|esbuild|dist\/report\.mjs/, "the secret job must not execute selected repository code");
    assert.doesNotMatch(workflow, /uses:\s+[^\s@]+@(?:v\d+|main|master|latest)\b/u,
        "workflow actions must be pinned to immutable revisions");
    const actionRefs = Array.from(workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/gu), match => match[1]);
    assert.ok(actionRefs.length > 0, "workflow must use reviewed actions");
    for (const ref of actionRefs) assert.match(ref, /^[0-9a-f]{40}$/u, "every reporter action must be pinned to an immutable commit");
    assert.match(publish, /MAX_PAYLOAD_BYTES = 64 \* 1024/, "the inert payload must be bounded before signing");
    assert.match(publish, /!metadata\.isFile\(\) \|\| metadata\.isSymbolicLink\(\)/,
        "the secret job must reject linked or special report artifacts");
    assert.match(publish, /validatePayload\(payload\)/, "the inert payload must be schema-validated before signing");
    assert.match(publish, /inputs\.webhook_url == '' && secrets\.WEBHOOK_SECRET/, "public endpoints must not receive a signature oracle");
    assert.match(reporter, /REPORT_WEBHOOK_BODY_FILE/, "the reporter must support secretless artifact generation");

    const tests = await readFile(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
    const expression = tests.match(/runs-on: \$\{\{ (.+) \}\}/)?.[1];
    assert.ok(expression, "the primary Test job must select its runner explicitly");
    for (const [event, head, author, actor, enabled, selfHosted] of [
        ["push", "owner/repo", "owner", "owner", "true", true],
        ["workflow_dispatch", "owner/repo", "owner", "owner", "true", true],
        ["pull_request", "owner/repo", "owner", "owner", "true", true],
        ["pull_request", "fork/repo", "owner", "owner", "true", false],
        ["pull_request", "owner/repo", "contributor", "owner", "true", false],
        ["pull_request", "owner/repo", "owner", "contributor", "true", false],
        ["pull_request_target", "owner/repo", "owner", "owner", "true", false],
        ["pull_request", "owner/repo", "owner", "owner", "false", false],
    ] as const) {
        const runner = runInNewContext(expression, {
            vars: { CI_SERVER_LINUX: enabled },
            github: { event_name: event, repository: "owner/repo", repository_owner: "owner", actor,
                event: { pull_request: { head: { repo: { full_name: head } }, user: { login: author } } } },
            fromJSON: JSON.parse, contains: (values: string[], value: string) => values.includes(value),
        });
        assert.equal(Array.isArray(runner), selfHosted, `${event}, ${head}, ${author}, ${actor}, opt-in=${enabled}`);
        if (selfHosted) assert.ok(runner.includes("server"));
        else assert.equal(runner, "ubuntu-latest");
    }

    console.log("Reporter workflow isolation tests passed.");
}

void main();
