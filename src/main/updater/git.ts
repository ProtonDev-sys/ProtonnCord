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

import { IpcEvents } from "@shared/IpcEvents";
import { parseUpdaterBranch, type UpdaterDiagnostics } from "@shared/Updater";
import { execFile as cpExecFile } from "child_process";
import { ipcMain } from "electron";
import * as originalFs from "original-fs";
import { join, resolve } from "path";
import { promisify } from "util";

import gitHash from "~git-hash";
import gitRemote from "~git-remote";

import { buildAndInstall } from "./buildOperations";
import { type GitCommandResult, inspectGitUpdates, pullGitUpdates } from "./gitOperations";
import { createOperationQueue, serializeErrors } from "./ipc";

const VENCORD_SRC_DIR = join(__dirname, "..");
const PROTONN_CORD_DIR = join(__dirname, "../../");

const execFile = promisify(cpExecFile);
const UPDATE_REPOSITORY = `https://github.com/${gitRemote}.git`;
const GIT_TIMEOUT_MS = 60_000;
const DEPENDENCY_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
let lastBuiltHead = gitHash;
const enqueue = createOperationQueue();

const isFlatpak = process.platform === "linux" && !!process.env.FLATPAK_ID;

if (process.platform === "darwin") process.env.PATH = `/usr/local/bin:${process.env.PATH}`;

async function git(...args: string[]): Promise<GitCommandResult> {
    const opts = {
        cwd: VENCORD_SRC_DIR,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
    };

    const result = isFlatpak
        ? await execFile("flatpak-spawn", ["--host", "git", ...args], opts)
        : await execFile("git", args, opts);
    return { stderr: String(result.stderr), stdout: String(result.stdout) };
}

async function getRepo() {
    return UPDATE_REPOSITORY.replace(/\.git$/u, "");
}

async function calculateGitChanges(branch: unknown) {
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

async function build(branch?: unknown) {
    const buildBranch = (await git("branch", "--show-current")).stdout.trim();
    if (branch !== undefined && buildBranch !== parseUpdaterBranch(branch))
        throw new Error("The source branch changed before the update could be built. Check for updates again.");
    const buildHead = (await git("rev-parse", "HEAD")).stdout.trim();
    const verifySource = async () => {
        if ((await git("rev-parse", "HEAD")).stdout.trim() !== buildHead
            || (await git("branch", "--show-current")).stdout.trim() !== buildBranch)
            throw new Error("The source checkout changed while building the update. Build it again before restarting.");
    };
    const installCommand = isFlatpak ? "flatpak-spawn" : process.platform === "win32" ? "cmd.exe" : "pnpm";
    const installArgs = isFlatpak ? ["--host", "pnpm", "install", "--frozen-lockfile"]
        : process.platform === "win32" ? ["/d", "/s", "/c", "pnpm install --frozen-lockfile"]
            : ["install", "--frozen-lockfile"];
    try {
        await execFile(installCommand, installArgs, {
            cwd: PROTONN_CORD_DIR,
            env: { ...process.env, CI: "true" },
            timeout: DEPENDENCY_TIMEOUT_MS,
            windowsHide: true,
        });
    } catch (error) {
        throw new Error(`Failed to install source update dependencies. Run pnpm install --frozen-lockfile in ${PROTONN_CORD_DIR} and try again. ${String(error)}`, { cause: error });
    }
    await verifySource();
    const opts = { cwd: PROTONN_CORD_DIR, timeout: BUILD_TIMEOUT_MS, windowsHide: true };
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
    return true;
}

async function getDiagnostics(branch: unknown): Promise<UpdaterDiagnostics> {
    return {
        backend: "git",
        branch: parseUpdaterBranch(branch),
        builtHead: lastBuiltHead,
        sourceRoot: resolve(PROTONN_CORD_DIR),
    };
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(getRepo));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors((branch: unknown) => enqueue(() => calculateGitChanges(branch))));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors((branch: unknown) => enqueue(() => pull(branch))));
ipcMain.handle(IpcEvents.BUILD, serializeErrors((branch?: unknown) => enqueue(() => build(branch))));
ipcMain.handle(IpcEvents.GET_UPDATER_DIAGNOSTICS, serializeErrors(getDiagnostics));
