import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { requestBytes } from "../src/main/updater/httpOperations";

function compile(source: string) {
    return transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
}

function source(path: string) {
    return readFileSync(path, "utf8");
}

test("native watchers remain independent across renderers and close on errors", async () => {
    const ipcSource = source("src/main/ipcMain.ts");
    const code = ipcSource.slice(ipcSource.indexOf("let stopWatching"), ipcSource.indexOf("ipcMain.on(IpcEvents.GET_MONACO_THEME"));
    class Sender extends EventEmitter {
        destroyed = false;
        messages: unknown[] = [];
        isDestroyed() { return this.destroyed; }
        postMessage(...args: unknown[]) { this.messages.push(args); }
    }
    class Watcher extends EventEmitter {
        closed = false;
        constructor(readonly callback: () => Promise<void>) { super(); }
        close() { this.closed = true; }
    }
    const watchers: Watcher[] = [];
    let init!: (event: { sender: Sender; }) => Promise<void>;
    runInNewContext(compile(code), {
        IpcEvents: { INIT_FILE_WATCHERS: "init" }, IS_DEV: true,
        QUICK_CSS_PATH: "quickCss", THEMES_DIR: "themes", RENDERER_CSS_PATH: "renderer",
        ipcMain: { handle(_name: string, handler: typeof init) { init = handler; } },
        debounce: (callback: unknown) => callback,
        readCss: async () => "css", readFile: async () => "renderer",
        open: async () => ({ close: async () => undefined }),
        watch(_path: string, _options: unknown, callback: () => Promise<void>) {
            const watcher = new Watcher(callback);
            watchers.push(watcher);
            return watcher;
        }
    });
    const first = new Sender();
    const second = new Sender();
    await init({ sender: first });
    await init({ sender: second });
    assert.equal(watchers.length, 6);
    assert.ok(watchers.every(watcher => !watcher.closed));
    await init({ sender: first });
    assert.ok(watchers.slice(0, 3).every(watcher => watcher.closed));
    assert.ok(watchers.slice(3).every(watcher => !watcher.closed));
    assert.equal(first.listenerCount("destroyed"), 1);
    assert.doesNotThrow(() => watchers[3].emit("error", new Error("fixture watcher failure")));
    assert.ok(watchers.slice(3, 6).every(watcher => watcher.closed));
    assert.equal(second.listenerCount("destroyed"), 0);
    first.destroyed = true;
    first.emit("destroyed");
    for (const watcher of watchers) await watcher.callback();
    assert.equal(first.messages.length, 0);
    assert.equal(second.messages.length, 0);
    await init({ sender: first });
    assert.equal(watchers.length, 9);
});

function managerFixture() {
    const customCspRules: Record<string, string[]> = {};
    const decisions: ((value: { response: number; checkboxChecked: boolean; }) => void)[] = [];
    const manager = runInNewContext(`${compile(source("src/main/csp/manager.ts"))}\n({ addCspRule, isDomainAllowed });`, {
        exports: {}, URL, IS_DISCORD_DESKTOP: true,
        require: () => ({
            NativeSettings: { store: { customCspRules } },
            CspPolicies: { "https://badge.equicord.org": ["img-src", "connect-src"], "cdn.fixture.example": ["script-src"] },
            ImageAndCssSrc: ["connect-src", "img-src", "style-src", "font-src"],
            dialog: { showMessageBox: () => new Promise(resolve => decisions.push(resolve)) }
        })
    });
    return { manager, customCspRules, decisions };
}

test("CSP queries recognize exact origins and reject empty or malformed directives", () => {
    const { manager } = managerFixture();
    assert.equal(manager.isDomainAllowed({}, "https://badge.equicord.org/badges.json", ["connect-src"]), true);
    assert.equal(manager.isDomainAllowed({}, "http://badge.equicord.org", ["connect-src"]), false);
    assert.equal(manager.isDomainAllowed({}, "https://cdn.fixture.example", ["script-src"]), true);
    for (const directives of [[], null, "connect-src", ["script-src"]])
        assert.equal(manager.isDomainAllowed({}, "https://badge.equicord.org", directives), false);
});

test("CSP consent cannot overwrite a rule approved by a concurrent dialog", async () => {
    const { manager, customCspRules, decisions } = managerFixture();
    const first = manager.addCspRule({}, "https://fixture.example", ["img-src"], "Fixture");
    const second = manager.addCspRule({}, "https://fixture.example", ["connect-src"], "Fixture");
    assert.equal(decisions.length, 2);
    decisions[0]({ response: 1, checkboxChecked: true });
    assert.equal(await first, "ok");
    decisions[1]({ response: 1, checkboxChecked: true });
    assert.equal(await second, "conflict");
    assert.deepEqual(Array.from(customCspRules["fixture.example"]), ["img-src"]);
});

