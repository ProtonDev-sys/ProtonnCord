/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { isCollectionList } from "../src/equicordplugins/gifCollections/types";
import { getUrlExtension } from "../src/equicordplugins/gifCollections/utils/getUrlExtension";

function loadUtility(file: string, mocks: Record<string, any>) {
    const source = readFileSync(`src/equicordplugins/gifCollections/utils/${file}.ts`, "utf8");
    const output = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: false } }).outputText;
    const exports: any = {};
    runInNewContext(output, { exports, require: (id: string) => mocks[id] ?? {} });
    return exports;
}

test("GIF collection imports validate the complete structure before replacing saved data", async () => {
    let writes = 0;
    const { importCollections } = loadUtility("settingsUtils", {
        "../types": { isCollectionList },
        "@api/index": { DataStore: { set: async () => { writes++; } } },
        "./collectionManager": { refreshCacheCollection: async () => { } }
    });
    for (const invalid of [null, {}, { collections: null }, { collections: [{}] }]) {
        await assert.rejects(importCollections(JSON.stringify(invalid)), /Invalid collections format/);
    }
    assert.equal(writes, 0);
    await importCollections('{"collections":[]}');
    assert.equal(writes, 1);
});

test("GIF media extension parsing handles case, HTTP and protocol-relative URLs", () => {
    assert.equal(getUrlExtension("https://example.test/movie.MP4?query=1"), "mp4");
    assert.equal(getUrlExtension("http://example.test/audio.WAV"), "wav");
    assert.equal(getUrlExtension("//example.test/picture.GIF"), "gif");
    assert.equal(getUrlExtension("unusable URL"), undefined);
});

test("adding the same GIF to different collections creates independent item identities", async () => {
    let writes = 0;
    const stored = ["a", "b"].map(name => ({ name, type: "Category", format: 1, src: "image", gifs: [] }));
    const manager = loadUtility("collectionManager", {
        "../types": { isCollectionList },
        "../settings": { settings: { store: { itemPrefix: "gif:", defaultEmptyCollectionImage: "image" } } },
        "@api/index": { DataStore: { get: async () => stored, set: async () => { writes++; } } },
        "./getFormat": { getFormat: () => 1 },
        "./uuidv4": { uuidv4: () => "gif:copy" }
    });
    await manager.refreshCacheCollection();
    const gif = { id: "gif:original", src: "image", url: "image", height: 1, width: 1 };
    await manager.addToCollection("a", gif);
    await manager.addToCollection("b", gif);
    assert.equal(manager.getItemCollectionNameFromId("gif:original"), "a");
    assert.equal(manager.getItemCollectionNameFromId("gif:copy"), "b");
    writes = 0;
    await manager.updateGifs(new Map([
        ["gif:original", { ...gif, src: "fresh-a" }],
        ["gif:copy", { ...gif, id: "gif:copy", src: "fresh-b" }]
    ]));
    assert.equal(writes, 1);
    assert.equal(manager.cache_collections[0].src, "fresh-a");
    assert.equal(manager.cache_collections[1].src, "fresh-b");
});

test("GIF collection failed saves preserve the existing cache and concurrent creates serialize", async () => {
    let fail = true;
    let stored: any[] = ["a", "b"].map(name => ({ name, type: "Category", format: 1, src: "image", gifs: [] }));
    const manager = loadUtility("collectionManager", {
        "../types": { isCollectionList },
        "../settings": { settings: { store: { collectionPrefix: "", itemPrefix: "gif:", defaultEmptyCollectionImage: "image" } } },
        "@api/index": { DataStore: { get: async () => stored, set: async (_key: string, value: any) => {
            await Promise.resolve();
            if (fail) throw new Error("fixture persistence failed");
            stored = structuredClone(value);
        } } },
        "./getFormat": { getFormat: () => 1 }
    });
    await manager.refreshCacheCollection();
    await assert.rejects(manager.renameCollection("a", "changed"), /persistence failed/);
    assert.deepEqual(manager.cache_collections.map((collection: any) => collection.name), ["a", "b"]);
    fail = false;
    await Promise.all([manager.createCollection("c", []), manager.createCollection("d", [])]);
    assert.deepEqual([...manager.cache_collections].map((collection: any) => collection.name), ["a", "b", "c", "d"]);
    await assert.rejects(manager.renameCollection("a", "b"), /already exists/);
    await assert.rejects(manager.createCollection("c", []), /already exists/);
});
