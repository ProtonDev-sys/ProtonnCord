import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function loadBenchmark() {
    const source = read("scripts/benchmarkDiscord.ts").replace("void main();", "exports.audit = { collectRuntimeMetrics, collectProcessCpu, collectNavigationSamples };");
    const code = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(`${code}\nexports.audit;`, {
        exports: {},
        require(name: string) {
            if (name === "node:assert/strict") return assert;
            if (name === "puppeteer-core") return {};
            throw new Error(`Unexpected benchmark import: ${name}`);
        },
        setTimeout,
    });
}

test("benchmark metric sessions detach after protocol failures", async () => {
    const benchmark = loadBenchmark();
    for (const operation of ["Performance.enable", "HeapProfiler.collectGarbage", "Performance.getMetrics", "Memory.getDOMCounters", "SystemInfo.getProcessInfo"]) {
        let detached = 0;
        const session = {
            async send(command: string) {
                if (command === operation) throw new Error(operation);
                return { metrics: [], documents: 1, nodes: 2, jsEventListeners: 3 };
            },
            async detach() { detached++; },
        };
        const run = operation.startsWith("SystemInfo")
            ? benchmark.collectProcessCpu({ target: () => ({ createCDPSession: async () => session }) })
            : benchmark.collectRuntimeMetrics({ createCDPSession: async () => session }, true);
        await assert.rejects(run, new RegExp(operation));
        assert.equal(detached, 1, operation);
    }
});

test("benchmark profiler stops and detaches after navigation failure", async () => {
    const commands: string[] = [];
    const session = {
        async send(command: string) { commands.push(command); return { profile: { nodes: [] } }; },
        async detach() { commands.push("detach"); },
    };
    await assert.rejects(loadBenchmark().collectNavigationSamples({
        createCDPSession: async () => session,
        evaluate: async () => { throw new Error("navigation failed"); },
    }, ["/channels/1/2"], 1, true), /navigation failed/);
    assert.deepEqual(commands, ["Profiler.enable", "Profiler.start", "Profiler.stop", "detach"]);
});

test("benchmark profiler detaches when enable, start, or stop fails", async () => {
    for (const failure of ["Profiler.enable", "Profiler.start", "Profiler.stop"]) {
        const commands: string[] = [];
        const session = {
            async send(command: string) {
                commands.push(command);
                if (command === failure) throw new Error(failure);
                return { profile: { nodes: [] } };
            },
            async detach() { commands.push("detach"); },
        };
        await assert.rejects(loadBenchmark().collectNavigationSamples({ createCDPSession: async () => session }, [], 0, true), new RegExp(failure));
        assert.equal(commands.at(-1), "detach");
        assert.equal(commands.filter(command => command === "detach").length, 1);
    }
});

test("successful benchmark sampling stops profiler exactly once", async () => {
    const commands: string[] = [];
    const profile = { nodes: [] };
    const result = await loadBenchmark().collectNavigationSamples({
        createCDPSession: async () => ({
            async send(command: string) { commands.push(command); return { profile }; },
            async detach() { commands.push("detach"); },
        }),
        evaluate: async () => ({ timedOut: false }),
    }, ["/channels/1/2"], 1, true);
    assert.equal(result.samples.length, 1);
    assert.equal(result.profile, profile);
    assert.deepEqual(commands, ["Profiler.enable", "Profiler.start", "Profiler.stop", "detach"]);
});

