import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

function loadDumper(count: number, stickers = false) {
    const requests: { url: string; resolve: (ok?: boolean, contentType?: string) => void; }[] = [];
    const archives: Record<string, Uint8Array>[] = [];
    const files: File[] = [];
    const toasts: string[] = [];
    let active = 0;
    let peak = 0;
    const assets = Array.from({ length: count }, (_, index) => ({ id: String(index), name: `asset/${index}`, animated: false, format_type: 2 }));
    const module = loadTestModule("src/equicordplugins/guildPickerDumper/index.tsx", {
        "@api/ContextMenu": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@utils/web": { saveFile: (file: File) => files.push(file) },
        "@webpack/common": {
            EmojiStore: { getGuilds: () => ({ guild: { emojis: assets } }) },
            StickersStore: { getStickersByGuildId: () => assets }, Menu: {},
            showToast: (message: string) => toasts.push(message), Toasts: { Type: { FAILURE: 1 } }
        },
        "fflate": { zipSync: (archive: Record<string, Uint8Array>) => { archives.push(archive); return new Uint8Array([1]); } }
    }, {
        window: { GLOBAL_ENV: { MEDIA_PROXY_ENDPOINT: "//media.discordapp.net" } }, AbortController, File, Uint8Array,
        console: { error() {} },
        fetch: (url: string) => {
            peak = Math.max(peak, ++active);
            return new Promise(resolve => requests.push({ url, resolve: (ok = true, contentType = "image/png") => {
                active--;
                resolve({ ok, status: ok ? 200 : 500, headers: { get: () => contentType }, blob: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) });
            } }));
        }
    }, "\nexports.zipGuildAssets = zipGuildAssets;");
    return { requests, archives, files, toasts, get peak() { return peak; }, run: () => module.zipGuildAssets({ id: "guild", name: "Server" }, stickers ? "stickers" : "emojis") };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("GuildPickerDumper bounds downloads while preserving every asset and filename order", async () => {
    const fixture = loadDumper(100);
    const done = fixture.run();
    assert.ok(fixture.requests.length <= 4, `Started ${fixture.requests.length} simultaneous downloads`);
    let completed = 0;
    while (completed < 100) {
        const available = fixture.requests.length;
        assert.ok(available > completed);
        for (; completed < available; completed++) fixture.requests[completed].resolve();
        await flush();
    }
    await done;
    assert.ok(fixture.peak <= 4);
    assert.deepEqual(Object.keys(fixture.archives[0]), Array.from({ length: 100 }, (_, index) => `asset_${index}_${index}.png`));
    assert.equal(fixture.files[0].name, "Server-emojis.zip");
    assert.equal(fixture.toasts.length, 0);
});

test("GuildPickerDumper preserves APNG fallback and stops queued downloads after failure", async () => {
    const fallback = loadDumper(1, true);
    const fallbackDone = fallback.run();
    fallback.requests[0].resolve(true, "text/html");
    await flush();
    assert.match(fallback.requests[1].url, /\/stickers\/0\.gif\?/);
    fallback.requests[1].resolve(true, "image/gif");
    await fallbackDone;
    assert.deepEqual(Object.keys(fallback.archives[0]), ["asset_0_0.gif"]);
    const failure = loadDumper(100);
    const failed = failure.run();
    failure.requests[0].resolve(false);
    await flush();
    for (const request of failure.requests.slice(1)) request.resolve();
    await failed;
    await flush();
    assert.ok(failure.requests.length <= 4, "Queued downloads continued after failure");
    assert.equal(failure.files.length, 0);
    assert.equal(failure.archives.length, 0);
    assert.equal(failure.toasts.length, 1);
});
