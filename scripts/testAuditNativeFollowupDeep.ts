import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { zipSync } from "fflate";
import * as fflate from "fflate";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { ensureSafePath } from "../src/main/utils/ensureSafePath";

const source = (path: string) => readFileSync(path, "utf8");
const compile = (code: string) => transpileModule(code, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText;

function timers() {
    let next = 0;
    const pending = new Map<number, { callback: () => void; delay: number; }>();
    return {
        pending,
        setTimeout(callback: () => void, delay: number) {
            const id = ++next;
            pending.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id: number) { pending.delete(id); },
        run(delay: number) {
            for (const [id, timer] of [...pending]) {
                if (timer.delay !== delay) continue;
                pending.delete(id);
                timer.callback();
            }
        }
    };
}

function editorFixture() {
    const clock = timers();
    const handlers = new Map<string, (...args: any[]) => any>();
    const events: string[] = [];
    const exposed = new Map<string, (...args: any[]) => any>();
    const renderer = new EventEmitter();
    const windows: Window[] = [];
    const IpcEvents = {
        OPEN_MONACO_EDITOR: "open", SET_QUICK_CSS: "save", GET_THEMES_LIST: "themes",
        MONACO_CLOSE: "close", MONACO_CLOSE_ACK: "ack"
    };
    let writeError: Error | undefined;
    let failureStage = "write";
    let saveGate: Promise<void> | undefined;
    let response = 1;
    let sendError = false;
    let showError = false;
    class Window extends EventEmitter {
        visible = true;
        destroyed = false;
        webContents = {
            isDestroyed: () => this.destroyed,
            send: (channel: string, value: unknown) => {
                if (sendError) throw new Error("fixture send failure");
                events.push(`request:${String(value)}`);
                renderer.emit(channel, {}, value);
            }
        };
        constructor(_options: unknown) { super(); windows.push(this); }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        show() { if (showError) throw new Error("fixture show failure"); this.visible = true; }
        focus() { }
        async loadURL() { }
        close() {
            let prevented = false;
            this.emit("close", { preventDefault() { prevented = true; } });
            if (!prevented) {
                events.push("closed");
                this.destroyed = true;
                this.emit("closed");
            }
        }
    }
    const app = new EventEmitter() as EventEmitter & { quit(): void; };
    app.quit = () => { events.push("quit"); };
    const mainSource = source("src/main/ipcMain.ts");
    const closeSource = mainSource.slice(mainSource.indexOf("let monacoWin"), mainSource.indexOf("ipcMain.handle(IpcEvents.GET_RENDERER_CSS"));
    const saveSource = mainSource.slice(mainSource.indexOf("ipcMain.handle(IpcEvents.SET_QUICK_CSS"), mainSource.indexOf("ipcMain.handle(IpcEvents.GET_THEMES_LIST"));
    const context = createContext({
        ...clock, IpcEvents, app, BrowserWindow: Window, __dirname: "/fixture", join,
        nativeTheme: { shouldUseDarkColors: true }, monacoHtml: "", makeLinksOpenExternally() { },
        ipcMain: { handle(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); } },
        dialog: { async showMessageBox() { events.push("prompt"); return { response }; } },
        console: { error() { events.push("error"); } }, QUICK_CSS_PATH: "fixture-css",
        openSync() { events.push("open-file"); return 7; },
        writeFileSync(_descriptor: unknown, css: string) {
            events.push(`write:${css}`);
            if (writeError && failureStage === "write") throw writeError;
        },
        fsyncSync() {
            events.push("fsync");
            if (writeError && failureStage === "fsync") throw writeError;
        }, closeSync() { events.push("close-file"); }
    });
    runInContext(compile(closeSource), context);
    runInContext(compile(saveSource), context);
    const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: windows[0].webContents }, ...args);
    const native = { quickCss: {
        async set(css: string) {
            events.push(`saving:${css}`);
            if (saveGate) await saveGate;
            await invoke("save", css);
        },
        async get() { return "existing"; }, getEditorTheme() { return "vs-dark"; }
    } };
    runInNewContext(compile(source("src/preload.ts")), {
        ...clock, exports: {}, location: { protocol: "data:" },
        console: { error() { events.push("error"); } },
        require(name: string) {
            if (name === "@shared/IpcEvents") return { IpcEvents };
            if (name === "electron/renderer") return {
                ipcRenderer: renderer,
                contextBridge: { exposeInMainWorld(key: string, value: (...args: any[]) => any) { exposed.set(key, value); } }
            };
            return { __esModule: true, default: native, invoke };
        }
    });
    exposed.get("onCssClosing")!((closing: boolean) => events.push(`readOnly:${closing}`));
    return {
        clock, events, windows, exposed, handlers,
        open: () => handlers.get("open")!(),
        set: (css: string) => exposed.get("setCss")!(css),
        fail(error?: Error, stage = "write") { writeError = error; failureStage = stage; },
        gate(promise?: Promise<void>) { saveGate = promise; },
        failWindow(send: boolean, show: boolean) { sendError = send; showError = show; },
        quit(hidden = false, decision = 1) {
            windows[0].visible = !hidden;
            response = decision;
            let prevented = false;
            app.emit("before-quit", { preventDefault() { prevented = true; } });
            return prevented;
        }
    };
}

