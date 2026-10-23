import { randomUUID } from "node:crypto";

import { existsSync, lstatSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "original-fs";
import { basename, dirname, join } from "path";

import { createHostInjector } from "./hostInjector";

const VERSION_PREFIX = "app-";

const injectorTarget = (patcherPath: string) => {
    const loader = `${dirname(patcherPath)}.loader.cjs`;
    return existsSync(loader) ? loader : patcherPath;
};

/** `_app.asar` next to `app.asar` marks any patched install. */
export const isAlreadyPatched = (resources: string) =>
    existsSync(join(resources, "_app.asar"));

/**
 * apply the ASAR shim patch to a discord `resources/` directory.
 *
 * renames vanilla `app.asar` to `_app.asar`, then installs a small packed
 * injector compatible with the installer's repair and removal operations.
 *
 * idempotent. returns `false` if the directory is already patched or
 * has no vanilla `app.asar`. throws on partial failure after rolling
 * back any disk changes already made.
 */
export const patchResourcesDir = (resources: string, patcherJsPath: string): boolean => {
    const app = join(resources, "app.asar");
    const _app = join(resources, "_app.asar");

    const backedUp = isAlreadyPatched(resources);
    if (backedUp ? existsSync(app) : !existsSync(app)) return false;
    try {
        const stat = lstatSync(backedUp ? _app : app);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
    } catch {
        return false;
    }

    const undo: Array<() => void> = [];
    const temporary = `${app}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, createHostInjector(injectorTarget(patcherJsPath)), { flag: "wx", flush: true });
        if (!backedUp) {
            renameSync(app, _app);
            undo.push(() => renameSync(_app, app));
        }
        renameSync(temporary, app);
        return true;
    } catch (err) {
        for (let i = undo.length - 1; i >= 0; i--) {
            try {
                undo[i]();
            } catch (cleanupErr) {
                console.error("[Protonn Cord] Rollback step failed", cleanupErr);
            }
        }
        throw err;
    } finally {
        try { unlinkSync(temporary); } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                console.error("[Protonn Cord] Failed to remove the temporary injector", error);
        }
    }
};

const parsePart = (s: string) => parseInt(s, 10) || 0;

const isNewer = ($new: string, old: string): boolean => {
    const newParts = $new.slice(VERSION_PREFIX.length).split(".").map(parsePart);
    const oldParts = old.slice(VERSION_PREFIX.length).split(".").map(parsePart);
    const len = Math.max(newParts.length, oldParts.length);
    for (let i = 0; i < len; i++) {
        const n = newParts[i] ?? 0;
        const o = oldParts[i] ?? 0;
        if (n > o) return true;
        if (n < o) return false;
    }
    return false;
};

/**
 * find the newest sibling `app-VERSION` directory's `resources/` path.
 *
 * squirrel-only layout. returns `null` on non-win32 platforms, or when
 * the running process is already in the newest sibling.
 */
export const findStaleSibling = (currentExeDir: string): string | null => {
    if (process.platform !== "win32") return null;

    const discordPath = dirname(currentExeDir);
    const currentVersion = basename(currentExeDir);

    let latest = currentVersion;
    try {
        for (const name of readdirSync(discordPath)) {
            if (!name.startsWith(VERSION_PREFIX)) continue;
            let isDir = false;
            try {
                isDir = statSync(join(discordPath, name)).isDirectory();
            } catch (statErr) {
                console.error("[Protonn Cord] Skipping unreadable sibling", name, statErr);
                continue;
            }
            if (!isDir) continue;
            if (isNewer(name, latest)) latest = name;
        }
    } catch (err) {
        console.error("[Protonn Cord] Failed to scan for sibling versions", err);
        return null;
    }

    if (latest === currentVersion) return null;
    return join(discordPath, latest, "resources");
};
