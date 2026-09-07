/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import ts from "typescript";

const apiDependencies = JSON.parse(readFileSync(new URL("../../src/shared/pluginApiDependencies.json", import.meta.url), "utf8"));
const UNKNOWN = Symbol("dynamic expression");
const metadataProperties = ["name", "description", "required", "enabledByDefault", "dependencies", "startAt", "requiresRestart", "hidden", "tags", "searchTerms", "isModified"];
const lazyWebpackFactories = new Set([
    "findByPropsLazy", "findByCodeLazy", "findComponentLazy", "findComponentByCodeLazy", "findExportedComponentLazy",
    "findCssClassesLazy", "findStoreLazy", "findLazy", "mapMangledModuleLazy", "extractAndLoadChunksLazy"
]);

function isTrustedBinding(binding, name, modules) {
    return binding?.name === name && modules.includes(binding.module);
}

function isPureFactory(binding) {
    if (!binding) return false;
    if (isTrustedBinding(binding, "default", ["@utils/types"])) return true;
    if (isTrustedBinding(binding, "definePluginSettings", ["@api/Settings"])) return true;
    if (isTrustedBinding(binding, "classNameFactory", ["@utils/css", "@api/Styles"])) return true;
    if (["makeLazy", "proxyLazy", "LazyComponent"].includes(binding.name) && ["@utils/lazy", "@utils/lazyReact"].includes(binding.module)) return true;
    return lazyWebpackFactories.has(binding.name) && ["@webpack", "@webpack/webpack"].includes(binding.module);
}

function isPureNamespace(binding) {
    return isTrustedBinding(binding, "Devs", ["@utils/constants"])
        || ["OptionType", "StartAt", "ReporterTestable"].includes(binding?.name) && binding.module === "@utils/types"
        || isTrustedBinding(binding, "BadgePosition", ["@api/Badges"]);
}

function unwrap(node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
    return node;
}

function propertyName(node) {
    return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) ? node.text : undefined;
}

function properties(object) {
    if (!object || !ts.isObjectLiteralExpression(object) || object.properties.some(property => ts.isSpreadAssignment(property) || propertyName(property.name) === undefined)) return undefined;
    return new Map(object.properties.map(property => [propertyName(property.name), property]));
}

function initializer(property) {
    return property && (ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined);
}

function literal(node, variables, visiting = new Set()) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
        if (node.text === "undefined") return undefined;
        if (visiting.has(node.text) || !variables.has(node.text)) return UNKNOWN;
        return literal(variables.get(node.text), variables, new Set([...visiting, node.text]));
    }
    if (ts.isArrayLiteralExpression(node)) {
        const values = node.elements.map(value => literal(value, variables, visiting));
        return values.includes(UNKNOWN) ? UNKNOWN : values;
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "StartAt") return node.name.text;
    return UNKNOWN;
}

function settingsInfo(property, variables) {
    if (!property) return { hasSettings: false, hasVisibleSettings: false, settingsKeys: [] };
    let expression = unwrap(initializer(property));
    if (expression && ts.isIdentifier(expression)) expression = unwrap(variables.get(expression.text));
    if (!expression || !ts.isCallExpression(expression) || expression.expression.getText() !== "definePluginSettings") return undefined;
    const entries = properties(unwrap(expression.arguments[0]));
    if (!entries || entries.has(undefined)) return undefined;
    let hasVisibleSettings = false;
    for (const setting of entries.values()) {
        const options = properties(unwrap(initializer(setting)));
        if (!options) return undefined;
        // Disabled plugins historically receive these callbacks before anyone opens their settings.
        if (options.has("onChange")) return undefined;
        const hiddenProperty = options.get("hidden");
        if (hiddenProperty && !ts.isPropertyAssignment(hiddenProperty) && !ts.isShorthandPropertyAssignment(hiddenProperty)) return undefined;
        const hidden = literal(initializer(hiddenProperty), variables);
        if (hidden === UNKNOWN) return undefined;
        if (!hidden) hasVisibleSettings = true;
    }
    return { hasSettings: true, hasVisibleSettings, settingsKeys: [...entries.keys()] };
}

