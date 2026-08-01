/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
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

async function configureRepository(path: string): Promise<void> {
    await run(path, "config", "user.name", "Updater Test");
    await run(path, "config", "user.email", "updater-test@example.invalid");
}

async function commitFile(path: string, filename: string, content: string, message: string): Promise<string> {
    await writeFile(join(path, filename), content);
    await run(path, "add", "--", filename);
    await run(path, "commit", "-m", message);
    return (await run(path, "rev-parse", "HEAD")).stdout.trim();
}

async function main(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "protonn-cord-updater-"));
    try {
        const remote = join(root, "remote.git");
        const seed = join(root, "seed");
        await run(root, "init", "--bare", remote);
        await run(root, "init", seed);
        await configureRepository(seed);
        const initialHead = await commitFile(seed, "state.txt", "initial\n", "initial");
        await run(seed, "branch", "-M", "main");
        await run(seed, "remote", "add", "origin", remote);
        await run(seed, "push", "-u", "origin", "main");
        await run(remote, "symbolic-ref", "HEAD", "refs/heads/main");

        const clone = async (name: string): Promise<string> => {
            const path = join(root, name);
            await run(root, "clone", remote, path);
            await configureRepository(path);
            return path;
        };

        const current = await clone("current");
        const currentInspection = await inspectGitUpdates(runner(current), remote, initialHead);
        assert.deepEqual(currentInspection.changes, []);
        assert.equal(currentInspection.localOnly, 0);
        assert.equal(currentInspection.remoteOnly, 0);
        assert.equal(await pullGitUpdates(runner(current), remote, initialHead), false);

        const behind = await clone("behind");
        const remoteHead = await commitFile(seed, "state.txt", "remote update\n", "remote update");
        await run(seed, "push", "origin", "main");
        const behindInspection = await inspectGitUpdates(runner(behind), remote, initialHead);
        assert.equal(behindInspection.localOnly, 0);
        assert.equal(behindInspection.remoteOnly, 1);
        assert.deepEqual(behindInspection.changes.map(change => change.hash), [remoteHead]);
        assert.equal(await pullGitUpdates(runner(behind), remote, initialHead), true);
        assert.equal((await run(behind, "rev-parse", "HEAD")).stdout.trim(), remoteHead);
        assert.equal((await readFile(join(behind, "state.txt"), "utf8")).replaceAll("\r\n", "\n"), "remote update\n");
        assert.equal((await inspectGitUpdates(runner(behind), remote, initialHead)).changes.length, 1, "a pulled but unbuilt checkout remains rebuild-pending");
        assert.deepEqual((await inspectGitUpdates(runner(behind), remote, remoteHead)).changes, []);
        assert.equal(await pullGitUpdates(runner(behind), remote, remoteHead), false);

        const ahead = await clone("ahead");
        const aheadBuiltHead = (await run(ahead, "rev-parse", "HEAD")).stdout.trim();
        const localHead = await commitFile(ahead, "local.txt", "local\n", "local update");
        const aheadInspection = await inspectGitUpdates(runner(ahead), remote, aheadBuiltHead);
        assert.equal(aheadInspection.localOnly, 1);
        assert.equal(aheadInspection.remoteOnly, 0);
        assert.deepEqual(aheadInspection.changes.map(change => change.hash), [localHead]);
        assert.equal(await pullGitUpdates(runner(ahead), remote, aheadBuiltHead), true, "a local source commit made after the active build requests one rebuild");
        assert.deepEqual((await inspectGitUpdates(runner(ahead), remote, localHead)).changes, []);
        assert.equal(await pullGitUpdates(runner(ahead), remote, localHead), false);

        const diverged = await clone("diverged");
        const divergedBuiltHead = (await run(diverged, "rev-parse", "HEAD")).stdout.trim();
        await commitFile(diverged, "local-diverged.txt", "local\n", "local divergence");
        await commitFile(seed, "remote-diverged.txt", "remote\n", "remote divergence");
        await run(seed, "push", "origin", "main");
        await assert.rejects(
            inspectGitUpdates(runner(diverged), remote, divergedBuiltHead),
            /diverged/iu,
        );

        const dirty = await clone("dirty");
        const dirtyBuiltHead = (await run(dirty, "rev-parse", "HEAD")).stdout.trim();
        await commitFile(seed, "dirty-remote.txt", "remote\n", "dirty-tree remote update");
        await run(seed, "push", "origin", "main");
        await writeFile(join(dirty, "state.txt"), "local dirty content\n");
        await assert.rejects(
            pullGitUpdates(runner(dirty), remote, dirtyBuiltHead),
            /uncommitted changes/iu,
        );
        assert.equal(await readFile(join(dirty, "state.txt"), "utf8"), "local dirty content\n");
        assert.equal((await run(dirty, "rev-parse", "HEAD")).stdout.trim(), dirtyBuiltHead);

        const missingBranch = await clone("missing-branch");
        await run(missingBranch, "switch", "-c", "local-only");
        await assert.rejects(
            inspectGitUpdates(runner(missingBranch), remote, (await run(missingBranch, "rev-parse", "HEAD")).stdout.trim()),
            /not available/iu,
        );

        const detached = await clone("detached");
        await run(detached, "checkout", "--detach");
        await assert.rejects(
            inspectGitUpdates(runner(detached), remote, (await run(detached, "rev-parse", "HEAD")).stdout.trim()),
            /detached/iu,
        );

        console.log("git updater repository-state matrix passed");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