test("release gate skips stale builds before creating tags or publishing", () => {
    const workflow = read(".github/workflows/publish.yml");
    assert.match(workflow, /release: \$\{\{ steps\.release\.outputs\.release \}\}/u);
    assert.match(workflow, /git archive --format=zip --output=dist\/extension-sources\.zip "\$GITHUB_SHA"/u);
    const persistenceStart = workflow.indexOf("current_sha=$(gh api", workflow.indexOf("- name: Persist durable release archives"));
    const tagStart = workflow.indexOf("current_sha=$(gh api", workflow.indexOf("- name: Create Tag"));
    assert.ok(persistenceStart >= 0 && tagStart > persistenceStart);
    const gates = [
        { name: "archives", command: workflow.slice(persistenceStart, workflow.indexOf("\n            - name: Store release archives", persistenceStart)), staleStatus: 1 },
        { name: "tag", command: workflow.slice(tagStart, workflow.indexOf("\n    publish-chrome:", tagStart)), staleStatus: 0 },
    ];
    const directory = mkdtempSync(path.join(tmpdir(), "tooling-release-test-"));
    try {
        for (const gate of gates) for (const current of ["stale", "expected"]) {
            const output = path.join(directory, `${gate.name}-${current}.txt`).replaceAll("\\", "/");
            writeFileSync(output, "");
            const mock = `gh() { if [[ "$*" == *branches/main* ]]; then echo "$CURRENT_SHA"; else echo mutation; fi; }\n`;
            let result = "";
            let status = 0;
            try {
                result = execFileSync(process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash", ["-s"], {
                    input: `set -euo pipefail\n${mock}${gate.command.replace(/^ {18}/gmu, "")}`,
                    encoding: "utf8",
                    timeout: 10_000,
                    stdio: "pipe",
                    env: { ...process.env, CURRENT_SHA: current, GITHUB_SHA: "expected", GITHUB_REPOSITORY: "fixture/repository", GITHUB_OUTPUT: output, ARTIFACT_TAG: "fixture-archives", PACKAGE_VERSION: "v1.0.0" },
                });
            } catch (error) {
                const failure = error as { status: number; stdout: string; stderr: string; };
                status = failure.status;
                result = failure.stdout;
                assert.match(failure.stderr, /Superseded release build/u);
            }
            assert.equal(status, current === "stale" ? gate.staleStatus : 0);
            assert.equal(readFileSync(output, "utf8").trim(), gate.name === "tag" ? `release=${current === "expected"}` : "");
            assert.equal(result.includes("mutation"), current === "expected");
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("report publisher passes a bounded abort signal without network access", async () => {
    const workflow = read(".github/workflows/reportBrokenPlugins.yml");
    assert.match(workflow, /publish:\s+name: Publish validated report\s+timeout-minutes: 5/u);
    const inline = workflow.slice(workflow.indexOf('const { createHmac } = require("node:crypto");'), workflow.lastIndexOf("main().catch(error =>"))
        .replace(/^ {18}/gmu, "");
    const payload = JSON.stringify({ username: "Protonn Cord Reporter", embeds: [{ description: "fixture" }] });
    const signal = {};
    let sent = 0;
    let cancelled = 0;
    await runInNewContext(`${inline}\nmain();`, {
        URL,
        process: { env: { WEBHOOK_URL: "https://report.invalid/endpoint", PAYLOAD_DIR: path.resolve("/fixture") } },
        require(name: string) {
            if (name === "node:crypto") return {};
            if (name === "node:path") return path;
            if (name === "node:fs/promises") return {
                realpath: async (value: string) => value,
                readdir: async () => ["report-stable.json"],
                lstat: async () => ({ size: Buffer.byteLength(payload), isFile: () => true, isSymbolicLink: () => false }),
                readFile: async () => payload,
            };
            throw new Error(`Unexpected publisher import: ${name}`);
        },
        AbortSignal: { timeout(milliseconds: number) { assert.equal(milliseconds, 30_000); return signal; } },
        async fetch(_endpoint: URL, options: { signal: unknown; redirect: string; }) {
            sent++;
            assert.equal(options.signal, signal);
            assert.equal(options.redirect, "error");
            return { ok: true, body: { async cancel() { cancelled++; } } };
        },
    });
    assert.equal(sent, 1);
    assert.equal(cancelled, 1);
});

test("mention proof uses a word boundary rather than a backspace", () => {
    const source = read("scripts/testSecureMessagingLive.ts");
    assert.equal(source.includes("\u0008"), false);
    const pattern = source.match(/mentionedClassApplied: (\/[^\n]+\/u)\.test/u)?.[1];
    assert.ok(pattern);
    const expression = runInNewContext(pattern);
    assert.equal(expression.test("pc-secure-row mentioned_123"), true);
    assert.equal(expression.test("pc-secure-row notmentioned_123"), false);
});

test("local reporter bounds webhook requests and releases response bodies", async () => {
    const source = read("scripts/generateReport.ts");
    const command = source.slice(source.indexOf("await fetch(process.env.WEBHOOK_URL"), source.indexOf("\n    }\n}", source.indexOf("await fetch(process.env.WEBHOOK_URL")));
    assert.ok(command.startsWith("await fetch("));
    for (const ok of [true, false]) {
        const signal = {};
        let cancelled = 0;
        await runInNewContext(`(async () => { ${command} })();`, {
            process: { env: { WEBHOOK_URL: "https://report.invalid/endpoint" } },
            headers: {},
            body: "fixture",
            logStderr() {},
            AbortSignal: { timeout(milliseconds: number) { assert.equal(milliseconds, 30_000); return signal; } },
            async fetch(_endpoint: string, options: { signal: unknown; }) {
                assert.equal(options.signal, signal);
                return { ok, status: ok ? 200 : 503, body: { async cancel() { cancelled++; } } };
            },
        });
        assert.equal(cancelled, 1);
    }
});

test("CI validates lint before fixing and includes omitted focused suites", () => {
    const workflow = read(".github/workflows/test.yml");
    assert.match(workflow, /run: pnpm lint && pnpm test/u);
    assert.match(workflow, /run: pnpm testPrimaryStreamAudio && pnpm testPromiseTimeout/u);
    assert.doesNotMatch(workflow, /run: pnpm exec tsx --test scripts\/testAuditToolingDeep\.ts/u);
    assert.match(read("scripts/runAuditTests.mjs"), /testAudit\.\+.*ts/u);
});

const identity = { accountId: "100000000000000001", channelId: "100000000000000002", recipientId: "100000000000000003" };
const identityEnv = {
    DISCORD_MCP_TEST_ACCOUNT_ID: identity.accountId,
    DISCORD_MCP_TEST_CHANNEL_ID: identity.channelId,
    DISCORD_MCP_TEST_RECIPIENT_ID: identity.recipientId,
};

function loadLiveHarness(globals: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
    const source = read("scripts/testDiscordMcpLive.ts").replace("void main();", "exports.audit = { readTestIdentity, manageTestPlugin, createRpcClient, cleanupLiveTest, connectWithRetry, main, readOwnedState() { return globalThis[Symbol.for('ProtonnCord.DiscordMCP.liveTest')]; } };");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const imports: Record<string, unknown> = {
        "node:assert/strict": assert,
        "node:child_process": { spawn() { throw new Error("Offline test forbids spawning MCP"); } },
        "node:fs/promises": {},
        "node:path": path,
        "node:readline": { createInterface },
        "puppeteer-core": { __esModule: true, default: { connect() { throw new Error("Offline test forbids connecting Discord"); } } },
        ...overrides,
    };
    return runInNewContext(`${code}\nexports.audit;`, {
        exports: {}, process: { env: identityEnv }, setTimeout, clearTimeout,
        require(name: string) { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; },
        ...globals,
    });
}

function rendererFixture(started = false) {
    const settings: Record<string, any> = { enabled: false, allowedChannelIds: ["saved"], unknown: { preserve: true } };
    const plugin = { started };
    const calls = { start: 0, stop: 0, initialize: 0 };
    const user = { id: identity.accountId };
    const channel = { type: 1, recipients: [identity.recipientId] };
    const globals = {
        Vencord: {
            Webpack: { Common: { UserStore: { getCurrentUser: () => user }, ChannelStore: { getChannel: (id: string) => id === identity.channelId ? channel : null } } },
            Settings: { plugins: { DiscordMCP: settings } },
            Plugins: {
                plugins: { DiscordMCP: plugin },
                startPlugin() { calls.start++; plugin.started = true; return true; },
                stopPlugin() { calls.stop++; plugin.started = false; return true; },
            },
        },
        VencordNative: { pluginHelpers: { DiscordMCP: { async initializeBridge() { calls.initialize++; return { queueDirectory: "/offline" }; } } } },
    };
    return { globals, settings, plugin, calls, user, channel };
}

test("live identity flags are mandatory before any connection", async () => {
    for (const name of Object.keys(identityEnv)) {
        const env: Record<string, string> = { ...identityEnv };
        delete env[name];
        await assert.rejects(loadLiveHarness({ process: { env } }).main(), new RegExp(name));
    }
    assert.throws(() => loadLiveHarness({ process: { env: { ...identityEnv, DISCORD_MCP_TEST_CHANNEL_ID: "not-an-id" } } }).readTestIdentity(), /CHANNEL_ID/);
});

test("unresolved Discord connect is bounded by the total deadline", async () => {
    let attempts = 0;
    const harness = loadLiveHarness({}, {
        "puppeteer-core": { __esModule: true, default: { connect() { attempts++; return new Promise(() => {}); } } },
    });
    const started = Date.now();
    await assert.rejects(harness.connectWithRetry(35, 20, 1), /Discord connection attempt timed out.*unknown/);
    assert.ok(Date.now() - started < 1_000);
    assert.ok(attempts >= 1 && attempts <= 2);
});

test("late Discord connect disconnects once without closing the browser or replacing a successful retry", async () => {
    let completeLate!: (value: unknown) => void;
    let attempts = 0;
    let disconnects = 0;
    let closes = 0;
    const current = { disconnect() { throw new Error("Must not disconnect the accepted session"); } };
    const late = { async disconnect() { disconnects++; }, async close() { closes++; } };
    const harness = loadLiveHarness({}, {
        "puppeteer-core": { __esModule: true, default: { connect() { attempts++; return attempts === 1 ? new Promise(resolve => { completeLate = resolve; }) : Promise.resolve(current); } } },
    });
    assert.equal(await harness.connectWithRetry(200, 20, 1), current);
    completeLate(late);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual({ attempts, disconnects, closes }, { attempts: 2, disconnects: 1, closes: 0 });
});

test("late connection cleanup failure is bounded and reports an unknown session without killing its browser", async () => {
    for (const failure of ["reject", "hang"]) {
        let completeLate!: (value: unknown) => void;
        let disconnects = 0;
        let closes = 0;
        const warnings: string[] = [];
        const processState = { env: identityEnv, exitCode: 0 };
        const harness = loadLiveHarness({
            process: processState,
            console: { error(message: unknown) { warnings.push(String(message)); } },
            setTimeout: (callback: () => void, timeoutMs: number) => setTimeout(callback, timeoutMs === 5_000 ? 20 : timeoutMs),
        }, {
            "puppeteer-core": { __esModule: true, default: { connect() { return new Promise(resolve => { completeLate = resolve; }); } } },
        });
        await assert.rejects(harness.connectWithRetry(20, 20, 1), /timed out/);
        completeLate({
            disconnect() { disconnects++; return failure === "reject" ? Promise.reject(new Error("disconnect failed")) : new Promise(() => {}); },
            close() { closes++; },
        });
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(disconnects, 1);
        assert.equal(closes, 0);
        assert.equal(processState.exitCode, 1);
        assert.ok(warnings.some(message => /Late Discord connection cleanup failed.*unknown/.test(message)));
    }
});

test("wrong live account or destination rejects before settings or activation", async () => {
    for (const mismatch of ["account", "recipient", "group", "missing"]) {
        const fixture = rendererFixture();
        const before = JSON.stringify(fixture.settings);
        if (mismatch === "account") fixture.user.id = "100000000000000009";
        if (mismatch === "recipient") fixture.channel.recipients = ["100000000000000009"];
        if (mismatch === "group") fixture.channel.type = 3;
        const expected = mismatch === "missing" ? { ...identity, channelId: "100000000000000009" } : identity;
        await assert.rejects(loadLiveHarness(fixture.globals).manageTestPlugin({ identity: expected, token: "fixture", phase: "activate" }), /refusing mutations/);
        assert.equal(JSON.stringify(fixture.settings), before);
        assert.deepEqual(fixture.calls, { start: 0, stop: 0, initialize: 0 });
    }
});

test("live activation restores only affected settings and test-owned lifecycle", async () => {
    for (const started of [false, true]) {
        const fixture = rendererFixture(started);
        const harness = loadLiveHarness(fixture.globals);
        const request = { identity, token: "fixture", phase: "activate" };
        await harness.manageTestPlugin(request);
        assert.equal(fixture.settings.enabled, true);
        assert.equal(Object.hasOwn(fixture.settings, "allowedChannelIds"), false);
        fixture.settings.concurrentUnknown = "retain";
        await harness.manageTestPlugin({ ...request, phase: "restore" });
        assert.equal(fixture.settings.enabled, false);
        assert.deepEqual(fixture.settings.allowedChannelIds, ["saved"]);
        assert.deepEqual(fixture.settings.unknown, { preserve: true });
        assert.equal(fixture.settings.concurrentUnknown, "retain");
        assert.equal(fixture.plugin.started, started);
        assert.equal(fixture.calls.start, started ? 0 : 1);
        assert.equal(fixture.calls.stop, started ? 0 : 1);
    }
});

test("bridge initialization failure still leaves a restorable settings snapshot", async () => {
    const fixture = rendererFixture();
    fixture.globals.VencordNative.pluginHelpers.DiscordMCP.initializeBridge = async () => { throw new Error("bridge unavailable"); };
    const harness = loadLiveHarness(fixture.globals);
    await assert.rejects(harness.manageTestPlugin({ identity, token: "fixture", phase: "activate" }), /bridge unavailable/);
    await harness.manageTestPlugin({ identity, token: "fixture", phase: "restore" });
    assert.equal(fixture.settings.enabled, false);
    assert.deepEqual(fixture.settings.allowedChannelIds, ["saved"]);
    assert.equal(fixture.plugin.started, false);
});

test("restoration refuses a switched account and does not stop its plugin", async () => {
    const fixture = rendererFixture();
    const harness = loadLiveHarness(fixture.globals);
    await harness.manageTestPlugin({ identity, token: "fixture", phase: "activate" });
    fixture.user.id = "100000000000000009";
    await assert.rejects(harness.manageTestPlugin({ identity, token: "fixture", phase: "restore" }), /refusing mutations/);
    assert.equal(fixture.calls.stop, 0);
});

function fakeRpcChild() {
    const sent: any[] = [];
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stdin: new Writable({ write(chunk, _encoding, callback) { sent.push(JSON.parse(chunk.toString())); callback(); } }),
    });
    return { child, sent };
}

test("RPC deadlines discard late responses while subsequent requests remain usable", async () => {
    const { child, sent } = fakeRpcChild();
    const client = loadLiveHarness().createRpcClient(child, 20);
    await assert.rejects(client.rpc("tools/call"), /timed out.*unknown/);
    child.stdout.write(JSON.stringify({ id: sent[0].id, result: "late" }) + "\n");
    const next = client.rpc("tools/list");
    child.stdout.write(JSON.stringify({ id: sent[1].id, result: "current" }) + "\n");
    assert.equal(await next, "current");
    client.dispose();
});

test("RPC rejects all pending work on child close, child error, stdin error, or malformed JSON", async () => {
    for (const failure of ["close", "error", "stdin", "json"]) {
        const { child } = fakeRpcChild();
        const client = loadLiveHarness().createRpcClient(child, 10_000);
        const first = assert.rejects(client.rpc("first"));
        const second = assert.rejects(client.rpc("second"));
        if (failure === "close") child.emit("close", 1, null);
        if (failure === "error") child.emit("error", new Error("child failed"));
        if (failure === "stdin") child.stdin.emit("error", new Error("pipe failed"));
        if (failure === "json") child.stdout.write("invalid-json\n");
        await Promise.all([first, second]);
        await assert.rejects(client.rpc("after failure"));
        client.dispose();
    }
});

test("bounded cleanup reports uncertainty and never resends or repeats an attempted deletion", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    await loadLiveHarness().cleanupLiveTest({
        channelId: identity.channelId, sentMessageId: "known-id", subscriptionId: "subscription", deleteAttempted: true, pendingSend: true, marker: "fixture-marker",
        callTool: async (name: string) => { calls.push(name); return new Promise(() => {}); },
        restore: async () => { calls.push("restore"); },
        dispose: () => { calls.push("dispose"); }, kill: () => { calls.push("kill"); }, disconnect: async () => { calls.push("disconnect"); },
        warn: (message: string) => { warnings.push(message); },
    }, 20);
    assert.deepEqual(calls, ["discord_unsubscribe_channel", "dispose", "kill", "restore", "disconnect"]);
    assert.ok(warnings.some(message => message.includes("fixture-marker") && message.includes("no automatic resend")));
    assert.ok(warnings.some(message => message.includes("known-id") && message.includes("no automatic delete retry")));
});

