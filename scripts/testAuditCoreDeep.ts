import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { createRendererRuntime } from "../src/runtime/bootstrap";
import { createSettingsPersistence } from "../src/shared/settingsPersistence";

function loadModule(path: string, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, { exports: {}, ...globals });
}

test("single-record updates abort when updater or put throws", async () => {
    const { update } = loadModule("src/api/DataStore/index.ts");
    for (const outcome of ["updater", "put"]) {
        const failure = new Error(outcome);
        let aborts = 0;
        const request = { result: 4, onsuccess: undefined as undefined | (() => void) };
        const transaction = { abort() { aborts++; } };
        const result = update("key", () => {
            if (outcome === "updater") throw failure;
            return 5;
        }, async (_mode: string, callback: (store: unknown) => unknown) => callback({
            transaction, get: () => request, put() { throw failure; }
        }));
        const rejected = assert.rejects(result, error => error === failure);
        await setImmediate();
        request.onsuccess!();
        await rejected;
        assert.equal(aborts, 1);
    }
});

test("single-record updates refuse and consume asynchronous updater results", async () => {
    const { update } = loadModule("src/api/DataStore/index.ts");
    let writes = 0;
    let aborts = 0;
    const request = { result: 4, onsuccess: undefined as undefined | (() => void) };
    const result = update("key", () => Promise.reject(new Error("async updater")),
        async (_mode: string, callback: (store: unknown) => unknown) => callback({
            transaction: { abort() { aborts++; } }, get: () => request,
            put() { writes++; throw new Error("not cloneable"); }
        }));
    const rejected = assert.rejects(result, /must be synchronous/);
    await setImmediate();
    request.onsuccess!();
    await rejected;
    await setImmediate();
    assert.equal(writes, 0);
    assert.equal(aborts, 1);
});

class FakeElement {
    parentNode: FakeElement | null = null;
    children: FakeElement[] = [];
    style = {};
    dataset = {};
    textContent = "";
    connected = false;
    get isConnected(): boolean { return this.connected || !!this.parentNode?.isConnected; }
    append(...children: FakeElement[]) { children.forEach(child => this.appendChild(child)); }
    appendChild(child: FakeElement) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
}

function stylesFixture() {
    const listeners: (() => void)[] = [];
    const documentElement = new FakeElement();
    documentElement.connected = true;
    const styles = loadModule("src/api/Styles.ts", {
        window: {},
        document: { documentElement, createElement: () => new FakeElement(), addEventListener: (_event: string, callback: () => void) => listeners.push(callback) },
        require(name: string) {
            if (name === "@components/BaseText") return { generateTextCss: () => "" };
            if (name === "@components/margins") return { generateMarginCss: () => "" };
            if (name === "@utils/css") return { classNameToSelector: (name: string) => `.${name}` };
            if (name === "@utils/Logger") return { Logger: class {} };
            throw new Error(`Unexpected import ${name}`);
        }
    });
    styles.styleMap.set("fixture", { name: "fixture", source: "[--target]{}", classNames: {}, dom: null });
    return { styles, mount: () => listeners.forEach(callback => callback()) };
}

test("managed styles are idempotent and recompile before DOM readiness", () => {
    const { styles, mount } = stylesFixture();
    assert.equal(styles.enableStyle("fixture"), true);
    assert.equal(styles.isStyleEnabled("fixture"), true);
    assert.equal(styles.enableStyle("fixture"), false);
    styles.setStyleClassNames("fixture", { target: "updated" });
    assert.equal(styles.requireStyle("fixture").dom.textContent, ".updated{}");
    mount();
    assert.equal(styles.isStyleEnabled("fixture"), true);
});

test("stopping a managed style before DOM readiness prevents later activation", () => {
    const { styles, mount } = stylesFixture();
    styles.enableStyle("fixture");
    assert.equal(styles.disableStyle("fixture"), true);
    mount();
    assert.equal(styles.managedStyleRootNode.children.length, 0);
    assert.equal(styles.isStyleEnabled("fixture"), false);
    assert.equal(styles.disableStyle("fixture"), false);
    assert.equal(styles.enableStyle("fixture"), true);
    assert.equal(styles.disableStyle("fixture"), true);
});

test("renderer disposal preserves the service receiver and runs once", async () => {
    const service = { disposed: 0, dispose() { assert.equal(this, service); this.disposed++; } };
    const errors: unknown[] = [];
    const runtime = createRendererRuntime({
        host: { now: () => 0, isDomReady: () => true, onDomReady: () => () => {}, onPageHide: () => () => {}, defer: () => () => {} },
        ready: Promise.resolve(), initializePlugins() {}, initializeStyles() {}, startPlugins() {},
        services: [{ name: "receiver", start: () => service }], onError: (_stage, error) => errors.push(error)
    });
    runtime.start();
    await setImmediate();
    runtime.dispose();
    runtime.dispose();
    assert.deepEqual(errors, []);
    assert.equal(service.disposed, 1);
});

test("settings recovery notifies paths from failed snapshots without overlapping writes", async () => {
    const firstWrite = Promise.withResolvers<void>();
    const secondWrite = Promise.withResolvers<void>();
    const commits: { value: number; paths: readonly string[]; }[] = [];
    const queue = createSettingsPersistence<number>((value, paths) => {
        commits.push({ value, paths });
        return value === 1 ? firstWrite.promise : value === 2 ? secondWrite.promise : Promise.resolve();
    });
    const first = assert.rejects(queue.set(1, "first"), /first failure/);
    await setImmediate();
    const second = assert.rejects(queue.set(2, "second"), /second failure/);
    firstWrite.reject(new Error("first failure"));
    await first;
    await setImmediate();
    secondWrite.reject(new Error("second failure"));
    await second;
    await assert.rejects(queue.flush(), /second failure/);
    await queue.set(3, "third");
    await queue.flush();
    assert.deepEqual(commits, [
        { value: 1, paths: ["first"] },
        { value: 2, paths: ["second", "first"] },
        { value: 3, paths: ["third", "second", "first"] }
    ]);
    await queue.set(4, "fourth");
    await queue.flush();
    assert.deepEqual(commits[3], { value: 4, paths: ["fourth"] });
});
