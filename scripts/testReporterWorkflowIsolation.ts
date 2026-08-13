/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strict as assert } from "assert";
import { readFile } from "fs/promises";

async function main() {
    const workflow = await readFile(new URL("../.github/workflows/reportBrokenPlugins.yml", import.meta.url), "utf8");
    const reporter = await readFile(new URL("./generateReport.ts", import.meta.url), "utf8");

    const generate = workflow.slice(workflow.indexOf("    generate:"), workflow.indexOf("    publish:"));
    const publish = workflow.slice(workflow.indexOf("    publish:"));

    assert.match(generate, /persist-credentials: false/, "selectable code must not retain checkout credentials");
    assert.doesNotMatch(generate, /secrets\./, "selectable code must run without repository secrets");
    assert.match(generate, /REPORT_WEBHOOK_BODY_FILE=/, "reporting code must emit an inert artifact");
    assert.match(publish, /github\.event\.repository\.default_branch/, "secret use must be limited to the default workflow ref");
    assert.match(publish, /environment: reporter-webhook/, "secret use must support protected-environment approval");
    assert.doesNotMatch(publish, /actions\/checkout|pnpm|esbuild|dist\/report\.mjs/, "the secret job must not execute selected repository code");
    assert.doesNotMatch(workflow, /uses:\s+[^\s@]+@(?:v\d+|main|master|latest)\b/u,
        "workflow actions must be pinned to immutable revisions");
    assert.match(publish, /MAX_PAYLOAD_BYTES = 64 \* 1024/, "the inert payload must be bounded before signing");
    assert.match(publish, /!metadata\.isFile\(\) \|\| metadata\.isSymbolicLink\(\)/,
        "the secret job must reject linked or special report artifacts");
    assert.match(publish, /validatePayload\(payload\)/, "the inert payload must be schema-validated before signing");
    assert.match(publish, /inputs\.webhook_url == '' && secrets\.WEBHOOK_SECRET/, "public endpoints must not receive a signature oracle");
    assert.match(reporter, /REPORT_WEBHOOK_BODY_FILE/, "the reporter must support secretless artifact generation");

    console.log("Reporter workflow isolation tests passed.");
}

void main();
