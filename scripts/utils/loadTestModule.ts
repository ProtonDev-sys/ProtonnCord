/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type CompilerOptions, JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

export function loadTestModule<T = any>(file: string | URL, imports: Record<string, unknown>, globals: Record<string, unknown>, expose = "", options: {
    compilerOptions?: CompilerOptions;
    mockImports?: boolean;
} = {}): T {
    const code = transpileModule(readFileSync(file, "utf8") + expose, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, ...options.compilerOptions }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {},
        ...(options.mockImports !== false && {
            require(name: string) {
                if (name.includes(".css")) return {};
                assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
                return imports[name];
            }
        }),
        ...globals
    });
}
