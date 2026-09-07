/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// @ts-check

import { transform } from "esbuild";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import ts from "typescript";

import { getPluginTarget } from "../utils.mjs";

const PLUGIN_DIRECTORIES = ["plugins", "equicordplugins", "userplugins"];

// Deferral is opt-in after reviewing the entry point and its runtime imports.
// These modules initialize local values only; shared main settings/constants are
// already eager, and sockets, files, timers and other resources start in methods.
// Re-review a listed module when adding top-level work or changing its imports.
// In particular, MessageLoggerEnhanced starts directory/settings work and
// SongSpotlight configures a shared fetch handler even though both export methods.
const DEFERRED_NATIVES = new Set([
    "plugins/appleMusic.desktop",
    "plugins/openInApp",
    "plugins/translate",
    "plugins/voiceMessages",
    "plugins/xsOverlay",
    "equicordplugins/clipUpload.desktop",
    "equicordplugins/discordMcp.desktop",
    "equicordplugins/favouriteAnything",
    "equicordplugins/fileUpload",
    "equicordplugins/gifMaker",
    "equicordplugins/questify",
    "equicordplugins/richPresence",
    "equicordplugins/secureMessaging.desktop",
    "equicordplugins/songLink.desktop",
    "equicordplugins/themeLibrary",
    "equicordplugins/voiceMessageTranscriber.desktop",
    "equicordplugins/zipPreview",
]);

async function exists(path) {
    return access(path).then(() => true, () => false);
}

async function resolveReexport(from, specifier) {
    if (!specifier.startsWith("."))
        throw new Error(`Native wildcard exports must reference a local module: ${from} -> ${specifier}`);

    const base = resolve(dirname(from), specifier);
    for (const candidate of [base, ...[".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"].map(suffix => base + suffix)]) {
        try {
            await readFile(candidate);
            return candidate;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR"))) throw error;
        }
    }
    throw new Error(`Cannot resolve native wildcard export: ${from} -> ${specifier}`);
}

/** Discover the IPC surface without importing a native module or running its side effects. */
export async function getNativeExportNames(entryPoint, watchFiles = new Set(), visited = new Set()) {
    const path = resolve(entryPoint);
    watchFiles.add(path);
    if (visited.has(path)) return [];
    visited.add(path);

    // Erase TypeScript-only exports before inspecting the runtime module interface.
    const { code } = await transform(await readFile(path, "utf8"), {
        loader: extname(path) === ".tsx" ? "tsx" : "ts",
        format: "esm",
        legalComments: "none",
        sourcefile: path,
    });
    const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const names = new Set();
    for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement)) continue;
        const clause = statement.exportClause;
        if (clause && ts.isNamedExports(clause)) {
            for (const element of clause.elements) names.add(element.name.text);
        } else if (clause && ts.isNamespaceExport(clause)) {
            names.add(clause.name.text);
        } else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            const exportedPath = await resolveReexport(path, statement.moduleSpecifier.text);
            for (const name of await getNativeExportNames(exportedPath, watchFiles, visited)) {
                if (name !== "default") names.add(name);
            }
        }
    }
    return [...names].sort();
}

/** @returns {import("esbuild").Plugin} */
export function createPluginNativesPlugin({ resolvePluginName, isDev, isReporter, sourceRoot = resolve("src") }) {
    return {
        name: "glob-natives-plugin",
        setup(build) {
            const filter = /^~pluginNatives$/;
            build.onResolve({ filter }, args => ({ namespace: "import-natives", path: args.path }));
            build.onLoad({ filter, namespace: "import-natives" }, async () => {
                const entries = [];
                const names = new Set();
                const watchFiles = new Set();
                const watchDirs = PLUGIN_DIRECTORIES.map(dir => join(sourceRoot, dir));

                for (const dir of PLUGIN_DIRECTORIES) {
                    const directory = join(sourceRoot, dir);
                    if (!await exists(directory)) continue;
                    for (const plugin of await readdir(directory, { withFileTypes: true })) {
                        if (!plugin.isDirectory()) continue;
                        const candidates = ["native.ts", "native/index.ts"].map(file => join(directory, plugin.name, file));
                        candidates.forEach(path => watchFiles.add(path));
                        const entryPoint = await exists(candidates[0]) ? candidates[0]
                            : await exists(candidates[1]) ? candidates[1] : undefined;
                        if (!entryPoint || (getPluginTarget(plugin.name) === "dev" && !isDev && !isReporter)) continue;

                        const name = await resolvePluginName(directory, plugin);
                        if (names.has(name)) throw new Error(`Duplicate native plugin: ${name}`);
                        names.add(name);
                        const methods = await getNativeExportNames(entryPoint, watchFiles);
                        const importPath = `./${dir}/${plugin.name}/native`;
                        // An exported method does not imply that import-time work can wait.
                        // Unknown modules, including user/development natives, retain eager loading.
                        const eager = methods.length === 0 || !DEFERRED_NATIVES.has(`${dir}/${plugin.name}`);
                        entries.push(`${JSON.stringify(name)}: { methods: ${JSON.stringify(methods)}, eager: ${eager}, load: () => require(${JSON.stringify(importPath)}) }`);
                    }
                }

                return {
                    contents: `export default {\n${entries.join(",\n")}\n};`,
                    resolveDir: sourceRoot,
                    watchDirs,
                    watchFiles: [...watchFiles],
                };
            });
        },
    };
}
