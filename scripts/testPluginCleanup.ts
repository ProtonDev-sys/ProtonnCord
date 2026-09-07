/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { EventEmitter } from "../src/equicordplugins/remix/editor/utils/eventEmitter";

function loadModule<T>(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, ...globals,
        require(name: string) {
            assert.ok(name in mocks, `Unexpected import: ${name}`);
            return mocks[name];
        }
    });
}

interface UnindentPlugin {
    onBeforeMessageSend(channelId: string, message: { content: string; }): void;
    onBeforeMessageEdit(channelId: string, messageId: string, message: { content: string; }): void;
}

const { default: unindent } = loadModule<{ default: UnindentPlugin; }>("src/plugins/unindent/index.ts", {
    "@utils/constants": { Devs: { Ven: {} } },
    "@utils/types": { __esModule: true, default: <T>(plugin: T) => plugin }
});

for (const [name, content, expected] of [
    ["ordinary text", "before\n    plain\nafter", "before\n    plain\nafter"],
    ["inline blocks", "before ```    code``` after", "before ```    code``` after"],
    ["unclosed blocks", "```ts\n    code", "```ts\n    code"],
    ["relative indentation", "```ts\n    first\n        second\n```", "```ts\nfirst\n    second\n```"],
    ["same-line closing fences", "before ```ts\n    code``` after", "before ```ts\ncode``` after"],
    ["empty multiline blocks", "```ts\n```", "```ts\n```"],
    ["blank lines", "```ts\n\n    first\n\n    second\n```", "```ts\n\nfirst\n\nsecond\n```"],
    ["tabs", "```ts\n\tfirst\n\t\tsecond\n```", "```ts\nfirst\n    second\n```"],
    ["CRLF", "```ts\r\n    first\r\n    second\r\n```", "```ts\r\nfirst\r\nsecond\r\n```"],
    ["Unicode line separators", "```ts\n    one\u2028    two\n```", "```ts\none\u2028two\n```"],
    ["multiple blocks", "a ```ts\n    x``` b ```\n  y\n``` c", "a ```ts\nx``` b ```\ny\n``` c"],
    ["trailing spaces", "```ts\n    first  ```", "```ts\nfirst  ```"],
    ["unindented blocks", "```\none\n```", "```\none\n```"],
    ["indented closing fences", "```ts\n    code\n    ```", "```ts\ncode\n```"],
    ["whitespace-only blocks", "```\n    \n```", "```\n    \n```"]
]) {
    for (const operation of ["send", "edit"]) {
        test(`Unindent handles ${name} before ${operation}`, () => {
            const message = { content };
            if (operation === "send") unindent.onBeforeMessageSend("channel", message);
            else unindent.onBeforeMessageEdit("channel", "message", message);
            assert.equal(message.content, expected);
        });
    }
}

interface Pointer {
    clientX: number;
    clientY: number;
}

class CanvasStub {
    width = 200;
    height = 100;
    readonly listeners = new Map<string, (event: Pointer) => void>();
    readonly context = { canvas: this, clearRect() { }, drawImage() { }, fillRect() { }, strokeRect() { } };

    getContext() { return this.context; }
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 50 }; }
    addEventListener(name: string, listener: (event: Pointer) => void) {
        assert.equal(this.listeners.has(name), false);
        this.listeners.set(name, listener);
    }
    removeEventListener(name: string, listener: (event: Pointer) => void) {
        assert.equal(this.listeners.get(name), listener);
        this.listeners.delete(name);
    }
}

interface CanvasModule {
    canvas: CanvasStub | null;
    ctx: CanvasStub["context"] | null;
    Canvas(props: { file: File; }): unknown;
}

