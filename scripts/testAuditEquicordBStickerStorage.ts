/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function load(file: string, imports: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, Promise, ...globals,
        require(name: string) { assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; }
    });
}

const api = load("src/api/DataStore/index.ts");
const clone = <T>(value: T): T => structuredClone(value);

function fixture() {
    const records = new Map<string, any>();
    let tail = Promise.resolve();
    const failure = { write: 0, read: false, commit: false };
    const store = (_mode: string, callback: (value: any) => unknown) => {
        const operation = tail.then(() => {
            const staged = clone(records);
            let aborted = false;
            let writes = 0;
            const transaction: any = {
                error: new Error("transaction failed"),
                abort() { aborted = true; queueMicrotask(() => transaction.onabort?.()); }
            };
            const outcome = callback({
                transaction,
                get(key: string) {
                    const request: any = { result: clone(staged.get(key)), error: new Error("read failed") };
                    queueMicrotask(() => {
                        if (aborted) return;
                        if (failure.read) request.onerror?.();
                        else request.onsuccess?.();
                    });
                    return request;
                },
                put(value: unknown, key: string) {
                    if (++writes === failure.write) throw new Error("write failed");
                    staged.set(key, clone(value));
                },
                delete(key: string) { staged.delete(key); }
            });
            setImmediate(() => {
                if (aborted) return;
                if (failure.commit) transaction.onerror?.();
                else {
                    records.clear();
                    for (const [key, value] of staged) records.set(key, value);
                    transaction.oncomplete?.();
                }
            });
            return outcome;
        });
        tail = operation.then(() => undefined, () => undefined);
        return operation;
    };
    const DataStore = {
        async get(key: string) { return clone(records.get(key)); },
        updateMany: (keys: string[], updater: (values: any[]) => unknown) => api.updateMany(keys, updater, store)
    };
    const packs = load("src/equicordplugins/moreStickers/stickers.ts", { "@api/DataStore": DataStore });
    const migration = load("src/equicordplugins/moreStickers/migrate-v1.ts", {
        "@api/index": { DataStore }, "./stickers": packs,
        "@webpack/common": { Toasts: { show() {}, genId: () => "fixture", Type: {} } }
    });
    return { records, failure, store, DataStore, packs, migration };
}

function pack(id: string, stickerId = `${id}:sticker`): any {
    const sticker = { id: stickerId, stickerPackId: id, image: "https://example.invalid/sticker.png", title: "fixture" };
    return { id, title: id, logo: sticker, stickers: [sticker], futurePackField: { retained: true } };
}

test("DataStore updateMany waits for commit, retains concurrent updates, and reads keys in order", async () => {
    const f = fixture();
    f.records.set("count", 0);
    let settled = false;
    const first = f.DataStore.updateMany(["missing", "count"], ([missing, count]) => {
        assert.equal(missing, undefined);
        return { set: [["count", count + 1]] };
    }).then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    await Promise.all([first, ...Array.from({ length: 10 }, () => f.DataStore.updateMany(["count"], ([count]) => ({ set: [["count", count + 1]] })))]);
    assert.equal(f.records.get("count"), 11);
    await f.DataStore.updateMany([], () => ({ delete: ["count"], set: [["replacement", 12]] }));
    assert.equal(f.records.has("count"), false);
    assert.equal(f.records.get("replacement"), 12);
});

test("DataStore updateMany rolls back on request, write, updater and commit failures", async () => {
    for (const kind of ["read", "write", "updater", "commit", "async", "invalid"] as const) {
        const f = fixture();
        f.records.set("original", { retained: true });
        const before = clone(f.records);
        f.failure.read = kind === "read";
        f.failure.write = kind === "write" ? 2 : 0;
        f.failure.commit = kind === "commit";
        await assert.rejects(f.DataStore.updateMany(["original"], () => {
            if (kind === "updater") throw new Error("updater failed");
            if (kind === "async") return Promise.reject(new Error("async updater forbidden"));
            if (kind === "invalid") return { set: [["first", 1], ["invalid"]] };
            return { set: [["first", 1], ["second", 2]], delete: ["original"] };
        }));
        await nextTurn();
        assert.deepEqual(f.records, before, kind);
    }
});