/**
 * Extract metadata only; never evaluate a plugin, a setting default, or migration code.
 * @returns {import("../../src/shared/pluginDefinition").PluginManifestEntry | undefined}
 */
export function extractPluginManifest(source, file = "plugin.ts") {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const variables = new Map();
    for (const statement of tree.statements) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) variables.set(declaration.name.text, declaration.initializer);
        }
    }
    const exported = tree.statements.find(statement => ts.isExportAssignment(statement));
    const call = exported && unwrap(exported.expression);
    if (!call || !ts.isCallExpression(call) || call.expression.getText(tree) !== "definePlugin") return undefined;
    const definition = properties(unwrap(call.arguments[0]));
    if (!definition || definition.has(undefined)) return undefined;
    const metadata = /** @type {Record<string, any>} */ ({});
    for (const key of metadataProperties) {
        const property = definition.get(key);
        if (property && !ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
        const value = literal(initializer(property), variables);
        if (value === UNKNOWN) return undefined;
        if (value !== undefined) metadata[key] = value;
    }
    if (typeof metadata.name !== "string" || typeof metadata.description !== "string") return undefined;
    const settings = settingsInfo(definition.get("settings"), variables);
    if (!settings) return undefined;
    const dependencies = new Set(metadata.dependencies ?? []);
    for (const [key, api] of Object.entries(apiDependencies)) {
        const property = definition.get(key);
        if (!property) continue;
        if (ts.isMethodDeclaration(property)) {
            dependencies.add(api);
            continue;
        }
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
        const expression = unwrap(initializer(property));
        if (expression && ts.isArrayLiteralExpression(expression)) {
            if (expression.elements.length) dependencies.add(api);
        } else {
            const value = literal(expression, variables);
            if (value === UNKNOWN) {
                if (!expression || !ts.isObjectLiteralExpression(expression) && !ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return undefined;
                dependencies.add(api);
            } else if (value && (!Array.isArray(value) || value.length)) dependencies.add(api);
        }
    }
    if (!metadata.dependencies?.includes(metadata.name)) dependencies.delete(metadata.name);
    const patchesProperty = definition.get("patches");
    if (patchesProperty && !ts.isPropertyAssignment(patchesProperty) && !ts.isShorthandPropertyAssignment(patchesProperty)) return undefined;
    let patches = unwrap(initializer(patchesProperty));
    if (patches && ts.isIdentifier(patches)) patches = unwrap(variables.get(patches.text));
    if (patches && !ts.isArrayLiteralExpression(patches)) return undefined;
    if (patches?.elements.some(ts.isSpreadElement)) return undefined;
    return { ...metadata, dependencies: [...dependencies], ...settings, hasPatches: !!patches?.elements.length, eager: false };
}

function isPureExpression(node, imports) {
    node = unwrap(node);
    if (!node) return true;
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isRegularExpressionLiteral(node)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(value => !ts.isSpreadElement(value) && isPureExpression(value, imports));
    if (ts.isObjectLiteralExpression(node)) return node.properties.every(property => {
        if (!propertyName(property.name)) return false;
        if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) return true;
        return !ts.isSpreadAssignment(property) && isPureExpression(initializer(property), imports);
    });
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        return isPureNamespace(imports.get(node.expression.text));
    }
    if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.ExclamationToken
        ? isPureExpression(node.operand, imports)
        : [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(node.operator) && ts.isNumericLiteral(unwrap(node.operand));
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        return isPureFactory(imports.get(node.expression.text)) && node.arguments.every(argument => isPureExpression(argument, imports));
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        return (["Map", "Set", "WeakMap", "WeakSet", "RegExp"].includes(name) && !imports.has(name) || isTrustedBinding(imports.get(name), "Logger", ["@utils/Logger"]))
            && (node.arguments ?? []).every(argument => isPureExpression(argument, imports));
    }
    return false;
}

function hasPureTopLevel(tree, imports) {
    return tree.statements.every(statement => {
        if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isFunctionDeclaration(statement)
            || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) return true;
        if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.every(declaration =>
            ts.isIdentifier(declaration.name) && isPureExpression(declaration.initializer, imports)
        );
        if (ts.isExportAssignment(statement)) return isPureExpression(statement.expression, imports);
        if (ts.isEnumDeclaration(statement)) return statement.members.every(member => isPureExpression(member.initializer, imports));
        return false;
    });
}

