/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

import { getEntryPoint, isPluginFile } from "./utils";
import { getPluginTarget } from "./utils.mjs";

interface CatalogEntry {
    name: string;
    target?: string;
    required?: true;
    enabledByDefault?: true;
    settings?: string[];
    dynamicSettings?: true;
}

interface CatalogBaseline {
    version: 1;
    plugins: CatalogEntry[];
}

const pluginDirectories = [
    "src/plugins/_api", "src/plugins/_core", "src/plugins",
    "src/equicordplugins/_api", "src/equicordplugins/_core", "src/equicordplugins",
];
const baselinePath = resolve("docs/plugin-catalog-baseline.json");

function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    for (const property of object.properties) {
        if (!property.name || property.name.getText() !== name) continue;
        if (ts.isPropertyAssignment(property)) return property.initializer;
        if (ts.isShorthandPropertyAssignment(property)) return property.name;
    }
    return undefined;
}

function pluginDefinition(file: ts.SourceFile): ts.ObjectLiteralExpression {
    for (const statement of file.statements) {
        if (!ts.isExportAssignment(statement) || !ts.isCallExpression(statement.expression)) continue;
        const call = statement.expression;
        if (!ts.isIdentifier(call.expression) || call.expression.text !== "definePlugin") continue;
        const object = call.arguments[0];
        if (object && ts.isObjectLiteralExpression(object)) return object;
    }
    throw new Error(`Missing definePlugin object in ${file.fileName}`);
}

function hasDynamicSettings(expression: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Node>()): boolean {
    if (seen.has(expression)) return false;
    seen.add(expression);
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression))
        return hasDynamicSettings(expression.expression, checker, seen);
    if (ts.isCallExpression(expression)) {
        if (ts.isIdentifier(expression.expression) && expression.expression.text === "definePluginSettings") {
            const definition = expression.arguments[0];
            if (!definition) return false;
            if (!ts.isObjectLiteralExpression(definition))
                return Boolean(checker.getIndexTypeOfType(checker.getTypeAtLocation(definition), ts.IndexKind.String));
            return definition.properties.some(property => ts.isSpreadAssignment(property) &&
                Boolean(checker.getIndexTypeOfType(checker.getTypeAtLocation(property.expression), ts.IndexKind.String)));
        }
        if (ts.isPropertyAccessExpression(expression.expression))
            return hasDynamicSettings(expression.expression.expression, checker, seen);
    }
    if (ts.isIdentifier(expression)) {
        let symbol = checker.getSymbolAtLocation(expression);
        if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const declaration = symbol?.valueDeclaration;
        if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
            const value = checker.getShorthandAssignmentValueSymbol(declaration)?.valueDeclaration;
            if (value && ts.isVariableDeclaration(value) && value.initializer)
                return hasDynamicSettings(value.initializer, checker, seen);
        }
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
            return hasDynamicSettings(declaration.initializer, checker, seen);
    }
    return false;
}

