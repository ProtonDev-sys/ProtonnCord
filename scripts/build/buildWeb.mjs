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

import { readFileSync } from "fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join, resolve, sep } from "path";
import Zip from "zip-local";

import { BUILD_TIMESTAMP, commonOpts, globPlugins, IS_DEV, IS_ANTI_CRASH_TEST, IS_REPORTER, IS_COMPANION_TEST, IS_STANDALONE, VERSION, commonRendererPlugins, buildOrWatchAll, stringifyValues } from "./common.mjs";

/**
 * @type {import("esbuild").BuildOptions}
 */
const commonOptions = {
    ...commonOpts,
    entryPoints: ["browser/Vencord.ts"],
    format: "iife",
    globalName: "Vencord",
    external: ["~plugins", "~git-hash", "/assets/*"],
    target: ["esnext"],
    plugins: [
        globPlugins("web"),
        ...commonRendererPlugins
    ],
    define: stringifyValues({
        IS_WEB: true,
        IS_EXTENSION: false,
        IS_USERSCRIPT: false,
        IS_STANDALONE,
        IS_DEV,
        IS_REPORTER,
        IS_COMPANION_TEST,
        IS_ANTI_CRASH_TEST,
        IS_DISCORD_DESKTOP: false,
        IS_VESKTOP: false,
        IS_EQUIBOP: false,
        IS_UPDATER_DISABLED: true,
        VERSION,
        BUILD_TIMESTAMP
    })
};

/** @type {import("esbuild").BuildOptions[]} */
const buildConfigs = [
    {
        ...commonOptions,
        outfile: "dist/browser/browser.js",
        footer: { js: "//# sourceURL=file:///VencordWeb" }
    },
    {
        ...commonOptions,
        outfile: "dist/browser/extension.js",
        plugins: [...(commonOptions.plugins ?? []), afterBuild("package-extensions", packageExtensions)],
        define: {
            ...commonOptions.define,
            IS_EXTENSION: "true"
        },
        footer: { js: "//# sourceURL=file:///VencordWeb" }
    },
    {
        ...commonOptions,
        inject: ["browser/GMPolyfill.js", ...(commonOptions?.inject || [])],
        plugins: [...(commonOptions.plugins ?? []), afterBuild("embed-userscript-css", appendCssRuntime)],
        define: {
            ...commonOptions.define,
            IS_USERSCRIPT: "true",
            window: "unsafeWindow",
        },
        outfile: "dist/ProtonnCord.user.js",
        banner: {
            js: readFileSync("browser/userscript.meta.js", "utf-8").replace("%version%", `${VERSION}.${BUILD_TIMESTAMP}`)
        },
        footer: {
            // UserScripts get wrapped in an iife, so define Vencord prop on window that returns our local
            js: "Object.defineProperty(unsafeWindow,'Vencord',{get:()=>Vencord});"
        }
    }
];

await buildOrWatchAll(buildConfigs);

/**
  * @type {(target: string, files: string[]) => Promise<void>}
 */
async function buildExtension(target, files) {
    const entries = {
        "dist/ProtonnCord.js": await readFile("dist/browser/extension.js"),
        "dist/ProtonnCord.css": await readFile("dist/browser/extension.css"),
        ...Object.fromEntries(await Promise.all(files.map(async f => {
            let content = await readFile(join("browser", f));
            if (f.startsWith("manifest")) {
                const json = JSON.parse(content.toString("utf-8"));
                json.version = VERSION;
                content = Buffer.from(new TextEncoder().encode(JSON.stringify(json)));
            }

            return [
                f.startsWith("manifest") ? "manifest.json" : f,
                content
            ];
        })))
    };

    const targetDirectory = join("dist/browser", target);
    const outputRoot = resolve("dist/browser");
    if (!resolve(targetDirectory).startsWith(outputRoot + sep))
        throw new Error("Extension output must remain inside dist/browser.");
    await rm(targetDirectory, { recursive: true, force: true });
    await Promise.all(Object.entries(entries).map(async ([file, content]) => {
        const dest = join(targetDirectory, file);
        const parentDirectory = join(dest, "..");
        await mkdir(parentDirectory, { recursive: true });
        await writeFile(dest, content);
    }));

    console.info("Unpacked Extension written to dist/browser/" + target);
}

async function appendCssRuntime() {
    const content = await readFile("dist/ProtonnCord.user.css", "utf-8");
    const cssRuntime = `unsafeWindow._vcUserScriptRendererCss=${JSON.stringify(content)};`;

    await appendFile("dist/ProtonnCord.user.js", cssRuntime);
}

/**
 * @param {string} name
 * @param {() => Promise<void>} callback
 * @returns {import("esbuild").Plugin}
 */
function afterBuild(name, callback) {
    return {
        name,
        setup(build) {
            build.onEnd(result => result.errors.length ? undefined : callback());
        }
    };
}

async function packageExtensions() {
    if (process.argv.includes("--skip-extension")) return;
    await Promise.all([
        buildExtension("chromium-unpacked", ["modifyResponseHeaders.json", "content.js", "manifest.json", "icon.png", "service-worker.js"]),
        buildExtension("firefox-unpacked", ["background.js", "content.js", "manifestv2.json", "icon.png"]),
    ]);

    await Promise.all([
        packExtension("chromium-unpacked", "extension-chrome.zip"),
        packExtension("firefox-unpacked", "extension-firefox.zip"),
    ]);
}

/** @returns {Promise<void>} */
function packExtension(source, destination) {
    return new Promise((resolve, reject) => {
        Zip.zip(join("dist/browser", source), (error, zip) => {
            if (error) return reject(error);
            try {
                zip.compress().save(join("dist", destination), error => {
                    if (error) return reject(error);
                    console.info("Packed extension written to dist/" + destination);
                    resolve();
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}