test("cleanup attempts a confirmed sent-message deletion once and reports an unconfirmed result", async () => {
    const warnings: string[] = [];
    let attempts = 0;
    await loadLiveHarness().cleanupLiveTest({
        channelId: identity.channelId, sentMessageId: "known-id", deleteAttempted: false, pendingSend: false,
        callTool: async (name: string) => { assert.equal(name, "discord_delete_own_message"); attempts++; return { deleted: false }; },
        restore: async () => {}, dispose() {}, kill() {}, disconnect: async () => {}, warn: (message: string) => { warnings.push(message); },
    }, 20);
    assert.equal(attempts, 1);
    assert.match(warnings[0], /known-id.*may be retained.*not confirmed/);
});

function loadReporter(browser: unknown, print: () => Promise<unknown> = async () => {}, launch: () => Promise<unknown> = async () => browser) {
    const exits: number[] = [];
    const processState = { env: { CHROMIUM_BIN: "offline-fixture" }, exitCode: 0, exit(code?: number) { exits.push(code ?? processState.exitCode); } };
    const source = read("scripts/generateReport.ts").replace("void main();", "exports.audit = { main, finishReporter, handleConsole, setBrowser(value) { browser = value; }, setPrint(value) { printReport = value; }, report };");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const imports: Record<string, unknown> = {
        crypto: {}, fs: { readFileSync: () => "offline-browser-fixture" },
        "puppeteer-core": { __esModule: true, default: { launch } },
    };
    const reporter = runInNewContext(`${code}\nexports.audit;`, {
        exports: {}, process: processState, setTimeout, clearTimeout, console: { log() {}, error() {} },
        require(name: string) { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; },
    });
    reporter.setPrint(print);
    return { reporter, exits, processState };
}