test("invalid persisted custom CSP records are ignored without losing valid rules", () => {
    const customCspRules = { "fixture.example": ["img-src"], "broken.example": null, "unsupported.example": ["not-a-directive"] };
    const { patchCsp } = runInNewContext(`${compile(source("src/main/csp/index.ts"))}\n({ patchCsp });`, {
        exports: {}, URL, require: () => ({ NativeSettings: { store: { customCspRules } } })
    });
    const headers = { "Content-Security-Policy": ["default-src 'self'"] };
    assert.doesNotThrow(() => patchCsp(headers));
    assert.match(headers["Content-Security-Policy"][0], /fixture\.example/);
    assert.doesNotMatch(headers["Content-Security-Policy"][0], /broken\.example|unsupported\.example|not-a-directive/);
});

test("external browser failures are caught while the window stays denied", async () => {
    let handler!: (details: { url: string; }) => { action: string; };
    const errors: unknown[] = [];
    const exports: { makeLinksOpenExternally?: (window: unknown) => void; } = {};
    runInNewContext(compile(source("src/main/utils/externalLinks.ts")), {
        exports, URL, console: { error: (...args: unknown[]) => errors.push(args) },
        require: () => ({ shell: { openExternal: async () => { throw new Error("fixture launch failure"); } } })
    });
    exports.makeLinksOpenExternally!({ webContents: { setWindowOpenHandler(callback: typeof handler) { handler = callback; } } });
    assert.equal(handler({ url: "https://fixture.example" }).action, "deny");
    await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.equal(handler({ url: "about:blank" }).action, "allow");
});

test("Monaco receives only its editor bridge and contains failed CSS saves", async () => {
    for (const protocol of ["data:", "https:"]) {
        const exposed = new Map<string, (...args: unknown[]) => unknown>();
        const errors: unknown[] = [];
        const native = { quickCss: {
            set: async () => { throw new Error("fixture save failure"); },
            get: async () => "fixture css", getEditorTheme: () => "vs-dark"
        } };
        runInNewContext(compile(source("src/preload.ts")), {
            exports: {}, location: { protocol }, IS_DISCORD_DESKTOP: false,
            setTimeout: (callback: () => void) => { callback(); return 1; }, clearTimeout() { },
            console: { error: (...args: unknown[]) => errors.push(args) },
            require(name: string) {
                if (name === "@shared/debounce") return { debounce: (callback: unknown) => callback };
                if (name === "@shared/IpcEvents") return { IpcEvents: {} };
                if (name === "electron/renderer") return {
                    ipcRenderer: { on() { } },
                    contextBridge: { exposeInMainWorld: (key: string, value: any) => exposed.set(key, value) }
                };
                return { __esModule: true, default: native, invoke: async () => { throw new Error("fixture watcher failure"); } };
            }
        });
        if (protocol === "data:") {
            assert.deepEqual([...exposed.keys()], ["setCss", "onCssClosing", "getCurrentCss", "getTheme"]);
            exposed.get("setCss")!("fixture css");
        } else {
            assert.deepEqual([...exposed.keys()], ["VencordNative"]);
        }
        await setImmediate();
        assert.equal(errors.length, 1);
    }
});

test("updater byte reads release the body lock after success and size failure", async () => {
    const success = new Response("fixture");
    assert.equal((await requestBytes(async () => success, "https://fixture.example", {}, 1000, 32)).toString(), "fixture");
    assert.equal(success.body!.locked, false);
    let cancelled = false;
    const oversized = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(4)); },
        cancel() { cancelled = true; }
    }));
    await assert.rejects(requestBytes(async () => oversized, "https://fixture.example", {}, 1000, 2), /byte limit/);
    assert.equal(cancelled, true);
    assert.equal(oversized.body!.locked, false);
});

test("updater timeouts cancel stalled bodies and release their locks", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const keepAlive = setTimeout(() => undefined, 1000);
    try {
        await assert.rejects(requestBytes(async () => response, "https://fixture.example", {}, 20, 32), /timed out/);
        assert.equal(cancelled, true);
        assert.equal(response.body!.locked, false);
    } finally {
        clearTimeout(keepAlive);
    }
});

test("updater body errors release locks and retain the original failure", async () => {
    const failure = new Error("fixture stream failure");
    const response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    await assert.rejects(requestBytes(async () => response, "https://fixture.example", {}, 1000, 32), error => error === failure);
    assert.equal(response.body!.locked, false);
});
