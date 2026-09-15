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

import { Settings } from "@api/Settings";

import gitHash from "~git-hash";

import { Logger } from "./Logger";
import { relaunch } from "./native";
import { IpcRes } from "./types";
import { classifyUpdateChanges } from "./updateClassification";

export const UpdateLogger = /* #__PURE__*/ new Logger("Updater", "white");
export let isOutdated = false;
export let isNewer = false;
export let changes: Record<"hash" | "author" | "message", string>[] = [];
let checkRevision = 0;
let installation: { branch: typeof Settings.updateBranch; promise: Promise<boolean>; } | undefined;

async function Unwrap<T>(p: Promise<IpcRes<T>>) {
    const res = await p;

    if (res.ok) return res.value;

    throw res.error;
}

export function resetUpdateState() {
    checkRevision++;
    isOutdated = false;
    isNewer = false;
    changes = [];
}

export async function checkForUpdates() {
    const branch = Settings.updateBranch;
    const revision = ++checkRevision;
    const [nextChanges, diagnostics] = await Promise.all([
        Unwrap(VencordNative.updater.getUpdates(branch)),
        Unwrap(VencordNative.updater.getDiagnostics(branch)),
    ]);
    if (branch !== Settings.updateBranch) return false;
    if (revision !== checkRevision) return isOutdated;
    changes = nextChanges;

    if (diagnostics.backend === "git") {
        const classification = classifyUpdateChanges(changes, gitHash);
        isNewer = classification.isNewer;
        return (isOutdated = classification.isOutdated);
    }

    isNewer = false;
    return (isOutdated = changes.length > 0);
}

async function install(force: boolean) {
    const branch = Settings.updateBranch;
    if (installation) {
        if (installation.branch !== branch)
            throw new Error("An update is already running for another branch. Wait for it to finish before trying again.");
        return installation.promise;
    }
    if (!force && !isOutdated) return true;

    const promise = (async () => {
        const res = await Unwrap(VencordNative.updater.update(branch, force));
        if (!res && !force) return false;
        if (!await Unwrap(VencordNative.updater.rebuild(branch)))
            throw new Error("The build or archive installation failed. Please try again.");
        if (branch === Settings.updateBranch) resetUpdateState();
        return true;
    })();
    installation = { branch, promise };
    try {
        return await promise;
    } finally {
        installation = undefined;
    }
}

export const update = () => install(false);
export const repair = () => install(true);

export const getRepo = () => Unwrap(VencordNative.updater.getRepo());

export async function maybePromptToUpdate(confirmMessage: string, checkForDev = false) {
    if (IS_WEB || IS_UPDATER_DISABLED) return;
    if (checkForDev && IS_DEV) return;

    try {
        const isOutdated = await checkForUpdates();
        if (isOutdated) {
            const wantsUpdate = confirm(confirmMessage);
            if (wantsUpdate && isNewer) return alert("Your local copy has more recent commits. Please stash or reset them.");
            if (wantsUpdate) {
                if (await update()) await relaunch();
            }
        }
    } catch (err) {
        UpdateLogger.error(err);
        alert("That also failed :( Try updating or re-installing with the installer!");
    }
}