test("reporter startup and navigation failures finalize browser ownership", async () => {
    for (const failure of ["newPage", "setUserAgent", "setBypassCSP", "evaluateOnNewDocument", "goto"]) {
        let closes = 0;
        let reports = 0;
        const page: Record<string, any> = { on() {} };
        for (const method of ["setUserAgent", "setBypassCSP", "evaluateOnNewDocument", "goto"])
            page[method] = async () => { if (failure === method) throw new Error(method); };
        const browser = { async newPage() { if (failure === "newPage") throw new Error(failure); return page; }, async close() { closes++; } };
        const { reporter, exits } = loadReporter(browser, async () => { reports++; });
        await reporter.main();
        assert.equal(closes, 1, failure);
        assert.equal(reports, 1, failure);
        assert.deepEqual(exits, [1], failure);
    }
});

test("reporter launch rejection publishes diagnostics without inventing an owned browser", async () => {
    let closes = 0;
    let reports = 0;
    const { reporter, exits } = loadReporter({ async close() { closes++; } }, async () => { reports++; }, async () => { throw new Error("launch failed"); });
    await reporter.main();
    assert.equal(closes, 0);
    assert.equal(reports, 1);
    assert.match(reporter.report.otherErrors[0], /launch failed/);
    assert.deepEqual(exits, [1]);
});

