/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import type { Sticker, StickerPack } from "../src/equicordplugins/moreStickers/types";

const root = "src/equicordplugins/moreStickers/";
const recentNames = ["getRecentStickers", "setRecentStickers", "addRecentSticker", "removeRecentStickerByPackId"] as const;
const recentSource = createSourceFile("misc.tsx", readFileSync(`${root}components/misc.tsx`, "utf8"), ScriptTarget.Latest, true);
const recentCode = recentSource.statements.filter(node =>
    isFunctionDeclaration(node) && node.name && recentNames.some(name => name === node.name?.text) ||
    isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(recentSource) === "KEY")
).map(node => node.getText(recentSource)).join("\n");

function fixture() {
    const values = new Map<string, unknown>();
    let pending = Promise.resolve();
    const transaction = (write: () => void) => pending = pending.then(write);
    const DataStore = {
        async get(key: string) { return structuredClone(values.get(key)); },
        set(key: string, value: unknown) { return transaction(() => { values.set(key, structuredClone(value)); }); },
        del(key: string) { return transaction(() => { values.delete(key); }); },
        update(key: string, update: (value: unknown) => unknown) {
            return transaction(() => { values.set(key, structuredClone(update(structuredClone(values.get(key))))); });
        }
    };
    const recent = evaluate(recentCode, { DataStore }) as Pick<typeof import("../src/equicordplugins/moreStickers/components/misc"), typeof recentNames[number]>;
    const packs = evaluate(readFileSync(`${root}stickers.ts`, "utf8"), {
        require(name: string) {
            if (name === "@api/DataStore") return DataStore;
            if (name === "./components") return recent;
            if (name === "./utils") return { corsFetch() { throw new Error("Storage tests must not make network requests"); } };
            throw new Error(`Unexpected import: ${name}`);
        }
    }) as typeof import("../src/equicordplugins/moreStickers/stickers");
    return { recent, packs };
}

function evaluate(source: string, globals: Record<string, unknown>): Record<string, unknown> {
    const exports = {};
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    runInNewContext(outputText, { ...globals, exports });
    return exports;
}

function sticker(id: string, stickerPackId = id): Sticker {
    return { id, stickerPackId, image: "fixture.png", title: id };
}

test("concurrent recent stickers survive, remain unique, and stay bounded", async () => {
    const { recent } = fixture();
    await Promise.all(Array.from({ length: 20 }, (_, index) => recent.addRecentSticker(sticker(String(index)))));
    assert.deepEqual(Array.from(await recent.getRecentStickers(), value => value.id), Array.from({ length: 16 }, (_, index) => String(19 - index)));
    await recent.addRecentSticker(sticker("10"));
    const values = await recent.getRecentStickers();
    assert.equal(values[0].id, "10");
    assert.equal(new Set(values.map(value => value.id)).size, 16);
    await Promise.all([recent.removeRecentStickerByPackId("10"), recent.addRecentSticker(sticker("new"))]);
    assert.equal((await recent.getRecentStickers()).some(value => value.id === "10"), false);
    assert.equal((await recent.getRecentStickers())[0].id, "new");
});

test("pack changes retain concurrent entries and honor migration keys", async () => {
    const { recent, packs } = fixture();
    const makePack = (id: string): StickerPack => ({ id, title: id, logo: sticker(id), stickers: [sticker(id)] });
    await Promise.all([packs.saveStickerPack(makePack("a")), packs.saveStickerPack(makePack("b"))]);
    assert.deepEqual(Array.from(await packs.getStickerPackMetas(), pack => pack.id), ["a", "b"]);
    await packs.saveStickerPack({ ...makePack("a"), title: "updated" });
    assert.deepEqual(Array.from(await packs.getStickerPackMetas(), pack => pack.title), ["updated", "b"]);
    await recent.addRecentSticker(sticker("a"));
    await Promise.all([packs.deleteStickerPack("a"), packs.saveStickerPack(makePack("c"))]);
    assert.deepEqual(Array.from(await packs.getStickerPackMetas(), pack => pack.id), ["b", "c"]);
    assert.equal(await packs.getStickerPack("a"), null);
    assert.equal((await recent.getRecentStickers()).length, 0);
    await packs.saveStickerPack(makePack("legacy"), "legacy-packs");
    assert.deepEqual(Array.from(await packs.getStickerPackMetas("legacy-packs"), pack => pack.id), ["legacy"]);
    await packs.deleteStickerPack("legacy", "legacy-packs");
    assert.equal((await packs.getStickerPackMetas("legacy-packs")).length, 0);
    assert.equal((await packs.getStickerPackMetas()).length, 2);
    await recent.setRecentStickers([sticker("legacy")], "legacy-recents");
    assert.equal((await recent.getRecentStickers("legacy-recents"))[0].id, "legacy");
    assert.equal((await recent.getRecentStickers()).length, 0);
});
