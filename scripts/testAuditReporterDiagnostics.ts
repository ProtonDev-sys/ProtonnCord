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

import { declaration } from "./utils/discordClientFixture";
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

function fixture(screenshot?: "success" | "reject" | "stall", factoryCapture?: "success" | "reject" | "stall" | "oversize" | "write-fail", globals: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const exits: number[] = [];
    const captured: any[] = [];
    const written: string[] = [];
    const handlers = new Map<string, (value: unknown) => void>();
    const launches: Array<{ args: string[]; }> = [];
    const processState = { env: { CHROMIUM_BIN: "fixture", ...(screenshot ? { REPORTER_SCREENSHOT_PATH: "failure.png" } : {}), ...(factoryCapture ? { REPORTER_FACTORY_PATH: "failed-factories.json" } : {}) },
        exitCode: 0, exit(code?: number) { calls.push("exit"); exits.push(code ?? this.exitCode); } };
    const page = {
        on(event: string, handler: (value: unknown) => void) { handlers.set(event, handler); },
        async setUserAgent() { assert.fail("The reporter must use the installed browser's native identity"); },
        async setBypassCSP() {}, async evaluateOnNewDocument() {}, async goto() {},
        async evaluate(callback: Function, options: unknown) {
            calls.push("factories");
            captured.push(options);
            if (factoryCapture === "reject") throw new Error("Factory capture failed");
            if (factoryCapture === "stall") await new Promise(() => {});
            if (factoryCapture === "oversize") return "x".repeat(8 * 1024 * 1024 + 1);
            return runInNewContext(`(${callback})(${JSON.stringify(options)})`, { TextEncoder, ...globals });
        },
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
    const imports = { crypto: {}, fs: { readFileSync: () => "fixture bundle", writeFileSync(path: string, data: string, options: unknown) {
        assert.equal(path, "failed-factories.json");
        assert.equal(JSON.stringify(options), JSON.stringify({ encoding: "utf8", flag: "wx" }));
        calls.push("write-factories");
        if (factoryCapture === "write-fail") throw new Error("Cannot write diagnostic");
        written.push(data);
    } },
        "puppeteer-core": { __esModule: true, default: { launch: async (options: { args: string[]; }) => { launches.push(options); return browser; } } } };
    const source = readFileSync("scripts/generateReport.ts", "utf8").replace("void main();",
        "printReport = async () => recordReport(); exports.audit = { main, finishReporter, handleConsole, handlePageError, report, captureFailedFactories };");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const reporter = runInNewContext(`${code}\nexports.audit;`, {
        exports: {}, process: processState, console: { log() {}, error() {} }, Buffer, TextEncoder, ...globals,
        setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds === 5_000 ? 10 : milliseconds), clearTimeout,
        recordReport: () => calls.push("report"),
        require(name: string) { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; },
    });
    return { reporter, calls, exits, handlers, processState, launches, captured, written };
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

test("failed-factory diagnostics capture original and retained patched source without executing modules or reading account state", async () => {
    const originalSymbol = Symbol("original");
    const sourceSymbol = Symbol("source");
    const original = function originalFactory() { assert.fail("A diagnostic must never execute a factory"); };
    const patched = Object.assign(function patchedFactory() { assert.fail("A diagnostic must never execute a patched factory"); }, { [originalSymbol]: original });
    original[sourceSymbol] = "0,function patchedFactory(){}";
    const handler = declaration("src/webpack/patchWebpack.ts", "moduleFactoryHandler", {
        SYM_ORIGINAL_FACTORY: originalSymbol, SYM_PATCHED_SOURCE: sourceSymbol,
        SYM_PATCHED_BY: Symbol("patchedBy"), SYM_IS_PROXIED_FACTORY: Symbol("proxied")
    });
    const factories = { "7": new Proxy(patched, handler), get "9"() { throw new Error("Detached factory"); } };
    const f = fixture(undefined, "success", { Vencord: {
        Webpack: { wreq: { m: factories, get c() { return assert.fail("Account/module cache must not be read"); } } },
        WebpackPatcher: { SYM_PATCHED_SOURCE: sourceSymbol }
    } });
    await f.reporter.main();
    for (const id of ["7", "7", "8", "9", "-", "NaN", "__proto__", "1e3", "-1"]) {
        await f.reporter.handleConsole(consoleMessage(["[Protonn Cord]", "WebpackPatcher:", `Patch by Fixture had no effect (Module id is ${id}): fixture`]));
    }
    await f.reporter.finishReporter();
    assert.deepEqual(Array.from(f.captured[0].ids), ["7", "8", "9"]);
    const data = JSON.parse(f.written[0]);
    assert.deepEqual(data.factories, [
        { id: "7", status: "captured", original: String(original), patched: original[sourceSymbol] },
        { id: "8", status: "missing" }, { id: "9", status: "unavailable" }
    ]);
    assert.deepEqual(f.calls, ["factories", "write-factories", "close", "report", "exit"]);
    assert.deepEqual(f.exits, [1]);
});

test("factory diagnostics cap escaped UTF-8 output, module counts, and optional patched source", async () => {
    const sourceSymbol = Symbol("source");
    const factory = function smallFactory() {};
    factory[sourceSymbol] = "🙂".repeat(2048);
    const unicodeFactory = new Function(`return "${"🙂".repeat(220)}";`);
    const f = fixture(undefined, "success", { Vencord: { Webpack: { wreq: { m: { "7": factory, "8": { toString: () => "not a factory" }, "9": unicodeFactory } } }, WebpackPatcher: { SYM_PATCHED_SOURCE: sourceSymbol } } });
    const payload = f.reporter.captureFailedFactories({ ids: ["7", "8"], omittedModuleCount: 0, maxBytes: 1024 });
    assert.ok(Buffer.byteLength(payload, "utf8") <= 1024);
    const data = JSON.parse(payload);
    assert.equal(data.factories[0].original, String(factory));
    assert.equal(data.factories[0].patched, undefined);
    assert.equal(data.factories[0].patchedStatus, "size-limit");
    assert.equal(data.factories[1].status, "missing");
    const bounded = f.reporter.captureFailedFactories({ ids: ["9", ...Array.from({ length: 100 }, (_, id) => String(id + 10))], omittedModuleCount: 0, maxBytes: 1024 });
    assert.ok(Buffer.byteLength(bounded, "utf8") <= 1024);
    const limited = JSON.parse(bounded);
    assert.equal(limited.factories[0].status, "size-limit", "UTF-8 and JSON overhead count towards the total limit");
    assert.ok(limited.omittedModuleCount > 0, "even missing-factory metadata must remain bounded");
    await f.reporter.main();
    for (let id = 0; id < 130; id++) f.reporter.report.badPatches.push({ id: String(id) });
    f.processState.exitCode = 1;
    await f.reporter.finishReporter();
    assert.equal(f.captured[0].ids.length, 100);
    assert.equal(JSON.parse(f.written[0]).omittedModuleCount, 30);
    assert.deepEqual(f.exits, [1]);
});

test("factory diagnostic failures, stalls, and oversized replies preserve the failed verdict and teardown", async () => {
    for (const mode of ["reject", "stall", "oversize", "write-fail"] as const) {
        const f = fixture("success", mode);
        await f.reporter.main();
        f.reporter.handlePageError(new Error("Startup failure"));
        await f.reporter.finishReporter();
        assert.deepEqual(f.calls, ["factories", ...(mode === "write-fail" ? ["write-factories"] : []), "screenshot", "close", "report", "exit"], mode);
        assert.deepEqual(f.exits, [1], mode);
        assert.equal(f.written.length, 0);
    }
    const success = fixture(undefined, "success");
    await success.reporter.main();
    await success.reporter.finishReporter();
    assert.deepEqual(success.calls, ["close", "report", "exit"], "successful runs must not capture factories");
    assert.deepEqual(success.exits, [0]);
});
