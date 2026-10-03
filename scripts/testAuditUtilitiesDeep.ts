import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadModule(path: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}, append = "") {
    const source = (process.env.AUDIT_UTILITIES_BASELINE === "1"
        ? execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" })
        : readFileSync(path, "utf8")) + append;
    const code = ts.transpileModule(source, {
        fileName: path,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, console, IS_DEV: false, IS_REPORTER: false, ...globals,
        require(name: string) {
            assert.ok(name in mocks, `Unexpected dependency: ${name}`);
            return mocks[name];
        }
    });
}

function pngChunk(type: string, data: Uint8Array) {
    const chunk = new Uint8Array(data.length + 12);
    new DataView(chunk.buffer).setUint32(0, data.length);
    chunk.set(Buffer.from(type), 4);
    chunk.set(data, 8);
    return chunk;
}

function animationBytes() {
    const header = new Uint8Array(13);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 4);
    headerView.setUint32(4, 4);
    header.set([8, 6], 8);
    const control = new Uint8Array(8);
    new DataView(control.buffer).setUint32(0, 2);
    const frame = new Uint8Array(26);
    const frameView = new DataView(frame.buffer);
    frameView.setUint32(4, 2);
    frameView.setUint32(8, 2);
    frameView.setUint16(20, 1);
    frameView.setUint16(22, 10);
    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header), pngChunk("acTL", control),
        pngChunk("fcTL", frame), pngChunk("IDAT", new Uint8Array([1])),
        pngChunk("fcTL", frame), pngChunk("fdAT", new Uint8Array([0, 0, 0, 1, 2])),
        pngChunk("IEND", new Uint8Array())
    ];
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
}

function apngFixture() {
    const images: { src: string; onload: () => void; onerror: () => void; }[] = [];
    const activeUrls = new Set<string>();
    let sequence = 0;
    const module = loadModule("src/utils/apng.ts", {}, {
        Uint8Array, Blob,
        Image: class {
            src = "";
            onload = () => {};
            onerror = () => {};
            constructor() { images.push(this); }
        },
        URL: {
            createObjectURL() {
                const url = `blob:offline-${++sequence}`;
                activeUrls.add(url);
                return url;
            },
            revokeObjectURL(url: string) { activeUrls.delete(url); }
        }
    });
    return { parse: module.parseAPNG, images, activeUrls };
}

test("APNG success preserves caller bytes and releases frame URLs", async () => {
    const fixture = apngFixture();
    const bytes = animationBytes();
    const original = bytes.slice();
    const promise = fixture.parse(bytes.buffer);
    assert.equal(fixture.images.length, 2);
    fixture.images.forEach(image => image.onload());
    const animation = await promise;
    assert.equal(animation.width, 4);
    assert.equal(animation.frames[0].width, 2);
    assert.equal(animation.frames.length, 2);
    assert.equal(fixture.activeUrls.size, 0);
    assert.deepEqual(bytes, original);
});

test("APNG failed frame releases its URL as other frames finish", async () => {
    const fixture = apngFixture();
    const promise = fixture.parse(animationBytes().buffer);
    const rejection = assert.rejects(promise, reason => reason === "Image creation error");
    fixture.images[0].onerror();
    fixture.images[1].onload();
    await rejection;
    assert.equal(fixture.activeUrls.size, 0);
});

test("APNG rejects truncated chunks before producing image resources", async () => {
    const bytes = animationBytes();
    const fixture = apngFixture();
    const promise = fixture.parse(bytes.slice(0, -2).buffer);
    fixture.images.forEach(image => image.onload());
    await assert.rejects(promise, /PNG chunk|PNG end/i);
    assert.equal(fixture.images.length, 0);
    assert.equal(fixture.activeUrls.size, 0);
});

test("APNG rejects short control data instead of reading the next chunk", async () => {
    const bytes = animationBytes();
    const chunkOffset = 8 + 25;
    const shortControl = pngChunk("acTL", new Uint8Array(1));
    const malformed = new Uint8Array(bytes.length - 7);
    malformed.set(bytes.subarray(0, chunkOffset));
    malformed.set(shortControl, chunkOffset);
    malformed.set(bytes.subarray(chunkOffset + 20), chunkOffset + shortControl.length);
    const fixture = apngFixture();
    const promise = fixture.parse(malformed.buffer);
    fixture.images.forEach(image => image.onload());
    await assert.rejects(promise, /PNG chunk/i);
    assert.equal(fixture.images.length, 0);
});

