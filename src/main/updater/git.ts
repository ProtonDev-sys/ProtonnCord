/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { ipcMain } from "@main/ipc";
import { IpcEvents } from "@shared/IpcEvents";
import { parseUpdaterBranch, type UpdaterDiagnostics } from "@shared/Updater";
import { execFile as cpExecFile } from "child_process";
import * as originalFs from "original-fs";
import { join, resolve } from "path";
import { promisify } from "util";

import gitHash, { buildChannel } from "~git-hash";
import gitRemote from "~git-remote";

import { buildAndInstall } from "./buildOperations";
import { type GitCommandResult, inspectGitUpdates, pullGitUpdates, requireCleanTree } from "./gitOperations";
import { createOperationQueue, serializeErrors } from "./ipc";

const VENCORD_SRC_DIR = join(__dirname, "..");
const PROTONN_CORD_DIR = join(__dirname, "../../");

const execFile = promisify(cpExecFile);
const UPDATE_REPOSITORY = `https://github.com/${gitRemote}.git`;
const GIT_TIMEOUT_MS = 60_000;
const DEPENDENCY_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
let lastBuiltHead = gitHash;
let lastBuiltBranch = buildChannel;
const enqueue = createOperationQueue();

const isFlatpak = process.platform === "linux" && !!process.env.FLATPAK_ID;

if (process.platform === "darwin") process.env.PATH = `/usr/local/bin:${process.env.PATH}`;

function sourceEnvironment() {
    // Git inherits repository and index overrides from the process that started
    // Discord. They must not redirect an update into another checkout.
    return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:GIT_|PROTONN_CORD_HASH$|EQUICORD_HASH$|PROTONN_CORD_BUILD_CHANNEL$|PROTONN_CORD_REMOTE$)/iu.test(name)));
}

async function git(...args: string[]): Promise<GitCommandResult> {
    const opts = {
        cwd: PROTONN_CORD_DIR,
        env: { ...sourceEnvironment(), GIT_TERMINAL_PROMPT: "0" },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        windowsHide: true,
    };

    const result = isFlatpak
        ? await execFile("flatpak-spawn", ["--host", "git", ...args], opts)
        : await execFile("git", args, opts);
    return { stderr: String(result.stderr), stdout: String(result.stdout) };
}

async function verifySourceRoot() {
    const root = (await git("rev-parse", "--show-toplevel")).stdout.trim();
    if (originalFs.realpathSync(root) !== originalFs.realpathSync(PROTONN_CORD_DIR))
        throw new Error("The Protonn Cord source directory is not the root of its Git checkout. Update or reinstall it manually.");
}

async function getRepo() {
    return UPDATE_REPOSITORY.replace(/\.git$/u, "");
}

async function calculateGitChanges(branch: unknown) {
    const selectedBranch = parseUpdaterBranch(branch);
    await verifySourceRoot();
    const inspection = await inspectGitUpdates(
        git,
        UPDATE_REPOSITORY,
        lastBuiltHead,
        selectedBranch,
    );
    if (selectedBranch !== lastBuiltBranch && inspection.changes.length === 0)
        return [{ author: "ProtonnCord", hash: inspection.targetHead, message: `Switch update branch to ${selectedBranch}` }];
    return inspection.changes;
}

async function pull(branch: unknown) {
    const selectedBranch = parseUpdaterBranch(branch);
    await verifySourceRoot();
    const changed = await pullGitUpdates(git, UPDATE_REPOSITORY, lastBuiltHead, selectedBranch);
    return changed || selectedBranch !== lastBuiltBranch;
}

async function build(branch?: unknown) {
    await verifySourceRoot();
    const buildBranch = parseUpdaterBranch((await git("branch", "--show-current")).stdout.trim());
    if (branch !== undefined && buildBranch !== parseUpdaterBranch(branch))
        throw new Error("The source branch changed before the update could be built. Check for updates again.");
    const buildHead = (await git("rev-parse", "HEAD")).stdout.trim();
    await requireCleanTree(git);
    const verifySource = async () => {
        await verifySourceRoot();
        if ((await git("rev-parse", "HEAD")).stdout.trim() !== buildHead
            || (await git("branch", "--show-current")).stdout.trim() !== buildBranch)
            throw new Error("The source checkout changed while building the update. Build it again before restarting.");
        await requireCleanTree(git);
    };
    const installCommand = isFlatpak ? "flatpak-spawn" : process.platform === "win32" ? "cmd.exe" : "pnpm";
    const installArgs = isFlatpak ? ["--host", "pnpm", "install", "--frozen-lockfile"]
        : process.platform === "win32" ? ["/d", "/s", "/c", "pnpm install --frozen-lockfile"]
            : ["install", "--frozen-lockfile"];
    try {
        await execFile(installCommand, installArgs, {
            cwd: PROTONN_CORD_DIR,
            env: { ...sourceEnvironment(), CI: "true" },
            timeout: DEPENDENCY_TIMEOUT_MS,
            maxBuffer: COMMAND_MAX_BUFFER,
            windowsHide: true,
        });
    } catch (error) {
        throw new Error(`Failed to install source update dependencies. Run pnpm install --frozen-lockfile in ${PROTONN_CORD_DIR} and try again. ${String(error)}`, { cause: error });
    }
    await verifySource();
    const opts = {
        cwd: PROTONN_CORD_DIR,
        env: {
            ...sourceEnvironment(),
            // Pin build metadata as well as source verification. Shell/CI
            // overrides must not label this checkout as a different build.
            PROTONN_CORD_HASH: buildHead,
            PROTONN_CORD_BUILD_CHANNEL: buildBranch,
            PROTONN_CORD_REMOTE: gitRemote,
        },
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        windowsHide: true,
    };
    await buildAndInstall({
        distDirectory: VENCORD_SRC_DIR,
        files: originalFs,
        build: async stagingDirectory => {
            const command = isFlatpak ? "flatpak-spawn" : "node";
            const args = isFlatpak ? ["--host", "node", "scripts/build/build.mjs"] : ["scripts/build/build.mjs"];
            args.push(`--outdir=${stagingDirectory}`);
            if (IS_DEV) args.push("--dev");

            const res = await execFile(command, args, opts);
            if (res.stderr.includes("Build failed")) throw new Error("The source update build failed. Please try again.");
        },
        verifySource,
    });
    lastBuiltHead = buildHead;
    lastBuiltBranch = buildBranch;
    return true;
}

async function getDiagnostics(branch: unknown): Promise<UpdaterDiagnostics> {
    return {
        backend: "git",
        branch: parseUpdaterBranch(branch),
        builtHead: lastBuiltHead,
        installedBranch: lastBuiltBranch,
        sourceRoot: resolve(PROTONN_CORD_DIR),
    };
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(getRepo));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors((branch: unknown) => enqueue(() => calculateGitChanges(branch))));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors((branch: unknown) => enqueue(() => pull(branch))));
ipcMain.handle(IpcEvents.BUILD, serializeErrors((branch?: unknown) => enqueue(() => build(branch))));
ipcMain.handle(IpcEvents.GET_UPDATER_DIAGNOSTICS, serializeErrors(getDiagnostics));
