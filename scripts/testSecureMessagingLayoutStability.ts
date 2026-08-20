/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    compensatedScrollTop,
    encryptedMessageRowId,
    preserveEncryptedMessageScroll,
    shouldPreserveHistoryScroll,
    targetMayAffectViewport,
} from "../src/equicordplugins/secureMessaging.desktop/layoutStability";

async function main(): Promise<void> {
    assert.equal(encryptedMessageRowId("200000000000000001", "300000000000000001"),
        "chat-messages-200000000000000001-300000000000000001");
    assert.equal(shouldPreserveHistoryScroll({ clientHeight: 600, scrollHeight: 2_000, scrollTop: 1_200 }), true);
    assert.equal(shouldPreserveHistoryScroll({ clientHeight: 600, scrollHeight: 2_000, scrollTop: 1_360 }), false);
    assert.equal(shouldPreserveHistoryScroll({ clientHeight: 600, scrollHeight: 600, scrollTop: 0 }), false);
    assert.equal(targetMayAffectViewport(599.5, 600), true);
    assert.equal(targetMayAffectViewport(600, 600), false);
    assert.equal(compensatedScrollTop(500, 10, 110), 600);
    assert.equal(compensatedScrollTop(500, Number.NaN, 110), 500);

    const originalDocument = globalThis.document;
    const originalGetComputedStyle = globalThis.getComputedStyle;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    let anchorContentTop = 510;

    const scroller = {
        clientHeight: 500,
        contains: (element: unknown) => element === anchor,
        getBoundingClientRect: () => ({ bottom: 500, top: 0 }),
        isConnected: true,
        parentElement: null,
        querySelectorAll: () => [target, anchor],
        scrollHeight: 2_000,
        scrollTop: 500,
    };
    const target = {
        getBoundingClientRect: () => ({ bottom: -10, top: -100 }),
        id: encryptedMessageRowId("200000000000000001", "300000000000000001"),
        parentElement: scroller,
    };
    const anchor = {
        getBoundingClientRect: () => {
            const top = anchorContentTop - scroller.scrollTop;
            return { bottom: top + 50, top };
        },
        id: "chat-messages-200000000000000001-300000000000000002",
        parentElement: scroller,
    };

    try {
        Object.defineProperty(globalThis, "document", {
            configurable: true,
            value: {
                getElementById(id: string) {
                    if (id === target.id) return target;
                    if (id === anchor.id) return anchor;
                    return null;
                },
            },
        });
        Object.defineProperty(globalThis, "getComputedStyle", {
            configurable: true,
            value: () => ({ overflowY: "scroll" }),
        });
        Object.defineProperty(globalThis, "requestAnimationFrame", {
            configurable: true,
            value: (callback: FrameRequestCallback) => {
                frames.push(callback);
                return frames.length;
            },
        });

        preserveEncryptedMessageScroll({
            channel_id: "200000000000000001",
            id: "300000000000000001",
        } as never, () => { anchorContentTop += 100; });
        await new Promise<void>(resolve => queueMicrotask(resolve));
        assert.equal(frames.length, 1, "the correction must be scheduled before the next paint");
        frames.shift()!(0);
        assert.equal(scroller.scrollTop, 600, "loading content above the viewport must not move the visible anchor");
        frames.shift()!(16);
        assert.equal(scroller.scrollTop, 600, "a settled layout must not be over-corrected");
        scroller.scrollTop = 700;
        frames.shift()!(32);
        assert.equal(scroller.scrollTop, 700, "the stabilizer must not fight direct history scrolling");
        assert.equal(frames.length, 0);
    } finally {
        Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
        Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: originalGetComputedStyle });
        Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: originalRequestAnimationFrame });
    }

    const attachmentCache = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/attachmentCache.ts",
        import.meta.url,
    ), "utf8");
    const embedCache = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/embedCache.ts",
        import.meta.url,
    ), "utf8");
    assert.match(attachmentCache, /preserveEncryptedMessageScroll\(message, \(\) => \{/u,
        "attachment render completion must preserve the history scroll anchor");
    assert.match(embedCache, /preserveEncryptedMessageScroll\(message, \(\) => \{/u,
        "embed and sticker render completion must preserve the history scroll anchor");

    console.log("Secure Messaging encrypted-media layout stability tests passed.");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
