/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const root = "src/equicordplugins/remix/";
interface Element {
    type: unknown;
    props: Record<string, unknown>;
}
const React = {
    createElement(type: unknown, props: object, ...children: unknown[]): Element {
        return { type, props: { ...props, children } };
    }
};
function elements(value: unknown, type: string): Element[] {
    if (Array.isArray(value)) return value.flatMap(child => elements(child, type));
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const element = value as Element;
    return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)];
}
function load<T>(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
    const code = transpileModule(readFileSync(root + path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, React, File, AbortController, ...globals,
        require(name: string) {
            assert.ok(name in mocks, `Unexpected import: ${name}`);
            return mocks[name];
        }
    });
}
function deferred<T>() { return Promise.withResolvers<T>(); }
async function settled<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, setImmediate().then(() => { throw new Error("Promise remained pending"); })]);
}
function hooks() {
    let cursor = 0;
    const slots: unknown[] = [];
    const effects = new Map<number, { setup(): void | (() => void); cleanup?: () => void; deps: readonly unknown[]; }>();
    const pending = new Set<number>();
    let writes = 0;
    const api = {
        useState<T>(initial?: T | (() => T)) {
            const index = cursor++;
            if (!(index in slots)) {
                const state = {
                    value: typeof initial === "function" ? (initial as () => T)() : initial,
                    set(next: T | ((previous: T | undefined) => T)) {
                        writes++;
                        state.value = typeof next === "function" ? (next as (previous: T | undefined) => T)(state.value) : next;
                    }
                };
                slots[index] = state;
            }
            const state = slots[index] as { value: T; set(next: T): void; };
            return [state.value, state.set] as const;
        },
        useRef<T>(initial: T) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = { current: initial };
            return slots[index] as { current: T; };
        },
        useEffect(setup: () => void | (() => void), deps: readonly unknown[]) {
            const index = cursor++;
            const previous = effects.get(index);
            if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
                effects.set(index, { setup, deps, cleanup: previous?.cleanup });
                pending.add(index);
            }
        }
    };
    function flush() {
        for (const index of pending) {
            const effect = effects.get(index);
            assert.ok(effect);
            effect.cleanup?.();
            effect.cleanup = effect.setup() || undefined;
        }
        pending.clear();
    }
    function unmount() { for (const effect of effects.values()) effect.cleanup?.(); }
    return {
        api, flush, unmount, get writes() { return writes; },
        render<T>(component: () => T) { cursor = 0; return component(); },
        replay() {
            unmount();
            for (const effect of effects.values()) effect.cleanup = effect.setup() || undefined;
        }
    };
}

class CanvasStub {
    width = 200;
    height = 100;
    contextAvailable = true;
    throwsOnEncode = false;
    readonly draws: unknown[][] = [];
    readonly context = { canvas: this, drawImage: (...args: unknown[]) => this.draws.push(args), clearRect() { } };
    callback?: (blob: Blob | null) => void;
    getContext() { return this.contextAvailable ? this.context : null; }
    toBlob(callback: (blob: Blob | null) => void) {
        if (this.throwsOnEncode) throw new Error("Encoding failed");
        this.callback = callback;
    }
}
class ImageStub {
    width = 200;
    height = 100;
    src = "";
    crossOrigin = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
}
interface ImageUtilities {
    urlToImage(url: string, signal?: AbortSignal): Promise<ImageStub>;
    imageToBlob(image: ImageStub): Promise<File>;
}
function imageFixture() {
    const images: ImageStub[] = [];
    const canvas = new CanvasStub();
    const module = load<ImageUtilities>("editor/utils/canvas.ts", {
        "@equicordplugins/remix/editor/components/Canvas": { brushCanvas: {} }
    }, {
        Image: class extends ImageStub { constructor() { super(); images.push(this); } },
        document: { createElement: () => canvas }
    });
    return { module, canvas, images };
}