test("waiting components replace an already rendered fallback with the host component", () => {
    let deliver: (component: unknown) => void = () => assert.fail("Missing waiter");
    const React = { createElement: (type: unknown, props: unknown) => ({ type, props }) };
    const lazy = loadModule("src/utils/lazy.ts");
    const lazyReact = loadModule("src/utils/lazyReact.tsx", { "./lazy": lazy }, { React });
    const module = loadModule("src/webpack/common/internal.tsx", {
        "@utils/lazy": lazy,
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/react": lazyReact,
        "@webpack": { waitFor: (_filter: unknown, callback: typeof deliver) => { deliver = callback; } }
    }, { React });
    const fallback = () => null;
    const host = Object.assign(() => null, { Sizes: { SMALL: "small" } });
    const wrapper = module.waitForComponent("Tooltip", "tooltip", fallback);
    assert.equal(wrapper({}).type, fallback);
    assert.equal(wrapper.$$vencordGetWrappedComponent(), fallback);
    deliver(host);
    assert.equal(wrapper({ value: 1 }).type, host);
    assert.equal(wrapper.$$vencordGetWrappedComponent(), host);
    assert.equal(wrapper.Sizes, host.Sizes);
});

test("waiting components rendered before registration recover without a fallback", () => {
    let deliver: (component: unknown) => void = () => {};
    const React = { createElement: (type: unknown, props: unknown) => ({ type, props }) };
    const lazy = loadModule("src/utils/lazy.ts");
    const lazyReact = loadModule("src/utils/lazyReact.tsx", { "./lazy": lazy }, { React });
    const module = loadModule("src/webpack/common/internal.tsx", {
        "@utils/lazy": lazy,
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/react": lazyReact,
        "@webpack": { waitFor: (_filter: unknown, callback: typeof deliver) => { deliver = callback; } }
    }, { React });
    const wrapper = module.waitForComponent("Checkbox", "checkbox");
    wrapper({});
    const host = () => null;
    deliver(host);
    assert.equal(wrapper({}).type, host);
});

function reporterFixture(throws: boolean, failsFetch = false) {
    const timers = new Map<() => void, number>();
    const listeners = new Set();
    const warnings: unknown[] = [];
    const chunks = { one: "one.js" };
    const requireWebpack = Object.assign(() => {}, {
        m: { entry: () => 'loader.e("one").then(loader.bind(loader,"entry"))' },
        p: "offline:",
        u(key: PropertyKey) {
            if (typeof key === "symbol" && throws) throw new Error("Unavailable chunk map");
            return chunks[key as keyof typeof chunks];
        },
        e: async () => {}
    });
    const module = loadModule("src/debug/loadLazyChunks.ts", {
        "@utils/Logger": { Logger: class { log() {} warn(error: unknown) { warnings.push(error); } } },
        "@utils/patches": { canonicalizeMatch: () => /(?:(loader\.e\("[^"]+"\)))\.then\(loader\.bind\(loader,"([^"]+)"\)\)/g },
        "@webpack": { wreq: requireWebpack, factoryListeners: listeners, ChunkIdsRegex: /\("([^"]+)"\)/g },
        "p-limit": () => Object.assign((work: () => unknown) => work(), { clearQueue() {} }),
        "./promiseTimeout": {
            withTimeout: async (promise: Promise<unknown>, timeout: number) => {
                if (timeout === 90_000) {
                    let completed = false;
                    const observed = promise.then(() => { completed = true; });
                    for (let turn = 0; turn < 30; turn++) {
                        await Promise.resolve();
                        for (const callback of timers.keys()) {
                            timers.delete(callback);
                            callback();
                        }
                    }
                    assert.ok(completed, "Search completion must not wait for the 90 second timeout");
                    return observed;
                }
                return promise;
            }
        }
    }, {
        setTimeout(callback: () => void, delay: number) { timers.set(callback, delay); return callback; },
        fetch: async () => {
            assert.ok(failsFetch, "No real network traffic is permitted");
            throw new Error("Offline inspection failure");
        }
    }, "\nexport { getWebpackChunkMap };");
    Object.setPrototypeOf(chunks, module.getWebpackChunkMap.constructor("return Object.prototype")());
    return { module, listeners, warnings };
}

test("chunk-map probing cleans its temporary prototype accessor when webpack throws", () => {
    const fixture = reporterFixture(true);
    const prototype = fixture.module.getWebpackChunkMap.constructor("return Object.prototype")();
    const before = Object.getOwnPropertySymbols(prototype);
    assert.throws(() => fixture.module.getWebpackChunkMap(), /Unavailable chunk map/);
    assert.deepEqual(Object.getOwnPropertySymbols(prototype), before);
});

test("failed lazy-chunk searches settle promptly and remove the factory listener", async () => {
    const fixture = reporterFixture(false, true);
    await fixture.module.loadLazyChunks();
    assert.equal(fixture.listeners.size, 0);
    assert.ok(!fixture.warnings.some(error => String(error).includes("90 second timeout")), fixture.warnings.map(String).join("\n"));
});

function patchHelperFixture() {
    const timers = new Map<() => void, number>();
    const searched: unknown[] = [];
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    let hooks: any;
    const debounce = loadModule("src/shared/debounce.ts", {}, {
        setTimeout(callback: () => void, delay: number) { timers.set(callback, delay); return callback; },
        clearTimeout(callback: () => void) { timers.delete(callback); }
    });
    const components = Object.fromEntries(["Button", "CodeBlock", "Divider", "Flex", "Heading", "Paragraph", "Span"].map(name => [`@components/${name}`, { [name]: name }]));
    const module = loadModule("src/components/settings/tabs/patchHelper/index.tsx", {
        ...components,
        "@components/settings/tabs/BaseTab": { SettingsTab: "Tab", wrapTab: (component: unknown) => component },
        "@shared/debounce": debounce,
        "@utils/discord": { copyWithToast() {} },
        "@utils/margins": { Margins: {} },
        "@utils/text": { stripIndent: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values) },
        "@webpack": { search(find: unknown) { searched.push(find); return find === "unique" ? { "1": () => {} } : {}; } },
        "@webpack/common": {
            React, TextInput: "input",
            useState: (value: unknown) => hooks.useState(value),
            useMemo: (factory: () => unknown) => factory(),
            useEffect: (effect: () => unknown, dependencies: unknown[]) => hooks.useEffect(effect, dependencies)
        },
        "./FullPatchInput": { FullPatchInput: "FullPatch" },
        "./PatchPreview": { PatchPreview: "Preview" },
        "./ReplacementInput": { ReplacementInput: "Replacement" }
    }, {
        React, IS_STANDALONE: false,
        setTimeout(callback: () => void, delay: number) { timers.set(callback, delay); return callback; },
        clearTimeout(callback: () => void) { timers.delete(callback); }
    });
    function mount() {
        const states: unknown[] = [];
        const effects: { dependencies: unknown[]; cleanup?: () => void; }[] = [];
        let stateIndex = 0;
        let effectIndex = 0;
        let tree: any;
        const localHooks = {
            useState(value: unknown) {
                const index = stateIndex++;
                if (!(index in states)) states[index] = value;
                return [states[index], (next: unknown) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
            },
            useEffect(effect: () => (() => void) | undefined, dependencies: unknown[]) {
                const index = effectIndex++;
                const previous = effects[index];
                if (previous && dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset]))) return;
                previous?.cleanup?.();
                effects[index] = { dependencies, cleanup: effect() };
            }
        };
        function render() {
            hooks = localHooks;
            stateIndex = effectIndex = 0;
            tree = module.default();
        }
        function find(type: string, node = tree): any {
            if (!node || typeof node !== "object") return;
            if (node.type === type) return node;
            for (const child of node.props?.children?.flat(Infinity) ?? []) {
                if (child == null) continue;
                const result = find(type, child);
                if (result) return result;
            }
        }
        render();
        return {
            render, find,
            change(value: string) { find("input").props.onChange(value); render(); },
            unmount() { effects.forEach(effect => effect.cleanup?.()); }
        };
    }
    function flush() {
        const callbacks = [...timers.keys()];
        timers.clear();
        callbacks.forEach(callback => callback());
    }
    return { mount, flush, searched, timers };
}

