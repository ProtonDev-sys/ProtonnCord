import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function loadSource(file: string, mocks: Record<string, any> = {}, globals: Record<string, any> = {}, extra = "") {
    const exports: any = {};
    const output = transpileModule(readFileSync(`src/equicordplugins/${file}`, "utf8") + extra, {
        fileName: file,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, esModuleInterop: false }
    }).outputText;
    const defaults: Record<string, any> = {
        "@utils/types": { default: (plugin: any) => plugin, OptionType: {}, StartAt: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/Logger": { Logger: class { error() { } } }
    };
    runInNewContext(output, {
        exports, Blob, Uint8Array, ArrayBuffer, btoa, AbortController,
        console: { log() { }, error() { } },
        require: (id: string) => mocks[id] ?? defaults[id] ?? {},
        ...globals
    });
    return exports;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

function hooks() {
    const states: any[] = [];
    const effects: Array<() => (() => void)> = [];
    let cursor = 0;
    let mounted = false;
    const React = {
        Fragment: "fragment",
        createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
        useState: (initial: any) => {
            const index = cursor++;
            if (!(index in states)) states[index] = initial;
            return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
        },
        useRef: (initial: any) => {
            const index = cursor++;
            states[index] ??= { current: initial };
            return states[index];
        },
        useEffect: (effect: any) => { if (!mounted) effects.push(effect); }
    };
    return {
        React,
        render: (callback: () => any) => { cursor = 0; const tree = callback(); mounted = true; return tree; },
        mount: () => effects.map(effect => effect()),
        states
    };
}

function nodes(tree: any): any[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!tree || typeof tree !== "object") return [];
    return [tree, ...nodes(tree.props?.children)];
}

const types = loadSource("customSounds/types.ts");
const settingsImport = loadSource("customSounds/settingsImport.ts", { "./types": types });

test("custom sound export/import retains disabled selections, legacy fields and unknown IDs", () => {
    const original = { ...types.makeEmptyOverride(), volume: 23, selectedFileId: "saved", useFile: true, future: { mode: "keep" } };
    const store = { known: JSON.stringify(original), futureSound: { ...original, enabled: true }, enabled: true, isFavorite: false, malformed: "{" };
    const exported = settingsImport.exportOverrides(store, ["known", "untouched"]);
    const imported = settingsImport.parseImportedOverrides(JSON.stringify({ overrides: exported }));
    const known = imported.find((entry: any) => entry.id === "known");
    assert.deepEqual(JSON.parse(JSON.stringify(known.override)), original);
    assert.equal(imported.find((entry: any) => entry.id === "futureSound").override.future.mode, "keep");
    assert.equal(imported.length, 3);
    assert.equal(store.malformed, "{");
    assert.throws(() => settingsImport.parseImportedOverrides('{"overrides":[{"id":"known","useFile":"invalid"}]}'));
});

test("clearing shared audio references preserves unknown fields and unrelated settings", () => {
    const base = { ...types.makeEmptyOverride(), enabled: true, selectedSound: "custom", selectedFileId: "shared", volume: 37, future: "retain" };
    const store: any = { first: JSON.stringify(base), second: { ...base }, other: JSON.stringify({ ...base, selectedFileId: "other" }), enabled: true, malformed: "{" };
    settingsImport.clearAudioReferences(store, "shared");
    for (const id of ["first", "second"]) {
        const result = JSON.parse(store[id]);
        assert.equal(result.selectedSound, "default");
        assert.equal(result.selectedFileId, undefined);
        assert.equal(result.enabled, true);
        assert.equal(result.future, "retain");
        assert.equal(result.volume, 37);
    }
    assert.equal(JSON.parse(store.other).selectedFileId, "other");
    assert.equal(store.enabled, true);
    assert.equal(store.malformed, "{");
});

