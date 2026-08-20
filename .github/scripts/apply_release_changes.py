from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def path(name: str) -> Path:
    return ROOT / name


def read(name: str) -> str:
    return path(name).read_text(encoding="utf-8")


def write(name: str, content: str) -> None:
    target = path(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(name: str, old: str, new: str) -> None:
    content = read(name)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {name}, found {count}: {old[:120]!r}")
    write(name, content.replace(old, new, 1))


def replace_between(name: str, start_marker: str, end_marker: str, replacement: str) -> None:
    content = read(name)
    start = content.find(start_marker)
    if start == -1:
        raise RuntimeError(f"Missing start marker in {name}: {start_marker!r}")
    end = content.find(end_marker, start)
    if end == -1:
        raise RuntimeError(f"Missing end marker in {name}: {end_marker!r}")
    write(name, content[:start] + replacement + content[end:])


write("src/shared/Updater.ts", '''/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const UPDATER_BRANCHES = ["main", "staging", "nightly"] as const;
export type UpdaterBranch = typeof UPDATER_BRANCHES[number];

const updaterBranchSet = new Set<string>(UPDATER_BRANCHES);

export function isUpdaterBranch(value: unknown): value is UpdaterBranch {
    return typeof value === "string" && updaterBranchSet.has(value);
}

export function parseUpdaterBranch(value: unknown): UpdaterBranch {
    if (value === undefined) return "main";
    if (!isUpdaterBranch(value)) throw new Error("Unsupported Protonn Cord update branch");
    return value;
}

export function updaterReleaseEndpoint(branch: UpdaterBranch): string {
    return branch === "main" ? "/releases/latest" : `/releases/tags/${branch}`;
}

export interface UpdaterDiagnostics {
    backend: "disabled" | "git" | "http";
    branch: UpdaterBranch | null;
    builtHead: string;
    sourceRoot: string | null;
}
''')

write("src/main/updater/gitOperations.ts", '''/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
    targetRevision: "FETCH_HEAD" | "HEAD";
}

const COMMIT_FORMAT = "%an%x00%H%x00%s";

function parseDirection(value: string): { localOnly: number; remoteOnly: number; } {
    const match = /^\\s*(\\d+)\\s+(\\d+)\\s*$/u.exec(value);
    if (!match) throw new Error("Git returned an invalid branch comparison");
    return { localOnly: Number(match[1]), remoteOnly: Number(match[2]) };
}

function parseChanges(value: string): GitChange[] {
    const fields = value.split("\\0");
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
    )).stdout.split("\\n").map(value => value.trim());
    return refs.includes(`refs/heads/${branch}`);
}

async function requireCleanTree(git: GitRunner): Promise<void> {
    const dirty = (await git("status", "--porcelain=v1", "--untracked-files=all")).stdout.trim();
    if (dirty)
        throw new Error("The Protonn Cord source tree has uncommitted changes; commit or stash them before updating");
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
    const remoteBranch = `refs/heads/${branch}`;
    const remote = (await git("ls-remote", "--heads", repository, remoteBranch)).stdout.trim();
    if (!remote)
        throw new Error(`Branch ${branch} is not available in the Protonn Cord update repository`);

    await git("fetch", "--no-tags", repository, remoteBranch);
    const direction = parseDirection((await git(
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...FETCH_HEAD",
    )).stdout);

    const sameBranch = current === branch;
    if (sameBranch && direction.localOnly > 0 && direction.remoteOnly > 0)
        throw new Error(`Branch ${branch} has diverged from Protonn Cord; rebase or merge it manually before updating`);

    const targetRevision = sameBranch && direction.remoteOnly === 0 ? "HEAD" : "FETCH_HEAD";
    const targetHead = (await git("rev-parse", targetRevision)).stdout.trim();
    return {
        branch,
        changes: [],
        currentBranch: current,
        localOnly: direction.localOnly,
        remoteOnly: direction.remoteOnly,
        targetHead,
        targetRevision,
    };
}

export async function inspectGitUpdates(
    git: GitRunner,
    repository: string,
    lastBuiltHead: string,
    selectedBranch?: UpdaterBranch,
): Promise<GitUpdateInspection> {
    const state = await fetchUpdateBranch(git, repository, selectedBranch);
    let changes = state.targetHead === lastBuiltHead
        ? []
        : parseChanges((await git(
            "log",
            `${lastBuiltHead}..${state.targetRevision}`,
            "-z",
            `--pretty=format:${COMMIT_FORMAT}`,
        )).stdout);

    if (state.targetHead !== lastBuiltHead && changes.length === 0) {
        changes = [{
            author: "ProtonnCord",
            hash: state.targetHead,
            message: `Switch update branch to ${state.branch}`,
        }];
    }

    const { currentBranch: _currentBranch, targetRevision: _targetRevision, ...inspection } = state;
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

    if (state.currentBranch === state.branch) {
        if (state.remoteOnly > 0) {
            await requireCleanTree(git);
            await git("merge", "--ff-only", "FETCH_HEAD");
        }
    } else {
        await requireCleanTree(git);
        if (await localBranchExists(git, state.branch)) {
            const targetDirection = parseDirection((await git(
                "rev-list",
                "--left-right",
                "--count",
                `refs/heads/${state.branch}...FETCH_HEAD`,
            )).stdout);
            if (targetDirection.localOnly > 0)
                throw new Error(`Local branch ${state.branch} has unpublished or divergent commits; reconcile it manually before switching update branches`);

            await git("switch", state.branch);
            if (targetDirection.remoteOnly > 0) await git("merge", "--ff-only", "FETCH_HEAD");
        } else {
            await git("switch", "--create", state.branch, "FETCH_HEAD");
        }
    }

    const after = (await git("rev-parse", "HEAD")).stdout.trim();
    const afterBranch = await currentBranch(git);
    return before !== after || beforeBranch !== afterBranch || lastBuiltHead !== after;
}
''')

write("src/components/settings/tabs/plugins/newPluginRelease.ts", '''/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface NewPluginRelease {
    plugins: readonly string[];
    version: string;
}

export const NEW_PLUGIN_RELEASE = {
    plugins: ["AutoJumpToMessage", "WebPWA"],
    version: "1.15.1.1",
} as const satisfies NewPluginRelease;

export function getReleaseNewPlugins(
    version: string,
    availablePluginNames: Iterable<string>,
): Set<string> | null {
    if (version !== NEW_PLUGIN_RELEASE.version) return null;

    const available = new Set(availablePluginNames);
    const plugins = NEW_PLUGIN_RELEASE.plugins.filter(plugin => available.has(plugin));
    return plugins.length > 0 ? new Set(plugins) : null;
}
''')

write("scripts/testPluginReleaseMarkers.ts", '''/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    getReleaseNewPlugins,
    NEW_PLUGIN_RELEASE,
} from "../src/components/settings/tabs/plugins/newPluginRelease";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(NEW_PLUGIN_RELEASE.version, packageJson.version, "the New marker manifest must be updated with every version bump");
assert.deepEqual(
    [...getReleaseNewPlugins(packageJson.version, ["AutoJumpToMessage", "WebPWA", "SecureMessaging"])!].sort(),
    ["AutoJumpToMessage", "WebPWA"],
);
assert.equal(getReleaseNewPlugins("1.15.1.2", ["AutoJumpToMessage", "WebPWA"]), null,
    "New markers must disappear as soon as the release version is bumped");
assert.deepEqual([...getReleaseNewPlugins(packageJson.version, ["AutoJumpToMessage"])!], ["AutoJumpToMessage"],
    "plugins excluded from the current client target must not create phantom cards");

const pluginSettings = readFileSync(new URL(
    "../src/components/settings/tabs/plugins/index.tsx",
    import.meta.url,
), "utf8");
assert.doesNotMatch(pluginSettings, /Vencord_existingPlugins|60\\s*\\*\\s*60\\s*\\*\\s*24\\s*\\*\\s*2/u,
    "the old time-based New marker cache must not return");
assert.match(pluginSettings, /getReleaseNewPlugins\\(VERSION/u);
assert.match(readFileSync(new URL(
    "../src/equicordplugins/autoJumpToMessage/index.ts",
    import.meta.url,
), "utf8"), /name:\s*"AutoJumpToMessage"/u);
assert.match(readFileSync(new URL(
    "../src/plugins/webPWA.browser/index.tsx",
    import.meta.url,
), "utf8"), /name:\s*"WebPWA"/u);

console.log("release-scoped plugin New marker checks passed");
''')

write("scripts/testUpdaterBranches.ts", '''/*
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
        const mainHead = await commitFile(seed, "state.txt", "main\\n", "main");
        await run(seed, "branch", "-M", "main");
        await run(seed, "remote", "add", "origin", remote);
        await run(seed, "push", "-u", "origin", "main");
        await run(remote, "symbolic-ref", "HEAD", "refs/heads/main");

        await run(seed, "switch", "-c", "staging");
        const stagingHead = await commitFile(seed, "staging.txt", "staging\\n", "staging update");
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

        await writeFile(join(clone, "state.txt"), "dirty\\n");
        await assert.rejects(
            pullGitUpdates(runner(clone), remote, mainHead, "staging"),
            /uncommitted changes/iu,
        );
        assert.equal(await readFile(join(clone, "state.txt"), "utf8"), "dirty\\n");
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
    assert.match(workflow, /- main[\\s\\S]*- staging[\\s\\S]*- nightly/u);
    assert.match(workflow, /tag="latest"/u);
    assert.match(workflow, /--prerelease/u);
    console.log("updater branch-channel checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
''')

# Settings schema and defaults.
replace_once(
    "src/api/Settings.ts",
    'import { SettingsStore as SettingsStoreClass } from "@shared/SettingsStore";\n',
    'import { SettingsStore as SettingsStoreClass } from "@shared/SettingsStore";\nimport type { UpdaterBranch } from "@shared/Updater";\n',
)
replace_once(
    "src/api/Settings.ts",
    '    autoUpdateNotification: boolean;\n    useQuickCss: boolean;\n',
    '    autoUpdateNotification: boolean;\n    updateBranch: UpdaterBranch;\n    useQuickCss: boolean;\n',
)
replace_once(
    "src/api/Settings.ts",
    '    autoUpdateNotification: true,\n    useQuickCss: true,\n',
    '    autoUpdateNotification: true,\n    updateBranch: "main",\n    useQuickCss: true,\n',
)

# Native bridge, including backwards-compatible defaults for direct callers.
replace_once(
    "src/VencordNative.ts",
    'import type { UpdaterDiagnostics } from "@shared/Updater";\n',
    'import type { UpdaterBranch, UpdaterDiagnostics } from "@shared/Updater";\n',
)
replace_once(
    "src/VencordNative.ts",
    '''    updater: {
        getDiagnostics: () => invoke<IpcRes<UpdaterDiagnostics>>(IpcEvents.GET_UPDATER_DIAGNOSTICS),
        getUpdates: () => invoke<IpcRes<Record<"hash" | "author" | "message", string>[]>>(IpcEvents.GET_UPDATES),
        update: () => invoke<IpcRes<boolean>>(IpcEvents.UPDATE),
        rebuild: () => invoke<IpcRes<boolean>>(IpcEvents.BUILD),
        getRepo: () => invoke<IpcRes<string>>(IpcEvents.GET_REPO),
    },
''',
    '''    updater: {
        getDiagnostics: (branch: UpdaterBranch = "main") =>
            invoke<IpcRes<UpdaterDiagnostics>>(IpcEvents.GET_UPDATER_DIAGNOSTICS, branch),
        getUpdates: (branch: UpdaterBranch = "main") =>
            invoke<IpcRes<Record<"hash" | "author" | "message", string>[]>>(IpcEvents.GET_UPDATES, branch),
        update: (branch: UpdaterBranch = "main") => invoke<IpcRes<boolean>>(IpcEvents.UPDATE, branch),
        rebuild: () => invoke<IpcRes<boolean>>(IpcEvents.BUILD),
        getRepo: () => invoke<IpcRes<string>>(IpcEvents.GET_REPO),
    },
''',
)

replace_once(
    "browser/VencordNativeStub.ts",
    'import { debounce } from "@shared/debounce";\n',
    'import { debounce } from "@shared/debounce";\nimport type { UpdaterBranch } from "@shared/Updater";\n',
)
replace_once(
    "browser/VencordNativeStub.ts",
    '''    updater: {
        getDiagnostics: async () => ({
            ok: true,
            value: { backend: "disabled" as const, branch: null, builtHead: "", sourceRoot: null },
        }),
        getRepo: async () => ({ ok: true, value: "https://github.com/ProtonDev-sys/ProtonnCord" }),
        getUpdates: async () => ({ ok: true, value: [] }),
        update: async () => ({ ok: true, value: false }),
        rebuild: async () => ({ ok: true, value: true }),
    },
''',
    '''    updater: {
        getDiagnostics: async (branch: UpdaterBranch = "main") => ({
            ok: true,
            value: { backend: "disabled" as const, branch, builtHead: "", sourceRoot: null },
        }),
        getRepo: async () => ({ ok: true, value: "https://github.com/ProtonDev-sys/ProtonnCord" }),
        getUpdates: async (_branch: UpdaterBranch = "main") => ({ ok: true, value: [] }),
        update: async (_branch: UpdaterBranch = "main") => ({ ok: true, value: false }),
        rebuild: async () => ({ ok: true, value: true }),
    },
''',
)

# Renderer updater state follows the locally selected channel.
replace_once(
    "src/utils/updater.ts",
    'import gitHash from "~git-hash";\n',
    'import { Settings } from "@api/Settings";\n\nimport gitHash from "~git-hash";\n',
)
replace_once(
    "src/utils/updater.ts",
    'export let changes: Record<"hash" | "author" | "message", string>[];\n',
    'export let changes: Record<"hash" | "author" | "message", string>[] = [];\n',
)
replace_once(
    "src/utils/updater.ts",
    'export async function checkForUpdates() {\n    changes = await Unwrap(VencordNative.updater.getUpdates());\n',
    '''export function resetUpdateState() {
    isOutdated = false;
    isNewer = false;
    updateError = undefined;
    changes = [];
}

export async function checkForUpdates() {
    changes = await Unwrap(VencordNative.updater.getUpdates(Settings.updateBranch));
''',
)
replace_once(
    "src/utils/updater.ts",
    '    const res = await Unwrap(VencordNative.updater.update());\n',
    '    const res = await Unwrap(VencordNative.updater.update(Settings.updateBranch));\n',
)

# Main-process handlers validate the selected channel at the trust boundary.
replace_once(
    "src/main/updater/git.ts",
    'import type { UpdaterDiagnostics } from "@shared/Updater";\n',
    'import { parseUpdaterBranch, type UpdaterDiagnostics } from "@shared/Updater";\n',
)
replace_once(
    "src/main/updater/git.ts",
    '''async function calculateGitChanges() {
    return (await inspectGitUpdates(git, UPDATE_REPOSITORY, lastBuiltHead)).changes;
}

async function pull() {
    return pullGitUpdates(git, UPDATE_REPOSITORY, lastBuiltHead);
}
''',
    '''async function calculateGitChanges(branch: unknown) {
    return (await inspectGitUpdates(
        git,
        UPDATE_REPOSITORY,
        lastBuiltHead,
        parseUpdaterBranch(branch),
    )).changes;
}

async function pull(branch: unknown) {
    return pullGitUpdates(git, UPDATE_REPOSITORY, lastBuiltHead, parseUpdaterBranch(branch));
}
''',
)
replace_once(
    "src/main/updater/git.ts",
    '''async function getDiagnostics(): Promise<UpdaterDiagnostics> {
    const branch = (await git("branch", "--show-current")).stdout.trim() || null;
    return {
        backend: "git",
        branch,
        builtHead: lastBuiltHead,
        sourceRoot: resolve(PROTONN_CORD_DIR),
    };
}
''',
    '''async function getDiagnostics(branch: unknown): Promise<UpdaterDiagnostics> {
    return {
        backend: "git",
        branch: parseUpdaterBranch(branch),
        builtHead: lastBuiltHead,
        sourceRoot: resolve(PROTONN_CORD_DIR),
    };
}
''',
)

replace_once(
    "src/main/updater/http.ts",
    'import type { UpdaterDiagnostics } from "@shared/Updater";\n',
    'import { parseUpdaterBranch, type UpdaterDiagnostics } from "@shared/Updater";\n',
)
replace_once(
    "src/main/updater/http.ts",
    '''async function calculateGitChanges() {
    const inspection = await inspectHttpUpdates(githubGet, gitHash, ASAR_FILE);
    PendingUpdate = inspection.pending;
    return inspection.changes;
}

async function fetchUpdates() {
    const pending = await findHttpUpdate(githubGet, gitHash, ASAR_FILE);
    PendingUpdate = pending;
    return pending !== null;
}
''',
    '''async function calculateGitChanges(branch: unknown) {
    const inspection = await inspectHttpUpdates(
        githubGet,
        gitHash,
        ASAR_FILE,
        parseUpdaterBranch(branch),
    );
    PendingUpdate = inspection.pending;
    return inspection.changes;
}

async function fetchUpdates(branch: unknown) {
    const pending = await findHttpUpdate(githubGet, gitHash, ASAR_FILE, parseUpdaterBranch(branch));
    PendingUpdate = pending;
    return pending !== null;
}
''',
)
replace_once(
    "src/main/updater/http.ts",
    '''ipcMain.handle(IpcEvents.GET_UPDATER_DIAGNOSTICS, serializeErrors((): UpdaterDiagnostics => ({
    backend: "http",
    branch: null,
    builtHead: gitHash,
    sourceRoot: null,
})));
''',
    '''ipcMain.handle(IpcEvents.GET_UPDATER_DIAGNOSTICS, serializeErrors((branch: unknown): UpdaterDiagnostics => ({
    backend: "http",
    branch: parseUpdaterBranch(branch),
    builtHead: gitHash,
    sourceRoot: null,
})));
''',
)

replace_once(
    "src/main/updater/index.ts",
    'import type { UpdaterDiagnostics } from "@shared/Updater";\n',
    'import { parseUpdaterBranch, type UpdaterDiagnostics } from "@shared/Updater";\n',
)
replace_once(
    "src/main/updater/index.ts",
    '''    ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(() => []));
    ipcMain.handle(IpcEvents.GET_UPDATER_DIAGNOSTICS, serializeErrors((): UpdaterDiagnostics => ({
        backend: "disabled",
        branch: null,
        builtHead: gitHash,
        sourceRoot: null,
    })));
''',
    '''    ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors((branch: unknown) => {
        parseUpdaterBranch(branch);
        return [];
    }));
    ipcMain.handle(IpcEvents.GET_UPDATER_DIAGNOSTICS, serializeErrors((branch: unknown): UpdaterDiagnostics => ({
        backend: "disabled",
        branch: parseUpdaterBranch(branch),
        builtHead: gitHash,
        sourceRoot: null,
    })));
''',
)

# HTTP release selection is branch-specific and supports intentional downgrades.
replace_once(
    "src/main/updater/httpOperations.ts",
    'import { createHash } from "node:crypto";\n',
    'import { createHash } from "node:crypto";\n\nimport { updaterReleaseEndpoint, type UpdaterBranch } from "@shared/Updater";\n',
)
replace_once(
    "src/main/updater/httpOperations.ts",
    '''export async function inspectHttpUpdates(
    request: JsonRequest,
    currentHash: string,
    asarFile: string,
): Promise<HttpUpdateInspection> {
    const release = parseRelease(await request("/releases/latest"), currentHash, asarFile);
    if (!release.pending) return { changes: [], pending: null };

    const comparison = await request(`/compare/${currentHash}...${release.hash}`);
    return { changes: parseChanges(comparison), pending: release.pending };
}

export async function findHttpUpdate(
    request: JsonRequest,
    currentHash: string,
    asarFile: string,
): Promise<PendingHttpUpdate | null> {
    return parseRelease(await request("/releases/latest"), currentHash, asarFile).pending;
}
''',
    '''export async function inspectHttpUpdates(
    request: JsonRequest,
    currentHash: string,
    asarFile: string,
    branch: UpdaterBranch = "main",
): Promise<HttpUpdateInspection> {
    const release = parseRelease(await request(updaterReleaseEndpoint(branch)), currentHash, asarFile);
    if (!release.pending) return { changes: [], pending: null };

    const comparison = await request(`/compare/${currentHash}...${release.hash}`);
    const parsedChanges = parseChanges(comparison);
    const changes = parsedChanges.length > 0
        ? parsedChanges
        : [{ author: "ProtonnCord", hash: release.hash, message: `Switch update branch to ${branch}` }];
    return { changes, pending: release.pending };
}

export async function findHttpUpdate(
    request: JsonRequest,
    currentHash: string,
    asarFile: string,
    branch: UpdaterBranch = "main",
): Promise<PendingHttpUpdate | null> {
    return parseRelease(await request(updaterReleaseEndpoint(branch)), currentHash, asarFile).pending;
}
''',
)

# Updater settings UI.
replace_once(
    "src/components/settings/tabs/updater/index.tsx",
    'import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";\n',
    'import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";\nimport { UPDATER_BRANCHES, type UpdaterBranch } from "@shared/Updater";\n',
)
replace_once(
    "src/components/settings/tabs/updater/index.tsx",
    'import { getRepo, isNewer, UpdateLogger } from "@utils/updater";\nimport { React } from "@webpack/common";\n',
    'import { getRepo, isNewer, resetUpdateState, UpdateLogger } from "@utils/updater";\nimport { React, Select } from "@webpack/common";\n',
)
replace_once(
    "src/components/settings/tabs/updater/index.tsx",
    '''interface CommonProps {
    repo: string;
    repoPending: boolean;
}
''',
    '''interface CommonProps {
    repo: string;
    repoPending: boolean;
}

const UPDATE_BRANCH_LABELS: Record<UpdaterBranch, string> = {
    main: "Main (stable)",
    nightly: "Nightly (latest previews)",
    staging: "Staging (tested previews)",
};
const UPDATE_BRANCH_OPTIONS = UPDATER_BRANCHES.map(branch => ({
    default: branch === "main",
    label: UPDATE_BRANCH_LABELS[branch],
    value: branch,
}));
''',
)
replace_once(
    "src/components/settings/tabs/updater/index.tsx",
    '    const settings = useSettings(["autoUpdate", "autoUpdateNotification"]);\n',
    '    const settings = useSettings(["autoUpdate", "autoUpdateNotification", "updateBranch"]);\n',
)
replace_once(
    "src/components/settings/tabs/updater/index.tsx",
    '''            <FormSwitch
                title="Automatically update"
''',
    '''            <HeadingSecondary>Update branch</HeadingSecondary>
            <Paragraph className={Margins.bottom8}>
                Main is the stable channel. Staging contains tested previews, while Nightly follows the latest preview work. Source installations switch Git branches safely when an update is applied; standalone installations use the matching signed release channel.
            </Paragraph>
            <Select
                placeholder="Main (stable)"
                options={UPDATE_BRANCH_OPTIONS}
                closeOnSelect={true}
                select={(branch: UpdaterBranch) => {
                    if (settings.updateBranch === branch) return;
                    settings.updateBranch = branch;
                    resetUpdateState();
                }}
                isSelected={branch => branch === settings.updateBranch}
                serialize={branch => branch}
            />

            <FormSwitch
                title="Automatically update"
''',
)
replace_once(
    "src/components/settings/tabs/updater/index.tsx",
    '            {isNewer ? <Newer {...commonProps} /> : <Updatable {...commonProps} />}\n',
    '            {isNewer\n                ? <Newer key={settings.updateBranch} {...commonProps} />\n                : <Updatable key={settings.updateBranch} {...commonProps} />}\n',
)

# Replace the unstable two-day plugin marker cache with a release manifest.
plugin_settings_path = "src/components/settings/tabs/plugins/index.tsx"
plugin_settings = read(plugin_settings_path)
plugin_settings = plugin_settings.replace('import * as DataStore from "@api/DataStore";\n', "")
plugin_settings = plugin_settings.replace(
    'import { useAwaiter, useCleanupEffect, useIntersection } from "@utils/react";\n',
    'import { useCleanupEffect, useIntersection } from "@utils/react";\n',
)
plugin_settings = plugin_settings.replace(
    'import { Alerts, ConfirmModal, lodash, openModal, Parser, React, SearchableSelect, Select, TextInput, Toasts, Tooltip, useCallback, useMemo, useRef, useState } from "@webpack/common";\n',
    'import { Alerts, ConfirmModal, openModal, Parser, React, SearchableSelect, Select, TextInput, Toasts, Tooltip, useCallback, useMemo, useRef, useState } from "@webpack/common";\n',
)
plugin_settings = plugin_settings.replace(
    'import { PluginCard } from "./PluginCard";\n',
    'import { getReleaseNewPlugins } from "./newPluginRelease";\nimport { PluginCard } from "./PluginCard";\n',
)
start = plugin_settings.find('    const [newPluginsSet] = useAwaiter(() => DataStore.get("Vencord_existingPlugins")')
end_marker = '\n\n    const handleRestartNeeded'
end = plugin_settings.find(end_marker, start)
if start == -1 or end == -1:
    raise RuntimeError("Could not locate the legacy plugin New marker block")
plugin_settings = (
    plugin_settings[:start]
    + '    const newPluginsSet = getReleaseNewPlugins(VERSION, sortedPlugins.map(plugin => plugin.name));'
    + plugin_settings[end:]
)
write(plugin_settings_path, plugin_settings)

# Version and aggregate regression gates.
package_path = path("package.json")
package_json = json.loads(package_path.read_text(encoding="utf-8"))
package_json["version"] = "1.15.1.1"
package_json["scripts"]["testUpdaterBranches"] = "tsx scripts/testUpdaterBranches.ts"
package_json["scripts"]["testPluginReleaseMarkers"] = "tsx scripts/testPluginReleaseMarkers.ts"
old_test = package_json["scripts"]["test"]
needle = " && pnpm testTsc"
if old_test.count(needle) != 1:
    raise RuntimeError("Could not locate testTsc in aggregate test command")
package_json["scripts"]["test"] = old_test.replace(
    needle,
    " && pnpm testUpdaterBranches && pnpm testPluginReleaseMarkers && pnpm testTsc",
    1,
)
package_path.write_text(json.dumps(package_json, indent=4) + "\n", encoding="utf-8")

# Stable, staging, and nightly standalone release channels.
write(".github/workflows/build.yml", '''name: Release
on:
    push:
        branches:
            - main
            - staging
            - nightly

env:
    FORCE_COLOR: true
    GITHUB_TOKEN: ${{ github.token }}

permissions:
    contents: write

concurrency:
    group: protonn-cord-release-${{ github.ref }}
    cancel-in-progress: false

jobs:
    Build:
        name: Build Protonn Cord
        runs-on: ubuntu-latest

        steps:
            - uses: actions/checkout@v7
              with:
                  fetch-depth: 0

            - uses: pnpm/action-setup@v6

            - name: Use Node.js 24
              uses: actions/setup-node@v6
              with:
                  node-version: 24
                  cache: "pnpm"

            - name: Install dependencies
              run: pnpm install --frozen-lockfile

            - name: Build web
              run: pnpm buildWebStandalone

            - name: Build
              run: pnpm buildStandalone

            - name: Generate plugin lists
              run: |
                  pnpm generatePluginJson dist/plugins.json
                  pnpm generateEquicordPluginJson dist/equicordplugins.json
                  pnpm generateVencordPluginJson dist/vencordplugins.json
                  pnpm generateDevsList dist/devs.json

            - name: Collect files to be released
              run: |
                  cd dist
                  mkdir release
                  shopt -s nullglob

                  cp browser/browser.* release
                  cp ProtonnCord.user.{js,js.LEGAL.txt} release

                  release_files=(*.json *.zip *.asar)
                  if (( ${#release_files[@]} )); then
                      cp "${release_files[@]}" release
                  fi

                  cp desktop/* release
                  for file in equibop/*; do
                    filename=$(basename "$file")
                    cp "$file" "release/equibop${filename^}"
                  done

                  find release -type f -size 0 -delete
                  rm -f release/package.json release/*.map

            - name: Upload Protonn Cord update channel
              if: github.repository == 'ProtonDev-sys/ProtonnCord' && vars.ACT != 'true'
              shell: bash
              run: |
                  set -euo pipefail
                  branch="$GITHUB_REF_NAME"
                  git fetch --no-tags origin "$branch"
                  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]]; then
                      echo "Skipping stale release build for $GITHUB_SHA; origin/$branch has advanced."
                      exit 0
                  fi

                  if [[ "$branch" == "main" ]]; then
                      tag="latest"
                      release_flags=(--latest)
                  else
                      tag="$branch"
                      release_flags=(--prerelease)
                  fi
                  title="Protonn Cord $branch $GITHUB_SHA"

                  if gh release view "$tag" >/dev/null 2>&1; then
                      git tag --force "$tag" "$GITHUB_SHA"
                      git push origin "refs/tags/$tag" --force
                      gh release edit "$tag" --target "$GITHUB_SHA" --title "$title" "${release_flags[@]}"
                  else
                      gh release create "$tag" --target "$GITHUB_SHA" --title "$title" \
                          --notes "Automatically built from Protonn Cord $branch." "${release_flags[@]}"
                  fi
                  gh release upload "$tag" --clobber dist/release/*
''')

# Follow the upstream removal instead of retaining the sole modify/delete conflict.
for obsolete in [
    "src/plugins/favGifSearch/index.tsx",
    ".github/UPSTREAM_SYNC_CONFLICTS.txt",
]:
    target = path(obsolete)
    if target.exists():
        target.unlink()

print("Applied Protonn Cord 1.15.1.1 release changes.")