test("patch helper cancels pending searches on unmount", () => {
    const fixture = patchHelperFixture();
    const component = fixture.mount();
    component.change("unique");
    component.unmount();
    fixture.flush();
    assert.equal(fixture.searched.length, 0);
    assert.equal(fixture.timers.size, 0);
});

test("patch helpers maintain independent pending searches", () => {
    const fixture = patchHelperFixture();
    const first = fixture.mount();
    const second = fixture.mount();
    first.change("unique");
    second.change("missing");
    fixture.flush();
    assert.deepEqual(fixture.searched, ["unique", "missing"]);
    first.render();
    second.render();
    assert.ok(first.find("Preview"));
    assert.equal(second.find("Preview"), undefined);
});

test("clearing or invalidating a patch query cancels its old candidate", () => {
    for (const next of ["", "/[/"]) {
        const fixture = patchHelperFixture();
        const component = fixture.mount();
        component.change("unique");
        component.change(next);
        fixture.flush();
        component.render();
        assert.equal(fixture.searched.length, 0);
        assert.equal(component.find("Preview"), undefined);
    }
});

test("a nonmatching patch query clears a previously selected preview", () => {
    const fixture = patchHelperFixture();
    const component = fixture.mount();
    component.change("unique");
    fixture.flush();
    component.render();
    assert.ok(component.find("Preview"));
    component.change("missing");
    fixture.flush();
    component.render();
    assert.equal(component.find("Preview"), undefined);
    assert.match(component.find("input").props.error, /No match/);
});

test("reapplying a full patch with the same find retains its selected module", () => {
    const fixture = patchHelperFixture();
    const component = fixture.mount();
    component.change("unique");
    fixture.flush();
    component.render();
    const previous = component.find("Preview").props.module;
    component.find("FullPatch").props.setFind("unique");
    component.render();
    assert.equal(component.find("Preview").props.module, previous);
    assert.equal(fixture.searched.length, 1);
});
