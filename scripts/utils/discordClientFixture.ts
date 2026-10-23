import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { canonicalizeMatch, canonicalizeReplace } from "../../src/utils/patches";
import { loadTestModule } from "./loadTestModule";

// Evaluate the real lookup/declaration independently of unrelated module startup.
export function sourceNode(file: string, predicate: (node: ts.Node) => boolean) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let found: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (found) return;
        if (predicate(node)) found = node;
        else ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(found, `Declaration missing in ${file}`);
    return found.getText(source);
}

export function evaluate(code: string, globals: Record<string, unknown>) {
    const compiled = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
    }).outputText;
    return runInNewContext(compiled, { exports: {}, ...globals });
}

export function declaration(file: string, name: string, globals: Record<string, unknown>) {
    const code = sourceNode(file, node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText() === name);
    return evaluate(`${code.includes(`function ${name}(`) ? "" : "const "}${code};\n${name};`, globals);
}

export const jsx = (type: unknown, props: any) => ({ type, props });
export const React = { createElement: (type: unknown, props: any, ...children: unknown[]) => jsx(type, children.length ? { ...props, children } : props) };

export function elements(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    return node && typeof node === "object" ? [node, ...elements(node.props?.children)] : [];
}

export function loadPlugin(file: string, imports: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
    return loadTestModule(file, {
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        ...imports
    }, globals).default;
}

export function host(source: string, modules: Record<number, any> = {}, globals: Record<string, unknown> = {}) {
    const exports: Record<string, any> = {};
    const requireHost = Object.assign((id: number) => modules[id] ?? {}, {
        d(target: object, getters: Record<string, () => unknown>) {
            for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get, enumerable: true });
        },
        r() {}, n: (value: unknown) => () => value
    });
    runInNewContext(`(${source})`, globals)({}, exports, requireHost);
    return exports;
}

export function pluginPatches(file: string, globals: Record<string, unknown> = {}) {
    const code = sourceNode(file, node => ts.isPropertyAssignment(node) && node.name.getText() === "patches");
    return evaluate(`const plugin={${code}};plugin.patches;`, globals);
}

export function applyPatch(source: string, patch: any, path = "plugin") {
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    return replacements.reduce((current: string, replacement: any) => {
        const next = current.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, path));
        assert.notEqual(next, current, `Captured Discord code must match ${replacement.match}`);
        return next;
    }, source);
}