/** Read names and inferred settings types without importing or running any plugin. */
async function sourceCatalog(): Promise<CatalogEntry[]> {
    const paths: string[] = [];
    for (const directory of pluginDirectories) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!isPluginFile(entry) || /\.(zip|rar|7z|tar|gz|bz2)/u.test(entry.name)) continue;
            paths.push(resolve(await getEntryPoint(directory, entry)));
        }
    }
    const configPath = resolve("tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(config.error, undefined, "Cannot read TypeScript configuration");
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve("."));
    const program = ts.createProgram(paths, parsed.options);
    const checker = program.getTypeChecker();
    const plugins: CatalogEntry[] = [];

    for (const path of paths) {
        const file = program.getSourceFile(path);
        assert.ok(file, `Cannot parse ${path}`);
        const definition = pluginDefinition(file);
        const name = propertyValue(definition, "name");
        assert.ok(name && ts.isStringLiteral(name), `Plugin name must be a string literal: ${path}`);
        const entry: CatalogEntry = { name: name.text };
        const target = getPluginTarget(path);
        if (target) entry.target = target;
        if (propertyValue(definition, "required")?.kind === ts.SyntaxKind.TrueKeyword) entry.required = true;
        if (propertyValue(definition, "enabledByDefault")?.kind === ts.SyntaxKind.TrueKeyword) entry.enabledByDefault = true;

        const settings = propertyValue(definition, "settings");
        if (settings) {
            const settingsType = checker.getTypeAtLocation(settings);
            const store = settingsType.getProperty("store");
            assert.ok(store, `${entry.name}: settings type must expose its saved store`);
            const storeType = checker.getTypeOfSymbolAtLocation(store, settings);
            assert.equal(storeType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown), 0,
                `${entry.name}: saved settings type must be statically inspectable`);
            const keys = storeType.getProperties().map(property => property.name).sort();
            if (keys.length) entry.settings = keys;
            if (checker.getIndexTypeOfType(storeType, ts.IndexKind.String) || hasDynamicSettings(settings, checker))
                entry.dynamicSettings = true;
        }
        plugins.push(entry);
    }
    return plugins.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function compareCatalog(baseline: CatalogEntry[], current: CatalogEntry[]): string[] {
    const failures: string[] = [];
    const byName = new Map<string, CatalogEntry>();
    for (const plugin of current) {
        if (byName.has(plugin.name)) failures.push(`Duplicate plugin name: ${plugin.name}`);
        byName.set(plugin.name, plugin);
    }
    for (const previous of baseline) {
        const plugin = byName.get(previous.name);
        if (!plugin) {
            failures.push(`Missing plugin/settings namespace: ${previous.name}`);
            continue;
        }
        for (const flag of ["target", "required", "enabledByDefault", "dynamicSettings"] as const) {
            if (plugin[flag] !== previous[flag]) failures.push(`${previous.name}: ${flag} changed`);
        }
        for (const key of previous.settings ?? []) {
            if (!plugin.settings?.includes(key)) failures.push(`${previous.name}: missing saved setting ${key}`);
        }
    }
    return failures;
}

function checkFailureDetection() {
    const previous: CatalogEntry[] = [{ name: "Example", target: "desktop", settings: ["color", "privateToken"] }];
    assert.deepEqual(compareCatalog(previous, previous), []);
    assert.match(compareCatalog(previous, [])[0], /Missing plugin/u);
    assert.match(compareCatalog(previous, [{ ...previous[0], target: "web" }])[0], /target changed/u);
    assert.match(compareCatalog(previous, [{ ...previous[0], settings: ["color"] }])[0], /privateToken/u);
    assert.match(compareCatalog(previous, [...previous, ...previous])[0], /Duplicate plugin/u);
    assert.deepEqual(compareCatalog(previous, [{ ...previous[0], settings: [...previous[0].settings!, "newOption"] }]), []);
}

async function main() {
    checkFailureDetection();
    const current = await sourceCatalog();
    if (process.argv.includes("--print-baseline")) {
        // Deliberately stdout-only: updating the compatibility contract requires a reviewed edit.
        console.log('{\n  "version": 1,\n  "plugins": [\n' +
            current.map(plugin => "    " + JSON.stringify(plugin)).join(",\n") + "\n  ]\n}");
        return;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as CatalogBaseline;
    assert.equal(baseline.version, 1, "Unsupported plugin catalog baseline version");
    assert.ok(Array.isArray(baseline.plugins) && baseline.plugins.length > 0, "Missing plugin catalog baseline");
    assert.equal(new Set(baseline.plugins.map(plugin => plugin.name)).size, baseline.plugins.length,
        "Duplicate plugin in the compatibility baseline");
    const failures = compareCatalog(baseline.plugins, current);
    assert.equal(failures.length, 0, "Plugin compatibility regressions:\n" + failures.join("\n"));
    const settingsCount = baseline.plugins.reduce((total, plugin) => total + (plugin.settings?.length ?? 0), 0);
    console.log(`Plugin catalog passed: ${baseline.plugins.length} retained plugins, ${settingsCount} saved setting identifiers; ${current.length} current plugins.`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