test("Remix URL loading settles success and failure and releases handlers", async () => {
    const f = imageFixture();
    const pending = f.module.urlToImage("fixture-image");
    const image = f.images[0];
    assert.equal(image.crossOrigin, "anonymous");
    assert.equal(image.src, "fixture-image");
    assert.ok(image.onload);
    image.onload();
    assert.equal(await settled(pending), image);
    assert.equal(image.onload, null);
    assert.equal(image.onerror, null);
    const failed = f.module.urlToImage("missing-image");
    assert.ok(f.images[1].onerror);
    f.images[1].onerror();
    await assert.rejects(settled(failed), /Could not load/);
});

for (const alreadyAborted of [false, true]) {
    test(`Remix URL loading cancels with ${alreadyAborted ? "an already" : "a subsequently"} aborted signal`, async () => {
        const f = imageFixture();
        const controller = new AbortController();
        if (alreadyAborted) controller.abort();
        const pending = f.module.urlToImage("fixture-image", controller.signal);
        controller.abort();
        await assert.rejects(settled(pending), /cancelled/);
        assert.equal(f.images[0].src, "");
        assert.equal(f.images[0].onload, null);
        assert.equal(f.images[0].onerror, null);
    });
}

test("Remix image conversion returns a PNG file and rejects missing contexts, blobs and encoding failures", async () => {
    const f = imageFixture();
    const pending = f.module.imageToBlob(new ImageStub());
    assert.ok(f.canvas.callback);
    f.canvas.callback(new Blob(["png"], { type: "image/png" }));
    const file = await settled(pending);
    assert.equal(file.type, "image/png");
    assert.equal(await file.text(), "png");
    assert.equal(f.canvas.width, 200);
    assert.equal(f.canvas.height, 100);
    const empty = f.module.imageToBlob(new ImageStub());
    f.canvas.callback(null);
    await assert.rejects(settled(empty), /Could not convert/);
    f.canvas.contextAvailable = false;
    await assert.rejects(settled(f.module.imageToBlob(new ImageStub())), /unavailable/);
    f.canvas.contextAvailable = true;
    f.canvas.throwsOnEncode = true;
    await assert.rejects(settled(f.module.imageToBlob(new ImageStub())), /Encoding failed/);
});

interface CanvasModule {
    canvas: CanvasStub | null;
    ctx: CanvasStub["context"] | null;
    brushCanvas: CanvasStub["context"];
    exportImg(): Promise<Blob>;
    Canvas(props: { file: File; onReady(ready: boolean): void; onError(error: string): void; }): Element;
}
function canvasFixture() {
    const images: ImageStub[] = [];
    const created: CanvasStub[] = [];
    const revoked: string[] = [];
    const cleanups: number[] = [];
    const bounds = { left: 0, top: 0, right: -1, bottom: -1 };
    let currentHooks = hooks();
    const module = load<CanvasModule>("editor/components/Canvas.tsx", {
        "@webpack/common": {
            useRef: <T>(initial: T) => currentHooks.api.useRef(initial),
            useEffect: (setup: () => void | (() => void), deps: unknown[]) => currentHooks.api.useEffect(setup, deps)
        },
        "@equicordplugins/remix/editor/input": { initInput() { const index = cleanups.push(0) - 1; return () => { cleanups[index]++; }; } },
        "@equicordplugins/remix/editor/tools/crop": { bounds },
        "@equicordplugins/remix/editor/utils/canvas": {
            widthFromBounds: (b: typeof bounds) => b.right - b.left,
            heightFromBounds: (b: typeof bounds) => b.bottom - b.top
        }
    }, {
        Image: class extends ImageStub { constructor() { super(); images.push(this); } },
        document: { createElement() { const canvas = new CanvasStub(); created.push(canvas); return canvas; } },
        URL: { createObjectURL: () => `blob:${images.length}`, revokeObjectURL: (url: string) => revoked.push(url) }
    });
    function mount(canvas = new CanvasStub()) {
        const owner = hooks();
        currentHooks = owner;
        const ready: boolean[] = [];
        const errors: string[] = [];
        const tree = owner.render(() => module.Canvas({ file: new File([], "fixture.png"), onReady: value => ready.push(value), onError: value => errors.push(value) }));
        (tree.props.ref as { current: CanvasStub; }).current = canvas;
        owner.flush();
        const image = images.at(-1);
        assert.ok(image);
        return { canvas, ready, errors, image, cleanup: owner.unmount };
    }
    return { module, mount, images, created, revoked, cleanups, bounds };
}

