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

import { Settings, SettingsStore } from "@api/Settings";

import gitHash, { buildChannel } from "~git-hash";

import { Logger } from "./Logger";
import { relaunch } from "./native";
import { IpcRes } from "./types";
import { classifyUpdateChanges, hashesReferToSameCommit } from "./updateClassification";

export const UpdateLogger = /* #__PURE__*/ new Logger("Updater", "white");
export let isOutdated = false;
export let isNewer = false;
export let changes: Record<"hash" | "author" | "message", string>[] = [];
let checkRevision = 0;
let stateBranch = Settings.updateBranch;
let hasChecked = false;
let needsRestart = false;
let prompting = false;
let checking: { branch: typeof Settings.updateBranch; revision: number; promise: Promise<boolean>; } | undefined;
let installation: { branch: typeof Settings.updateBranch; force: boolean; promise: Promise<boolean>; } | undefined;
const listeners = new Set<() => void>();

function createUpdateState() {
    return {
        branch: stateBranch, changes, isOutdated, isNewer, hasChecked, needsRestart,
        isChecking: checking?.revision === checkRevision,
        isInstalling: installation !== undefined,
    };
}

let state = createUpdateState();

function publishUpdateState() {
    state = createUpdateState();
    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            UpdateLogger.error("Failed to notify an updater listener", error);
        }
    }
}

export function getUpdateState() {
    if (stateBranch !== Settings.updateBranch) resetUpdateState();
    return state;
}

export function subscribeToUpdates(listener: () => void) {
    if (!listeners.size) SettingsStore.addChangeListener("updateBranch", resetUpdateState);
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (!listeners.size) SettingsStore.removeChangeListener("updateBranch", resetUpdateState);
    };
}

async function Unwrap<T>(p: Promise<IpcRes<T>>) {
    const res = await p;

    if (res.ok) return res.value;

    throw res.error;
}

export function resetUpdateState() {
    stateBranch = Settings.updateBranch;
    checkRevision++;
    hasChecked = false;
    isOutdated = false;
    isNewer = false;
    changes = [];
    publishUpdateState();
}

export async function checkForUpdates() {
    const branch = Settings.updateBranch;
    getUpdateState();
    // Inspect a completed installation, never the intermediate checkout/archive.
    if (installation) {
        await installation.promise.catch(() => {});
        if (branch !== Settings.updateBranch) return false;
        return checkForUpdates();
    }
    if (checking?.branch === branch && checking.revision === checkRevision) return checking.promise;
    const revision = ++checkRevision;
    const promise = (async () => {
        const nextChanges = await Unwrap(VencordNative.updater.getUpdates(branch));
        const diagnostics = await Unwrap(VencordNative.updater.getDiagnostics(branch));
        if (branch !== Settings.updateBranch) return false;
        if (revision !== checkRevision) return isOutdated;
        changes = nextChanges;
        hasChecked = true;
        // A same-commit channel switch still installs different build metadata.
        // Its synthetic change is not evidence of unpublished local commits.
        const switchingBranch = diagnostics.installedBranch !== undefined && diagnostics.installedBranch !== branch;
        const classification = diagnostics.backend === "git" && !switchingBranch
            ? classifyUpdateChanges(changes, diagnostics.builtHead ?? gitHash)
            : { isNewer: false, isOutdated: changes.length > 0 };
        isNewer = classification.isNewer;
        isOutdated = classification.isOutdated;
        needsRestart ||= typeof diagnostics.builtHead === "string" && !hashesReferToSameCommit(diagnostics.builtHead, gitHash)
            || buildChannel !== undefined && diagnostics.installedBranch !== undefined && diagnostics.installedBranch !== buildChannel;
        return isOutdated;
    })();
    checking = { branch, revision, promise };
    publishUpdateState();
    try {
        return await promise;
    } finally {
        if (checking?.promise === promise) {
            checking = undefined;
            publishUpdateState();
        }
    }
}

async function install(force: boolean) {
    const branch = Settings.updateBranch;
    getUpdateState();
    if (installation) {
        if (installation.branch !== branch)
            throw new Error("An update is already running for another branch. Wait for it to finish before trying again.");
        // A repair must still force a lookup/rebuild if it follows an ordinary update.
        if (force && !installation.force) {
            await installation.promise.catch(() => {});
            if (branch !== Settings.updateBranch) return false;
            return install(true);
        }
        return installation.promise;
    }
    const pendingCheck = checking?.promise;
    if (!force && !pendingCheck && !isOutdated) return false;

    const promise = Promise.resolve().then(async () => {
        if (pendingCheck) {
            if (force) await pendingCheck.catch(() => {});
            else await pendingCheck;
        }
        if (branch !== Settings.updateBranch) return false;
        if (!force && !isOutdated) return false;
        checkRevision++;
        const res = await Unwrap(VencordNative.updater.update(branch, force));
        if (!res && !force) return false;
        if (!await Unwrap(VencordNative.updater.rebuild(branch)))
            throw new Error("The build or archive installation failed. Please try again.");
        needsRestart = true;
        resetUpdateState();
        return true;
    });
    installation = { branch, force, promise };
    publishUpdateState();
    try {
        return await promise;
    } finally {
        installation = undefined;
        publishUpdateState();
    }
}

export const update = () => install(false);
export const repair = () => install(true);

export const getRepo = () => Unwrap(VencordNative.updater.getRepo());

export async function maybePromptToUpdate(confirmMessage: string, checkForDev = false) {
    if (IS_WEB || IS_UPDATER_DISABLED) return;
    if (checkForDev && IS_DEV) return;
    if (prompting) return;
    prompting = true;

    try {
        const branch = Settings.updateBranch;
        const isOutdated = await checkForUpdates();
        if (branch !== Settings.updateBranch) return;
        if (isOutdated) {
            const wantsUpdate = confirm(confirmMessage);
            if (branch !== Settings.updateBranch) return;
            if (wantsUpdate && isNewer) return alert("Your local copy has more recent commits. Please stash or reset them.");
            if (wantsUpdate) {
                if (!await update()) return alert("The update could not be installed. Check for updates and try again.");
                if (branch === Settings.updateBranch) await relaunch();
            }
        }
    } catch (err) {
        UpdateLogger.error(err);
        alert("That also failed :( Try updating or re-installing with the installer!");
    } finally {
        prompting = false;
    }
}
