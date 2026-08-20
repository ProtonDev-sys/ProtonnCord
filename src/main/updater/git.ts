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
import { join, resolve } from "path";
import { promisify } from "util";

import gitHash from "~git-hash";
import gitRemote from "~git-remote";

import { type GitCommandResult, inspectGitUpdates, pullGitUpdates } from "./gitOperations";
import { serializeErrors } from "./ipc";

const VENCORD_SRC_DIR = join(__dirname, "..");
const PROTONN_CORD_DIR = join(__dirname, "../../");

const execFile = promisify(cpExecFile);
const UPDATE_REPOSITORY = `https://github.com/${gitRemote}.git`;
const GIT_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
let lastBuiltHead = gitHash;

const isFlatpak = process.platform === "linux" && !!process.env.FLATPAK_ID;

if (process.platform === "darwin") process.env.PATH = `/usr/local/bin:${process.env.PATH}`;

async function git(...args: string[]): Promise<GitCommandResult> {
    const opts = {
        cwd: VENCORD_SRC_DIR,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: GIT_TIMEOUT_MS,
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

async function build() {
    const opts = { cwd: PROTONN_CORD_DIR, timeout: BUILD_TIMEOUT_MS };

    const command = isFlatpak ? "flatpak-spawn" : "node";
    const args = isFlatpak ? ["--host", "node", "scripts/build/build.mjs"] : ["scripts/build/build.mjs"];

    if (IS_DEV) args.push("--dev");

    const res = await execFile(command, args, opts);
    const succeeded = !res.stderr.includes("Build failed");
    if (succeeded) lastBuiltHead = (await git("rev-parse", "HEAD")).stdout.trim();

    return succeeded;
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
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(calculateGitChanges));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors(pull));
ipcMain.handle(IpcEvents.BUILD, serializeErrors(build));
ipcMain.handle(IpcEvents.GET_UPDATER_DIAGNOSTICS, serializeErrors(getDiagnostics));
