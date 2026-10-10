import { parseUpdaterBranch, type UpdaterBranch } from "@shared/Updater";

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

interface GitUpdateState extends GitUpdateInspection {
    currentBranch: string | null;
    currentHead: string;
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

async function currentBranch(git: GitRunner): Promise<string | null> {
    return (await git("branch", "--show-current")).stdout.trim() || null;
}

async function localBranchExists(git: GitRunner, branch: string): Promise<boolean> {
    const refs = (await git(
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${branch}`,
    )).stdout.split("\n").map(value => value.trim());
    return refs.includes(`refs/heads/${branch}`);
}

async function requireCleanTree(git: GitRunner): Promise<void> {
    const dirty = (await git("status", "--porcelain=v1", "--untracked-files=all")).stdout.trim();
    if (dirty)
        throw new Error("The Protonn Cord source tree has uncommitted changes; commit or stash them before updating");
}

async function resolveBuiltHead(git: GitRunner, hash: string): Promise<string | null> {
    if (!/^[a-f0-9]{7,64}$/u.test(hash)) return null;
    try {
        return (await git("rev-parse", "--verify", "--quiet", "--end-of-options", `${hash}^{commit}`)).stdout.trim();
    } catch (error) {
        // A shallow or replaced checkout may no longer have the running build's
        // commit. Other Git failures must still be reported instead of hidden.
        if (error && typeof error === "object" && "code" in error && error.code === 1) return null;
        throw error;
    }
}

async function fetchUpdateBranch(
    git: GitRunner,
    repository: string,
    selectedBranch?: UpdaterBranch,
): Promise<GitUpdateState> {
    const current = await currentBranch(git);
    if (selectedBranch === undefined && !current)
        throw new Error("The Protonn Cord updater cannot run from a detached Git HEAD");

    const branch = selectedBranch === undefined ? current! : parseUpdaterBranch(selectedBranch);
    const currentHead = (await git("rev-parse", "HEAD")).stdout.trim();
    const remoteBranch = `refs/heads/${branch}`;
    const remote = (await git("ls-remote", "--heads", repository, remoteBranch)).stdout.trim();
    if (!remote)
        throw new Error(`Branch ${branch} is not available in the Protonn Cord update repository`);
    const [remoteHead, remoteRef] = remote.split(/\s+/u);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(remoteHead) || remoteRef !== remoteBranch)
        throw new Error("Git returned an invalid update branch");

    // Pin the advertised commit before fetching: another Git client can replace
    // FETCH_HEAD at any time, including between our fetch and the next command.
    await git("fetch", "--no-tags", repository, remoteBranch);
    const direction = parseDirection((await git(
        "rev-list",
        "--left-right",
        "--count",
        `${currentHead}...${remoteHead}`,
    )).stdout);

    const sameBranch = current === branch;
    if (sameBranch && direction.localOnly > 0 && direction.remoteOnly > 0)
        throw new Error(`Branch ${branch} has diverged from Protonn Cord; rebase or merge it manually before updating`);

    const targetHead = sameBranch && direction.remoteOnly === 0 ? currentHead : remoteHead;
    return {
        branch,
        changes: [],
        currentBranch: current,
        currentHead,
        localOnly: direction.localOnly,
        remoteOnly: direction.remoteOnly,
        targetHead,
    };
}

export async function inspectGitUpdates(
    git: GitRunner,
    repository: string,
    lastBuiltHead: string,
    selectedBranch?: UpdaterBranch,
): Promise<GitUpdateInspection> {
    const state = await fetchUpdateBranch(git, repository, selectedBranch);
    const builtHead = state.targetHead === lastBuiltHead ? lastBuiltHead : await resolveBuiltHead(git, lastBuiltHead);
    let changes = state.targetHead === builtHead || builtHead === null
        ? []
        : parseChanges((await git(
            "log",
            `${builtHead}..${state.targetHead}`,
            "-z",
            `--pretty=format:${COMMIT_FORMAT}`,
        )).stdout);

    if (state.targetHead !== builtHead && changes.length === 0) {
        changes = [{
            author: "ProtonnCord",
            hash: state.targetHead,
            message: builtHead === null
                ? `Rebuild from ${state.branch}; the previous build commit is unavailable in this checkout`
                : `Switch update branch to ${state.branch}`,
        }];
    }

    const { currentBranch: _currentBranch, currentHead: _currentHead, ...inspection } = state;
    return { ...inspection, changes };
}

export async function pullGitUpdates(
    git: GitRunner,
    repository: string,
    lastBuiltHead: string,
    selectedBranch?: UpdaterBranch,
): Promise<boolean> {
    const state = await fetchUpdateBranch(git, repository, selectedBranch);
    const before = (await git("rev-parse", "HEAD")).stdout.trim();
    const beforeBranch = await currentBranch(git);
    if (before !== state.currentHead || beforeBranch !== state.currentBranch)
        throw new Error("The source checkout changed while checking for updates. Check for updates again.");

    if (state.currentBranch === state.branch) {
        if (state.remoteOnly > 0) {
            await requireCleanTree(git);
            await git("merge", "--ff-only", state.targetHead);
        }
    } else {
        await requireCleanTree(git);
        if (await localBranchExists(git, state.branch)) {
            const targetDirection = parseDirection((await git(
                "rev-list",
                "--left-right",
                "--count",
                `refs/heads/${state.branch}...${state.targetHead}`,
            )).stdout);
            if (targetDirection.localOnly > 0)
                throw new Error(`Local branch ${state.branch} has unpublished or divergent commits; reconcile it manually before switching update branches`);

            await git("switch", state.branch);
            if (targetDirection.remoteOnly > 0) await git("merge", "--ff-only", state.targetHead);
        } else {
            await git("switch", "--create", state.branch, state.targetHead);
        }
    }

    const after = (await git("rev-parse", "HEAD")).stdout.trim();
    const afterBranch = await currentBranch(git);
    return before !== after || beforeBranch !== afterBranch || lastBuiltHead !== after;
}
