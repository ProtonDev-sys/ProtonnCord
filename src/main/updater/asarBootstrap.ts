/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { dirname, resolve } from "node:path";

import { validateAsar } from "./httpOperations";

// This module must live outside the archive: opening any file inside it locks
// the destination on Windows, including while the next client is starting.
const files = require("original-fs") as typeof import("node:fs");
const isLocked = (error: unknown) => error instanceof Error && "code" in error
    && ["EPERM", "EBUSY", "EACCES"].includes(String(error.code));

export function installAsarUpdateShim(archive: string) {
    const target = resolve(archive);
    const pending = `${target}.pending`;
    const rename = files.renameSync;

    files.renameSync = (source, destination) => {
        try {
            rename(source, destination);
        } catch (error) {
            // Older main/nightly releases already use this atomic-write path.
            // Keep the shim outside their archives so switching to them retains
            // the repair, without changing unrelated filesystem operations.
            if (process.platform !== "win32" || !isLocked(error)
                || typeof source !== "string" || typeof destination !== "string"
                || resolve(destination) !== target || dirname(resolve(source)) !== dirname(target)
                || !resolve(source).startsWith(`${target}.`)
                || !/^\d+\.[a-f0-9-]{36}\.tmp$/iu.test(resolve(source).slice(target.length + 1)))
                throw error;

            validateAsar(files.readFileSync(source));
            rename(source, pending);
        }
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
    require(`${target}/patcher.js`);
}
