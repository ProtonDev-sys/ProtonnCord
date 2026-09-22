/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import { build } from "esbuild";

import { captureDimensions, CapturedMessage, composeCaptures, maskBetween, paintPreview } from "../src/equicordplugins/messageImage.desktop/image";

async function main() {
    assert.deepEqual(maskBetween({ x: 80, y: 90 }, { x: -20, y: 5 }, 60, 70), { x: 0, y: 5, width: 60, height: 65 });
    const drawCalls: unknown[][] = [], fills: unknown[][] = [];
    const ctx = { drawImage: (...args: unknown[]) => drawCalls.push(args), fillRect: (...args: unknown[]) => fills.push(args) };
    const makeCanvas = (width: number, height: number) => ({ width, height, getContext: () => ctx }) as unknown as HTMLCanvasElement;
    const a: CapturedMessage = { id: "1", canvas: makeCanvas(800, 120), names: [{ x: 80, y: 5, width: 50, height: 20 }], avatars: [], times: [] };
    const b: CapturedMessage = { id: "2", canvas: makeCanvas(800, 240), names: [{ x: 80, y: 5, width: 50, height: 20 }], avatars: [], times: [] };
    assert.deepEqual(captureDimensions([a, b]), { width: 800, height: 360 });
    assert.throws(() => captureDimensions([a, { ...b, canvas: makeCanvas(801, 240) }]), /width or zoom changed/);
    assert.throws(() => captureDimensions([a, { ...b, canvas: makeCanvas(800, 20000) }]), /too large/);
    assert.throws(() => captureDimensions([]), /Choose/);
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => makeCanvas(0, 0) } });
    try {
        const result = composeCaptures([a, b]);
        assert.deepEqual(drawCalls, [[a.canvas, 0, 0], [b.canvas, 0, 120]], "captures are copied at integer offsets with no resizing or reconstruction");
        assert.equal(result.names[1].y, 125, "censor coordinates follow each captured row");
        paintPreview(result.canvas, result.canvas, [{ x: 10.5, y: 20.5, width: 19.8, height: 22.2 }]);
        assert.deepEqual(fills.at(-1), [10, 20, 21, 23], "blocks fully cover boundary pixels");
    } finally {
        if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document");
    }

    let screenshotArea: unknown;
    let clipboardWrites = 0;
    const settings = { plugins: { MessageImage: { enabled: true } } };
    const fixture = {
        settings,
        electron: {
            clipboard: { writeImage: () => { clipboardWrites++; } },
            nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) }
        }
    };
    const nativeBundle = await build({
        entryPoints: ["src/equicordplugins/messageImage.desktop/native.ts"], bundle: true, platform: "node", format: "cjs", write: false,
        plugins: [{ name: "native-test", setup(b) {
            b.onResolve({ filter: /^(?:electron|@main\/settings)$/ }, args => ({ path: args.path, namespace: "mock" }));
            b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "electron" ? "export const {clipboard,nativeImage}=fixture.electron;" : "export const RendererSettings={store:fixture.settings};", loader: "js" }));
        } }]
    });
    const module = { exports: {} as any };
    runInNewContext(nativeBundle.outputFiles[0].text, { module, exports: module.exports, fixture, URL, Buffer, Uint8Array });
    const native = module.exports;
    const frame = { url: "https://discord.com/channels/@me" };
    const event = {
        senderFrame: frame,
        sender: { mainFrame: frame, isDestroyed: () => false, getZoomFactor: () => 1.25, capturePage: async (area: unknown) => {
            screenshotArea = area;
            return { isEmpty: () => false, getScaleFactors: () => [1, 2], getSize: () => ({ width: 800, height: 200 }), toPNG: () => Buffer.from([1, 2, 3]) };
        } }
    };
    const bytes = await native.capture(event, { x: 10, y: 20, width: 400, height: 100 });
    assert.equal(JSON.stringify(screenshotArea), JSON.stringify({ x: 13, y: 25, width: 500, height: 125 }));
    assert.deepEqual([...bytes], [1, 2, 3], "capture returns the native PNG unchanged");
    await assert.rejects(native.capture(event, { x: -1, y: 0, width: 400, height: 100 }), /Invalid/);
    frame.url = "https://discord.com.evil.test";
    await assert.rejects(native.capture(event, { x: 0, y: 0, width: 400, height: 100 }), /only.*Discord/);
    frame.url = "https://discord.com/channels/@me";
    settings.plugins.MessageImage.enabled = false;
    await assert.rejects(native.capture(event, { x: 0, y: 0, width: 400, height: 100 }), /unavailable/);
    settings.plugins.MessageImage.enabled = true;
    assert.throws(() => native.copyImage(event, new Uint8Array(50)), /Invalid PNG/);
    assert.equal(clipboardWrites, 0, "invalid images never reach the clipboard");
    const pngHeader = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader);
    pngHeader.write("IHDR", 12); pngHeader.writeUInt32BE(800, 16); pngHeader.writeUInt32BE(200, 20);
    native.copyImage(event, new Uint8Array(pngHeader));
    assert.equal(clipboardWrites, 1);
    pngHeader.writeUInt32BE(100000, 16);
    assert.throws(() => native.copyImage(event, new Uint8Array(pngHeader)), /too large/);
    console.log("MessageImage: unchanged screenshot bytes, unscaled composition, censor coordinates, zoom handling and native validation passed.");
}

void main();
