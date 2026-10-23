/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateAsar } from "../src/main/updater/httpOperations.ts";

const [injectorArgument, archiveArgument, ...extra] = process.argv.slice(2);
if (process.platform !== "win32" || !injectorArgument || !archiveArgument || extra.length
    || !isAbsolute(injectorArgument) || !isAbsolute(archiveArgument))
    throw new Error("Usage: node --import tsx scripts/repairWindowsUpdater.mjs <absolute injector index.js> <absolute desktop.asar>");

const injector = resolve(injectorArgument);
const archive = resolve(archiveArgument);
const bootstrap = `${archive}.bootstrap.cjs`;
const stub = `require(${JSON.stringify(bootstrap)}).load(${JSON.stringify(archive)});`;
const previous = await readFile(injector, "utf8");
if (previous.trim() !== `require(${JSON.stringify(join(archive, "patcher.js"))});` && previous.trim() !== stub)
    throw new Error("The injector does not match this archive; refusing to overwrite it.");
validateAsar(await readFile(archive));

const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/main/updater/asarBootstrap.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", external: ["original-fs"],
});

async function replaceFile(path, contents) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, contents, { flag: "wx", flush: true });
        await rename(temporary, path);
    } finally {
        await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
}

// Install the independent loader first, so a failed injector write is harmless.
await replaceFile(bootstrap, bundle.outputFiles[0].contents);
if (previous.trim() !== stub) {
    const backup = `${injector}.before-updater-repair-${Date.now()}.bak`;
    await writeFile(backup, previous, { flag: "wx", flush: true });
    await replaceFile(injector, stub + "\n");
    console.log(`Injector backup: ${backup}`);
}
console.log(`Installed Windows updater repair: ${bootstrap}\nRestart Discord to activate it.`);
