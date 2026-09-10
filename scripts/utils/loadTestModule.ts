/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

export function loadTestModule(file: string, imports: Record<string, unknown>, globals: Record<string, unknown>, expose = "") {
    const code = transpileModule(readFileSync(file, "utf8") + expose, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {},
        require(name: string) {
            if (name.includes(".css")) return {};
            assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
            return imports[name];
        },
        ...globals
    });
}