test("live main finally restores partial start and bridge failures without spawning a child", async () => {
    for (const failure of ["start", "bridge"]) {
        const fixture = rendererFixture();
        if (failure === "bridge") fixture.globals.VencordNative.pluginHelpers.DiscordMCP.initializeBridge = async () => { throw new Error("bridge failed"); };
        else fixture.globals.Vencord.Plugins.startPlugin = () => { fixture.calls.start++; fixture.plugin.started = true; throw new Error("start failed"); };
        let disconnects = 0;
        const page = {
            url: () => "https://discord.com/channels/@me/offline",
            async waitForFunction() {},
            evaluate: (callback: (input: unknown) => Promise<unknown>, input: unknown) => callback(input),
        };
        const harness = loadLiveHarness(fixture.globals, {
            "puppeteer-core": { __esModule: true, default: { async connect() { return { pages: async () => [page], disconnect() { disconnects++; } }; } } },
        });
        await assert.rejects(harness.main(), new RegExp(failure + " failed"));
        assert.equal(disconnects, 1);
        assert.equal(fixture.calls.stop, 1);
        assert.equal(fixture.settings.enabled, false);
        assert.deepEqual(fixture.settings.allowedChannelIds, ["saved"]);
        assert.equal(harness.readOwnedState(), undefined);
    }
});

