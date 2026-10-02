import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function load(file: string, mocks: Record<string, any>, globals: Record<string, any> = {}, transform = (source: string) => source) {
    const exports: any = {};
    const source = transform(readFileSync(`src/equicordplugins/${file}`, "utf8"));
    const code = transpileModule(source, {
        fileName: file,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, esModuleInterop: false }
    }).outputText;
    runInNewContext(code, { exports, require: (name: string) => mocks[name] ?? {}, Blob, URL, Uint8Array, Uint8ClampedArray, ...globals });
    return exports;
}

function clock() {
    let now = 10000;
    let sequence = 0;
    const timers = new Map<number, { deadline: number; callback: () => void; }>();
    const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
    return {
        timers, settle,
        globals: {
            Date: class extends Date { static now() { return now; } },
            setTimeout: (callback: () => void, delay: number) => {
                const timer = ++sequence;
                timers.set(timer, { deadline: now + delay, callback });
                return timer;
            },
            clearTimeout: (timer: number) => timers.delete(timer)
        },
        async advance(milliseconds: number) {
            const target = now + milliseconds;
            for (let steps = 0; steps < 100; steps++) {
                const next = [...timers].sort((left, right) => left[1].deadline - right[1].deadline)[0];
                if (!next || next[1].deadline > target) { now = target; await settle(); return; }
                now = next[1].deadline;
                timers.delete(next[0]);
                next[1].callback();
                await settle();
            }
            throw new Error("Timer regression exceeded bounded work");
        }
    };
}

function encoderHarness(frames: any[] = [], sourceWidth = 2, sourceHeight = 1) {
    const encoded: number[][] = [];
    let decoded = 0;
    let readbacks = 0;
    let canvasCount = 0;
    let sampleBytes = 0;
    class Canvas {
        width = 0;
        height = 0;
        pixels = new Uint8ClampedArray();
        ensure() {
            const size = this.width * this.height * 4;
            assert.ok(size <= 4 * 1024 * 1024, "fixture must never allocate oversized canvases");
            if (size !== this.pixels.length) this.pixels = new Uint8ClampedArray(size);
        }
        getContext() {
            const canvas = this;
            return {
                save() { }, restore() { }, translate() { },
                clearRect(left: number, top: number, width: number, height: number) {
                    canvas.ensure();
                    for (let row = top; row < top + height; row++)
                        canvas.pixels.fill(0, (row * canvas.width + left) * 4, (row * canvas.width + left + width) * 4);
                },
                getImageData() { canvas.ensure(); readbacks++; return { data: canvas.pixels.slice(), width: canvas.width, height: canvas.height }; },
                putImageData(image: any, left: number, top: number) {
                    canvas.ensure();
                    for (let row = 0; row < image.height; row++) {
                        const start = row * image.width * 4;
                        canvas.pixels.set(image.data.subarray(start, start + image.width * 4), ((row + top) * canvas.width + left) * 4);
                    }
                },
                drawImage(image: Canvas, left: number, top: number) {
                    canvas.ensure(); image.ensure();
                    for (let row = 0; row < image.height; row++) {
                        for (let column = 0; column < image.width; column++) {
                            const source = (row * image.width + column) * 4;
                            if (image.pixels[source + 3]) canvas.pixels.set(image.pixels.subarray(source, source + 4), ((row + top) * canvas.width + left + column) * 4);
                        }
                    }
                }
            };
        }
    }
    const module = load("gifMaker/utils/encoder.ts", {
        "@utils/misc": { sleep: async () => { } },
        "gifuct-js": {
            parseGIF: () => ({ frames, lsd: { width: sourceWidth, height: sourceHeight }, gct: [] }),
            decompressFrame: (frame: any) => {
                decoded++;
                const descriptor = frame.image.descriptor;
                const patch = new Uint8ClampedArray(new SharedArrayBuffer(frame.pixels.length));
                patch.set(frame.pixels);
                return { dims: descriptor, disposalType: frame.disposal, patch };
            }
        },
        "gifenc": {
            quantize: (samples: Uint8ClampedArray) => { sampleBytes = samples.length; return []; },
            applyPalette: (pixels: Uint8ClampedArray) => pixels,
            GIFEncoder: () => ({ writeFrame: (pixels: Uint8ClampedArray) => encoded.push(Array.from(pixels)), finish() { }, bytesView: () => new Uint8Array([1]) })
        },
        "../captions": { CAPTIONS: [] },
        "../captions/caption": { measureTextLines: () => ({ lines: ["caption"], lineHeight: 100 }) }
    }, {
        VencordNative: undefined,
        document: { createElement: () => { canvasCount++; return new Canvas(); } },
        fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
        ImageData: class {
            constructor(public data: Uint8ClampedArray, public width: number, public height: number) {
                assert.ok(data.buffer instanceof ArrayBuffer, "ImageData must receive cloned ArrayBuffer storage");
            }
        }
    }, source => source + "\nexport { encodeFrames };\n");
    return { module, encoded, stats: () => ({ decoded, readbacks, canvasCount, sampleBytes }) };
}

