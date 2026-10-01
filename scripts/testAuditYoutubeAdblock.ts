import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

function loadNative(enabled = true) {
    let onWindow!: (event: unknown, window: unknown) => void;
    let onFrame!: (event: unknown, details: unknown) => void;
    loadTestModule("src/plugins/youtubeAdblock.desktop/native.ts", {
        "@main/settings": { RendererSettings: { store: { plugins: { YoutubeAdblock: { enabled } } } } },
        "electron": { app: { on: (_event: string, callback: typeof onWindow) => { onWindow = callback; } } },
        "file://adguard.js?minify": { __esModule: true, default: "fixture-adguard" }
    }, { URL });
    onWindow({}, { webContents: { on: (_event: string, callback: typeof onFrame) => { onFrame = callback; } } });
    return (url: string, parentUrl?: string) => {
        const injected: string[] = [];
        const parent = parentUrl ? { url: parentUrl, executeJavaScript: (source: string) => injected.push(`parent:${source}`) } : undefined;
        onFrame({}, { frame: {
            url, parent,
            once: (_event: string, callback: () => void) => callback(),
            executeJavaScript: (source: string) => injected.push(`frame:${source}`)
        } });
        return injected;
    };
}

test("YoutubeAdblock injects only into genuine HTTPS YouTube embed origins", () => {
    const ready = loadNative();
    for (const url of ["https://youtube.com/embed/video", "https://www.youtube.com/embed/video?autoplay=1"]) {
        assert.deepEqual(ready(url), ["frame:fixture-adguard"], url);
    }
    for (const url of [
        "https://notyoutube.com/embed/video", "https://www.youtube.com.evil.test/embed/video",
        "https://evil.test/youtube.com/embed/video", "https://evil.test/?next=youtube.com/embed/video",
        "http://youtube.com/embed/video", "https://youtube.com:8443/embed/video",
        "https://youtube.com/watch?v=video", "about:blank", "not a URL"
    ]) assert.deepEqual(ready(url), [], url);
    assert.deepEqual(ready("https://WWW.YOUTUBE.COM:443/embed/videoseries"), ["frame:fixture-adguard"]);
});

test("YoutubeAdblock validates parent origin and respects disabled settings", () => {
    const ready = loadNative();
    assert.deepEqual(ready("about:blank", "https://www.youtube.com/embed/video"), ["parent:fixture-adguard"]);
    assert.deepEqual(ready("about:blank", "https://notyoutube.com/embed/video"), []);
    assert.deepEqual(ready("https://youtube.com/embed/video", "https://youtube.com/embed/parent"), ["frame:fixture-adguard"]);
    assert.deepEqual(loadNative(false)("https://youtube.com/embed/video"), []);
    assert.deepEqual(loadNative(false)("about:blank", "https://youtube.com/embed/video"), []);
});
