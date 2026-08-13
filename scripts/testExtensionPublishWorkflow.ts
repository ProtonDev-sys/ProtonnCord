/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PUBLISHER_VERSION = "4.0.8";
const PUBLISHER_INTEGRITY = "sha512-x+QEsTVF2slhdL8rIAKC6TGOIYJ5srHWm+NDHEDu8nIsCttrXhR80XcCWntKtUiaSydLa1Sjs3/Zwy0Ry0Yyrw==";
const workflow = readFileSync(".github/workflows/publish.yml", "utf8").replaceAll("\r\n", "\n");
const lockfile = readFileSync("pnpm-lock.yaml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
};

function getJob(name: string): string {
    const marker = `    ${name}:\n`;
    const start = workflow.indexOf(marker);
    assert.notEqual(start, -1, `${name} job must exist`);
    const remainder = workflow.slice(start + marker.length);
    const nextJob = /\n    [a-z][a-z0-9-]*:\n/u.exec(remainder);
    return nextJob ? remainder.slice(0, nextJob.index) : remainder;
}

assert.equal(packageJson.devDependencies?.["@equicord/publish-browser-extension"], PUBLISHER_VERSION, "publisher must be an exact reviewed devDependency");
assert.match(packageJson.scripts?.test ?? "", /pnpm testExtensionPublishWorkflow/u, "publisher hardening regression must run in the main test suite");
assert.match(lockfile, /'@equicord\/publish-browser-extension':\s+specifier: 4\.0\.8\s+version: 4\.0\.8/u, "root lockfile importer must pin the publisher");
assert.match(lockfile, /'@equicord\/publish-browser-extension@4\.0\.8':\s+resolution: \{integrity: sha512-x\+QEsTVF2slhdL8rIAKC6TGOIYJ5srHWm\+NDHEDu8nIsCttrXhR80XcCWntKtUiaSydLa1Sjs3\/Zwy0Ry0Yyrw==\}/u, "publisher tarball integrity must remain locked");
assert.ok(lockfile.includes(PUBLISHER_INTEGRITY), "reviewed publisher integrity must remain present");

assert.doesNotMatch(workflow, /\b(?:npx|pnpx)\b|pnpm\s+dlx|@latest/u, "release workflow must not execute floating packages");
assert.match(workflow, /concurrency:\s+group: browser-extension-release\s+cancel-in-progress: false/u, "extension releases must be serialized");
assert.match(workflow, /permissions:\s+contents: read/u, "workflow permissions must default to read-only");
assert.equal(workflow.match(/pnpm --config\.offline=true exec publish-extension/gu)?.length, 3, "each store must invoke the locked local publisher offline");
assert.equal(workflow.match(/pnpm install --frozen-lockfile --ignore-scripts/gu)?.length, 3, "credentialed jobs must install the frozen dependency graph without lifecycle scripts");
assert.equal(workflow.match(/pnpm buildWebStandalone/gu)?.length, 1, "release archives must be built once without store credentials");
assert.equal(workflow.match(/persist-credentials: false/gu)?.length, 4, "no job may retain checkout credentials");

const actionRefs = Array.from(workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/gu), match => match[1]);
assert.ok(actionRefs.length > 0, "workflow must use reviewed actions");
for (const ref of actionRefs)
    assert.match(ref, /^[0-9a-f]{40}$/u, "every release action must be pinned to an immutable commit");

const prepare = getJob("prepare");
assert.match(prepare, /permissions:\s+contents: write/u, "only the preparation job may create the release tag");
assert.doesNotMatch(prepare, /secrets\.(?:CHROME|FIREFOX|EDGE)_/u, "build and tagging job must not receive browser-store credentials");
assert.match(prepare, /gh api --method POST "repos\/\$GITHUB_REPOSITORY\/git\/tags"/u, "tagging must use the runner's GitHub client without another floating action");
assert.doesNotMatch(prepare, /action-autotag/u, "tagging must not execute action-autotag's runtime npm install");

const stores = [
    {
        job: "publish-chrome",
        environment: "browser-extension-release-chrome",
        flags: ["--chrome-zip"],
        secrets: ["CHROME_EXTENSION_ID", "CHROME_PUBLISHER_ID", "CHROME_CLIENT_ID", "CHROME_CLIENT_SECRET", "CHROME_REFRESH_TOKEN"],
        forbidden: ["--firefox-", "--edge-"],
    },
    {
        job: "publish-firefox",
        environment: "browser-extension-release-firefox",
        flags: ["--firefox-zip", "--firefox-sources-zip"],
        secrets: ["FIREFOX_EXTENSION_ID", "FIREFOX_JWT_ISSUER", "FIREFOX_JWT_SECRET"],
        forbidden: ["--chrome-", "--edge-"],
    },
    {
        job: "publish-edge",
        environment: "browser-extension-release-edge",
        flags: ["--edge-zip"],
        secrets: ["EDGE_PRODUCT_ID", "EDGE_CLIENT_ID", "EDGE_API_KEY"],
        forbidden: ["--chrome-", "--firefox-"],
    },
] as const;

for (const store of stores) {
    const job = getJob(store.job);
    assert.ok(job.includes(`environment: ${store.environment}`), `${store.job} must use its store-specific protected release environment`);
    assert.match(job, /permissions:\s+contents: read/u, `${store.job} must have read-only repository permissions`);
    assert.match(job, /pnpm install --frozen-lockfile --ignore-scripts/u, `${store.job} must use the frozen dependency graph`);
    assert.match(job, /pnpm --config\.offline=true exec publish-extension/u, `${store.job} must execute only the local publisher`);
    for (const flag of store.flags) assert.ok(job.includes(flag), `${store.job} must pass ${flag}`);
    for (const flag of store.forbidden) assert.equal(job.includes(flag), false, `${store.job} must not publish another store`);

    const actualSecrets = Array.from(job.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gu), match => match[1]).sort();
    assert.deepEqual(actualSecrets, [...store.secrets].sort(), `${store.job} must receive only its own credentials`);
}

console.log("browser extension publishing workflow checks passed");