test("Remix exports only the cropped image and brush layers without mutating the editor", async () => {
    const f = canvasFixture();
    await assert.rejects(settled(f.module.exportImg()), /Load an image/);
    const mounted = f.mount();
    assert.ok(mounted.image.onload);
    mounted.image.onload();
    assert.deepEqual(mounted.ready, [false, true]);
    assert.deepEqual(f.bounds, { left: 0, top: 0, right: 200, bottom: 100 });
    Object.assign(f.bounds, { left: 10, top: 20, right: 100, bottom: 80 });
    const before = [...mounted.canvas.draws];
    const pending = f.module.exportImg();
    const exported = f.created.at(-1);
    assert.ok(exported?.callback);
    assert.equal(exported.width, 90);
    assert.equal(exported.height, 60);
    assert.deepEqual(exported.draws, [[mounted.image, -10, -20], [f.module.brushCanvas.canvas, -10, -20]]);
    const blob = new Blob(["png"]);
    exported.callback(blob);
    assert.equal(await settled(pending), blob);
    assert.deepEqual(mounted.canvas.draws, before);
    assert.deepEqual(f.bounds, { left: 10, top: 20, right: 100, bottom: 80 });
    mounted.cleanup();
    assert.deepEqual(f.cleanups, [1]);
    assert.deepEqual(f.revoked, ["blob:1"]);
});

test("Remix export rejects null blobs and empty crops and remains usable for retry", async () => {
    const f = canvasFixture();
    const mounted = f.mount();
    assert.ok(mounted.image.onload);
    mounted.image.onload();
    const failed = f.module.exportImg();
    const exported = f.created.at(-1);
    assert.ok(exported?.callback);
    exported.callback(null);
    await assert.rejects(settled(failed), /Could not export/);
    f.bounds.right = f.bounds.left;
    await assert.rejects(settled(f.module.exportImg()), /non-empty crop/);
    f.bounds.right = 200;
    const retry = f.module.exportImg();
    const next = f.created.at(-1);
    assert.ok(next?.callback);
    const blob = new Blob(["retry"]);
    next.callback(blob);
    assert.equal(await settled(retry), blob);
    mounted.cleanup();
});

for (const failure of ["load", "context", "dimensions"] as const) {
    test(`Remix contains ${failure} failures and releases each image URL once`, () => {
        const f = canvasFixture();
        const mounted = f.mount();
        assert.ok(mounted.image.onload);
        assert.ok(mounted.image.onerror);
        if (failure === "load") mounted.image.onerror();
        else {
            if (failure === "context") mounted.canvas.contextAvailable = false;
            else mounted.image.width = 0;
            mounted.image.onload();
        }
        assert.deepEqual(mounted.ready, [false]);
        assert.equal(mounted.errors.length, 1);
        assert.equal(f.module.canvas, null);
        mounted.cleanup();
        assert.deepEqual(f.revoked, ["blob:1"]);
        assert.equal(mounted.image.onload, null);
        assert.equal(mounted.image.onerror, null);
    });
}

test("Remix ignores superseded image callbacks even before the old effect is cleaned up", () => {
    const f = canvasFixture();
    const old = f.mount();
    const late = old.image.onload;
    assert.ok(late);
    const next = f.mount(old.canvas);
    late();
    assert.equal(f.module.canvas, null);
    assert.deepEqual(old.ready, [false]);
    assert.ok(next.image.onload);
    next.image.onload();
    old.cleanup();
    assert.equal(f.module.canvas, next.canvas);
    assert.deepEqual(f.cleanups, [0]);
    next.cleanup();
    assert.equal(f.module.canvas, null);
    assert.deepEqual(f.cleanups, [1]);
});

