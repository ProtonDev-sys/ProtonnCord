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

import { randomUUID } from "node:crypto";

import { IpcEvents } from "@shared/IpcEvents";
import { parseUpdaterBranch, type UpdaterBranch, type UpdaterDiagnostics } from "@shared/Updater";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { ipcMain } from "electron";
import { renameSync, unlinkSync, writeFileSync } from "original-fs";

import gitHash from "~git-hash";
import gitRemote from "~git-remote";

import { ASAR_FILE } from "./common";
import {
    applyPendingHttpUpdate,
    findHttpUpdate,
    inspectHttpUpdates,
    type PendingHttpUpdate,
    replaceAsarAtomically,
    requestBytes,
    requestJson,
} from "./httpOperations";
import { createOperationQueue, serializeErrors } from "./ipc";

const API_BASE = `https://api.github.com/repos/${gitRemote}`;
const API_TIMEOUT = 15_000;
const API_SIZE_LIMIT = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 60_000;
const DOWNLOAD_SIZE_LIMIT = 64 * 1024 * 1024;
const pendingUpdates = new Map<UpdaterBranch, PendingHttpUpdate>();
let lastRequestedBranch: UpdaterBranch = "main";
const enqueue = createOperationQueue();

async function githubGet(endpoint: string): Promise<unknown> {
    return requestJson(fetch, API_BASE + endpoint, {
        headers: {
            Accept: "application/vnd.github+json",
            // "All API requests MUST include a valid User-Agent header.
            // Requests with no User-Agent header will be rejected."
            "User-Agent": VENCORD_USER_AGENT
        }
    }, API_TIMEOUT, API_SIZE_LIMIT);
}

async function calculateGitChanges(branch: unknown) {
    const inspection = await inspectHttpUpdates(
        githubGet,
        gitHash,
        ASAR_FILE,
        parseUpdaterBranch(branch),
    );
    return inspection.changes;
}

async function fetchUpdates(branch: unknown, force: unknown = false) {
    if (typeof force !== "boolean") throw new Error("Invalid repair option");
    const selectedBranch = parseUpdaterBranch(branch);
    const pending = await findHttpUpdate(githubGet, gitHash, ASAR_FILE, selectedBranch, force);
    lastRequestedBranch = selectedBranch;
    if (pending) pendingUpdates.set(selectedBranch, pending);
    else pendingUpdates.delete(selectedBranch);
    return pending !== null;
}

async function applyUpdates(branch?: unknown) {
    const selectedBranch = branch === undefined ? lastRequestedBranch : parseUpdaterBranch(branch);
    const pending = pendingUpdates.get(selectedBranch);
    if (!pending) return false;
    await applyPendingHttpUpdate(
        pending,
        url => requestBytes(fetch, url, {}, DOWNLOAD_TIMEOUT, DOWNLOAD_SIZE_LIMIT),
        data => replaceAsarAtomically(__dirname, `${__dirname}.${process.pid}.${randomUUID()}.tmp`, data, {
            remove(path) {
                try {
                    unlinkSync(path);
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                }
            },
            rename: renameSync,
            write(path, contents) {
                writeFileSync(path, contents, { flag: "wx", flush: true });
            },
        }),
    );
    pendingUpdates.delete(selectedBranch);

    return true;
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(() => `https://github.com/${gitRemote}`));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(calculateGitChanges));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors((branch: unknown, force?: unknown) => enqueue(() => fetchUpdates(branch, force))));
ipcMain.handle(IpcEvents.BUILD, serializeErrors((branch?: unknown) => enqueue(() => applyUpdates(branch))));
ipcMain.handle(IpcEvents.GET_UPDATER_DIAGNOSTICS, serializeErrors((branch: unknown): UpdaterDiagnostics => ({
    backend: "http",
    branch: parseUpdaterBranch(branch),
    builtHead: gitHash,
    sourceRoot: null,
})));