test("timed-out activation never replays late completion and retains ownership when the account switches", async () => {
    for (const switched of [false, true]) {
        const fixture = rendererFixture();
        let completeBridge!: (value: { queueDirectory: string; }) => void;
        fixture.globals.VencordNative.pluginHelpers.DiscordMCP.initializeBridge = () => {
            fixture.calls.initialize++;
            if (switched) fixture.user.id = "100000000000000009";
            return new Promise(resolve => { completeBridge = resolve; });
        };
        let disconnects = 0;
        const warnings: string[] = [];
        const processState = { env: identityEnv, exitCode: 0 };
        const page = {
            url: () => "https://discord.com/channels/@me/offline",
            async waitForFunction() {},
            evaluate: (callback: (input: unknown) => Promise<unknown>, input: unknown) => callback(input),
        };
        const harness = loadLiveHarness({
            ...fixture.globals, process: processState,
            setTimeout: (callback: () => void, timeoutMs: number) => setTimeout(callback, timeoutMs === 10_000 ? 20 : timeoutMs),
            console: { error(message: unknown) { warnings.push(String(message)); }, log() {} },
        }, {
            "puppeteer-core": { __esModule: true, default: { async connect() { return { pages: async () => [page], disconnect() { disconnects++; } }; } } },
        });
        await assert.rejects(harness.main(), /Plugin activation timed out; outcome may be unknown/);
        const saved = harness.readOwnedState();
        assert.equal(disconnects, 1);
        assert.equal(fixture.calls.stop, switched ? 0 : 1);
        if (switched) {
            assert.ok(saved.token && saved.startedByTest);
            assert.equal(saved.fields.enabled.value, false);
            assert.ok(warnings.some(message => /ownership state is retained.*original account/.test(message)));
            assert.equal(processState.exitCode, 1);
        } else {
            assert.equal(saved, undefined);
            assert.equal(fixture.settings.enabled, false);
            assert.deepEqual(fixture.settings.allowedChannelIds, ["saved"]);
        }
        completeBridge({ queueDirectory: "/offline-late" });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(fixture.calls, { start: 1, stop: switched ? 0 : 1, initialize: 1 });
        assert.equal(harness.readOwnedState(), saved);
        assert.equal(fixture.settings.enabled, switched);
    }
});

