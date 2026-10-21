/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const generateCatalog = `
const { globPlugins, IS_DEV, IS_REPORTER, IS_NIGHTLY } = await import("./scripts/build/common.mjs");
let load;
globPlugins("web").setup({ onResolve() {}, onLoad(_options, callback) { load = callback; } });
if (!load) throw new Error("Production plugin loader was not registered");
const { contents } = await load({ path: "~plugins", namespace: "import-plugins" });
process.stdout.write(JSON.stringify({ contents, IS_DEV, IS_REPORTER, IS_NIGHTLY }));
`;

async function main() {
    const { getBuildChannel } = await import(new URL("./build/common.mjs", import.meta.url).href);
    const github = { GITHUB_ACTIONS: "true", CI: "true" };
    const cases: [NodeJS.ProcessEnv, string | null][] = [
        ...["main", "staging", "nightly"].map(channel => [{ ...github, GITHUB_REF: `refs/heads/${channel}` }, channel] as [NodeJS.ProcessEnv, string]),
        [{ ...github, GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "nightly", GITHUB_REF: "refs/pull/42/merge" }, "nightly"],
        [{ ...github, GITHUB_EVENT_NAME: "pull_request_target", GITHUB_BASE_REF: "main", GITHUB_REF: "refs/heads/nightly" }, "main"],
        [{ ...github, GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "feature", GITHUB_REF: "refs/heads/nightly" }, null],
        [{ ...github, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/nightly" }, null],
        [{ ...github, GITHUB_REF: "refs/tags/nightly" }, null],
        [{ ...github, GITHUB_REF: "refs/pull/42/merge" }, null],
        [{ ...github, GITHUB_REF: "refs/heads/feature" }, null],
        [{ ...github }, null],
        [{ CI: "true" }, null],
        ...["main", "staging", "nightly"].map(channel => [{ ...github, PROTONN_CORD_BUILD_CHANNEL: channel, GITHUB_REF: "refs/tags/irrelevant" }, channel] as [NodeJS.ProcessEnv, string]),
    ];
    for (const [env, expected] of cases) {
        let localReads = 0;
        assert.equal(getBuildChannel(env, () => { localReads++; return "nightly"; }), expected, JSON.stringify(env));
        assert.equal(localReads, 0, "CI and explicit overrides must never infer a local branch");
    }
    for (const branch of ["main", "staging", "nightly", "feature", "", "HEAD"]) {
        assert.equal(getBuildChannel({}, () => branch), ["main", "staging", "nightly"].includes(branch) ? branch : null);
    }
    assert.equal(getBuildChannel({}, () => { throw new Error("git unavailable"); }), null);
    for (const invalid of ["", "stable", "Nightly", " nightly "]) {
        assert.throws(() => getBuildChannel({ PROTONN_CORD_BUILD_CHANNEL: invalid }, () => "nightly"));
    }

    // Spawn genuine builds' catalog generation so module-level environment and
    // command-line flags are re-evaluated; no filter implementation is duplicated.
    const variants: [string, string[], boolean][] = [
        ["nightly", [], true], ["main", [], false], ["staging", [], false],
        ["main", ["--dev"], true], ["main", ["--reporter"], true],
    ];
    for (const [channel, flags, included] of variants) {
        const child = spawnSync(process.execPath, ["--input-type=module", "-", ...flags], {
            cwd: projectRoot, input: generateCatalog, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, PROTONN_CORD_BUILD_CHANNEL: channel },
        });
        assert.ifError(child.error);
        assert.equal(child.status, 0, `${channel} ${flags.join(" ")}: ${child.stderr}`);
        const result = JSON.parse(child.stdout);
        assert.equal(result.IS_NIGHTLY, channel === "nightly");
        assert.equal(result.IS_DEV, flags.includes("--dev"));
        assert.equal(result.IS_REPORTER, flags.includes("--reporter"));
        const path = '"./equicordplugins/messageCompression.nightly"';
        const hasLoader = result.contents.includes(`require(${path}).default`) || result.contents.includes(`from ${path};`);
        assert.equal(hasLoader, included, `${channel} ${flags.join(" ")}: actual MessageCompression import/loader eligibility`);
        const match = result.contents.match(/export const ExcludedPlugins=(\{[\s\S]*?\});/);
        assert.ok(match, "the production catalog must export its exclusion map");
        const excluded = JSON.parse(match[1].replace(/,\s*\}/, "}"));
        assert.equal(excluded.MessageCompression, included ? undefined : "nightly", "stable exclusion must name the nightly target");
    }
    console.log("Nightly channel resolution and production plugin-catalog boundaries passed.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
