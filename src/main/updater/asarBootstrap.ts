/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { dirname, join, resolve } from "node:path";

import { findStaleSibling, patchResourcesDir } from "../applyHostPatch";
import { bootstrapPaths, upgradeBootstrapInjector } from "./bootstrapFiles";
import { validateAsar } from "./httpOperations";

// This module must live outside the archive: opening any file inside it locks
// the destination on Windows, including while the next client is starting.
const files = require("original-fs") as typeof import("node:fs");
const isLocked = (error: unknown) => error instanceof Error && "code" in error
    && ["EPERM", "EBUSY", "EACCES"].includes(String(error.code));

const recoveryKey = Symbol.for("ProtonnCord.hostUpdateRecovery");

export function installHostRecovery(archive: string) {
    if (process.platform !== "win32") return;
    const state = globalThis as typeof globalThis & { [recoveryKey]?: () => void; };
    if (state[recoveryKey]) return state[recoveryKey];
    const { app } = require("electron") as typeof import("electron");
    const { loader } = bootstrapPaths(archive);
    const sweep = () => {
        try {
            const resources = findStaleSibling(dirname(process.execPath));
            if (!resources) return;
            patchResourcesDir(resources, loader);
            // An older channel's native hook may have injected the raw archive
            // first. Upgrade only our exact known stub; leave other mods alone.
            for (const name of ["app.asar", "app"]) {
                const container = join(resources, name);
                const injector = join(container, "index.js");
                if (files.existsSync(container) && (files.statSync(container).isFile() || files.existsSync(injector))) {
                    upgradeBootstrapInjector(injector, archive, files);
                    break;
                }
            }
        } catch (error) {
            console.error("[Protonn Cord] Host update recovery will retry", error);
        }
    };
    // The filesystem fallback does not depend on Discord's private updater
    // APIs, plugin startup, or a compatible renderer. Quit hooks cover the
    // immediate relaunch path; the timer retries versions still being written.
    const timer = setInterval(sweep, 2_000);
    timer.unref();
    app.on("before-quit", sweep);
    app.on("will-quit", sweep);
    process.once("exit", sweep);
    const dispose = () => {
        clearInterval(timer);
        app.removeListener("before-quit", sweep);
        app.removeListener("will-quit", sweep);
        process.removeListener("exit", sweep);
        delete state[recoveryKey];
    };
    state[recoveryKey] = dispose;
    app.once("quit", dispose);
    sweep();
    return dispose;
}

export function installAsarUpdateShim(archive: string) {
    const target = resolve(archive);
    const pending = `${target}.pending`;
    const rename = files.renameSync;

    files.renameSync = (source, destination) => {
        // Keep the active archive unchanged until the next process starts,
        // including when an earlier staged update could not yet be installed.
        if (process.platform !== "win32"
            || typeof source !== "string" || typeof destination !== "string"
            || resolve(destination) !== target || dirname(resolve(source)) !== dirname(target)
            || !resolve(source).startsWith(`${target}.`)
            || !/^\d+\.[a-f0-9-]{36}\.tmp$/iu.test(resolve(source).slice(target.length + 1)))
            return rename(source, destination);

        validateAsar(files.readFileSync(source));
        rename(source, pending);
    };

    return () => { files.renameSync = rename; };
}

export function load(archive: string) {
    const target = resolve(archive);
    const pending = `${target}.pending`;
    if (files.existsSync(pending)) {
        try {
            validateAsar(files.readFileSync(pending));
            // The old renderer can briefly outlive the main process on relaunch.
            for (let attempt = 0; ; attempt++) {
                try {
                    files.renameSync(pending, target);
                    break;
                } catch (error) {
                    if (!isLocked(error) || attempt === 49) throw error;
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
                }
            }
        } catch (error) {
            // Preserve both the working client and pending file for retry.
            console.error("[Protonn Cord] Could not install the pending update; keeping the current client", error);
        }
    }

    installAsarUpdateShim(target);
    installHostRecovery(target);
    require(`${target}/patcher.js`);
}