const options = { width: 2, height: 1, captionMode: "none" };
const red = [255, 0, 0, 255];
const green = [0, 255, 0, 255];
const blank = [0, 0, 0, 0];
function frame(left: number, pixels: number[], disposal = 1) {
    return { image: { descriptor: { left, top: 0, width: pixels.length / 4, height: 1 } }, disposal, pixels };
}

test("GIF aggregate, caption, frame-count and descriptor budgets reject before decode/readback", async () => {
    const harness = encoderHarness([frame(0, red), frame(0, green)]);
    await assert.rejects(harness.module.encodeFrames(1024, 1024, options, 20, () => assert.fail("draw")), /64 MiB/);
    await assert.rejects(harness.module.encodeFrames(1024, 1024, { captionMode: "caption", captionText: "text" }, 14, () => assert.fail("draw")), /64 MiB/);
    await assert.rejects(harness.module.encodeFrames(2, 1, options, 201, () => assert.fail("draw")), /200/);
    assert.equal(harness.stats().readbacks, 0);
    const oversized = encoderHarness([frame(0, red), frame(0, green)], 8192, 8192);
    await assert.rejects(oversized.module.createGif("https://media.tenor.com/fixture.gif", false, options), /64 MiB/);
    assert.equal(oversized.stats().decoded, 0);
    const invalid = encoderHarness([frame(2, red), frame(0, green)]);
    await assert.rejects(invalid.module.createGif("https://media.tenor.com/fixture.gif", false, options), /outside/);
    assert.equal(invalid.stats().decoded, 0);
    const tooMany = encoderHarness(Array.from({ length: 201 }, () => frame(0, red)));
    await assert.rejects(tooMany.module.createGif("https://media.tenor.com/fixture.gif", false, options), /200/);
    assert.equal(tooMany.stats().decoded, 0);
});

test("GIF palette sampling stays bounded instead of duplicating all retained frames", async () => {
    const harness = encoderHarness();
    await harness.module.encodeFrames(256, 256, options, 8, () => { });
    assert.equal(harness.stats().sampleBytes, 1024 * 1024);
    assert.equal(harness.encoded.length, 8);
});

test("GIF disposal3 restores the canvas before the first frame and after disposal2", async () => {
    const first = encoderHarness([frame(0, red, 3), frame(1, green)]);
    await first.module.createGif("https://media.tenor.com/fixture.gif", false, options);
    assert.deepEqual(first.encoded, [[...red, ...blank], [...blank, ...green]]);
    const prior = encoderHarness([frame(0, red, 2), frame(1, green, 3), frame(0, green)]);
    await prior.module.createGif("https://media.tenor.com/fixture.gif", false, options);
    assert.deepEqual(prior.encoded, [[...red, ...blank], [...blank, ...green], [...green, ...blank]]);
    assert.equal(prior.stats().decoded, 3);
    assert.equal(prior.stats().canvasCount, 3);
});

function queueHarness() {
    const time = clock();
    const queueModule = load("../utils/Queue.ts", { "./Logger": { Logger: class { error() { } } } });
    const { BatchedRequestQueue } = load("favouriteAnything/utils.ts", { "@utils/Queue": queueModule }, time.globals,
        source => "import { Queue } from '@utils/Queue';\n" + source.slice(source.indexOf("export class BatchedRequestQueue")));
    return { time, BatchedRequestQueue };
}

