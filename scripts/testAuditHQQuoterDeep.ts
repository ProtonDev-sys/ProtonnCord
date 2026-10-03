import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const compile = (file: string) => transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText;

function deferred<Value>() {
    let resolve!: (value: Value) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Value>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    return { promise, resolve, reject };
}

async function flush() {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

function loadQuoter(options: {
    ready?: Promise<unknown>;
    load?: (descriptor: string, text: string) => Promise<{ status: string; }[]>;
    existingStyle?: boolean;
} = {}) {
    const timers = new Map<number, { callback: () => void; delay: number; }>();
    const fontCalls: { descriptor: string; text: string; }[] = [];
    const textCalls: { text: string; font: string; vertical: number; }[] = [];
    const images: unknown[] = [];
    const revoked: string[] = [];
    let timerId = 0;
    let stylePresent = options.existingStyle ?? false;
    const context = {
        font: "",
        fillStyle: "",
        globalCompositeOperation: "source-over",
        measureText(text: string) { return { width: Array.from(text).length * 10 }; },
        fillText(text: string, _horizontal: number, vertical: number) { textCalls.push({ text, font: this.font, vertical }); },
        fillRect() { },
        drawImage(image: unknown) { images.push(image); },
        createLinearGradient() { return { addColorStop() { } }; },
    };
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["quote"])) };
    const types = runInNewContext(compile("src/equicordplugins/quoter/types.ts") + "\nexports;", { exports: {} });
    const api = runInNewContext(compile("src/equicordplugins/quoter/utils.tsx") + "\n({ ...exports, calculateTextLines, drawQuoteText, extractCustomEmojis, drawAuthorInfo, drawWatermark });", {
        exports: {},
        require(name: string) {
            if (name === "./types") return types;
            if (name === "@webpack/common") return { UserStore: { getUser: () => undefined }, IconUtils: { getEmojiURL: () => "mock:emoji" } };
            if (name === "gifenc") return {};
            throw new Error("Unexpected Quoter import: " + name);
        },
        document: {
            getElementById: () => stylePresent ? {} : null,
            createElement: (kind: string) => kind === "canvas" ? canvas : {},
            head: { appendChild() { stylePresent = true; } },
            fonts: {
                ready: options.ready ?? Promise.resolve(),
                load(descriptor: string, text: string) {
                    fontCalls.push({ descriptor, text });
                    return options.load?.(descriptor, text) ?? Promise.resolve([{ status: "loaded" }]);
                }
            }
        },
        setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout(handle: number) { timers.delete(handle); },
        Blob,
        AbortSignal,
        fetch: async () => ({ ok: true, blob: async () => new Blob(["image"]) }),
        URL: { createObjectURL: () => "mock:object", revokeObjectURL: (url: string) => revoked.push(url) },
        Image: class {
            onload?: () => void;
            onerror?: () => void;
            set src(_value: string) { queueMicrotask(() => this.onload?.()); }
        }
    });
    return {
        api, types, context, fontCalls, textCalls, images, timers, revoked,
        expire() {
            for (const [handle, timer] of timers) {
                assert.equal(timer.delay, 5000);
                timers.delete(handle);
                timer.callback();
            }
        }
    };
}

const quoteOptions = {
    avatarUrl: "mock:avatar", quote: "First\nSecond", grayScale: false,
    author: { username: "author", globalName: "Author" }, watermark: "marker",
    showWatermark: true, saveAsGif: false, quoteFont: "Merriweather"
};