function canvasFixture() {
    const effects: Array<() => (() => void) | undefined> = [];
    const images: ImageStub[] = [];
    const urls: string[] = [];
    const revoked: string[] = [];
    const inputCleanups: number[] = [];
    let currentRef: { current: CanvasStub | null; } = { current: null };
    class ImageStub {
        width = 200;
        height = 100;
        src = "";
        onload: (() => void) | null = null;
        constructor() { images.push(this); }
    }
    const module = loadModule<CanvasModule>("src/equicordplugins/remix/editor/components/Canvas.tsx", {
        "@equicordplugins/remix/editor/input": {
            initInput() {
                const index = inputCleanups.push(0) - 1;
                return () => { inputCleanups[index]++; };
            }
        },
        "@equicordplugins/remix/editor/tools/crop": { bounds: {} },
        "@equicordplugins/remix/editor/utils/canvas": {},
        "@webpack/common": {
            useRef: () => currentRef,
            useEffect: (effect: () => (() => void) | undefined) => effects.push(effect)
        }
    }, {
        React: { createElement: () => null },
        document: { createElement: () => new CanvasStub() },
        Image: ImageStub,
        URL: {
            createObjectURL() {
                const url = `blob:fixture-${urls.length}`;
                urls.push(url);
                return url;
            },
            revokeObjectURL: (url: string) => revoked.push(url)
        }
    });
    function mount(canvas: CanvasStub | null = new CanvasStub()) {
        const ref = { current: canvas };
        currentRef = ref;
        module.Canvas({ file: new File([], "fixture.png") });
        const effect = effects.shift();
        assert.ok(effect);
        const cleanup = effect();
        return { canvas, ref, cleanup, image: images.at(-1) };
    }
    return { module, mount, images, urls, revoked, inputCleanups };
}

test("Remix releases its canvas and input after React clears the ref", () => {
    const fixture = canvasFixture();
    const mounted = fixture.mount();
    assert.ok(mounted.image?.onload);
    mounted.image.onload();
    assert.equal(fixture.module.canvas, mounted.canvas);
    mounted.ref.current = null;
    assert.ok(mounted.cleanup);
    mounted.cleanup();
    assert.equal(fixture.module.canvas, null);
    assert.equal(fixture.module.ctx, null);
    assert.deepEqual(fixture.inputCleanups, [1]);
    assert.deepEqual(fixture.revoked, fixture.urls);
});

test("Remix old cleanup does not clear a replacement canvas", () => {
    const fixture = canvasFixture();
    const old = fixture.mount();
    assert.ok(old.image?.onload);
    old.image.onload();
    const replacement = fixture.mount();
    assert.ok(replacement.image?.onload);
    replacement.image.onload();
    old.ref.current = null;
    assert.ok(old.cleanup);
    old.cleanup();
    assert.equal(fixture.module.canvas, replacement.canvas);
    assert.equal(fixture.module.ctx, replacement.canvas?.context);
    assert.deepEqual(fixture.inputCleanups, [1, 0]);
    assert.ok(replacement.cleanup);
    replacement.ref.current = null;
    replacement.cleanup();
    assert.equal(fixture.module.canvas, null);
    assert.deepEqual(fixture.inputCleanups, [1, 1]);
});

test("Remix ignores an old image callback after cleanup and replacement", () => {
    const fixture = canvasFixture();
    const old = fixture.mount();
    const lateLoad = old.image?.onload;
    assert.ok(lateLoad);
    assert.ok(old.cleanup);
    old.ref.current = null;
    old.cleanup();
    assert.equal(old.image?.onload, null);
    const replacement = fixture.mount();
    assert.ok(replacement.image?.onload);
    replacement.image.onload();
    lateLoad();
    assert.equal(fixture.module.canvas, replacement.canvas);
    assert.deepEqual(fixture.inputCleanups, [0]);
    assert.ok(replacement.cleanup);
    replacement.cleanup();
    assert.deepEqual(fixture.revoked, fixture.urls);
});

test("Remix does not start an image load without an attached canvas", () => {
    const fixture = canvasFixture();
    const mounted = fixture.mount(null);
    assert.equal(mounted.cleanup, undefined);
    assert.deepEqual(fixture.images, []);
    assert.deepEqual(fixture.urls, []);
});

test("Remix event removal preserves current dispatch order and removes future callbacks", () => {
    const emitter = new EventEmitter<number>();
    const seen: number[] = [];
    const second = (value: number) => seen.push(value * 10);
    emitter.on("move", value => { seen.push(value); emitter.off("move", second); });
    emitter.on("move", second);
    emitter.emit("missing", 1);
    emitter.off("missing", second);
    emitter.emit("move", 1);
    emitter.emit("move", 2);
    assert.deepEqual(seen, [1, 10, 2]);
});