test("Remix toolbar effects own activation, repeated clicks, switching, replay and unmount", () => {
    const h = hooks();
    const seen: string[] = [];
    const tool = (name: string) => ({ selected() { seen.push(`+${name}`); }, unselected() { seen.push(`-${name}`); } });
    const brushCanvas = {};
    const module = load<{ currentTool: string; Toolbar(): Element; }>("editor/components/Toolbar.tsx", {
        "@webpack/common": { ...h.api, Button: "button", Select: "select", Slider: "slider" },
        "@components/Paragraph": { Paragraph: "p" }, "@components/settings": { Switch: "switch" },
        "@equicordplugins/remix/editor/tools/brush": { BrushTool: tool("brush") },
        "@equicordplugins/remix/editor/tools/eraser": { EraseTool: tool("erase") },
        "@equicordplugins/remix/editor/tools/crop": { CropTool: tool("crop"), resetBounds() { } },
        "@equicordplugins/remix/editor/tools/shape": { ShapeTool: tool("shape"), setShapeFill() { } },
        "./Canvas": { brushCanvas, shapeCanvas: {}, cropCanvas: {} },
        "./SettingColorComponent": { SettingColorComponent: "color" }
    });
    module.currentTool = "crop";
    function render() { const tree = h.render(module.Toolbar); h.flush(); return tree; }
    let tree = render();
    assert.deepEqual(seen, ["+crop"]);
    (elements(tree, "button")[2].props.onClick as () => void)();
    tree = render();
    assert.deepEqual(seen, ["+crop"]);
    (elements(tree, "button")[0].props.onClick as () => void)();
    render();
    assert.deepEqual(seen, ["+crop", "-crop", "+brush"]);
    h.replay();
    h.unmount();
    assert.deepEqual(seen, ["+crop", "-crop", "+brush", "-brush", "+brush", "-brush"]);
    assert.equal((brushCanvas as { strokeStyle: string; }).strokeStyle, "#ff0000");
});

function editorFixture() {
    const h = hooks();
    const requests: { signal: AbortSignal; work: ReturnType<typeof deferred<ImageStub>>; }[] = [];
    const conversions: ReturnType<typeof deferred<File>>[] = [];
    const module = load<{ Editor(props: { url?: string; }): Element; }>("editor/Editor.tsx", {
        "@webpack/common": h.api, "@webpack": { findComponentByCodeLazy: () => "upload" },
        "@components/Paragraph": { Paragraph: "p" }, "./components/Canvas": { Canvas: "canvas" },
        "./components/Toolbar": { Toolbar: "toolbar" },
        "./utils/canvas": {
            urlToImage(_url: string, signal: AbortSignal) { const work = deferred<ImageStub>(); requests.push({ signal, work }); return work.promise; },
            imageToBlob() { const work = deferred<File>(); conversions.push(work); return work.promise; }
        }
    });
    const render = (url = "first-image") => { const tree = h.render(() => module.Editor({ url })); h.flush(); return tree; };
    return { h, requests, conversions, render };
}

test("Remix local file selection supersedes an unfinished remote conversion and delays toolbar activation until ready", async () => {
    const f = editorFixture();
    const tree = f.render();
    f.requests[0].work.resolve(new ImageStub());
    await setImmediate();
    const file = new File(["local"], "local.png");
    (elements(tree, "upload")[0].props.onFileSelect as (file: File) => void)(file);
    assert.equal(f.requests[0].signal.aborted, true);
    f.conversions[0].resolve(new File(["remote"], "remote.png"));
    await setImmediate();
    const loading = f.render();
    assert.equal(elements(loading, "canvas")[0].props.file, file);
    assert.equal(elements(loading, "toolbar").length, 0);
    (elements(loading, "canvas")[0].props.onReady as (ready: boolean) => void)(true);
    assert.equal(elements(f.render(), "toolbar").length, 1);
    f.h.unmount();
});

