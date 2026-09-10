/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createCompilerHost, createProgram, createSourceFile, flattenDiagnosticMessageText, getPreEmitDiagnostics, ModuleKind, ModuleResolutionKind, ScriptTarget } from "typescript";

test("Discord declarations accept combobox render callbacks and webpack own-property checks", () => {
    const file = resolve("scripts/__auditDiscordTypesFixture.ts");
    const source = `
import type { ComponentProps } from "react";
import type { ComboboxPopout } from "../packages/discord-types/src";
import type { WebpackRequire } from "../packages/discord-types/webpack";
const props: ComponentProps<ComboboxPopout> = {
    value: new Set<string>(),
    placeholder: "Select an item",
    children: query => [query],
    onChange() {}
};
const invalid: ComponentProps<ComboboxPopout> = {
    ...props,
    // @ts-expect-error This component requires a query render callback.
    children: "plain text"
};
void invalid;
declare const webpackRequire: WebpackRequire;
const ownsProperty: boolean = webpackRequire.o({ key: undefined }, "key");
webpackRequire.o({}, Symbol("key"));
webpackRequire.o([], 0);
// @ts-expect-error The wrapper requires both object and property arguments.
webpackRequire.o("key");
// @ts-expect-error An object is not a property key.
webpackRequire.o({}, {});
void ownsProperty;
`;
    const options = { strict: true, noEmit: true, skipLibCheck: false, esModuleInterop: true,
        target: ScriptTarget.ES2022, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
        types: ["node", "react"] };
    const host = createCompilerHost(options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => resolve(name) === file
        ? createSourceFile(name, source, languageVersion)
        : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
    const program = createProgram([file], options, host);
    const diagnostics = getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics.map(diagnostic => flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
});