test("Remix input preserves pointer state and removes listeners from its original canvas", () => {
    const canvas = new CanvasStub();
    const owner = { canvas };
    const input = loadModule<{
        Mouse: { x: number; y: number; prevX: number; prevY: number; down: boolean; event: EventEmitter<Pointer>; };
        initInput(): (() => void) | undefined;
    }>("src/equicordplugins/remix/editor/input.ts", {
        "./components/Canvas": owner,
        "./utils/eventEmitter": { EventEmitter }
    });
    const cleanup = input.initInput();
    assert.ok(cleanup);
    const seen: string[] = [];
    input.Mouse.event.on("move", () => seen.push("move"));
    input.Mouse.event.on("up", () => seen.push("up"));
    for (const [name, down] of [["mousemove", false], ["mousedown", true], ["mousemove", true], ["mouseleave", false]] as const) {
        const listener = canvas.listeners.get(name);
        assert.ok(listener);
        listener({ clientX: 20, clientY: 30 });
        assert.equal(input.Mouse.down, down);
    }
    assert.deepEqual(seen, ["move", "move", "up"]);
    assert.equal(input.Mouse.x, 20);
    assert.equal(input.Mouse.y, 20);
    assert.equal(input.Mouse.prevX, 20);
    assert.equal(input.Mouse.prevY, 20);
    owner.canvas = new CanvasStub();
    cleanup();
    assert.equal(canvas.listeners.size, 0);
    assert.equal(owner.canvas.listeners.size, 0);
    assert.equal(input.Mouse.down, false);
});

test("Remix crop removes subscriptions even after its canvas has gone", () => {
    const canvas = new CanvasStub();
    const owner: { canvas: CanvasStub | null; cropCanvas: CanvasStub["context"]; render(): void; } = {
        canvas, cropCanvas: canvas.context, render() { }
    };
    const event = new EventEmitter<Pointer>();
    const crop = loadModule<{ CropTool: { selected(): void; unselected(): void; }; }>("src/equicordplugins/remix/editor/tools/crop.ts", {
        "@equicordplugins/remix/editor/components/Canvas": owner,
        "@equicordplugins/remix/editor/input": { Mouse: { event } },
        "@equicordplugins/remix/editor/utils/canvas": { fillCircle() { } }
    });
    crop.CropTool.selected();
    assert.equal(event.events.move.length, 1);
    assert.equal(event.events.up.length, 1);
    owner.canvas = null;
    crop.CropTool.unselected();
    assert.equal(event.events.move.length, 0);
    assert.equal(event.events.up.length, 0);
});

for (const outcome of ["success", "throw", "reject"] as const) {
    test(`Remix leaves reply drafts to the host upload flow on ${outcome}`, async () => {
        const actions: unknown[] = [];
        const channel = { id: "channel" };
        const uploaded: File[] = [];
        const failure = new Error("Upload preparation failed");
        const module = loadModule<{ sendRemix(blob: Blob): Promise<void>; }>("src/equicordplugins/remix/index.tsx", {
            "@api/ContextMenu": {},
            "@components/Icons": {},
            "@utils/constants": { EquicordDevs: { MrDiamond: {}, meowabyte: {} } },
            "@utils/types": { __esModule: true, default: <T>(plugin: T) => plugin },
            "@webpack": { extractAndLoadChunksLazy: () => async () => { } },
            "@webpack/common": {
                SelectedChannelStore: { getChannelId: () => channel.id },
                ChannelStore: { getChannel: (id: string) => { assert.equal(id, channel.id); return channel; } },
                PendingReplyStore: { getPendingReply: () => ({ messageId: "reply-draft" }) },
                FluxDispatcher: { dispatch: (action: unknown) => actions.push(action) },
                DraftType: { ChannelMessage: 0 },
                UploadHandler: {
                    promptToUpload(files: File[], target: object, draftType: number) {
                        assert.equal(target, channel);
                        assert.equal(draftType, 0);
                        uploaded.push(...files);
                        if (outcome === "throw") throw failure;
                        return outcome === "reject" ? Promise.reject(failure) : Promise.resolve();
                    }
                }
            },
            "./RemixModal": { __esModule: true, default: () => null },
            "./styles.css?managed": { __esModule: true, default: "style" }
        }, { File });
        const send = () => module.sendRemix(new Blob(["fixture"]));
        if (outcome === "throw") assert.throws(send, error => error === failure);
        else if (outcome === "reject") await assert.rejects(send(), error => error === failure);
        else await send();
        assert.equal(uploaded.length, 1);
        assert.equal(uploaded[0].name, "remix.png");
        assert.equal(uploaded[0].type, "image/png");
        assert.equal(await uploaded[0].text(), "fixture");
        assert.deepEqual(actions, [], "preparing an image must not delete the host reply draft");
    });
}
