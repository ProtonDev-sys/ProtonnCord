/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { loadTestModule } from "./utils/loadTestModule";

function consoleMessage(args: unknown[], level = "log") {
    return {
        type: () => level, text: () => args.join(" "),
        args: () => args.map(value => ({
            jsonValue: async () => value,
            getProperty: async (key: string) => ({ jsonValue: async () => value?.[key] }),
        })),
    };
}

function fixture(screenshot?: "success" | "reject" | "stall") {
    const calls: string[] = [];
    const exits: number[] = [];
    const handlers = new Map<string, (value: unknown) => void>();
    const launches: Array<{ args: string[]; }> = [];
    const processState = { env: { CHROMIUM_BIN: "fixture", ...(screenshot ? { REPORTER_SCREENSHOT_PATH: "failure.png" } : {}) },
        exitCode: 0, exit(code?: number) { calls.push("exit"); exits.push(code ?? this.exitCode); } };
    const page = {
        on(event: string, handler: (value: unknown) => void) { handlers.set(event, handler); },
        async setUserAgent() { assert.fail("The reporter must use the installed browser's native identity"); },
        async setBypassCSP() {}, async evaluateOnNewDocument() {}, async goto() {},
        async screenshot(options: { path: string; type: string; fullPage: boolean; }) {
            assert.equal(options.path, "failure.png");
            assert.equal(options.type, "png");
            assert.equal(options.fullPage, false);
            calls.push("screenshot");
            if (screenshot === "reject") throw new Error("Screenshot failed");
            if (screenshot === "stall") await new Promise(() => {});
        },
    };
    const browser = { newPage: async () => page, async close() { calls.push("close"); } };
    const imports = { crypto: {}, fs: { readFileSync: () => "fixture bundle" },
        "puppeteer-core": { __esModule: true, default: { launch: async (options: { args: string[]; }) => { launches.push(options); return browser; } } } };
    const source = readFileSync("scripts/generateReport.ts", "utf8").replace("void main();",
        "printReport = async () => recordReport(); exports.audit = { main, finishReporter, handleConsole, handlePageError, report };");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const reporter = runInNewContext(`${code}\nexports.audit;`, {
        exports: {}, process: processState, console: { log() {}, error() {} },
        setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds === 5_000 ? 10 : milliseconds), clearTimeout,
        recordReport: () => calls.push("report"),
        require(name: string) { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; },
    });
    return { reporter, calls, exits, handlers, processState, launches };
}

test("ordinary client runs retain Chromium's sandbox and installed browser identity", async t => {
    const f = fixture();
    t.after(() => f.reporter.finishReporter());
    await f.reporter.main();
    assert.equal(f.processState.exitCode, 0);
    assert.equal(f.launches.length, 1);
    assert.ok(!f.launches[0].args.some(argument => argument === "--no-sandbox" || argument === "--disable-setuid-sandbox"));
});

test("actual reporter Logger messages preserve patch, lookup and plugin-start failures through completion", async t => {
    const f = fixture();
    t.after(() => f.reporter.finishReporter());
    await f.reporter.main();
    const messages: ReturnType<typeof consoleMessage>[] = [];
    const { Logger } = loadTestModule<typeof import("../src/utils/Logger")>("src/utils/Logger.ts", {}, {
        IS_REPORTER: true, IS_WEB: true, IS_VESKTOP: false, IS_EQUIBOP: false,
        console: Object.fromEntries(["log", "warn", "error"].map(level => [level, (...args: unknown[]) => messages.push(consoleMessage(args, level))])),
    });
    new Logger("WebpackPatcher").warn("Patch by Fixture found no module (Module id is -): fixture-code");
    new Logger("PluginManager").error("Failed to start Fixture", new Error("Fixture start error"));
    new Logger("Reporter").log("Webpack Find Fail:", 'findByProps("fixture")');
    new Logger("Reporter").log("Finished test");
    for (const message of messages) await f.reporter.handleConsole(message);
    assert.equal(f.reporter.report.badPatches[0]?.plugin, "Fixture");
    assert.equal(f.reporter.report.badStarts[0]?.error, "Fixture start error");
    assert.equal(f.reporter.report.badWebpackFinds[0], 'findByProps("fixture")');
    assert.deepEqual(f.exits, [1]);
    assert.deepEqual(f.calls, ["close", "report", "exit"]);
});

test("page-error diagnostics retain bounded stacks and fail on missing modules", async t => {
    const f = fixture();
    t.after(() => f.reporter.finishReporter());
    const message = "Reflect.get called on non-object";
    const stack = [`TypeError: ${message}`, ...Array.from({ length: 40 }, (_, i) => `    at frame${i} (${"x".repeat(500)})`)].join("\n");
    f.reporter.handlePageError({ message, stack });
    const detail = f.reporter.report.otherErrors[0];
    assert.match(detail, /Reflect.get called on non-object\n    at frame0/);
    assert.ok(detail.length <= 8_000 && detail.split("\n").length <= 25);
    assert.doesNotMatch(detail, /frame30/);
    f.reporter.handlePageError(new Error("Cannot find module fixture"));
    assert.match(f.reporter.report.otherErrors[1], /Cannot find module fixture/);
    assert.equal(f.processState.exitCode, 1);
    f.reporter.handlePageError(new Error("Sentry successfully disabled"));
    assert.equal(f.reporter.report.otherErrors.length, 2);
});

test("failure screenshots run before browser teardown and cannot stall or mask the failure", async () => {
    for (const screenshot of ["success", "reject", "stall"] as const) {
        const f = fixture(screenshot);
        await f.reporter.main();
        f.reporter.handlePageError(new Error("Startup failure"));
        await f.reporter.finishReporter();
        assert.deepEqual(f.calls, ["screenshot", "close", "report", "exit"], screenshot);
        assert.deepEqual(f.exits, [1], screenshot);
    }
});

test("completion waits for earlier console findings whose handles resolve later", async t => {
    const f = fixture();
    t.after(() => f.reporter.finishReporter());
    await f.reporter.main();
    let resolve!: (value: string) => void;
    const prefix = new Promise<string>(yes => { resolve = yes; });
    const delayed = consoleMessage(["[Protonn Cord]", "Reporter:", "Webpack Find Fail:", "delayed lookup"]);
    const handles = delayed.args();
    handles[0].jsonValue = () => prefix;
    delayed.args = () => handles;
    f.handlers.get("console")!(delayed);
    f.handlers.get("console")!(consoleMessage(["[Protonn Cord]", "Reporter:", "Finished test"]));
    await new Promise(setImmediate);
    assert.equal(f.exits.length, 0, "a later completion marker must not close the browser before the finding is read");
    resolve("[Protonn Cord]");
    await new Promise(setImmediate);
    assert.equal(f.reporter.report.badWebpackFinds[0], "delayed lookup");
    assert.deepEqual(f.exits, [1]);
});