test("batch retries autonomously with bounded attempts and duplicate-add recovery", async () => {
    const { time, BatchedRequestQueue } = queueHarness();
    let calls = 0;
    let failing = true;
    const batches: string[][] = [];
    const queue = new BatchedRequestQueue(async (items: string[]) => {
        calls++; batches.push(Array.from(items));
        if (failing) throw new Error("offline failure");
    }, { maxCount: 1, timeout: 50 });
    queue.add("item");
    await time.settle();
    await time.advance(7000);
    assert.equal(calls, 4);
    assert.equal(time.timers.size, 0);
    failing = false;
    queue.add("item");
    await time.settle();
    assert.equal(calls, 5);
    assert.deepEqual(batches, Array.from({ length: 5 }, () => ["item"]));
    assert.equal(time.timers.size, 0);
});

test("batch transient failure retries without another add and clear cancels pending retries", async () => {
    const { time, BatchedRequestQueue } = queueHarness();
    let calls = 0;
    const queue = new BatchedRequestQueue(async () => { if (++calls === 1) throw new Error("transient"); }, { maxCount: 2, timeout: 50 });
    queue.add("item");
    await time.advance(50);
    await time.advance(999);
    assert.equal(calls, 1);
    await time.advance(1);
    assert.equal(calls, 2);
    queue.add("pending");
    queue.clear();
    await time.advance(10000);
    assert.equal(calls, 2);
    let failures = 0;
    const failing = new BatchedRequestQueue(async () => { failures++; throw new Error("retry"); }, { maxCount: 1 });
    failing.add("retry");
    await time.settle();
    assert.equal(time.timers.size, 1);
    failing.clear();
    await time.advance(10000);
    assert.equal(failures, 1);
    assert.equal(time.timers.size, 0);
});

test("batch keeps one in-flight request and ignores cleared-generation failure", async () => {
    const { time, BatchedRequestQueue } = queueHarness();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((resolve, decline) => { reject = decline; });
    const batches: string[][] = [];
    const queue = new BatchedRequestQueue(async (items: string[]) => {
        batches.push(Array.from(items));
        if (batches.length === 1) await pending;
    }, { maxCount: 1, timeout: 50 });
    queue.add("old");
    for (let index = 0; index < 20; index++) queue.add(`queued-${index}`);
    await time.settle();
    assert.equal(queue.queued, 2);
    assert.equal(batches.length, 1);
    assert.equal(time.timers.size, 0);
    queue.clear();
    queue.add("new");
    reject(new Error("stale"));
    await time.settle();
    await time.advance(50);
    assert.deepEqual(batches, [["old"], ["new"]]);
    assert.equal(time.timers.size, 0);
});

test("batch queued-task cap drains all arrivals in order without dropping work", async () => {
    const { time, BatchedRequestQueue } = queueHarness();
    const received: number[] = [];
    const queue = new BatchedRequestQueue(async (items: number[]) => { received.push(...items); }, { maxCount: 2, timeout: 50 });
    for (let index = 0; index < 20; index++) queue.add(index);
    assert.equal(queue.queued, 2);
    await time.settle();
    await time.advance(500);
    assert.deepEqual(received, Array.from({ length: 20 }, (_, index) => index));
    assert.equal(queue.queued, 0);
    assert.equal(time.timers.size, 0);
});