test("activation start failure restores absent fields and cannot steal another harness snapshot", async () => {
    const fixture = rendererFixture();
    delete fixture.settings.enabled;
    delete fixture.settings.allowedChannelIds;
    fixture.globals.Vencord.Plugins.startPlugin = () => false;
    const harness = loadLiveHarness(fixture.globals);
    await assert.rejects(harness.manageTestPlugin({ identity, token: "owner", phase: "activate" }), /failed to start/);
    await assert.rejects(harness.manageTestPlugin({ identity, token: "other", phase: "activate" }), /already owns/);
    await assert.rejects(harness.manageTestPlugin({ identity, token: "other", phase: "restore" }), /owns the saved/);
    await harness.manageTestPlugin({ identity, token: "owner", phase: "restore" });
    assert.equal(Object.hasOwn(fixture.settings, "enabled"), false);
    assert.equal(Object.hasOwn(fixture.settings, "allowedChannelIds"), false);
    assert.deepEqual(fixture.settings.unknown, { preserve: true });
});

test("stop failure restores affected settings but retains the cleanup snapshot for diagnosis", async () => {
    const fixture = rendererFixture();
    fixture.globals.Vencord.Plugins.stopPlugin = () => false;
    const harness = loadLiveHarness(fixture.globals);
    await harness.manageTestPlugin({ identity, token: "owner", phase: "activate" });
    await assert.rejects(harness.manageTestPlugin({ identity, token: "owner", phase: "restore" }), /could not be stopped/);
    assert.equal(fixture.settings.enabled, false);
    assert.deepEqual(fixture.settings.allowedChannelIds, ["saved"]);
    await assert.rejects(harness.manageTestPlugin({ identity, token: "other", phase: "activate" }), /already owns/);
});