test("selected and author fonts await readiness and their own loads beyond 300 ms", async () => {
    const ready = deferred<void>();
    const loads: ReturnType<typeof deferred<{ status: string; }[]>>[] = [];
    const harness = loadQuoter({ ready: ready.promise, load: () => { const pending = deferred<{ status: string; }[]>(); loads.push(pending); return pending.promise; } });
    let completed = false;
    const result = harness.api.ensureFontLoaded(harness.types.QuoteFont.Merriweather, "quoted glyphs", "author glyphs").then((fonts: object) => { completed = true; return fonts; });
    await flush();
    assert.equal(harness.fontCalls.length, 0);
    assert.equal(completed, false);
    ready.resolve();
    await flush();
    assert.equal(loads.length, 3);
    assert.deepEqual(harness.fontCalls.map(call => call.text), ["quoted glyphs", "author glyphs", "author glyphs"]);
    assert.match(harness.fontCalls[0].descriptor, /Merriweather/);
    assert.match(harness.fontCalls[2].descriptor, /^italic .*M PLUS Rounded 1c/);
    loads[0].resolve([{ status: "loaded" }]);
    loads[1].resolve([{ status: "loaded" }]);
    await flush();
    assert.equal(completed, false);
    loads[2].resolve([{ status: "loaded" }]);
    assert.deepEqual({ ...await result }, { quoteFont: "Merriweather", authorFont: "M PLUS Rounded 1c" });
    assert.equal(harness.timers.size, 0);
});

test("an existing stylesheet does not bypass font loading; concurrent matching loads share work", async () => {
    const pending = deferred<{ status: string; }[]>();
    const harness = loadQuoter({ existingStyle: true, load: () => pending.promise });
    const first = harness.api.ensureFontLoaded(harness.types.QuoteFont.Lora);
    const second = harness.api.ensureFontLoaded(harness.types.QuoteFont.Lora);
    await flush();
    assert.equal(harness.fontCalls.length, 3);
    pending.resolve([{ status: "loaded" }]);
    assert.equal((await first).quoteFont, "Lora");
    assert.equal((await second).quoteFont, "Lora");
    assert.equal(harness.timers.size, 0);
});

test("font readiness rejection, missing faces and unloaded faces select an explicit fallback", async () => {
    for (const load of [async () => { throw new Error("font failed"); }, async () => [], async () => [{ status: "loading" }]]) {
        const harness = loadQuoter({ load });
        assert.deepEqual({ ...await harness.api.ensureFontLoaded(harness.types.QuoteFont.Lora) }, { quoteFont: "sans-serif", authorFont: "sans-serif" });
        assert.equal(harness.timers.size, 0);
    }
    const harness = loadQuoter({ ready: Promise.reject(new Error("stylesheet failed")) });
    assert.equal((await harness.api.ensureFontLoaded()).quoteFont, "sans-serif");
    assert.equal(harness.fontCalls.length, 0);
    assert.equal(harness.timers.size, 0);
});

test("never-settling font loads time out, clean timers and allow a later independent retry", async () => {
    let stalled = true;
    const late = deferred<{ status: string; }[]>();
    const harness = loadQuoter({ load: () => stalled ? late.promise : Promise.resolve([{ status: "loaded" }]) });
    const pending = harness.api.ensureFontLoaded(harness.types.QuoteFont.Lora);
    await flush();
    harness.expire();
    assert.deepEqual({ ...await pending }, { quoteFont: "sans-serif", authorFont: "sans-serif" });
    late.resolve([{ status: "loaded" }]);
    await flush();
    assert.equal(harness.timers.size, 0);
    stalled = false;
    assert.equal((await harness.api.ensureFontLoaded(harness.types.QuoteFont.Lora)).quoteFont, "Lora");
});

test("late stylesheet readiness does not initiate font loads after its deadline", async () => {
    const ready = deferred<void>();
    const harness = loadQuoter({ ready: ready.promise });
    const pending = harness.api.ensureFontLoaded();
    harness.expire();
    assert.equal((await pending).authorFont, "sans-serif");
    ready.resolve();
    await flush();
    assert.equal(harness.fontCalls.length, 0);
    assert.equal(harness.timers.size, 0);
});

test("reset separates old pending font work from a replacement cache entry", async () => {
    const oldLoad = deferred<{ status: string; }[]>();
    const newLoad = deferred<{ status: string; }[]>();
    let replacement = false;
    const harness = loadQuoter({ load: () => replacement ? newLoad.promise : oldLoad.promise });
    const old = harness.api.ensureFontLoaded(harness.types.QuoteFont.Lora);
    await flush();
    harness.api.resetFontLoading();
    replacement = true;
    const current = harness.api.ensureFontLoaded(harness.types.QuoteFont.Lora);
    await flush();
    oldLoad.resolve([{ status: "loaded" }]);
    await old;
    const joined = harness.api.ensureFontLoaded(harness.types.QuoteFont.Lora);
    await flush();
    assert.equal(harness.fontCalls.length, 6);
    newLoad.resolve([{ status: "loaded" }]);
    await Promise.all([current, joined]);
    assert.equal(harness.timers.size, 0);
});