test("audio store notifies all subscribers only after committed writes and retries failures", async () => {
    let persisted: any = { shared: { id: "shared", name: "shared.mp3", type: "audio/mpeg", dataUri: "data:audio/mpeg;base64,AA==" } };
    let fail = true;
    const store = loadSource("customSounds/audioStore.ts", {
        "@api/DataStore": {
            get: async () => persisted,
            set: async (_key: string, value: any) => { if (fail) throw new Error("storage failed"); persisted = value; }
        }
    }, { crypto: { randomUUID: () => "uploaded" } });
    const first: any[] = [];
    const second: any[] = [];
    const unsubscribe = store.subscribeAudioFiles((files: any) => first.push(files));
    store.subscribeAudioFiles((files: any) => second.push(files));
    await assert.rejects(store.deleteAudio("shared"), /storage failed/);
    assert.equal((await store.getAllAudio()).shared.id, "shared");
    assert.equal(first.length, 0);
    fail = false;
    await store.deleteAudio("shared");
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].shared, undefined);
    unsubscribe();
    await store.saveAudio({ size: 1, name: "new.mp3", type: "audio/mpeg", arrayBuffer: async () => new Uint8Array([1]).buffer });
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
    assert.equal(second[1].uploaded.name, "new.mp3");
});

test("mounted sound cards refresh together, ignore stale initial reads and unsubscribe", async () => {
    const initial = deferred<any>();
    const listeners = new Set<(files: any) => void>();
    const cleanups: Array<() => void> = [];
    const renderers: Array<() => any> = [];
    for (const id of ["first", "second"]) {
        const state = hooks();
        const component = loadSource("customSounds/SoundOverrideComponent.tsx", {
            "@webpack/common": { React: state.React, showToast() { }, Select: "select" },
            "@utils/react": { useForceUpdater: () => () => {} },
            "@utils/margins": { Margins: {} },
            "@utils/types": { makeRange: () => [] },
            "./audioStore": {
                getAllAudio: () => initial.promise,
                subscribeAudioFiles: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); }
            },
            "./index": {}
        });
        const props = { type: { id, name: id }, override: { ...types.makeEmptyOverride(), enabled: true, selectedSound: "custom" }, onChange: async () => {}, onDelete: async () => {} };
        const render = () => state.render(() => component.SoundOverrideComponent(props));
        render();
        cleanups.push(...state.mount());
        renderers.push(render);
    }
    const fresh = { shared: { name: "fresh.mp3" } };
    for (const listener of listeners) listener(fresh);
    initial.resolve({ stale: { name: "stale.mp3" } });
    await initial.promise;
    for (const render of renderers) {
        const fileSelect = nodes(render()).find(node => node.props?.options?.some((option: any) => option.value === "shared"));
        assert.ok(fileSelect);
        assert.equal(fileSelect.props.options.some((option: any) => option.value === "stale"), false);
    }
    for (const listener of listeners) listener({});
    for (const render of renderers) assert.equal(nodes(render()).some(node => node.props?.options?.some((option: any) => option.value === "shared")), false);
    for (const cleanup of cleanups) cleanup();
    assert.equal(listeners.size, 0);
});

test("parent deletion clears every reference and remounts cards only on success", async () => {
    const state = hooks();
    let fail = true;
    const pending = deferred<void>();
    const definitions: any = {};
    const store: any = {};
    loadSource("customSounds/index.tsx", {
        "@api/Settings": { definePluginSettings: (options: any) => { Object.assign(definitions, options); return { store }; } },
        "@webpack/common": { React: state.React, showToast() { } },
        "./types": { ...types, soundTypes: [{ id: "first", name: "First" }, { id: "second", name: "Second" }] },
        "./settingsImport": settingsImport,
        "./audioStore": { deleteAudio: async () => { if (fail) throw new Error("storage failed"); await pending.promise; } },
        "./SoundOverrideComponent": { SoundOverrideComponent: "card" }
    });
    const base = { ...types.makeEmptyOverride(), selectedSound: "custom", selectedFileId: "shared", future: "retain" };
    for (const id of ["first", "second"]) store[id] = JSON.stringify(base);
    const render = () => state.render(definitions.overrides.component);
    const cards = nodes(render()).filter(node => node.type === "card");
    await assert.rejects(cards[0].props.onDelete("shared"), /storage failed/);
    assert.equal(JSON.parse(store.second).selectedFileId, "shared");
    fail = false;
    const deletion = cards[0].props.onDelete("shared");
    assert.equal(JSON.parse(store.first).selectedFileId, "shared");
    pending.resolve();
    await deletion;
    const refreshed = nodes(render()).filter(node => node.type === "card");
    for (const card of refreshed) {
        assert.equal(card.props.override.selectedFileId, undefined);
        assert.equal(card.props.override.future, "retain");
        assert.notEqual(card.props.key, cards.find((old: any) => old.props.type.id === card.props.type.id).props.key);
    }
});

