/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface GitChange {
    author: string;
    hash: string;
    message: string;
}

export interface GitCommandResult {
    stderr: string;
    stdout: string;
}

export type GitRunner = (...args: string[]) => Promise<GitCommandResult>;

export interface GitUpdateInspection {
    branch: string;
    changes: GitChange[];
    localOnly: number;
    remoteOnly: number;
    targetHead: string;
}

const COMMIT_FORMAT = "%an%x00%H%x00%s";

function parseDirection(value: string): { localOnly: number; remoteOnly: number; } {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(value);
    if (!match) throw new Error("Git returned an invalid branch comparison");
    return { localOnly: Number(match[1]), remoteOnly: Number(match[2]) };
}

function parseChanges(value: string): GitChange[] {
    const fields = value.split("\0");
    if (fields.at(-1) === "") fields.pop();
    if (fields.length % 3 !== 0) throw new Error("Git returned an invalid update log");

    const changes: GitChange[] = [];
    for (let index = 0; index < fields.length; index += 3) {
        changes.push({ author: fields[index], hash: fields[index + 1], message: fields[index + 2] });
    }
    return changes;
}

async function currentBranch(git: GitRunner): Promise<string> {
    const branch = (await git("branch", "--show-current")).stdout.trim();
    if (!branch) throw new Error("The Protonn Cord updater cannot run from a detached Git HEAD");
    return branch;
}

async function fetchUpdateBranch(git: GitRunner, repository: string): Promise<{
    branch: string;
    localOnly: number;
    remoteOnly: number;
    targetHead: string;
    targetRevision: "FETCH_HEAD" | "HEAD";
}> {
    const branch = await currentBranch(git);
    const remoteBranch = `refs/heads/${branch}`;
    const remote = (await git("ls-remote", "--heads", repository, remoteBranch)).stdout.trim();
    if (!remote)
        throw new Error(`Branch ${branch} is not available in the Protonn Cord update repository`);

    await git("fetch", "--no-tags", repository, remoteBranch);
    const { localOnly, remoteOnly } = parseDirection((await git(
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...FETCH_HEAD",
    )).stdout);
    if (localOnly > 0 && remoteOnly > 0)
        throw new Error(`Branch ${branch} has diverged from Protonn Cord; rebase or merge it manually before updating`);

    const targetRevision = remoteOnly > 0 ? "FETCH_HEAD" : "HEAD";
    const targetHead = (await git("rev-parse", targetRevision)).stdout.trim();
    return { branch, localOnly, remoteOnly, targetHead, targetRevision };
}

export async function inspectGitUpdates(
    git: GitRunner,
    repository: string,
    lastBuiltHead: string,
): Promise<GitUpdateInspection> {
    const state = await fetchUpdateBranch(git, repository);
    const changes = state.targetHead === lastBuiltHead
        ? []
        : parseChanges((await git("log", `${lastBuiltHead}..${state.targetRevision}`, "-z", `--pretty=format:${COMMIT_FORMAT}`)).stdout);
    return { ...state, changes };
}

export async function pullGitUpdates(
    git: GitRunner,
    repository: string,
    lastBuiltHead: string,
): Promise<boolean> {
    const state = await fetchUpdateBranch(git, repository);
    const before = (await git("rev-parse", "HEAD")).stdout.trim();
    if (state.remoteOnly > 0) {
        const dirty = (await git("status", "--porcelain=v1", "--untracked-files=all")).stdout.trim();
        if (dirty)
            throw new Error("The Protonn Cord source tree has uncommitted changes; commit or stash them before updating");
        await git("pull", "--ff-only", repository, state.branch);
    }
    const after = (await git("rev-parse", "HEAD")).stdout.trim();
    return before !== after || lastBuiltHead !== after;
}
