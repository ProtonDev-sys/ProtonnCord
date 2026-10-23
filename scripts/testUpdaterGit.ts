import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
    inspectGitUpdates,
    pullGitUpdates,
} from "../src/main/updater/gitOperations";
import { commitFile, run, runner } from "./utils/gitFixture";

async function configureRepository(path: string): Promise<void> {
    await run(path, "config", "user.name", "Updater Test");
    await run(path, "config", "user.email", "updater-test@example.invalid");
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
        assert.deepEqual((await inspectGitUpdates(runner(current), remote, initialHead.slice(0, 7))).changes, [],
            "abbreviated build hashes resolve to the same installed commit");
        assert.equal(await pullGitUpdates(runner(current), remote, initialHead.slice(0, 7)), false,
            "an abbreviated installed hash must not request a redundant rebuild");
        const missingBuiltHead = "0".repeat(40);
        const missingBuild = await inspectGitUpdates(runner(current), remote, missingBuiltHead);
        assert.equal(missingBuild.changes.length, 1);
        assert.equal(missingBuild.changes[0].hash, initialHead);
        assert.match(missingBuild.changes[0].message, /previous build commit is unavailable/u);
        assert.equal(await pullGitUpdates(runner(current), remote, missingBuiltHead), true,
            "a missing build commit requests a recoverable rebuild");
        const unavailableGit = Object.assign(new Error("Git executable unavailable"), { code: "ENOENT" });
        await assert.rejects(
            inspectGitUpdates(async (...args) => {
                if (args.includes("--verify")) throw unavailableGit;
                return run(current, ...args);
            }, remote, missingBuiltHead),
            error => error === unavailableGit,
            "unrelated Git failures must not be treated as a missing build commit",
        );

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

        const concurrentFetch = await clone("concurrent-fetch");
        const fetchBuiltHead = (await run(concurrentFetch, "rev-parse", "HEAD")).stdout.trim();
        const expectedHead = await commitFile(seed, "expected.txt", "expected\n", "expected update");
        await run(seed, "push", "origin", "main");
        await run(seed, "switch", "-c", "nightly");
        const unrelatedHead = await commitFile(seed, "unrelated.txt", "unrelated\n", "different branch update");
        await run(seed, "push", "origin", "nightly");
        await run(seed, "switch", "main");
        const overwriteFetchHead = (branch: string) => async (...args: string[]) => {
            const result = await run(concurrentFetch, ...args);
            if (args[0] === "fetch") await run(concurrentFetch, "fetch", "--no-tags", remote, `refs/heads/${branch}`);
            return result;
        };
        assert.equal((await inspectGitUpdates(overwriteFetchHead("nightly"), remote, fetchBuiltHead, "main")).targetHead, expectedHead,
            "an external fetch cannot replace the advertised update commit");
        await pullGitUpdates(overwriteFetchHead("nightly"), remote, fetchBuiltHead, "main");
        assert.equal((await run(concurrentFetch, "rev-parse", "HEAD")).stdout.trim(), expectedHead);
        await pullGitUpdates(overwriteFetchHead("main"), remote, expectedHead, "nightly");
        assert.equal((await run(concurrentFetch, "rev-parse", "HEAD")).stdout.trim(), unrelatedHead,
            "branch switches also use the pinned commit instead of FETCH_HEAD");

        const concurrentCheckout = await clone("concurrent-checkout");
        const checkoutBuiltHead = (await run(concurrentCheckout, "rev-parse", "HEAD")).stdout.trim();
        await commitFile(seed, "checkout-update.txt", "update\n", "checkout race update");
        await run(seed, "push", "origin", "main");
        await assert.rejects(pullGitUpdates(async (...args) => {
            const result = await run(concurrentCheckout, ...args);
            if (args[0] === "fetch") await run(concurrentCheckout, "switch", "-c", "work-in-progress");
            return result;
        }, remote, checkoutBuiltHead, "main"), /checkout changed/iu);
        assert.equal((await run(concurrentCheckout, "branch", "--show-current")).stdout.trim(), "work-in-progress");
        assert.equal((await run(concurrentCheckout, "rev-parse", "HEAD")).stdout.trim(), checkoutBuiltHead,
            "updates never merge into a branch selected by another Git client during the fetch");

        const statusRace = await clone("status-race");
        const statusBuiltHead = (await run(statusRace, "rev-parse", "HEAD")).stdout.trim();
        await commitFile(seed, "status-race.txt", "remote\n", "status race update");
        await run(seed, "push", "origin", "main");
        await assert.rejects(pullGitUpdates(async (...args) => {
            const result = await run(statusRace, ...args);
            if (args[0] === "status") await run(statusRace, "switch", "-c", "editing");
            return result;
        }, remote, statusBuiltHead, "main"), /checkout changed/u);
        assert.equal((await run(statusRace, "rev-parse", "HEAD")).stdout.trim(), statusBuiltHead);

        const ignored = await clone("ignored-merge");
        const ignoredHead = (await run(ignored, "rev-parse", "HEAD")).stdout.trim();
        await writeFile(join(ignored, ".git", "info", "exclude"), "ignored-*.txt\n");
        await writeFile(join(ignored, "ignored-merge.txt"), "precious ignored work\n");
        await commitFile(seed, "ignored-merge.txt", "remote tracked content\n", "new tracked file");
        await run(seed, "push", "origin", "main");
        await assert.rejects(pullGitUpdates(runner(ignored), remote, ignoredHead, "main"), /overwritten|untracked/u);
        assert.equal(await readFile(join(ignored, "ignored-merge.txt"), "utf8"), "precious ignored work\n");
        assert.equal((await run(ignored, "rev-parse", "HEAD")).stdout.trim(), ignoredHead);

        const ignoredSwitch = await clone("ignored-switch");
        const switchHead = (await run(ignoredSwitch, "rev-parse", "HEAD")).stdout.trim();
        await writeFile(join(ignoredSwitch, ".git", "info", "exclude"), "ignored-*.txt\n");
        await writeFile(join(ignoredSwitch, "ignored-switch.txt"), "precious branch work\n");
        await run(seed, "switch", "nightly");
        await commitFile(seed, "ignored-switch.txt", "nightly tracked content\n", "nightly tracked file");
        await run(seed, "push", "origin", "nightly");
        await run(seed, "switch", "main");
        await assert.rejects(pullGitUpdates(runner(ignoredSwitch), remote, switchHead, "nightly"), /overwritten|untracked/u);
        assert.equal(await readFile(join(ignoredSwitch, "ignored-switch.txt"), "utf8"), "precious branch work\n");
        assert.equal((await run(ignoredSwitch, "branch", "--show-current")).stdout.trim(), "main");

        const rollback = await clone("branch-rollback");
        const rollbackHead = (await run(rollback, "rev-parse", "HEAD")).stdout.trim();
        await run(rollback, "branch", "nightly", initialHead);
        for (const detached of [false, true]) {
            if (detached) await run(rollback, "switch", "--detach");
            const busyMerge = async (...args: string[]) => {
                if (args[0] === "merge") throw new Error("fixture fast-forward failed: locked source file");
                return run(rollback, ...args);
            };
            await assert.rejects(pullGitUpdates(busyMerge, remote, rollbackHead, "nightly"), /locked source file/u);
            assert.equal((await run(rollback, "branch", "--show-current")).stdout.trim(), detached ? "" : "main");
            assert.equal((await run(rollback, "rev-parse", "HEAD")).stdout.trim(), rollbackHead);
            assert.equal((await run(rollback, "rev-parse", "refs/heads/nightly")).stdout.trim(), initialHead);
        }

        await assert.rejects(pullGitUpdates(async (...args) => {
            if (args[0] === "merge") {
                await writeFile(join(rollback, "state.txt"), "precious concurrent edits\n");
                throw new Error("fixture merge failed after concurrent edits");
            }
            return run(rollback, ...args);
        }, remote, rollbackHead, "nightly"), /original source branch could not be restored/u);
        assert.equal(await readFile(join(rollback, "state.txt"), "utf8"), "precious concurrent edits\n",
            "branch recovery never discards edits made by another Git client");
        assert.equal((await run(rollback, "rev-parse", "refs/heads/main")).stdout.trim(), rollbackHead);

        await run(seed, "branch", "staging");
        await run(seed, "push", "origin", "staging");
        const checkoutHook = await clone("failed-checkout-hook");
        const hookHead = (await run(checkoutHook, "rev-parse", "HEAD")).stdout.trim();
        await assert.rejects(pullGitUpdates(async (...args) => {
            const result = await run(checkoutHook, ...args);
            if (args[0] === "switch" && args.includes("--create")) throw new Error("fixture post-checkout hook failed");
            return result;
        }, remote, hookHead, "staging"), /post-checkout hook failed/u);
        assert.equal((await run(checkoutHook, "branch", "--show-current")).stdout.trim(), "main");
        assert.equal((await run(checkoutHook, "rev-parse", "HEAD")).stdout.trim(), hookHead);

        console.log("git updater repository-state matrix passed");
    } finally {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(basename(root).startsWith("protonn-cord-updater-"));
        await rm(root, { force: true, recursive: true });
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