test("pack imports validate every record before writing and preserve unknown existing metadata", async () => {
    const f = fixture();
    await f.packs.saveStickerPack(pack("one"));
    f.records.get("MoreStickers:Packs")[0].futureMeta = "keep";
    const before = clone(f.records);
    await assert.rejects(f.packs.saveStickerPacks([pack("two"), { id: "invalid" }]));
    assert.deepEqual(f.records, before);
    const updated = pack("one");
    delete updated.futurePackField;
    await Promise.all([f.packs.saveStickerPacks([updated, pack("two")]), f.packs.saveStickerPack(pack("three"))]);
    assert.equal(f.records.get("one").futurePackField.retained, true);
    assert.equal(f.records.get("MoreStickers:Packs")[0].futureMeta, "keep");
    assert.deepEqual(f.records.get("MoreStickers:Packs").map((meta: any) => meta.id), ["one", "two", "three"]);
});

test("failed pack imports and removals leave packs, metadata and recents together", async () => {
    const f = fixture();
    await f.packs.saveStickerPack(pack("one"));
    f.records.set("MoreStickers:RecentStickers", [pack("one").logo]);
    const before = clone(f.records);
    f.failure.write = 2;
    await assert.rejects(f.packs.saveStickerPacks([pack("two"), pack("three")]));
    assert.deepEqual(f.records, before);
    await assert.rejects(f.packs.deleteStickerPack("one"));
    assert.deepEqual(f.records, before);
    f.failure.write = 0;
    await f.packs.deleteStickerPack("one");
    assert.equal(f.records.has("one"), false);
    assert.equal(f.records.get("MoreStickers:Packs").length, 0);
    assert.equal(f.records.get("MoreStickers:RecentStickers").length, 0);
});

test("migration preserves legacy originals, current packs, unknown fields, and canonical emoji references", async () => {
    const f = fixture();
    const old = pack("Vencord-MoreStickers-Line-Emoji-Pack-42", "Vencord-MoreStickers-Line-Emoji-42-7");
    const current = pack("MoreStickers:Line:Emoji-Pack:42", "current-sticker");
    current.currentOnly = true;
    f.records.set(old.id, clone(old));
    f.records.set("Vencord-MoreStickers-Packs", [{ ...f.packs.stickerPackToMeta(old), futureMeta: true }]);
    f.records.set("Vencord-MoreStickers-RecentStickers", [old.logo]);
    await f.packs.saveStickerPack(current);
    await f.migration.migrate();
    assert.deepEqual(f.records.get(old.id), old);
    const migrated = f.records.get(current.id);
    assert.equal(migrated.currentOnly, true);
    assert.deepEqual(migrated.stickers.map((sticker: any) => sticker.id), ["current-sticker", "MoreStickers:Line-Emoji:42:7"]);
    assert.equal(migrated.stickers[1].stickerPackId, current.id);
    assert.equal(f.records.get("MoreStickers:Packs")[0].futureMeta, true);
    assert.equal(f.records.get("MoreStickers:RecentStickers")[0].stickerPackId, current.id);
    const beforeRepeat = clone(f.records);
    await f.migration.migrate();
    assert.deepEqual(f.records, beforeRepeat);
});

test("failed migration preserves every original record and rejects mismatched stored pack IDs", async () => {
    const f = fixture();
    const old = pack("Vencord-MoreStickers-Line-Pack-42", "Vencord-MoreStickers-Line-Sticker-42-7");
    f.records.set(old.id, clone(old));
    f.records.set("Vencord-MoreStickers-Packs", [clone(f.packs.stickerPackToMeta(old))]);
    const original = clone(f.records);
    f.failure.write = 2;
    await assert.rejects(f.migration.migrate());
    assert.deepEqual(f.records, original);
    f.failure.write = 0;
    f.records.get(old.id).id = "unrelated";
    const corrupt = clone(f.records);
    await assert.rejects(f.migration.migrate());
    assert.deepEqual(f.records, corrupt);
});

test("dynamic packs keep configured headers on their own endpoint and reject mismatched pack IDs", async () => {
    const requests: any[] = [];
    const module = load("src/equicordplugins/moreStickers/stickers.ts", { "@api/DataStore": {} }, {
        AbortSignal,
        fetch: async (...args: any[]) => { requests.push(args); return { ok: true, json: async () => pack("different") }; }
    });
    await assert.rejects(module.getDynamicStickerPack({ id: "expected", dynamic: { refreshUrl: "https://example.invalid/pack", authHeaders: { Authorization: "synthetic-token" } } }));
    assert.equal(requests[0][0], "https://example.invalid/pack");
    assert.equal(requests[0][1].headers.Authorization, "synthetic-token");
    assert.equal(requests[0][1].credentials, "omit");
    assert.equal(requests[0][1].redirect, "error");
});
