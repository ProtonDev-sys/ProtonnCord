/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { build } from "esbuild";
import * as files from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateAsar } from "../src/main/updater/httpOperations.ts";
import { readHostInjector } from "../src/main/hostInjector.ts";
import { bootstrapPaths, isBootstrapInjector, isBootstrapLoader, upgradeBootstrapInjector, writeBootstrapFiles } from "../src/main/updater/bootstrapFiles.ts";

const [injectorArgument, archiveArgument, ...extra] = process.argv.slice(2);
if (process.platform !== "win32" || !injectorArgument || !archiveArgument || extra.length
    || !isAbsolute(injectorArgument) || !isAbsolute(archiveArgument))
    throw new Error("Usage: node --import tsx scripts/repairWindowsUpdater.mjs <absolute injector index.js> <absolute desktop.asar>");

const injector = resolve(injectorArgument);
const archive = resolve(archiveArgument);
const { bootstrap } = bootstrapPaths(archive);
const packed = files.statSync(dirname(injector)).isFile();
const folderShim = !packed && basename(dirname(injector)) === "app.asar";
const target = packed ? dirname(injector) : injector;
const original = await readFile(target);
const previous = packed ? readHostInjector(original) : original.toString("utf8");
if (!isBootstrapInjector(previous, archive))
    throw new Error("The injector does not match this archive; refusing to overwrite it.");
validateAsar(await readFile(archive));

const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/main/updater/asarBootstrap.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", external: ["original-fs", "electron"],
});

// Install the independent loader first, so a failed injector write is harmless.
writeBootstrapFiles(archive, bundle.outputFiles[0].contents, files);
if (!isBootstrapLoader(previous, archive) || folderShim) {
    const backup = `${target}.before-updater-repair-${Date.now()}.bak`;
    if (!folderShim) await writeFile(backup, original, { flag: "wx", flush: true });
    upgradeBootstrapInjector(injector, archive, files);
    console.log(folderShim ? "The previous injector folder was retained beside app.asar." : `Injector backup: ${backup}`);
}
console.log(`Installed Windows updater repair: ${bootstrap}\nRestart Discord to activate it.`);
