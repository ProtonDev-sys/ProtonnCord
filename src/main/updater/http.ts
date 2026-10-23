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

import { ipcMain } from "@main/ipc";
import { RendererSettings } from "@main/settings";
import { IS_VANILLA } from "@main/utils/constants";
import { IpcEvents } from "@shared/IpcEvents";
import { parseUpdaterBranch, type UpdaterBranch, type UpdaterDiagnostics } from "@shared/Updater";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { app } from "electron";
import { renameSync, unlinkSync, writeFileSync } from "original-fs";

import gitHash, { buildChannel } from "~git-hash";
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
const pendingUpdates = new Map<UpdaterBranch, { update: PendingHttpUpdate; force: boolean; revision: number; }>();
let lastRequestedBranch: UpdaterBranch = "main";
let lastInstalledHash = gitHash;
let lastInstalledBranch: UpdaterBranch | null = buildChannel;
let automaticUpdate: PendingHttpUpdate | undefined;
let installedRevision = 0;
const enqueue = createOperationQueue();
let rendererActive = false;

function enqueueRenderer<Result>(operation: () => Promise<Result>) {
    rendererActive = true;
    return enqueue(operation);
}

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
    const selectedBranch = parseUpdaterBranch(branch);
    const installed = automaticUpdateFor(selectedBranch);
    if (installed) return [{ author: "ProtonnCord", hash: installed.hash, message: "Automatic update installed; restart to apply it" }];
    const inspection = await inspectHttpUpdates(
        githubGet,
        lastInstalledHash,
        ASAR_FILE,
        selectedBranch,
        lastInstalledBranch,
    );
    return inspection.changes;
}

function automaticUpdateFor(branch: UpdaterBranch) {
    return lastInstalledBranch === branch && automaticUpdate?.hash === lastInstalledHash ? automaticUpdate : undefined;
}

async function fetchUpdates(branch: unknown, force: unknown = false) {
    if (typeof force !== "boolean") throw new Error("Invalid repair option");
    const selectedBranch = parseUpdaterBranch(branch);
    const installed = !force && automaticUpdateFor(selectedBranch);
    if (installed) {
        // Preserve the renderer's successful UPDATE/BUILD handshake after the
        // fallback completed, including when startup resumes during a download.
        lastRequestedBranch = selectedBranch;
        pendingUpdates.set(selectedBranch, { update: installed, force: false, revision: installedRevision });
        return true;
    }
    const pending = await findHttpUpdate(githubGet, lastInstalledHash, ASAR_FILE, selectedBranch, force, lastInstalledBranch);
    lastRequestedBranch = selectedBranch;
    if (pending) pendingUpdates.set(selectedBranch, { update: pending, force, revision: installedRevision });
    else pendingUpdates.delete(selectedBranch);
    return pending !== null;
}

async function installUpdate(pending: PendingHttpUpdate, branch: UpdaterBranch, shouldInstall = () => true) {
    if (!shouldInstall()) return false;
    let installed = false;
    await applyPendingHttpUpdate(
        pending,
        url => requestBytes(fetch, url, {}, DOWNLOAD_TIMEOUT, DOWNLOAD_SIZE_LIMIT),
        data => {
            // Settings can change while the archive is downloading.
            if (!shouldInstall()) return;
            replaceAsarAtomically(__dirname, `${__dirname}.${process.pid}.${randomUUID()}.tmp`, data, {
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
            });
            installed = true;
        },
    );
    if (!installed) return false;
    lastInstalledHash = pending.hash;
    lastInstalledBranch = branch;
    installedRevision++;
    return true;
}

async function applyUpdates(branch?: unknown) {
    const selectedBranch = branch === undefined ? lastRequestedBranch : parseUpdaterBranch(branch);
    let pending = pendingUpdates.get(selectedBranch);
    if (!pending) return false;
    if (!pending.force && automaticUpdateFor(selectedBranch)) {
        pendingUpdates.delete(selectedBranch);
        automaticUpdate = undefined;
        return true;
    }
    // UPDATE and BUILD are separate IPC calls. Revalidate selections after any
    // intervening installation, acknowledging already satisfied ordinary updates
    // while retaining an explicit repair's force flag.
    if (pending.revision !== installedRevision) {
        const update = await findHttpUpdate(githubGet, lastInstalledHash, ASAR_FILE, selectedBranch, pending.force, lastInstalledBranch);
        if (!update) {
            pendingUpdates.delete(selectedBranch);
            return true;
        }
        pending = { ...pending, update, revision: installedRevision };
        pendingUpdates.set(selectedBranch, pending);
    }
    await installUpdate(pending.update, selectedBranch);
    pendingUpdates.delete(selectedBranch);
    automaticUpdate = undefined;

    return true;
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(() => `https://github.com/${gitRemote}`));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors((branch: unknown) => enqueueRenderer(() => calculateGitChanges(branch))));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors((branch: unknown, force?: unknown) => enqueueRenderer(() => fetchUpdates(branch, force))));
ipcMain.handle(IpcEvents.BUILD, serializeErrors((branch?: unknown) => enqueueRenderer(() => applyUpdates(branch))));
ipcMain.handle(IpcEvents.GET_UPDATER_DIAGNOSTICS, serializeErrors((branch: unknown): UpdaterDiagnostics => ({
    backend: "http",
    branch: parseUpdaterBranch(branch),
    builtHead: lastInstalledHash,
    sourceRoot: null,
})));

if (!IS_DEV && !IS_UPDATER_DISABLED && !IS_VANILLA) {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let settingsRevision = 0;
    const settingsChanged = () => { settingsRevision++; };
    RendererSettings.addGlobalChangeListener(settingsChanged);

    // Native settings have not had the renderer's defaults merged into them.
    const autoUpdateEnabled = () => (RendererSettings.store.autoUpdate ?? true) === true;
    const selectedBranch = () => parseUpdaterBranch(RendererSettings.store.updateBranch ?? undefined);

    async function check() {
        try {
            await enqueue(async () => {
                const active = rendererActive;
                rendererActive = false;
                // Give a working renderer its normal update notices and controls.
                if (disposed || active || !autoUpdateEnabled()) return;
                const branch = selectedBranch();
                const revision = settingsRevision;
                const current = () => !disposed && revision === settingsRevision && autoUpdateEnabled() && selectedBranch() === branch;
                const pending = await findHttpUpdate(githubGet, lastInstalledHash, ASAR_FILE, branch, false, lastInstalledBranch);
                // Yield to renderer operations that arrived during the lookup.
                if (pending && !rendererActive && current() && await installUpdate(pending, branch, current)) automaticUpdate = pending;
            });
        } catch (error) {
            console.error("[Protonn Cord] Native automatic update failed", error);
        } finally {
            if (!disposed) schedule(30 * 60_000);
        }
    }

    function schedule(delay: number) {
        timer = setTimeout(() => void check(), delay);
        timer.unref();
    }

    function dispose() {
        disposed = true;
        clearTimeout(timer);
        RendererSettings.removeGlobalChangeListener(settingsChanged);
        app.removeListener("will-quit", dispose);
    }

    app.once("will-quit", dispose);
    // Let normal renderer startup go first, without depending on webpack readiness.
    schedule(60_000);
}