test("editor close drains the debounce, authenticates acknowledgement and waits for durable save", async () => {
    const fixture = editorFixture();
    await fixture.open();
    const gate = Promise.withResolvers<void>();
    fixture.gate(gate.promise);
    fixture.set("latest");
    assert.equal(fixture.events.some(event => event.startsWith("saving:")), false);
    fixture.windows[0].close();
    fixture.windows[0].close();
    await setImmediate();
    assert.equal(fixture.windows[0].destroyed, false);
    assert.equal(fixture.events.filter(event => event === "request:1").length, 1);
    assert.ok(fixture.events.includes("readOnly:true"));
    assert.throws(() => fixture.handlers.get("ack")!({ sender: {} }, 1), /Unexpected/);
    assert.throws(() => fixture.handlers.get("ack")!({ sender: fixture.windows[0].webContents }, 99), /Unexpected/);
    gate.resolve();
    await setImmediate();
    assert.equal(fixture.windows[0].destroyed, true);
    assert.ok(fixture.events.indexOf("fsync") < fixture.events.indexOf("closed"));
    assert.equal(fixture.clock.pending.size, 0);
});

test("failed editor saves preserve pending CSS and keep the editor open for retry", async () => {
    for (const stage of ["write", "fsync"]) {
        const fixture = editorFixture();
        await fixture.open();
        fixture.fail(new Error("fixture save failure"), stage);
        fixture.set("retry-me");
        assert.equal(fixture.quit(), true);
        await setImmediate();
        assert.equal(fixture.windows[0].destroyed, false);
        assert.equal(fixture.events.includes("quit"), false);
        assert.equal(fixture.events.includes("close-file"), stage === "fsync");
        assert.ok(fixture.events.includes("readOnly:false"));
        fixture.fail();
        fixture.windows[0].close();
        await setImmediate();
        assert.equal(fixture.windows[0].destroyed, true);
        assert.equal(fixture.events.filter(event => event === "write:retry-me").length, stage === "write" ? 2 : 1);
    }
});

test("visible and confirmed hidden app quits wait for editor flush; cancelled quits do not close", async () => {
    for (const hidden of [false, true]) {
        const fixture = editorFixture();
        await fixture.open();
        fixture.set("on-quit");
        assert.equal(fixture.quit(hidden), true);
        await setImmediate();
        assert.ok(fixture.events.indexOf("fsync") < fixture.events.indexOf("closed"));
        assert.ok(fixture.events.indexOf("closed") < fixture.events.indexOf("quit"));
        assert.equal(fixture.events.includes("prompt"), hidden);
    }
    const fixture = editorFixture();
    await fixture.open();
    fixture.set("unsaved");
    assert.equal(fixture.quit(true, 0), true);
    await setImmediate();
    assert.equal(fixture.windows[0].destroyed, false);
    assert.equal(fixture.events.includes("quit"), false);
});

test("editor timeout fails closed and rejects stale acknowledgements", async () => {
    const fixture = editorFixture();
    await fixture.open();
    const gate = Promise.withResolvers<void>();
    fixture.gate(gate.promise);
    fixture.set("pending");
    fixture.windows[0].close();
    await setImmediate();
    fixture.clock.run(10000);
    assert.equal(fixture.windows[0].destroyed, false);
    assert.equal(fixture.clock.pending.size, 0);
    gate.resolve();
    await setImmediate();
    assert.equal(fixture.windows[0].destroyed, false);
    fixture.gate();
    fixture.windows[0].close();
    await setImmediate();
    assert.equal(fixture.windows[0].destroyed, true);
});

test("failed reset send and window show cannot mask close cleanup or prevent a later retry", async () => {
    const fixture = editorFixture();
    await fixture.open();
    fixture.set("retained");
    fixture.failWindow(true, true);
    assert.doesNotThrow(() => fixture.windows[0].close());
    assert.equal(fixture.windows[0].destroyed, false);
    assert.equal([...fixture.clock.pending.values()].some(timer => timer.delay === 10000), false);
    assert.equal(fixture.events.filter(event => event === "error").length, 3);
    fixture.failWindow(false, false);
    fixture.windows[0].close();
    await setImmediate();
    assert.equal(fixture.windows[0].destroyed, true);
    assert.ok(fixture.events.includes("write:retained"));
});

