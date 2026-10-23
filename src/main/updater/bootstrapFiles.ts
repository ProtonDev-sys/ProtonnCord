/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { createHostInjector, readHostInjector } from "../hostInjector";

export const bootstrapPaths = (archive: string) => ({
    bootstrap: `${archive}.bootstrap.cjs`,
    loader: `${archive}.loader.cjs`,
});

function parseInjector(contents: string) {
    const match = /^require\(("(?:[^"\\]|\\.)*")\)(?:\.load\(("(?:[^"\\]|\\.)*")\))?;?$/u.exec(contents.trim());
    if (!match) return null;
    try {
        return { module: JSON.parse(match[1]) as string, archive: match[2] === undefined ? undefined : JSON.parse(match[2]) as string };
    } catch {
        return null;
    }
}

export function isBootstrapInjector(contents: string, archive: string) {
    const { bootstrap, loader } = bootstrapPaths(archive);
    const previous = parseInjector(contents);
    return previous !== null && (previous.archive === undefined
        ? [archive, join(archive, "patcher.js"), loader].includes(previous.module)
        : previous.module === bootstrap && previous.archive === archive);
}

export function isBootstrapLoader(contents: string, archive: string) {
    const previous = parseInjector(contents);
    return previous?.module === bootstrapPaths(archive).loader && previous.archive === undefined;
}

function writeAtomically(path: string, contents: string | Uint8Array, files: typeof import("node:fs")) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        files.writeFileSync(temporary, contents, { flag: "wx", flush: true });
        files.renameSync(temporary, path);
    } catch (error) {
        try { files.unlinkSync(temporary); } catch (cleanupError) {
            if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT"))
                console.error("[Protonn Cord] Failed to remove a temporary bootstrap file", cleanupError);
        }
        throw error;
    }
}

export function writeBootstrapFiles(archive: string, source: string | Uint8Array, files: typeof import("node:fs")) {
    const paths = bootstrapPaths(archive);
    const loader = `require(${JSON.stringify(paths.bootstrap)}).load(${JSON.stringify(archive)});\n`;
    for (const [path, contents] of [[paths.bootstrap, source], [paths.loader, loader]] as const)
        writeAtomically(path, contents, files);
    return paths;
}

export function upgradeBootstrapInjector(injector: string, archive: string, files: typeof import("node:fs")) {
    const { loader } = bootstrapPaths(archive);
    const parent = dirname(injector);
    const packed = files.statSync(parent).isFile();
    const target = packed ? parent : injector;
    const previous = (packed ? readHostInjector(files.readFileSync(target)) : files.readFileSync(injector, "utf8")).trim();
    const next = `require(${JSON.stringify(loader)});`;
    if ((packed || basename(parent) !== "app.asar") && isBootstrapLoader(previous, archive)) return;
    if (!isBootstrapInjector(previous, archive))
        throw new Error("The injector does not match this archive; refusing to overwrite it.");
    if (!packed && basename(parent) === "app.asar") {
        const manifest = JSON.parse(files.readFileSync(join(parent, "package.json"), "utf8"));
        if (manifest.name !== "discord" || manifest.main !== "index.js"
            || files.readdirSync(parent).sort().join(",") !== "index.js,package.json")
            throw new Error("The injector directory contains unexpected files; refusing to replace it.");
        const backup = `${parent}.${randomUUID()}.bak`;
        const temporary = `${parent}.${randomUUID()}.tmp`;
        let moved = false;
        try {
            files.writeFileSync(temporary, createHostInjector(loader), { flag: "wx", flush: true });
            files.renameSync(parent, backup);
            moved = true;
            files.renameSync(temporary, parent);
        } catch (error) {
            let failure = error;
            if (moved) {
                try { files.renameSync(backup, parent); } catch (rollbackError) {
                    failure = new Error(`The injector could not be restored. Its backup is in ${backup}.`, {
                        cause: new AggregateError([error, rollbackError], "Injector migration and rollback failed")
                    });
                }
            }
            try { files.unlinkSync(temporary); } catch (cleanupError) {
                if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT"))
                    console.error("[Protonn Cord] Failed to remove a temporary injector", cleanupError);
            }
            throw failure;
        }
        return;
    }
    writeAtomically(target, packed ? createHostInjector(loader) : next + "\n", files);
}
