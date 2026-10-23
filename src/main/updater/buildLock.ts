/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type * as fs from "node:fs";
import { basename, join } from "node:path";

type LockFiles = Pick<typeof fs, "lstatSync" | "mkdirSync" | "mkdtempSync" | "readFileSync" | "readdirSync" | "renameSync" | "rmSync" | "rmdirSync" | "writeFileSync">;

export const BUILD_LOCK = ".protonn-source-build.lock";
export const BUILD_RECLAIM_GUARD = ".protonn-source-build.reclaim";

/** A populated directory makes rename exclusive on both Windows and POSIX. */
export function acquireBuildLock(dist: string, files: LockFiles): () => void {
    const lock = join(dist, BUILD_LOCK);
    const guard = join(dist, BUILD_RECLAIM_GUARD);
    const failure = (message: string, cause?: unknown) => new Error(`${message} Source-build lock: ${lock}; reclamation guard: ${guard}. Close other Discord processes and retry; if this persists, inspect these paths before removing them.`, { cause });
    function stat(path: string) {
        try { return files.lstatSync(path); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        }
    }
    function owner() {
        const directory = stat(lock);
        if (!directory) return undefined;
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure("The source-build lock is not a regular directory.");
        const path = join(lock, "owner.json");
        const record = stat(path);
        if (!record?.isFile() || record.isSymbolicLink() || files.readdirSync(lock).some(name => name !== "owner.json"))
            throw failure("The source-build lock owner is incomplete or not a regular file.");
        const value: unknown = JSON.parse(files.readFileSync(path, "utf8"));
        if (!value || typeof value !== "object" || !("pid" in value) || !("token" in value)
            || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
            || typeof value.token !== "string" || !/^\.protonn-source-lock-[a-z0-9]+$/iu.test(value.token))
            throw failure("The source-build lock owner is invalid.");
        return { pid: value.pid, token: value.token };
    }
    function assertDead(value: { pid: number; }) {
        try { process.kill(value.pid, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
            throw failure("The source-build lock owner's process could not be checked.", error);
        }
        throw failure(`Another Discord process (PID ${value.pid}) is installing a source update. Wait for it to finish before retrying.`);
    }
    function assertNoGuard() {
        const directory = stat(guard);
        if (!directory) return;
        throw failure(directory.isDirectory() && !directory.isSymbolicLink()
            ? "Source-build lock reclamation is in progress or was interrupted."
            : "The source-build reclamation guard is not a regular directory.");
    }
    function removeDetached(path: string) {
        files.rmSync(join(path, "owner.json"), { force: true });
        files.rmdirSync(path);
    }

    // Publish the complete owner record atomically; never expose an empty lock.
    assertNoGuard();
    const prepared = files.mkdtempSync(join(dist, ".protonn-source-lock-"));
    const token = basename(prepared);
    let acquired = false;
    try {
        files.writeFileSync(join(prepared, "owner.json"), JSON.stringify({ pid: process.pid, token }), { flag: "wx", flush: true });
        try {
            // Validate existing paths before rename, including an empty/corrupt lock.
            if (owner()) throw failure("The source-build lock is occupied.");
            files.renameSync(prepared, lock);
        } catch {
            const current = owner();
            if (!current) throw failure("The source-build lock changed while it was being acquired. Retry the update.");
            assertDead(current);
            assertNoGuard();
            try { files.mkdirSync(guard); } catch (error) { throw failure("Could not exclusively acquire the source-build reclamation guard.", error); }
            try {
                // Another reclaimer may have replaced the observed owner before we got the guard.
                const latest = owner();
                if (latest) {
                    assertDead(latest);
                    const detached = join(prepared, "stale");
                    files.renameSync(lock, detached);
                    removeDetached(detached);
                }
                files.renameSync(prepared, lock);
            } finally {
                files.rmdirSync(guard);
            }
        }
        acquired = true;
    } catch (error) {
        throw failure("Could not acquire the source-build lock.", error);
    } finally {
        if (!acquired) {
            try { removeDetached(prepared); } catch (error) { console.warn("Could not remove the prepared source-build lock", prepared, error); }
        }
    }

    return () => {
        try {
            const current = owner();
            if (current?.pid !== process.pid || current.token !== token) throw failure("The source-build lock owner changed before release.");
            // Detach first so releasing cannot delete a new owner's lock.
            files.renameSync(lock, prepared);
            removeDetached(prepared);
        } catch (error) {
            throw failure("Could not release the source-build lock.", error);
        }
    };
}