function ghostHarness() {
    const time = clock();
    const settings = { store: { exemptedChannels: "", ignoreGroupDms: false, ignoreBots: false, maxInactiveTimeMs: 50, showDmIcons: true }, use() { return this.store; } };
    let account: string | undefined = "first";
    const accountListeners = new Set<() => void>();
    const message = { id: "message", author: { id: "other" }, content: "hello?", timestamp: new Date(10000).toISOString() };
    const states: any[] = [];
    const effects: Array<{ deps: any[]; cleanup?: () => void; }> = [];
    let stateCursor = 0;
    let effectCursor = 0;
    let pendingEffects: Array<() => void> = [];
    const common = {
        UserStore: { getCurrentUser: () => account ? { id: account } : undefined, addChangeListener: (listener: () => void) => accountListeners.add(listener), removeChangeListener: (listener: () => void) => accountListeners.delete(listener) },
        MessageStore: { getMessages: () => ({ last: () => message }) },
        useStateFromStores: (stores: any, select: () => any) => select(),
        useState: (initial: any) => {
            const index = stateCursor++;
            if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
            return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
        },
        useEffect: (effect: () => (() => void) | undefined, deps: any[]) => {
            const index = effectCursor++;
            if (effects[index] && deps.every((value, position) => Object.is(value, effects[index].deps[position]))) return;
            pendingEffects.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
        }
    };
    const React = { createElement: () => ({}) };
    const boo = load("ghosted/Boo.tsx", { ".": { settings, cl: () => "" }, "@webpack": { findCssClassesLazy: () => ({}) }, "@webpack/common": common }, { ...time.globals, React });
    const plugin = load("ghosted/index.tsx", {
        "./Boo": boo, "@webpack/common": common,
        "@utils/types": { default: (value: any) => value, OptionType: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@api/Settings": { definePluginSettings: () => settings },
        "@api/ServerList": { ServerListRenderPosition: { Above: 0 }, addServerListElement() { }, removeServerListElement() { } }
    }, { React }).default;
    return {
        boo, plugin, time, settings, message, accountListeners,
        switchAccount(value?: string) { account = value; for (const listener of accountListeners) listener(); },
        render() {
            stateCursor = 0; effectCursor = 0; pendingEffects = [];
            const result = boo.Boo({ channel: { id: "channel", isGroupDM: () => false } });
            for (const effect of pendingEffects) effect();
            return result;
        },
        unmount() { for (const effect of effects) effect.cleanup?.(); }
    };
}

test("ghost expiry updates idle tracking and unmount disposes its timer", async () => {
    const harness = ghostHarness();
    harness.plugin.start(); harness.render();
    assert.equal(harness.boo.getBooCount(), 1);
    await harness.time.advance(51);
    assert.equal(harness.render(), null);
    assert.equal(harness.boo.getBooCount(), 0);
    harness.message.timestamp = new Date(10051).toISOString();
    harness.message.id = "next"; harness.render();
    assert.equal(harness.time.timers.size, 1);
    harness.unmount();
    assert.equal(harness.time.timers.size, 0);
    harness.plugin.stop();
});

test("ghost long expiry is clamped and unlimited timeframe cancels timers", async () => {
    const harness = ghostHarness();
    harness.settings.store.maxInactiveTimeMs = 30 * 86400000;
    harness.plugin.start(); harness.render();
    assert.equal([...harness.time.timers.values()][0].deadline, 10000 + 2147483647);
    await harness.time.advance(2147483647);
    assert.equal(harness.boo.getBooCount(), 1);
    assert.equal(harness.time.timers.size, 1);
    harness.settings.store.maxInactiveTimeMs = 0; harness.render();
    assert.equal(harness.time.timers.size, 0);
    harness.unmount(); harness.plugin.stop();
});

test("ghost account/logout and plugin stop reset count, manual clears and listeners", async () => {
    const harness = ghostHarness();
    harness.plugin.start(); harness.render();
    harness.boo.clearChannelFromGhost("channel");
    assert.equal(harness.boo.isChannelCleared("channel"), true);
    harness.switchAccount("second");
    assert.equal(harness.boo.isChannelCleared("channel"), false);
    assert.equal(harness.boo.getBooCount(), 0);
    assert.equal(harness.time.timers.size, 0);
    harness.render();
    assert.equal(harness.boo.getBooCount(), 1);
    harness.switchAccount();
    assert.equal(harness.boo.getBooCount(), 0);
    harness.switchAccount("third"); harness.render();
    assert.equal(harness.boo.getBooCount(), 1);
    harness.plugin.stop();
    assert.equal(harness.accountListeners.size, 0);
    assert.equal(harness.time.timers.size, 0);
    assert.equal(harness.boo.getGhostedChannels().length, 0);
    await harness.time.advance(10000);
    assert.equal(harness.render(), null);
    assert.equal(harness.boo.getBooCount(), 0);
    harness.message.timestamp = new Date(20000).toISOString();
    harness.plugin.start(); harness.render();
    assert.equal(harness.boo.getBooCount(), 1);
    assert.equal(harness.time.timers.size, 1);
    harness.plugin.stop();
    harness.unmount();
});
