#!/usr/bin/node
/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// @ts-check

import { createPackage } from "@electron/asar";
import { writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { BUILD_TIMESTAMP, commonOpts, globPlugins, IS_DEV, IS_REPORTER, IS_COMPANION_TEST, IS_STANDALONE, IS_UPDATER_DISABLED, resolvePluginName, VERSION, commonRendererPlugins, watch, buildOrWatchAll, stringifyValues, IS_ANTI_CRASH_TEST } from "./common.mjs";
import { createPluginNativesPlugin } from "./pluginNatives.mjs";

const outputArguments = process.argv.filter(argument => argument.startsWith("--outdir="));
if (outputArguments.length > 1 || process.argv.includes("--outdir"))
    throw new Error("Pass one output directory using --outdir=<directory>.");
const outputArgument = outputArguments[0]?.slice("--outdir=".length);
if (outputArgument !== undefined && !outputArgument.trim())
    throw new Error("The build output directory cannot be empty.");
const outputDirectory = resolve(outputArgument ?? "dist");
const outputPath = (...parts) => join(outputDirectory, ...parts);

const defines = stringifyValues({
    IS_STANDALONE,
    IS_DEV,
    IS_REPORTER,
    IS_COMPANION_TEST,
    IS_UPDATER_DISABLED,
    IS_ANTI_CRASH_TEST,
    IS_WEB: false,
    IS_EXTENSION: false,
    IS_USERSCRIPT: false,
    VERSION,
    BUILD_TIMESTAMP
});

if (defines.IS_STANDALONE === "false") {
    // If this is a local build (not standalone), optimize
    // for the specific platform we're on
    defines["process.platform"] = JSON.stringify(process.platform);
}

/**
 * @type {import("esbuild").BuildOptions}
 */
const nodeCommonOpts = {
    ...commonOpts,
    define: defines,
    format: "cjs",
    platform: "node",
    target: ["esnext"],
    // @ts-expect-error this is never undefined
    external: ["electron", "original-fs", "~pluginNatives", ...commonOpts.external]
};

const sourceMapFooter = s => watch ? "" : `//# sourceMappingURL=vencord://${s}.js.map`;
const sourcemap = watch ? "inline" : "external";

const globNativesPlugin = createPluginNativesPlugin({ resolvePluginName, isDev: IS_DEV, isReporter: IS_REPORTER });

const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const hosts = ["desktop", "equibop"];

/** @type {import("esbuild").BuildOptions[]} */
const buildConfigs = hosts.flatMap(host => {
    const desktop = host === "desktop";
    const mainFile = desktop ? "patcher" : "main";
    const define = {
        ...defines,
        IS_DISCORD_DESKTOP: String(desktop),
        IS_VESKTOP: "false",
        IS_EQUIBOP: String(!desktop)
    };
    return [
        {
            ...nodeCommonOpts,
            entryPoints: [join(sourceDirectory, "main/index.ts")],
            outfile: outputPath(host, `${mainFile}.js`),
            footer: { js: `//# sourceURL=file:///${desktop ? "VencordPatcher" : "VencordDesktopMain"}\n` + sourceMapFooter(mainFile) },
            sourcemap,
            plugins: [...(nodeCommonOpts.plugins ?? []), globNativesPlugin],
            define
        },
        {
            ...commonOpts,
            entryPoints: [join(sourceDirectory, "Vencord.ts")],
            outfile: outputPath(host, "renderer.js"),
            format: "iife",
            target: ["esnext"],
            footer: { js: `//# sourceURL=file:///${desktop ? "VencordRenderer" : "VencordDesktopRenderer"}\n` + sourceMapFooter("renderer") },
            globalName: "Vencord",
            sourcemap,
            plugins: [globPlugins(desktop ? "discordDesktop" : "equibop"), ...commonRendererPlugins],
            define
        },
        {
            ...nodeCommonOpts,
            entryPoints: [join(sourceDirectory, "preload.ts")],
            outfile: outputPath(host, "preload.js"),
            footer: { js: "//# sourceURL=file:///VencordPreload\n" + sourceMapFooter("preload") },
            sourcemap,
            define
        }
    ];
});

await buildOrWatchAll(buildConfigs);

await Promise.all(hosts.map(host =>
    writeFile(outputPath(host, "package.json"), JSON.stringify({
        name: "protonn-cord",
        main: host === "desktop" ? "patcher.js" : "main.js"
    }))
));

await Promise.all(hosts.map(host => createPackage(outputPath(host), outputPath(`${host}.asar`))));
