/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type * as fs from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

type BuildFiles = Pick<typeof fs, "copyFileSync" | "lstatSync" | "mkdirSync" | "mkdtempSync" | "readFileSync" | "readdirSync" | "renameSync" | "rmSync" | "rmdirSync" | "writeFileSync">;

interface BuildOptions {
    distDirectory: string;
    build(outputDirectory: string): Promise<void>;
    verifySource(): Promise<void>;
    files: BuildFiles;
}

const OUTPUTS = ["desktop", "equibop", "desktop.asar", "equibop.asar"];

function optionalStat(files: BuildFiles, path: string) {
    try {
        return files.lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function assertDirectory(files: BuildFiles, path: string) {
    const stat = optionalStat(files, path);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error(`The update output directory is not a regular directory: ${path}`);
    return !!stat;
}

function stagedFiles(files: BuildFiles, output: string) {
    const paths: string[] = [];
    const names = files.readdirSync(output);
    if (names.length !== OUTPUTS.length || OUTPUTS.some(name => !names.includes(name)))
        throw new Error("The source build did not produce the complete desktop and Equibop outputs.");

    function visit(path: string) {
        const stat = files.lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`The source build produced a symbolic link: ${path}`);
        if (stat.isDirectory()) {
            for (const name of files.readdirSync(path).sort()) {
                if (/[<>:"/\\|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name))
                    throw new Error(`The source build produced an unsafe filename: ${name}`);
                visit(join(path, name));
            }
        } else {
            if (!stat.isFile() || stat.size === 0) throw new Error(`The source build produced an invalid file: ${path}`);
            paths.push(relative(output, path));
        }
    }

    for (const name of OUTPUTS) visit(join(output, name));
    if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length)
        throw new Error("The source build produced filenames that conflict on Windows.");
    for (const host of ["desktop", "equibop"]) {
        const main = host === "desktop" ? "patcher.js" : "main.js";
        for (const name of [main, "preload.js", "renderer.js", "renderer.css", "package.json"])
            if (!paths.includes(join(host, name))) throw new Error(`The source build is missing ${host}/${name}.`);
        const manifest = JSON.parse(files.readFileSync(join(output, host, "package.json"), "utf8"));
        if (manifest?.main !== main) throw new Error(`The source build has an invalid ${host}/package.json entry point.`);
    }
    for (const name of ["desktop.asar", "equibop.asar"])
        if (!paths.includes(name)) throw new Error(`The source build is missing ${name}.`);
    return paths;
}

/** Build away from the running files, then replace individual outputs with rollback copies. */
export async function buildAndInstall({ distDirectory, build, verifySource, files }: BuildOptions): Promise<void> {
    const dist = resolve(distDirectory);
    assertDirectory(files, dist);
    files.mkdirSync(dist, { recursive: true });
    const transaction = files.mkdtempSync(join(dist, ".protonn-build-"));
    const output = join(transaction, "output");
    const backup = join(transaction, "backup");
    let keepBackup = false;
    try {
        files.mkdirSync(output);
        await build(output);
        const paths = stagedFiles(files, output);
        await verifySource();

        const entries = paths.map(path => {
            const destination = join(dist, path);
            let parent = dirname(destination);
            while (parent !== dist) {
                assertDirectory(files, parent);
                parent = dirname(parent);
            }
            const stat = optionalStat(files, destination);
            if (stat && (!stat.isFile() || stat.isSymbolicLink()))
                throw new Error(`Cannot replace a non-regular source-build output: ${destination}`);
            return { path, destination, existed: !!stat };
        });
        files.mkdirSync(backup);
        for (const entry of entries) {
            if (!entry.existed) continue;
            const path = join(backup, entry.path);
            files.mkdirSync(dirname(path), { recursive: true });
            files.copyFileSync(entry.destination, path);
        }
        // These copies also remain usable for manual recovery after a process interruption.
        files.writeFileSync(join(backup, "manifest.json"), JSON.stringify(entries.map(({ path, existed }) => ({ path, existed })), null, 2));

        const installed: typeof entries = [];
        const directories: string[] = [];
        try {
            for (const entry of entries) {
                let parent = dist;
                for (const name of entry.path.split(sep).slice(0, -1)) {
                    parent = join(parent, name);
                    if (!assertDirectory(files, parent)) {
                        files.mkdirSync(parent);
                        directories.push(parent);
                    }
                }
                // Never unlink a running file first: a Windows sharing violation must leave it intact.
                files.renameSync(join(output, entry.path), entry.destination);
                installed.push(entry);
            }
        } catch (error) {
            const failures: unknown[] = [];
            for (const entry of installed.reverse()) {
                try {
                    if (entry.existed) files.renameSync(join(backup, entry.path), entry.destination);
                    else files.rmSync(entry.destination);
                } catch (rollbackError) {
                    failures.push(rollbackError);
                }
            }
            for (const directory of directories.reverse()) {
                try { files.rmdirSync(directory); } catch (rollbackError) { failures.push(rollbackError); }
            }
            if (failures.length) {
                keepBackup = true;
                throw new Error(`The source build could not be fully restored. Close Discord and repair the build before restarting; recovery files are in ${backup}.`, {
                    cause: new AggregateError([error, ...failures], "Source-build installation and rollback failed")
                });
            }
            throw error;
        }
    } finally {
        if (!keepBackup) {
            try { files.rmSync(transaction, { recursive: true, force: true }); } catch (error) {
                console.warn("Could not remove the temporary source-build directory", transaction, error);
            }
        }
    }
}
