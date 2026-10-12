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
import { load } from "yaml-js";

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
            return runInNewContext(`(${callback})(${JSON.stringify(options)})`, { TextEncoder, performance, ...globals });
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
        "printReport = async () => recordReport(); exports.audit = { main, finishReporter, handleConsole, handlePageError, report, captureFailedFactories, parseFactoryProbes, parseFactoryIds };");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const reporter = runInNewContext(`${code}\nexports.audit;`, {
        exports: {}, process: processState, console: { log() {}, error() {} }, Buffer, TextEncoder, performance, ...globals,
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

async function runLookupReporter(findByProps: (property: string) => unknown, count: number) {
    const messages: unknown[][] = [];
    const webpack: any = {
        wreq: { m: {} }, findByProps,
        lazyWebpackSearchHistory: Array.from({ length: count }, (_, i) => ["findByProps", [`property${i}`]])
    };
    const run = declaration("src/debug/runReporter.ts", "runReporter", {
        Logger: class { log(...args: unknown[]) { messages.push(["[Protonn Cord]", "Reporter:", ...args]); } },
        addPatch: () => queueMicrotask(() => webpack._initReporter()),
        loadLazyChunks: async () => {}, Webpack: webpack, Vencord: { Webpack: webpack },
        setTimeout: (callback: () => void) => queueMicrotask(callback), patches: [], patchTimings: [],
        describeLookupError: declaration("src/debug/runReporter.ts", "describeLookupError", {}),
        IS_REPORTER: false, IS_COMPANION_TEST: false
    });
    await run();
    return messages;
}

test("lookup diagnostics retain a real throwing export and its cause once while every affected lookup still fails", async () => {
    const original = new Error("Module getter failed", { cause: new TypeError("Uninitialized export") });
    const webpack = loadTestModule("src/webpack/webpack.ts", {
        "@debug/Tracer": { traceFunction: (_name: string, fn: Function) => fn },
        "@utils/lazy": {}, "@utils/lazyReact": {}, "@utils/Logger": { Logger: class {} },
        "@utils/patches": {}, "@utils/text": {}
    }, { IS_REPORTER: false, IS_DEV: false, IS_ANTI_CRASH_TEST: false });
    webpack._initWebpack({ c: { 1: { loaded: true, exports: Object.defineProperty({}, "broken", {
        enumerable: true, get() { throw original; }
    }) } } });
    const messages = await runLookupReporter(webpack.findByProps, 229);
    const exceptions = messages.filter(([, , message]) => message === "Webpack Find Exception:");
    assert.equal(exceptions.length, 1);
    assert.match(String(exceptions[0][3]), /1 \(229 lookups\)/);
    assert.match(String(exceptions[0][3]), /Error: Module getter failed\n\s+at/);
    assert.match(String(exceptions[0][3]), /Caused by:\nTypeError: Uninitialized export/);
    const f = fixture();
    await f.reporter.main();
    for (const message of messages) await f.reporter.handleConsole(consoleMessage(message));
    assert.equal(f.reporter.report.badWebpackFinds.length, 229);
    assert.equal(f.reporter.report.badWebpackFinds[228], 'findByProps("property228")');
    assert.deepEqual(f.exits, [1]);
});

test("lookup error details bound long stacks and cause chains and tolerate cycles and inaccessible error properties", () => {
    const describe = declaration("src/debug/runReporter.ts", "describeLookupError", {});
    const failure = { stack: ["Error: long failure", ...Array.from({ length: 30 }, (_, i) => `at frame${i} ${"x".repeat(500)}`)].join("\n"), cause: new Error("Original cause") };
    const detail = describe(failure);
    assert.match(detail, /Error: long failure/);
    assert.match(detail, /Caused by:\nError: Original cause/);
    assert.doesNotMatch(detail, /frame20/);
    assert.ok(detail.length <= 6_400);
    failure.cause.cause = failure;
    assert.match(describe(failure), /Circular cause/);
    assert.equal(describe(null), "null");
    assert.equal(describe("x".repeat(10_000)).length, 2_000);
    assert.match(describe(new Proxy({}, { get() { throw new Error("Unavailable property"); } })), /Unable to read/);
    const inaccessibleCause = Object.defineProperty(new Error("Preserved original"), "cause", { get() { throw new Error("Unavailable cause"); } });
    assert.match(describe(inaccessibleCause), /Error: Preserved original/);
    assert.match(describe(inaccessibleCause), /Unable to read error properties: cause/);
    let chain: unknown = new Error("Deepest cause");
    for (let i = 0; i < 20; i++) chain = { stack: "x".repeat(10_000), cause: chain };
    assert.ok(describe(chain).length <= 6_400);
});

test("lookup diagnostic groups have a fixed bound without dropping additional findings", async () => {
    const messages = await runLookupReporter(property => { throw new Error(property + "x".repeat(10_000)); }, 40);
    const exceptions = messages.filter(([, , message]) => message === "Webpack Find Exception:");
    assert.equal(exceptions.length, 8);
    assert.ok(exceptions.every(message => String(message[3]).length < 6_500));
    assert.equal(messages.filter(([, , message]) => message === "Webpack Find Fail:").length, 40);
    assert.ok(messages.some(([, , message, detail]) => message === "Webpack Find Exception Limit:" && String(detail).includes("32 additional")));
    assert.equal(messages.at(-1)?.[2], "Finished test");
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

test("configured literal probes find only unique original factories without executing code or reading module cache", async () => {
    const originalSymbol = Symbol("original");
    const sourceSymbol = Symbol("source");
    const original = function originalFactory() { assert.fail("Must not execute"); return ".FORWARD_BREADCRUMB_CLICKED,{ shared-literal"; };
    const second = function secondFactory() { assert.fail("Must not execute"); return "shared-literal"; };
    const patched = Object.assign(function patchedFactory() { assert.fail("Must not execute"); }, { [originalSymbol]: original });
    second[sourceSymbol] = 'function onlyPatched(){return ".FORWARD_BREADCRUMB_CLICKED,{"}';
    const handler = declaration("src/webpack/patchWebpack.ts", "moduleFactoryHandler", {
        SYM_ORIGINAL_FACTORY: originalSymbol, SYM_PATCHED_SOURCE: sourceSymbol,
        SYM_PATCHED_BY: Symbol("patchedBy"), SYM_IS_PROXIED_FACTORY: Symbol("proxied")
    });
    const factories = { "7": new Proxy(patched, handler), "8": second, ignored: original };
    const require = Object.assign(() => assert.fail("Must not require a module"), { m: factories });
    Object.defineProperty(require, "c", { get() { assert.fail("Must not read module cache"); } });
    const f = fixture(undefined, "success", { Vencord: { Webpack: { wreq: require }, WebpackPatcher: { SYM_PATCHED_SOURCE: sourceSymbol } } });
    Object.assign(f.processState.env, { REPORTER_FACTORY_PROBES: JSON.stringify([".FORWARD_BREADCRUMB_CLICKED,{", "shared-literal", ".*", "not-in-source"]) });
    await f.reporter.main();
    f.reporter.report.badPatches.push({ id: "8" });
    f.processState.exitCode = 1;
    await f.reporter.finishReporter();
    const data = JSON.parse(f.written[0]);
    assert.equal(data.probeScan.complete, true);
    assert.deepEqual(data.probes.map(probe => [probe.status, probe.matchCount, probe.matches]), [
        ["selected", 1, ["7"]], ["ambiguous", 2, ["7", "8"]], ["not-found", 0, []], ["not-found", 0, []]
    ]);
    assert.deepEqual(data.factories.map(factory => factory.id), ["8", "7"], "failed IDs retain capture priority");
    assert.equal(data.factories[1].original, String(original));
    assert.equal(data.factories[0].patched, second[sourceSymbol]);
    assert.deepEqual(f.exits, [1]);
});

test("configured numeric factory requests capture known source without scanning or executing modules", async () => {
    const workflow = load(readFileSync(".github/workflows/client-smoke.yml", "utf8"));
    const configured = workflow.jobs.reporter.steps.find(step => step.name === "Test logged-out Discord").env;
    assert.deepEqual(JSON.parse(configured.REPORTER_FACTORY_IDS), ["230797"]);
    assert.equal(configured.REPORTER_FACTORY_PROBES, undefined);
    const original = function knownFactory() { assert.fail("Must not execute a factory"); };
    const reads: string[] = [];
    const entries = Object.assign(Object.create({ "8": original }), { "7": original, "230797": original, "10": {} });
    Object.defineProperty(entries, "9", { get() { throw new Error("Unavailable factory"); } });
    const factories = new Proxy(entries, {
        ownKeys() { return assert.fail("Known IDs must not enumerate the factory map"); },
        get(target, key, receiver) { reads.push(String(key)); return Reflect.get(target, key, receiver); }
    });
    const require = Object.assign(() => assert.fail("Must not require a module"), { m: factories });
    Object.defineProperty(require, "c", { get() { assert.fail("Must not read module cache"); } });
    const f = fixture(undefined, "success", { Vencord: { Webpack: { wreq: require } } });
    Object.assign(f.processState.env, { REPORTER_FACTORY_IDS: JSON.stringify([...JSON.parse(configured.REPORTER_FACTORY_IDS), "230797", "7", "8", "9", "10"]) });
    await f.reporter.main();
    f.reporter.report.badPatches.push({ id: "7" });
    f.processState.exitCode = 1;
    await f.reporter.finishReporter();
    const data = JSON.parse(f.written[0]);
    assert.deepEqual(data.factories.map(factory => [factory.id, factory.status]), [
        ["7", "captured"], ["230797", "captured"], ["8", "missing"], ["9", "unavailable"], ["10", "missing"]
    ]);
    assert.equal(data.factories[1].original, String(original));
    assert.deepEqual(data.requestedFactories.map(factory => factory.id), ["230797", "7", "8", "9", "10"]);
    assert.deepEqual(reads, ["7", "230797", "9", "10"], "failed IDs come first and inherited values are not read");
    assert.equal(data.probeScan, undefined);
    assert.deepEqual(f.exits, [1]);
});

test("invalid numeric factory configuration preserves normal capture and the failed verdict", async () => {
    const f = fixture(undefined, "success", { Vencord: { Webpack: { wreq: { m: { "7": function failedFactory() {} } } } } });
    const parse = f.reporter.parseFactoryIds;
    for (const value of ["", "[", "{}", '[null]', '[1]', '[""]', '["01"]', '["-1"]', '["1e3"]', '["__proto__"]', JSON.stringify(["1".repeat(17)]), JSON.stringify(Array(9).fill("7")), " ".repeat(1_025)]) {
        const parsed = parse(value);
        assert.equal(parsed.requestedIds.length, 0);
        assert.match(parsed.requestedIdsError, /at most 8 canonical numeric strings/);
        assert.ok(parsed.requestedIdsError.length < 200);
    }
    assert.equal(parse(undefined).requestedIds.length, 0);
    assert.equal(parse("[]").requestedIdsError, undefined);
    assert.equal(parse(JSON.stringify(Array(8).fill("7"))).requestedIds.length, 1);
    assert.deepEqual(Array.from(parse('["0","9999999999999999"]').requestedIds), ["0", "9999999999999999"]);
    Object.assign(f.processState.env, { REPORTER_FACTORY_IDS: '["__proto__"]' });
    await f.reporter.main();
    f.reporter.report.badPatches.push({ id: "7" });
    f.processState.exitCode = 1;
    await f.reporter.finishReporter();
    const data = JSON.parse(f.written[0]);
    assert.equal(data.factories[0].status, "captured");
    assert.match(data.requestedIdsError, /REPORTER_FACTORY_IDS/);
    assert.equal(data.requestedFactories, undefined);
    assert.deepEqual(f.exits, [1]);
});

test("invalid or excessive probe configuration cannot discard failed-ID capture", async () => {
    const f = fixture(undefined, "success", { Vencord: { Webpack: { wreq: { m: { "7": function fixtureFactory() {} } } } } });
    const parse = f.reporter.parseFactoryProbes;
    for (const value of ["", "[", "{}", '[null]', '[""]', JSON.stringify(["x".repeat(129)]), JSON.stringify(Array(9).fill("x")), " ".repeat(8_193)]) {
        const parsed = parse(value);
        assert.equal(parsed.probes.length, 0);
        assert.match(parsed.probeError, /at most 8/);
        assert.ok(parsed.probeError.length < 200);
    }
    assert.equal(parse(undefined).probes.length, 0);
    assert.equal(parse("[]").probeError, undefined);
    assert.equal(parse(JSON.stringify(Array(8).fill("x".repeat(128)))).probes.length, 1, "valid duplicate literals are searched once");
    Object.assign(f.processState.env, { REPORTER_FACTORY_PROBES: "[invalid" });
    await f.reporter.main();
    f.reporter.report.badPatches.push({ id: "7" });
    f.processState.exitCode = 1;
    await f.reporter.finishReporter();
    const data = JSON.parse(f.written[0]);
    assert.equal(data.factories[0].status, "captured");
    assert.match(data.probeError, /REPORTER_FACTORY_PROBES/);
    assert.equal(data.probes, undefined);
    assert.deepEqual(f.exits, [1]);
});

test("probe and requested captures share the 100-factory and 8 MiB escaped UTF-8 limits with failed IDs", () => {
    const original = function target() { return "unique-probe"; };
    const factories = Object.fromEntries(Array.from({ length: 100 }, (_, id) => [String(id), function unrelated() {}]));
    factories["100"] = original;
    const f = fixture(undefined, "success", { Vencord: { Webpack: { wreq: { m: factories } } } });
    const options = { ids: Object.keys(factories).slice(0, 100), omittedModuleCount: 0, maxBytes: 8 * 1024 * 1024, probes: ["unique-probe"] };
    const limited = JSON.parse(f.reporter.captureFailedFactories(options));
    assert.equal(limited.factories.length, 100);
    assert.equal(limited.probes[0].status, "module-limit");
    const requested = JSON.parse(f.reporter.captureFailedFactories({ ...options, requestedIds: ["100", "0"] }));
    assert.equal(requested.factories.length, 100);
    assert.deepEqual(requested.requestedFactories, [{ id: "100", status: "module-limit" }, { id: "0", status: "selected" }]);
    const duplicate = JSON.parse(f.reporter.captureFailedFactories({ ...options, ids: ["100"] }));
    assert.deepEqual(duplicate.factories.map(factory => factory.id), ["100"], "a probe and failure selecting one ID must not duplicate its source");
    const shared = JSON.parse(f.reporter.captureFailedFactories({ ...options, ids: ["0"], requestedIds: ["100"] }));
    assert.deepEqual(shared.factories.map(factory => factory.id), ["0", "100"], "requested and probe IDs share one source entry after failed IDs");
    const source = 'function large(){return "unique-probe' + "🙂".repeat(3 * 1024 * 1024) + '"}';
    original.toString = () => source;
    const payload = f.reporter.captureFailedFactories({ ...options, ids: [], requestedIds: ["100"] });
    assert.ok(Buffer.byteLength(payload, "utf8") <= options.maxBytes);
    const oversized = JSON.parse(payload);
    assert.equal(oversized.probes[0].status, "selected");
    assert.equal(oversized.factories[0].status, "size-limit");
    assert.equal(oversized.factories[0].original, undefined);
});

test("incomplete probe scans disclose unavailable factories and bounded time, entry and character work", () => {
    const match = function firstFactory() { return "unique-probe"; };
    const options = { ids: ["1"], probes: ["unique-probe"], omittedModuleCount: 0, maxBytes: 8 * 1024 * 1024 };
    const check = (factories: object, status: string, extraGlobals: Record<string, unknown> = {}, probes = options.probes) => {
        const f = fixture(undefined, "success", { Vencord: { Webpack: { wreq: { m: factories } } }, performance: { now: () => 0 }, ...extraGlobals });
        const data = JSON.parse(f.reporter.captureFailedFactories({ ...options, probes }));
        assert.equal(data.probeScan.complete, false);
        assert.equal(data.probeScan.status, status);
        assert.equal(data.probes[0].status, "incomplete", "a partial scan cannot claim uniqueness");
        assert.deepEqual(data.factories.map(factory => factory.id), ["1"], "failed-ID capture survives an incomplete probe scan");
        return data;
    };
    const unavailable = check({ "1": match, get "2"() { throw new Error("Detached factory"); } }, "unavailable");
    assert.equal(unavailable.probeScan.unavailableFactories, 1);
    let time = 0;
    check({ "1": match, "2": function laterFactory() {} }, "time-limit", { performance: { now: () => time += 1_000 } });
    const entries = Object.fromEntries(Array.from({ length: 50_001 }, (_, id) => [String(id + 1), id ? function unrelated() {} : match]));
    const entryLimited = check(entries, "entry-limit");
    assert.equal(entryLimited.probeScan.examinedEntries, 50_000);
    const large = Object.assign(function largeFactory() {}, { toString: () => "x".repeat(2 * 1024 * 1024) });
    const chars = Object.fromEntries(Array.from({ length: 10 }, (_, id) => [String(id + 1), id ? large : match]));
    const characterLimited = check(chars, "character-limit", {}, ["unique-probe", ...Array.from({ length: 7 }, (_, id) => `absent-${id}`)]);
    assert.ok(characterLimited.probeScan.searchedCharacters <= 128 * 1024 * 1024);
});

test("factory diagnostic failures, stalls, and oversized replies preserve the failed verdict and teardown", async () => {
    for (const mode of ["reject", "stall", "oversize", "write-fail"] as const) {
        const f = fixture("success", mode);
        Object.assign(f.processState.env, { REPORTER_FACTORY_PROBES: '["fixture"]', REPORTER_FACTORY_IDS: '["7"]' });
        await f.reporter.main();
        f.reporter.handlePageError(new Error("Startup failure"));
        await f.reporter.finishReporter();
        assert.deepEqual(f.calls, ["factories", ...(mode === "write-fail" ? ["write-factories"] : []), "screenshot", "close", "report", "exit"], mode);
        assert.deepEqual(f.exits, [1], mode);
        assert.equal(f.written.length, 0);
    }
    const success = fixture(undefined, "success");
    Object.assign(success.processState.env, { REPORTER_FACTORY_PROBES: '["fixture"]', REPORTER_FACTORY_IDS: '["7"]' });
    await success.reporter.main();
    await success.reporter.finishReporter();
    assert.deepEqual(success.calls, ["close", "report", "exit"], "successful runs must not capture factories");
    assert.deepEqual(success.exits, [0]);
});