test("Remix remote loading follows URL changes, reports failures and ignores unmounted conversions", async () => {
    const f = editorFixture();
    f.render();
    f.render("replacement-image");
    assert.equal(f.requests[0].signal.aborted, true);
    f.requests[1].work.reject(new Error("missing"));
    await setImmediate();
    const failed = f.render("replacement-image");
    assert.equal(elements(failed, "p").length, 1);
    assert.equal(elements(failed, "upload").length, 1);
    f.render("third-image");
    f.requests[2].work.resolve(new ImageStub());
    await setImmediate();
    f.h.unmount();
    const writes = f.h.writes;
    f.conversions[0].resolve(new File([], "late.png"));
    f.requests[0].work.reject(new Error("old"));
    await setImmediate();
    assert.equal(f.h.writes, writes);
});

interface ModalProps {
    onClose(): void;
    notice?: { message: string; };
    actions: { onClick(): Promise<void> | void; disabled?: boolean; }[];
}
function modalFixture() {
    const h = hooks();
    const exports: ReturnType<typeof deferred<Blob>>[] = [];
    const uploads: Blob[] = [];
    let closeCount = 0;
    let uploadFailure = false;
    const module = load<{ default(props: { modalProps: object; close(): void; }): Element; }>("RemixModal.tsx", {
        "@webpack/common": { ...h.api, React, Modal: "modal", SelectedChannelStore: { getChannelId: () => "channel" } },
        ".": { sendRemix(blob: Blob) { if (uploadFailure) return Promise.reject(new Error("upload")); uploads.push(blob); } },
        "./editor/components/Canvas": { exportImg() { const work = deferred<Blob>(); exports.push(work); return work.promise; } },
        "./editor/Editor": { Editor: "editor" }, "./icons/SendIcon": { SendIcon: "send-icon" },
        "./editor/tools/crop": { resetBounds() { } }
    });
    function render() {
        const tree = h.render(() => module.default({ modalProps: {}, close() { closeCount++; } }));
        h.flush();
        return tree.props as unknown as ModalProps;
    }
    return { h, exports, uploads, render, get closeCount() { return closeCount; }, failUpload() { uploadFailure = true; } };
}

test("Remix contains export failures, prevents duplicate submissions and permits retry without losing the editor", async () => {
    const f = modalFixture();
    const first = f.render();
    const pending = first.actions[0].onClick();
    await first.actions[0].onClick();
    assert.equal(f.exports.length, 1);
    assert.equal(f.render().actions[0].disabled, true);
    f.exports[0].reject(new Error("no image"));
    await pending;
    const failed = f.render();
    assert.ok(failed.notice?.message);
    assert.equal(failed.actions[0].disabled, false);
    assert.equal(f.closeCount, 0);
    const retry = failed.actions[0].onClick();
    const blob = new Blob(["retry"]);
    f.exports[1].resolve(blob);
    await retry;
    assert.deepEqual(f.uploads, [blob]);
    assert.equal(f.closeCount, 1);
});

for (const cancellation of ["close", "dismiss", "unmount"] as const) {
    test(`Remix ${cancellation} prevents a late export from opening an upload`, async () => {
        const f = modalFixture();
        const props = f.render();
        const pending = props.actions[0].onClick();
        if (cancellation === "close") props.actions[1].onClick();
        else if (cancellation === "dismiss") props.onClose();
        else f.h.unmount();
        const writes = f.h.writes;
        f.exports[0].resolve(new Blob(["obsolete"]));
        await pending;
        assert.deepEqual(f.uploads, []);
        assert.equal(f.h.writes, writes);
        assert.equal(f.closeCount, cancellation === "unmount" ? 0 : 1);
    });
}

test("Remix contains rejected upload preparation and retains the modal", async () => {
    const f = modalFixture();
    f.failUpload();
    const pending = f.render().actions[0].onClick();
    f.exports[0].resolve(new Blob(["png"]));
    await pending;
    assert.ok(f.render().notice?.message);
    assert.equal(f.closeCount, 0);
});