test("A-B-A edits cannot let an older matching save erase the newest pending revision", async () => {
    const fixture = editorFixture();
    await fixture.open();
    const gate = Promise.withResolvers<void>();
    fixture.gate(gate.promise);
    fixture.set("A");
    fixture.clock.run(300);
    await setImmediate();
    fixture.set("B");
    fixture.clock.run(300);
    fixture.set("A");
    gate.resolve();
    await setImmediate();
    assert.equal(fixture.events.includes("fsync"), false, "normal debounced saves must not force a disk flush");
    fixture.gate();
    fixture.windows[0].close();
    await setImmediate();
    assert.deepEqual(fixture.events.filter(event => event.startsWith("write:")), ["write:A", "write:B", "write:A"]);
    assert.equal(fixture.windows[0].destroyed, true);
    assert.equal(fixture.events.filter(event => event === "fsync").length, 1);
});

function httpFixture(fetcher: typeof fetch) {
    return runInNewContext(`${compile(source("src/main/utils/http.ts"))}\nexports;`, {
        exports: {}, fetch: fetcher, Buffer, AbortController, AbortSignal, setTimeout, clearTimeout
    }) as { fetchBuffer(url: string, options: RequestInit, limits: { maxBytes: number; timeoutMs: number; }): Promise<Buffer>; };
}

test("bounded download checks declared and actual bytes and cancels failed response bodies", async () => {
    const limits = { maxBytes: 4, timeoutMs: 1000 };
    const normal = new Response("test");
    assert.equal((await httpFixture(async () => normal).fetchBuffer("https://fixture.invalid", {}, limits)).toString(), "test");
    assert.equal(normal.body!.locked, false);
    for (const mode of ["declared", "streamed", "http-error"]) {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(mode === "streamed" ? 5 : 1)); },
            cancel() { cancelled = true; }
        });
        const response = new Response(body, {
            status: mode === "http-error" ? 503 : 200,
            headers: mode === "declared" ? { "content-length": "5" } : {}
        });
        await assert.rejects(httpFixture(async () => response).fetchBuffer("https://fixture.invalid", {}, limits), /byte limit|failed: 503/);
        assert.equal(cancelled, true);
        assert.equal(response.body!.locked, false);
    }
});

test("download deadline and caller cancellation stop stalled reads; late headers are cancelled", async () => {
    for (const abort of [false, true]) {
        let cancelled = false;
        const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
        const controller = new AbortController();
        const pending = httpFixture(async () => response).fetchBuffer("https://fixture.invalid", { signal: controller.signal }, { maxBytes: 4, timeoutMs: 20 });
        if (abort) controller.abort(new Error("caller cancelled"));
        await assert.rejects(pending, /timed out|caller cancelled/);
        assert.equal(response.body!.locked, false);
        assert.equal(cancelled, true);
    }
    const gate = Promise.withResolvers<Response>();
    let cancelled = false;
    await assert.rejects(httpFixture(() => gate.promise).fetchBuffer("https://fixture.invalid", {}, { maxBytes: 4, timeoutMs: 20 }), /timed out/);
    gate.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await setImmediate();
    assert.equal(cancelled, true);
});

function extensionFixture(options: { metadata?: { name: string; originalSize: number; size?: number; compression?: number; }[]; files?: Record<string, Uint8Array>; stall?: boolean; writeError?: boolean; real?: boolean; } = {}) {
    const clock = timers();
    const events: string[] = [];
    const root = join(process.cwd(), "fixture-extension");
    const code = source("src/main/utils/extensions.ts")
        .replace("64 * 1024 * 1024", "16")
        .replace("64 * 1024 * 1024", "8")
        .replace("256 * 1024 * 1024", "12")
        .replace("MAX_ENTRIES = 10000", "MAX_ENTRIES = 3");
    const data = zipSync({ "file.js": new Uint8Array([1, 2, 3]) });
    const files = options.files ?? { "file.js": new Uint8Array(3) };
    const dependencies: Record<string, unknown> = {
        electron: { session: { defaultSession: { extensions: { async loadExtension() { events.push("load"); } } } } },
        fflate: options.real ? fflate : {
            unzipSync(_data: unknown, policy: { filter(file: { name: string; originalSize: number; }): boolean; }) {
                events.push("preflight");
                for (const file of options.metadata ?? [{ name: "file.js", originalSize: 3 }])
                    assert.equal(policy.filter({ size: file.originalSize, compression: 0, ...file }), false);
            },
            unzip(_data: unknown, callback: (error: null, files: Record<string, Uint8Array>) => void) {
                events.push("inflate");
                if (!options.stall) callback(null, files);
                return () => { events.push("terminate"); };
            }
        },
        fs: { constants: { F_OK: 0 } },
        "fs/promises": {
            async access() { throw new Error("not cached"); }, async mkdir() { events.push("mkdir"); },
            async writeFile() { events.push("write"); if (options.writeError) throw new Error("fixture write failed"); },
            async rm() { events.push("cleanup"); }
        },
        path: { dirname, join }, "./constants": { DATA_DIR: root }, "./ensureSafePath": { ensureSafePath },
        "./crxToZip": { crxToZip: (buffer: Buffer) => buffer },
        "./http": { async fetchBuffer(url: string, _request: unknown, limits: { maxBytes: number; timeoutMs: number; }) {
            assert.ok(url.startsWith("https://clients2.google.com/service/update2/crx?"));
            assert.equal(limits.maxBytes, 16);
            assert.equal(limits.timeoutMs, 60000);
            return data;
        } }
    };
    const module = runInNewContext(`${compile(code)}\nexports;`, {
        ...clock, exports: {}, process, require: (name: string) => dependencies[name]
    }) as { installExt(id: string): Promise<void>; };
    return { ...module, events, clock };
}