test("cleanup continues after disposal, termination, restoration and disconnect failures", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    await loadLiveHarness().cleanupLiveTest({
        channelId: identity.channelId, deleteAttempted: false, pendingSend: false,
        dispose() { calls.push("dispose"); throw new Error("dispose failed"); },
        kill() { calls.push("kill"); throw new Error("kill failed"); },
        restore: async () => { calls.push("restore"); return new Promise(() => {}); },
        disconnect: async () => { calls.push("disconnect"); return new Promise(() => {}); },
        warn: (message: string) => { warnings.push(message); },
    }, 20);
    assert.deepEqual(calls, ["dispose", "kill", "restore", "disconnect"]);
    assert.equal(warnings.length, 4);
    assert.ok(warnings.slice(2).every(message => message.includes("timed out") && message.includes("unknown")));
});

test("reporter finalization is shared and kills an unresponsive owned browser", async () => {
    let closes = 0;
    let kills = 0;
    let reports = 0;
    const browser = { close() { closes++; return new Promise(() => {}); }, process: () => ({ kill() { kills++; } }) };
    const { reporter, exits } = loadReporter(browser, async () => { reports++; });
    reporter.setBrowser(browser);
    const first = reporter.finishReporter(false, 20, 200);
    assert.equal(first, reporter.finishReporter());
    await first;
    assert.deepEqual({ closes, kills, reports }, { closes: 1, kills: 1, reports: 1 });
    assert.deepEqual(exits, [1]);
});

test("reporter publishes diagnostics after close failure and exits failed after publish failure", async () => {
    let kills = 0;
    const browser = { async close() { throw new Error("close failed"); }, process: () => ({ kill() { kills++; } }) };
    const { reporter, exits } = loadReporter(browser, async () => { throw new Error("publish failed"); });
    reporter.setBrowser(browser);
    await reporter.finishReporter(false, 20, 200);
    assert.equal(kills, 1);
    assert.match(reporter.report.otherErrors[0], /Browser cleanup failed/);
    assert.deepEqual(exits, [1]);
});

test("reporter final watchdog remains active while publication never settles", async () => {
    let kills = 0;
    const browser = { async close() {}, process: () => ({ kill() { kills++; } }) };
    const { reporter, exits } = loadReporter(browser, () => new Promise(() => {}));
    reporter.setBrowser(browser);
    void reporter.finishReporter(false, 20, 40);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(kills, 1);
    assert.deepEqual(exits, [1]);
});
