/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const bootstrapPaths = (archive: string) => ({
    bootstrap: `${archive}.bootstrap.cjs`,
    loader: `${archive}.loader.cjs`,
});

export function writeBootstrapFiles(archive: string, source: string | Uint8Array, files: typeof import("node:fs")) {
    const paths = bootstrapPaths(archive);
    const loader = `require(${JSON.stringify(paths.bootstrap)}).load(${JSON.stringify(archive)});\n`;
    for (const [path, contents] of [[paths.bootstrap, source], [paths.loader, loader]] as const) {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            files.writeFileSync(temporary, contents, { flag: "wx", flush: true });
            files.renameSync(temporary, path);
        } finally {
            try { files.unlinkSync(temporary); } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
        }
    }
    return paths;
}

export function upgradeBootstrapInjector(injector: string, archive: string, files: typeof import("node:fs")) {
    const { bootstrap, loader } = bootstrapPaths(archive);
    const previous = files.readFileSync(injector, "utf8").trim();
    const next = `require(${JSON.stringify(loader)});`;
    if (previous === next) return;
    if (previous !== `require(${JSON.stringify(join(archive, "patcher.js"))});`
        && previous !== `require(${JSON.stringify(bootstrap)}).load(${JSON.stringify(archive)});`)
        throw new Error("The injector does not match this archive; refusing to overwrite it.");
    const temporary = `${injector}.${randomUUID()}.tmp`;
    try {
        files.writeFileSync(temporary, next + "\n", { flag: "wx", flush: true });
        files.renameSync(temporary, injector);
    } finally {
        try { files.unlinkSync(temporary); } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
    }
}