for (const name of ["crop", "shape"] as const) {
    test(`Remix ${name} deselection releases subscriptions and resets unfinished dragging`, () => {
        const listeners = new Set<unknown>();
        const target = { width: 200, height: 100, style: { cursor: "nwse-resize" } };
        let renders = 0;
        const context = { canvas: target, clearRect() { }, fillRect() { }, strokeRect() { } };
        const owner: { canvas: typeof target | null; brushCanvas: typeof context; cropCanvas: typeof context; shapeCanvas: typeof context; render(): void; } = {
            canvas: target, brushCanvas: context, cropCanvas: context, shapeCanvas: context,
            render() { renders++; }
        };
        const module = load<Record<string, { selected(): void; unselected(): void; dragging?: string; isDragging?: boolean; }>>(`editor/tools/${name}.ts`, {
            "@equicordplugins/remix/editor/components/Canvas": owner,
            "@equicordplugins/remix/editor/input": { Mouse: { event: {
                on(_name: string, listener: unknown) { listeners.add(listener); },
                off(_name: string, listener: unknown) { listeners.delete(listener); }
            } } },
            "@equicordplugins/remix/editor/utils/canvas": { fillCircle() { }, line() { } }
        });
        const tool = module[name === "crop" ? "CropTool" : "ShapeTool"];
        tool.selected();
        assert.equal(listeners.size, 2);
        if (name === "crop") tool.dragging = "left top";
        else tool.isDragging = true;
        const before = renders;
        tool.unselected();
        assert.equal(listeners.size, 0);
        assert.ok(renders > before, "the removed overlay must also be removed from the visible canvas");
        if (name === "crop") {
            assert.equal(tool.dragging, "");
            assert.equal(target.style.cursor, "default");
            owner.canvas = null;
            tool.dragging = "right";
            tool.unselected();
            assert.equal(tool.dragging, "");
        } else assert.equal(tool.isDragging, false);
    });
}

test("Remix menu entry points share a modal key, stop closes it and upload preparation errors reach the caller", async () => {
    const opened: { render(props: object): Element; key?: string; }[] = [];
    const closed: string[] = [];
    const group: Element[] = [{ type: "item", props: { id: "copy-text" } }];
    const upload = deferred<void>();
    const module = load<{
        sendRemix(blob: Blob): Promise<void>;
        default: { contextMenus: Record<string, (children: Element[], props: Record<string, unknown>) => void>; stop(): void; };
    }>("index.tsx", {
        "@api/ContextMenu": { findGroupChildrenByChildId: () => group },
        "@components/Icons": { PaintbrushIcon: "icon" },
        "@utils/constants": { EquicordDevs: { MrDiamond: {}, meowabyte: {} } },
        "@utils/types": { __esModule: true, default: <T>(plugin: T) => plugin },
        "@webpack": { extractAndLoadChunksLazy: () => async () => { } },
        "@webpack/common": {
            Menu: { MenuItem: "item" },
            openModal(render: (props: object) => Element, options?: { modalKey?: string; }) {
                opened.push({ render, key: options?.modalKey });
                return options?.modalKey;
            },
            closeModal: (key: string) => closed.push(key),
            SelectedChannelStore: { getChannelId: () => "channel" },
            ChannelStore: { getChannel: () => ({ id: "channel" }) },
            PendingReplyStore: { getPendingReply: () => null },
            DraftType: { ChannelMessage: 0 },
            UploadHandler: { promptToUpload: () => upload.promise }
        },
        "./RemixModal": { __esModule: true, default: "remix" },
        "./styles.css?managed": { __esModule: true, default: "style" }
    });
    const attach: Element[] = [];
    module.default.contextMenus["channel-attach"](attach, {});
    module.default.contextMenus.message([], { itemHref: "fixture-image" });
    (attach[0].props.action as () => void)();
    (group[1].props.action as () => void)();
    assert.deepEqual(opened.map(item => item.key), ["vc-remix", "vc-remix"]);
    const modal = opened[1].render({});
    assert.equal(modal.props.url, "fixture-image");
    (modal.props.close as () => void)();
    module.default.stop();
    assert.deepEqual(closed, ["vc-remix", "vc-remix"]);
    const pending = module.sendRemix(new Blob(["synthetic"]));
    assert.equal(pending, upload.promise);
    upload.reject(new Error("preparation failed"));
    await assert.rejects(pending, /preparation failed/);
});
