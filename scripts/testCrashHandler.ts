/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, forEachChild, isMethodDeclaration, ScriptTarget, transpileModule } from "typescript";

const source = createSourceFile("crashHandler.ts", readFileSync("src/plugins/crashHandler/index.ts", "utf8"), ScriptTarget.Latest, true);
const method = forEachChild(source, function visit(node): string | undefined {
    if (isMethodDeclaration(node) && node.name.getText(source) === "handleCrash") return node.getText(source);
    return forEachChild(node, visit);
});
assert.ok(method);
const { outputText } = transpileModule(`({ ${method} });`, { compilerOptions: { target: ScriptTarget.ES2022 } });

for (const mode of ["disabled", "cooldown", "failure", "enabled"]) {
    test(`crash recovery releases its guard after ${mode}`, () => {
        const timers: (() => void)[] = [];
        const immediate: (() => void)[] = [];
        let recoveries = 0;
        let updates = 0;
        const context = {
            IS_DEV: false,
            hasCrashedOnce: false,
            isRecovering: false,
            shouldAttemptRecover: mode !== "cooldown",
            settings: { store: { attemptToPreventCrashes: mode !== "disabled" } },
            DataStore: { del() { } },
            CrashHandlerLogger: { error() { } },
            showNotification() { },
            maybePromptToUpdate() { updates++; },
            setTimeout(callback: () => void, delay: number) { if (delay === 1) timers.push(callback); },
            setImmediate(callback: () => void) { immediate.push(callback); }
        };
        const plugin = runInNewContext(outputText, context);
        plugin.handlePreventCrash = () => {
            recoveries++;
            if (mode === "failure") throw new Error("Recovery failed");
        };
        const boundary = { setState() { } };
        plugin.handleCrash(boundary, {});
        plugin.handleCrash(boundary, {});
        assert.equal(timers.length, 1, "reentrant crashes must not queue a second recovery");
        assert.equal(context.isRecovering, true);
        timers.shift()?.();
        assert.equal(recoveries, mode === "enabled" || mode === "failure" ? 1 : 0);
        assert.equal(context.isRecovering, true, "guard remains active until React state updates finish");
        immediate.splice(0).forEach(callback => callback());
        assert.equal(context.isRecovering, false);

        context.shouldAttemptRecover = true;
        plugin.handleCrash(boundary, {});
        assert.equal(timers.length, 1, "a later crash can be handled again");
        timers.shift()?.();
        immediate.splice(0).forEach(callback => callback());
        assert.equal(updates, 1, "update prompt is still attempted only once");
        assert.equal(context.isRecovering, false);
    });
}