test("ZIP metadata policy rejects entry/aggregate/count limits before any inflation", async () => {
    for (const metadata of [
        [{ name: "file.js", originalSize: 9 }],
        [{ name: "first", originalSize: 7 }, { name: "second", originalSize: 6 }],
        ["first", "second", "third", "fourth"].map(name => ({ name, originalSize: 0 }))
    ]) {
        const fixture = extensionFixture({ metadata });
        await assert.rejects(fixture.installExt("fixture"), /declared limits/);
        assert.deepEqual(fixture.events, ["preflight", "cleanup"]);
    }
});

test("stored entry and aggregate compressed allocations are bounded before unzip starts", async () => {
    for (const metadata of [
        [{ name: "file.js", originalSize: 0, size: 5, compression: 0 }],
        [{ name: "first", originalSize: 1, size: 80, compression: 8 }, { name: "second", originalSize: 1, size: 80, compression: 8 }],
        [{ name: "file.js", originalSize: 1, size: Number.NaN, compression: 8 }],
        [{ name: "file.js", originalSize: 1, size: 1, compression: 99 }]
    ]) {
        const fixture = extensionFixture({ metadata });
        await assert.rejects(fixture.installExt("fixture"), /declared limits/);
        assert.deepEqual(fixture.events, ["preflight", "cleanup"]);
    }
});

test("installed fflate DEFLATE paths allocate declared-size buffers without output growth", () => {
    const library = source("node_modules/fflate/lib/node.cjs");
    assert.match(library, /inflateSync\(infl, \{ out: new u8\(su\) \}\)/);
    assert.match(library, /inflate\(infl, \{ size: su \}, cbl\)/);
    assert.match(library, /out: o\.size && new u8\(o\.size\)/);
    assert.match(library, /inflateSync\(ev\.data\[0\], gopt\(ev\.data\[1\]\)\)/);
    assert.match(library, /return inflt\(data, \{ i: 2 \}, opts && opts\.out/);
    assert.match(library, /var resize = noBuf \|\| st\.i != 2/);
    assert.match(library, /if \(su < 524288 \|\| sc > 0\.8 \* su\)/);
});

test("real small ordinary ZIP works, and actual output bounds/size mismatches fail before writes", async () => {
    const normal = extensionFixture({ real: true });
    await normal.installExt("fixture");
    assert.ok(normal.events.includes("write"));
    assert.equal(normal.events.at(-1), "load");
    const outputs: Record<string, Uint8Array>[] = [
        { "file.js": new Uint8Array(9) },
        { "file.js": new Uint8Array(2) },
        { "file.js": new Uint8Array(3), "unexpected": new Uint8Array(0) }
    ];
    for (const files of outputs) {
        const fixture = extensionFixture({ files });
        await assert.rejects(fixture.installExt("fixture"), /extracted limits|declared size|entry count/);
        assert.equal(fixture.events.includes("write"), false);
        assert.equal(fixture.events.at(-1), "cleanup");
    }
});

test("extraction deadline terminates worker and cleans up; failed writes never load", async () => {
    const stalled = extensionFixture({ stall: true });
    const pending = stalled.installExt("fixture");
    await setImmediate();
    const rejected = assert.rejects(pending, /extraction timed out/);
    stalled.clock.run(60000);
    await rejected;
    assert.deepEqual(stalled.events, ["preflight", "inflate", "terminate", "cleanup"]);
    assert.equal(stalled.clock.pending.size, 0);
    const failed = extensionFixture({ writeError: true });
    await assert.rejects(failed.installExt("fixture"), /write failed/);
    assert.equal(failed.events.at(-1), "cleanup");
    assert.equal(failed.events.includes("load"), false);
});
