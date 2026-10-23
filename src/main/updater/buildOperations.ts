import type * as fs from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { acquireBuildLock, BUILD_LOCK, BUILD_RECLAIM_GUARD } from "./buildLock";

type BuildFiles = Pick<typeof fs, "copyFileSync" | "lstatSync" | "mkdirSync" | "mkdtempSync" | "readFileSync" | "readdirSync" | "renameSync" | "rmSync" | "rmdirSync" | "writeFileSync">;

interface BuildOptions {
    distDirectory: string;
    build(outputDirectory: string): Promise<void>;
    verifySource(): Promise<void>;
    files: BuildFiles;
}

const OUTPUTS = ["desktop", "equibop", "desktop.asar", "equibop.asar"];

function unsafeFilename(name: string) {
    return /[<>:"/\\|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
}

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

function outputFile(files: BuildFiles, root: string, path: string) {
    const destination = join(root, path);
    let parent = dirname(destination);
    while (parent !== root) {
        assertDirectory(files, parent);
        parent = dirname(parent);
    }
    const stat = optionalStat(files, destination);
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
        throw new Error(`Cannot replace a non-regular source-build output: ${destination}`);
    return { destination, existed: !!stat };
}

function completeTransaction(files: BuildFiles, transaction: string) {
    const temporary = join(transaction, "completed.tmp");
    const stat = optionalStat(files, temporary);
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
        throw new Error(`The source-build completion marker is not a regular file: ${temporary}`);
    files.writeFileSync(temporary, "complete\n", { flush: true });
    files.renameSync(temporary, join(transaction, "completed"));
}

function cleanTransaction(files: BuildFiles, transaction: string) {
    // Keep the completion marker until every journal and backup has been removed.
    for (const name of ["output", "backup", "completed.tmp", "owner.json"])
        files.rmSync(join(transaction, name), { recursive: true, force: true });
    files.rmSync(join(transaction, "completed"), { force: true });
    files.rmdirSync(transaction);
}

/** Restore interrupted publications before loading source-build outputs or starting another build. */
export function recoverBuildInstallations(distDirectory: string, files: BuildFiles): boolean {
    const dist = resolve(distDirectory);
    if (!assertDirectory(files, dist)) return false;
    // Ordinary source startups need no writes, including on read-only installations.
    // A pending transaction or lock must be re-scanned only after acquiring the lock.
    if (!files.readdirSync(dist).some(name => name.startsWith(".protonn-build-") || name === BUILD_LOCK || name === BUILD_RECLAIM_GUARD))
        return false;
    const release = acquireBuildLock(dist, files);
    try {
        return recoverBuildInstallationsLocked(dist, files);
    } finally {
        release();
    }
}

function recoverBuildInstallationsLocked(dist: string, files: BuildFiles): boolean {
    let recovered = false;
    for (const name of files.readdirSync(dist).sort()) {
        if (!name.startsWith(".protonn-build-")) continue;
        const transaction = join(dist, name);
        const backup = join(transaction, "backup");
        try {
            assertDirectory(files, transaction);
            const completed = join(transaction, "completed");
            const marker = optionalStat(files, completed);
            if (marker) {
                if (!marker.isFile() || marker.isSymbolicLink() || files.readFileSync(completed, "utf8") !== "complete\n")
                    throw new Error("The source-build completion marker is invalid.");
                cleanTransaction(files, transaction);
                continue;
            }
            if (!assertDirectory(files, backup)) continue;
            const manifestPath = join(backup, "manifest.json");
            const manifestStat = optionalStat(files, manifestPath);
            // No publication starts until a complete manifest has been flushed to disk.
            if (!manifestStat) continue;
            if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
                throw new Error("The source-build backup manifest is not a regular file.");
            const manifest: unknown = JSON.parse(files.readFileSync(manifestPath, "utf8"));
            if (!Array.isArray(manifest) || !manifest.length)
                throw new Error("The source-build backup manifest is invalid.");
            const names = new Map<string, { path: string; directory: boolean; }>();
            const entries = manifest.map(entry => {
                if (!entry || typeof entry.path !== "string" || typeof entry.existed !== "boolean")
                    throw new Error("The source-build backup manifest entry is invalid.");
                const parts: string[] = entry.path.split(/[\\/]/u);
                if (parts.some(part => !part || part === "." || part === ".." || unsafeFilename(part))
                    || !OUTPUTS.includes(parts[0]) || (parts.length === 1) !== parts[0].endsWith(".asar"))
                    throw new Error(`The source-build backup path is unsafe: ${entry.path}`);
                for (let i = 1; i <= parts.length; i++) {
                    const path = join(...parts.slice(0, i));
                    const directory = i < parts.length;
                    const previous = names.get(path.toLowerCase());
                    if (previous && (previous.path !== path || !previous.directory || !directory))
                        throw new Error("The source-build backup paths conflict.");
                    names.set(path.toLowerCase(), { path, directory });
                }
                const path = join(...parts);
                const target = outputFile(files, dist, path);
                if (entry.existed && !outputFile(files, backup, path).existed)
                    throw new Error(`The original source-build output is missing from ${join(backup, path)}.`);
                return { path, destination: target.destination, existed: entry.existed as boolean };
            });
            // Validate the entire journal before changing anything. Copies keep recovery retryable.
            for (const entry of entries) {
                if (entry.existed) {
                    files.mkdirSync(dirname(entry.destination), { recursive: true });
                    files.copyFileSync(join(backup, entry.path), entry.destination);
                } else {
                    files.rmSync(entry.destination, { force: true });
                }
            }
            completeTransaction(files, transaction);
            cleanTransaction(files, transaction);
            recovered = true;
        } catch (error) {
            throw new Error(`The source build could not be recovered. Close Discord and retry; recovery files are in ${transaction}.`, { cause: error });
        }
    }
    return recovered;
}

function stagedFiles(files: BuildFiles, output: string) {
    assertDirectory(files, output);
    const paths: string[] = [];
    const namesByCase = new Map<string, string>();
    const names = files.readdirSync(output);
    if (names.length !== OUTPUTS.length || OUTPUTS.some(name => !names.includes(name)))
        throw new Error("The source build did not produce the complete desktop and Equibop outputs.");

    function visit(path: string) {
        const name = relative(output, path);
        const previous = namesByCase.get(name.toLowerCase());
        if (previous !== undefined && previous !== name)
            throw new Error("The source build produced filenames that conflict on Windows.");
        namesByCase.set(name.toLowerCase(), name);
        const stat = files.lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`The source build produced a symbolic link: ${path}`);
        if (stat.isDirectory()) {
            for (const name of files.readdirSync(path).sort()) {
                if (unsafeFilename(name))
                    throw new Error(`The source build produced an unsafe filename: ${name}`);
                visit(join(path, name));
            }
        } else {
            if (!stat.isFile() || stat.size === 0) throw new Error(`The source build produced an invalid file: ${path}`);
            paths.push(relative(output, path));
        }
    }

    for (const name of OUTPUTS) visit(join(output, name));
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
export async function buildAndInstall(options: BuildOptions): Promise<void> {
    const dist = resolve(options.distDirectory);
    const { files } = options;
    assertDirectory(files, dist);
    files.mkdirSync(dist, { recursive: true });
    assertDirectory(files, dist);
    const release = acquireBuildLock(dist, files);
    try {
        recoverBuildInstallationsLocked(dist, files);
        await buildAndInstallLocked({ ...options, distDirectory: dist });
    } finally {
        release();
    }
}

async function buildAndInstallLocked({ distDirectory: dist, build, verifySource, files }: BuildOptions): Promise<void> {
    const transaction = files.mkdtempSync(join(dist, ".protonn-build-"));
    const output = join(transaction, "output");
    const backup = join(transaction, "backup");
    let keepBackup = false;
    try {
        files.mkdirSync(output);
        await build(output);
        const paths = stagedFiles(files, output);
        await verifySource();

        const entries = paths.map(path => ({ path, ...outputFile(files, dist, path) }));
        files.mkdirSync(backup);
        for (const entry of entries) {
            if (!entry.existed) continue;
            const path = join(backup, entry.path);
            files.mkdirSync(dirname(path), { recursive: true });
            files.copyFileSync(entry.destination, path);
        }
        files.writeFileSync(join(backup, "manifest.tmp"), JSON.stringify(entries.map(({ path, existed }) => ({ path, existed })), null, 2), { flush: true });
        files.renameSync(join(backup, "manifest.tmp"), join(backup, "manifest.json"));

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
            completeTransaction(files, transaction);
        } catch (error) {
            const failures: unknown[] = [];
            for (const entry of installed.reverse()) {
                try {
                    if (entry.existed) files.copyFileSync(join(backup, entry.path), entry.destination);
                    else files.rmSync(entry.destination);
                } catch (rollbackError) {
                    failures.push(rollbackError);
                }
            }
            for (const directory of directories.reverse()) {
                try { files.rmdirSync(directory); } catch (rollbackError) { failures.push(rollbackError); }
            }
            if (!failures.length) {
                try { completeTransaction(files, transaction); } catch (rollbackError) { failures.push(rollbackError); }
            }
            if (failures.length) {
                keepBackup = true;
                throw new Error(`The source build could not be fully restored. Close Discord and retry; recovery files are in ${backup}.`, {
                    cause: new AggregateError([error, ...failures], "Source-build installation and rollback failed")
                });
            }
            throw error;
        }
    } finally {
        if (!keepBackup) {
            try { cleanTransaction(files, transaction); } catch (error) {
                console.warn("Could not remove the temporary source-build directory", transaction, error);
            }
        }
    }
}