test("LF, CRLF and bare CR preserve leading, trailing and intentional blank paragraphs", () => {
    const { api, context, types } = loadQuoter();
    for (const separator of ["\n", "\r\n", "\r"]) {
        const text = ["", "First", "", "Second", ""].join(separator);
        assert.deepEqual(Array.from(api.calculateTextLines(context, text, 18, types.QuoteFont.Lora, 200)), ["", "First", "", "Second", ""]);
    }
    assert.deepEqual(Array.from(api.calculateTextLines(context, "\n\n", 18, types.QuoteFont.Lora, 200)), ["", "", ""]);
});

test("word wrapping remains paragraph-local and oversized Unicode words stay codepoint-safe", () => {
    const { api, context, types } = loadQuoter();
    assert.deepEqual(Array.from(api.calculateTextLines(context, "one two\nthree four", 18, types.QuoteFont.Lora, 50)), ["one", "two", "three", "four"]);
    assert.deepEqual(Array.from(api.calculateTextLines(context, "😀😀😀\nx", 18, types.QuoteFont.Lora, 20)), ["😀😀", "😀", "x"]);
});

test("custom emoji order survives wrapping and blank paragraphs without duplicate or skipped tokens", () => {
    const harness = loadQuoter();
    const extracted = harness.api.extractCustomEmojis("<:first:1>\r\n\r\n<a:second:2> tail");
    const lines = harness.api.calculateTextLines(harness.context, extracted.text, 18, harness.types.QuoteFont.Lora, 45);
    assert.equal(lines[1], "");
    const calculation = { lines, fontSize: 18, lineHeight: 22.5, totalHeight: 200 };
    const first = { id: "first-image" };
    const second = { id: "second-image" };
    harness.api.drawQuoteText(harness.context, calculation, "Lora", harness.types.CANVAS_CONFIG, extracted.emojis, new Map([["1:s", first], ["2:a", second]]));
    assert.deepEqual(harness.images, [first, second]);
});

test("image rendering waits for selected and author fonts then uses explicit fallback families", async () => {
    const pending = deferred<{ status: string; }[]>();
    const harness = loadQuoter({ load: () => pending.promise });
    const rendering = harness.api.createQuoteImage(quoteOptions);
    await flush();
    assert.equal(harness.textCalls.length, 0);
    assert.equal(harness.images.length, 0);
    harness.expire();
    assert.ok(await rendering instanceof Blob);
    assert.deepEqual(harness.textCalls.slice(0, 2).map(call => call.text), ["First", "Second"]);
    assert.ok(harness.textCalls.every(call => call.font.includes("'sans-serif'")));
    assert.ok(harness.fontCalls[1].text.includes("@author marker"));
    assert.equal(harness.revoked.length, 1);
    assert.equal(harness.timers.size, 0);
});


test("successful image rendering uses the selected quote family and the ready author family", async () => {
    const harness = loadQuoter();
    const options = { ...quoteOptions, quote: "漢字\nSecond", author: { username: "author", globalName: "名前" } };
    assert.ok(await harness.api.createQuoteImage(options) instanceof Blob);
    assert.match(harness.textCalls[0].font, /Merriweather/);
    assert.match(harness.textCalls.find(call => call.text === "- 名前")!.font, /italic .*M PLUS Rounded 1c/);
    assert.match(harness.textCalls.find(call => call.text === "@author")!.font, /M PLUS Rounded 1c/);
    assert.equal(harness.fontCalls[0].text, "漢字\nSecond");
    assert.ok(harness.fontCalls[1].text.includes("名前 @author marker"));
    assert.equal(harness.timers.size, 0);
});