/** Conservative graph analysis: unknown effects, migrations, external dependencies and cycles stay eager. */
export function createPluginManifestAnalyzer(root = process.cwd()) {
    const sources = new Map();
    const resolutions = new Map();
    const safety = new Map();
    let eagerFramework;

    async function sourceInfo(file) {
        if (!sources.has(file)) sources.set(file, (async () => {
            const source = await readFile(file, "utf8");
            const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
            // Erase imports used only as TypeScript types before inspecting the dependency graph.
            const emitted = ts.transpileModule(source, {
                compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve }
            }).outputText;
            const runtime = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true);
            const imports = new Map();
            const dependencies = [];
            for (const statement of runtime.statements) {
                if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name)) imports.set(declaration.name.text, { name: "local", module: "local" });
                }
                if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
                    imports.set(statement.name.text, { name: "local", module: "local" });
                }
                if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
                if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
                dependencies.push(statement.moduleSpecifier.text);
                if (ts.isImportDeclaration(statement)) {
                    if (statement.importClause?.name) imports.set(statement.importClause.name.text, { name: "default", module: statement.moduleSpecifier.text });
                    const bindings = statement.importClause?.namedBindings;
                    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) imports.set(binding.name.text, {
                        name: binding.propertyName?.text ?? binding.name.text, module: statement.moduleSpecifier.text
                    });
                }
            }
            return { source, tree, imports, dependencies };
        })());
        return sources.get(file);
    }

    async function resolveImport(file, specifier) {
        const key = `${file}\0${specifier}`;
        if (!resolutions.has(key)) resolutions.set(key, (async () => {
            if (/\.(?:css|svg|png|html)(?:\?|$)/u.test(specifier) || specifier.includes("?file")) return "asset";
            if (specifier === "~plugins") return "catalog";
            let target;
            if (specifier.startsWith(".")) target = resolve(dirname(file), specifier);
            else if (specifier === "@webpack") target = resolve(root, "src/webpack/webpack");
            else if (specifier === "@webpack/patcher") target = resolve(root, "src/webpack/patchWebpack");
            else if (/^@(api|components|utils|shared|debug|plugins|equicordplugins|webpack)\//u.test(specifier)) target = resolve(root, "src", specifier.slice(1));
            else return undefined;
            for (const candidate of [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.json`, resolve(target, "index.ts"), resolve(target, "index.tsx")]) {
                if (!extname(candidate)) continue;
                try { if ((await stat(candidate)).isFile()) return candidate; } catch { }
            }
            return undefined;
        })());
        return resolutions.get(key);
    }

    async function collectFramework() {
        const files = new Set();
        async function visit(file) {
            if (files.has(file) || file.endsWith(".json")) return;
            files.add(file);
            const info = await sourceInfo(file);
            for (const specifier of info.dependencies) {
                const target = await resolveImport(file, specifier);
                if (target && target !== "asset" && target !== "catalog") await visit(target);
            }
        }
        await visit(resolve(root, "src/Vencord.ts"));
        return files;
    }

    async function isSafe(file, visiting, framework) {
        if (file.endsWith(".json")) return true;
        if (visiting.has(file)) return false;
        if (safety.has(file)) return safety.get(file);
        const info = await sourceInfo(file);
        if (!hasPureTopLevel(info.tree, info.imports)) {
            safety.set(file, false);
            return false;
        }
        const next = new Set([...visiting, file]);
        for (const specifier of info.dependencies) {
            const target = await resolveImport(file, specifier);
            if (target === "asset") continue;
            if (!target || target === "catalog" || !framework.has(target) && !await isSafe(target, next, framework)) {
                safety.set(file, false);
                return false;
            }
        }
        safety.set(file, true);
        return true;
    }

    return async function analyze(file) {
        file = resolve(file);
        const framework = await (eagerFramework ??= collectFramework());
        const { source } = await sourceInfo(file);
        const metadata = extractPluginManifest(source, file);
        if (!metadata || framework.has(file) || !await isSafe(file, new Set(), framework)) return undefined;
        return metadata;
    };
}
