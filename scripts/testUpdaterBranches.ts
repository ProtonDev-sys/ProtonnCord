/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
    type GitRunner,
    inspectGitUpdates,
    pullGitUpdates,
} from "../src/main/updater/gitOperations";
import {
    findHttpUpdate,
    inspectHttpUpdates,
} from "../src/main/updater/httpOperations";
import {
    parseUpdaterBranch,
    updaterReleaseEndpoint,
} from "../src/shared/Updater";

const execFile = promisify(execFileCallback);

async function run(cwd: string, ...args: string[]): Promise<{ stderr: string; stdout: string; }> {
    const result = await execFile("git", args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 30_000,
    });
    return { stderr: String(result.stderr), stdout: String(result.stdout) };
}

function runner(cwd: string): GitRunner {
    return (...args) => run(cwd, ...args);
}

async function configureRepository(repository: string): Promise<void> {
    await run(repository, "config", "user.name", "Updater Branch Test");
    await run(repository, "config", "user.email", "updater-branch-test@example.invalid");
}

async function commitFile(repository: string, filename: string, content: string, message: string): Promise<string> {
    await writeFile(join(repository, filename), content);
    await run(repository, "add", "--", filename);
    await run(repository, "commit", "-m", message);
    return (await run(repository, "rev-parse", "HEAD")).stdout.trim();
}

async function testGitBranches(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "protonn-cord-updater-branches-"));
    try {
        const remote = join(root, "remote.git");
        const seed = join(root, "seed");
        await run(root, "init", "--bare", remote);
        await run(root, "init", seed);
        await configureRepository(seed);
        const mainHead = await commitFile(seed, "state.txt", "main\n", "main");
        await run(seed, "branch", "-M", "main");
        await run(seed, "remote", "add", "origin", remote);
        await run(seed, "push", "-u", "origin", "main");
        await run(remote, "symbolic-ref", "HEAD", "refs/heads/main");

        await run(seed, "switch", "-c", "staging");
        const stagingHead = await commitFile(seed, "staging.txt", "staging\n", "staging update");
        await run(seed, "push", "-u", "origin", "staging");
        await run(seed, "switch", "main");
        await run(seed, "branch", "nightly", "staging");
        await run(seed, "push", "origin", "nightly");

        const clone = join(root, "clone");
        await run(root, "clone", remote, clone);
        await configureRepository(clone);

        const stagingInspection = await inspectGitUpdates(runner(clone), remote, mainHead, "staging");
        assert.equal(stagingInspection.branch, "staging");
        assert.equal(stagingInspection.targetHead, stagingHead);
        assert.deepEqual(stagingInspection.changes.map(change => change.hash), [stagingHead]);
        assert.equal(await pullGitUpdates(runner(clone), remote, mainHead, "staging"), true);
        assert.equal((await run(clone, "branch", "--show-current")).stdout.trim(), "staging");
        assert.equal((await run(clone, "rev-parse", "HEAD")).stdout.trim(), stagingHead);

        const mainInspection = await inspectGitUpdates(runner(clone), remote, stagingHead, "main");
        assert.equal(mainInspection.changes.length, 1);
        assert.match(mainInspection.changes[0].message, /Switch update branch to main/u);
        assert.equal(await pullGitUpdates(runner(clone), remote, stagingHead, "main"), true);
        assert.equal((await run(clone, "branch", "--show-current")).stdout.trim(), "main");
        assert.equal((await run(clone, "rev-parse", "HEAD")).stdout.trim(), mainHead);

        await writeFile(join(clone, "state.txt"), "dirty\n");
        await assert.rejects(
            pullGitUpdates(runner(clone), remote, mainHead, "staging"),
            /uncommitted changes/iu,
        );
        assert.equal(await readFile(join(clone, "state.txt"), "utf8"), "dirty\n");
        await assert.rejects(
            inspectGitUpdates(runner(clone), remote, mainHead, "beta" as never),
            /Unsupported Protonn Cord update branch/u,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
}

async function testHttpBranches(): Promise<void> {
    const currentHash = "a".repeat(40);
    const targetHash = "b".repeat(40);
    const endpoints: string[] = [];
    const release = {
        name: `Protonn Cord staging ${targetHash}`,
        assets: [{
            name: "desktop.asar",
            browser_download_url: "https://github.com/ProtonDev-sys/ProtonnCord/releases/download/staging/desktop.asar",
        }],
    };
    const inspection = await inspectHttpUpdates(async endpoint => {
        endpoints.push(endpoint);
        if (endpoint === "/releases/tags/staging") return release;
        if (endpoint === `/compare/${currentHash}...${targetHash}`) return { commits: [] };
        throw new Error(`Unexpected endpoint ${endpoint}`);
    }, currentHash, "desktop.asar", "staging");
    assert.deepEqual(endpoints, [
        "/releases/tags/staging",
        `/compare/${currentHash}...${targetHash}`,
    ]);
    assert.equal(inspection.pending?.hash, targetHash);
    assert.match(inspection.changes[0].message, /Switch update branch to staging/u);

    let nightlyEndpoint = "";
    const nightly = await findHttpUpdate(async endpoint => {
        nightlyEndpoint = endpoint;
        return {
            ...release,
            name: `Protonn Cord nightly ${targetHash}`,
            assets: [{
                name: "desktop.asar",
                browser_download_url: "https://github.com/ProtonDev-sys/ProtonnCord/releases/download/nightly/desktop.asar",
            }],
        };
    }, currentHash, "desktop.asar", "nightly");
    assert.equal(nightlyEndpoint, "/releases/tags/nightly");
    assert.equal(nightly?.hash, targetHash);
}

async function main(): Promise<void> {
    assert.equal(parseUpdaterBranch(undefined), "main");
    assert.equal(parseUpdaterBranch("staging"), "staging");
    assert.throws(() => parseUpdaterBranch("dev"), /Unsupported Protonn Cord update branch/u);
    assert.equal(updaterReleaseEndpoint("main"), "/releases/latest");
    assert.equal(updaterReleaseEndpoint("nightly"), "/releases/tags/nightly");

    await testGitBranches();
    await testHttpBranches();

    const workflow = await readFile(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
    assert.match(workflow, /- main[\s\S]*- staging[\s\S]*- nightly/u);
    assert.match(workflow, /tag="latest"/u);
    assert.match(workflow, /--prerelease/u);

    const updaterSettings = await readFile(new URL(
        "../src/components/settings/tabs/updater/index.tsx",
        import.meta.url,
    ), "utf8");
    assert.match(updaterSettings, /<Select[\s\S]*options=\{UPDATE_BRANCH_OPTIONS\}/u,
        "ProtonnCord settings must expose the update branch dropdown");
    assert.match(updaterSettings, /settings\.updateBranch = branch/u,
        "the branch dropdown must persist the locally selected channel");
    assert.match(updaterSettings, /Main \(stable\)[\s\S]*Staging \(tested previews\)[\s\S]*Nightly \(latest previews\)/u);

    console.log("updater branch-channel checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