test("clipboard reports completion, rejection, synchronous failure and missing URLs accurately", async () => {
    const pending = deferred<void>();
    const toasts: any[] = [];
    let copy = () => pending.promise;
    const plugin = loadSource("copyUserMediaUrls/index.tsx", {
        "@utils/clipboard": { copyToClipboard: () => copy() },
        "@webpack/common": { Toasts: { show: (toast: any) => toasts.push(toast), genId: () => "toast", Type: { SUCCESS: "success", FAILURE: "failure" } } }
    }, {}, "\nexport { copyUrl };\n");
    const copying = plugin.copyUrl("Avatar URL", "mock-url");
    assert.equal(toasts.length, 0);
    pending.resolve();
    await copying;
    assert.equal(toasts.pop().type, "success");
    copy = () => Promise.reject(new Error("denied"));
    await plugin.copyUrl("Avatar URL", "mock-url");
    assert.equal(toasts.pop().type, "failure");
    copy = () => { throw new Error("desktop failure"); };
    await plugin.copyUrl("Avatar URL", "mock-url");
    assert.equal(toasts.pop().type, "failure");
    await plugin.copyUrl("Avatar URL", null);
    assert.equal(toasts.pop().message, "Avatar URL not found.");
});

test("editable targets use effective contenteditable state while retaining controls", () => {
    class Element {
        constructor(public isContentEditable = false, public control = false) { }
        closest(selector: string) { assert.equal(selector.includes("contenteditable"), false); return this.control ? this : null; }
    }
    const keyboard = loadSource("commandPalette/ui/keyboard.ts", {}, { HTMLElement: Element });
    for (const scenario of [
        { label: "empty contenteditable", editable: true, control: false },
        { label: "plaintext-only", editable: true, control: false },
        { label: "inherited editable", editable: true, control: false },
        { label: "input/textarea/select/textbox", editable: false, control: true },
        { label: "explicit false descendant", editable: false, control: false }
    ]) {
        assert.equal(keyboard.isEditableTarget(new Element(scenario.editable, scenario.control)), scenario.editable || scenario.control, scenario.label);
    }
    assert.equal(keyboard.isEditableTarget(new Element(false)), false);
    assert.equal(keyboard.isEditableTarget(null), false);
    assert.equal(keyboard.isEditableTarget({}), false);
});

test("horse shake composes transforms and restores idle/disposal state", () => {
    for (const original of ["scale(0.9)", "none", ""]) {
        let now = 1000;
        let frame: () => void = () => {};
        let move: (event: any) => void = () => {};
        let cancelled = false;
        const body = { style: { transform: original, willChange: "opacity" }, appendChild: (element: any) => { element.parentElement = body; } };
        const horse = loadSource("cursorBuddy/fathorse.js", {}, {
            document: { body, getElementById: () => null, createElement: () => ({ style: {}, remove() { } }) },
            window: { innerWidth: 1000, innerHeight: 1000, addEventListener: (_name: string, callback: any) => { move = callback; } },
            Date: { now: () => now },
            requestAnimationFrame: (callback: any) => { frame = callback; return 1; },
            cancelAnimationFrame: () => { cancelled = true; }
        });
        const dispose = horse.default({ shake: true, freeroam: false, fade: false });
        frame();
        assert.equal(body.style.transform, original);
        move({ clientX: 900, clientY: 900 });
        now += 100;
        frame();
        assert.ok(body.style.transform.startsWith("translate3d("));
        assert.equal(body.style.transform.endsWith(` ${original}`), original !== "" && original !== "none");
        now += 25;
        frame();
        assert.equal(body.style.transform, original);
        dispose();
        assert.equal(body.style.transform, original);
        assert.equal(body.style.willChange, "opacity");
        assert.equal(cancelled, true);
    }
});

test("calculator never displays small nonzero results as zero", () => {
    const evaluator = loadSource("commandPalette/commands/calculator/evaluator.ts");
    for (const expression of ["1/1000000000", "-1/1000000000", "1/200000000", "1/100000000"]) {
        const result = evaluator.evaluateExpression(expression);
        assert.notEqual(Number(result.formatted), 0);
        if (result.formatted.includes("e")) assert.equal(Number(result.formatted), Number(result.plain));
    }
    assert.equal(evaluator.evaluateExpression("1000+234").formatted, "1,234");
    assert.equal(evaluator.evaluateExpression("1-1").formatted, "0");
    assert.equal(evaluator.evaluateExpression("1/0"), null);
});
