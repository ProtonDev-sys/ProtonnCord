/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import JSONParser from "@streamparser/json/jsonparser.js";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const requireBuiltin = createRequire(import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
const directory = "src/equicordplugins/messageLoggerEnhanced/";

function load(file: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}, expose = "") {
    let source = readFileSync(directory + file, "utf8");
    // CommonJS transpilation needs this declaration after imports to reproduce ESM import initialization.
    if (file === "index.tsx") source = source.replace("export const Native = getNative();", "") + "\nexport const Native = getNative();\n";
    const code = transpileModule(source + expose, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, esModuleInterop: true }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, Promise, Buffer, structuredClone, setTimeout, clearTimeout, console: { error() {} },
        require(name: string) {
            if (Object.hasOwn(mocks, name)) return mocks[name];
            if (name.startsWith("node:")) return requireBuiltin(name);
            assert.fail(`Unexpected import: ${name}`);
        },
        ...globals
    });
}

function event(id = 1) {
    const sender = Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
    return { sender, senderFrame: { url: "https://discord.com/channels/@me", processId: id, routingId: 10 } };
}

function sessions() {
    return load("native/logSessions.ts", {
        "./attachmentDownload": { isTrustedDiscordRendererEvent: (request: any) => request?.senderFrame?.url.startsWith("https://discord.com/") }
    });
}

function settings(root: string, files = fs) {
    return load("native/settings.ts", {
        "node:fs/promises": files,
        ".": { getDefaultNativeDataDir: async () => root, getDefaultNativeImageDir: async () => path.join(root, "images"), getDefaultAttachmentFileExtensions: async () => "png" },
        "./attachmentDownload": { parseAllowedAttachmentExtensions: (value: string) => value.split(","), attachmentSizeLimitMegabytesOrDefault: (value: unknown) => typeof value === "number" ? value : 12 },
        "./utils": { ensureDirectoryExists: (target: string) => fs.mkdir(target, { recursive: true }) }
    });
}

test("MessageLogger native settings preserve unknown data and concurrent updates, including failed-write recovery", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "pc-audit-log-settings-"));
    try {
        const file = path.join(root, "mlSettings.json");
        await fs.writeFile(file, JSON.stringify({ logsDir: root, future: { keep: [1, 2] }, attachmentFileExtensions: "png" }));
        let fail = false;
        const api = settings(root, { ...fs, writeFile: (async (...args: any[]) => {
            if (fail) throw new Error("disk full");
            return (fs.writeFile as any)(...args);
        }) as typeof fs.writeFile });
        const initial = await api.getSettings();
        initial.future.keep.length = 0;
        await Promise.all([api.updateSettings({ attachmentSizeLimitInMegabytes: 5 }), api.updateSettings({ imageCacheDir: "new-dir" })]);
        assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).future, { keep: [1, 2] });
        assert.equal((await api.getSettings()).attachmentSizeLimitInMegabytes, 5);
        fail = true;
        await assert.rejects(api.updateSettings({ logsDir: "failed" }), /disk full/);
        assert.equal((await api.getSettings()).logsDir, root);
        fail = false;
        await api.updateSettings({ logsDir: "retry" });
        assert.equal((await api.getSettings()).logsDir, "retry");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("MessageLogger native settings never replace corrupt, non-object or oversized existing files", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "pc-audit-log-corrupt-"));
    try {
        const file = path.join(root, "mlSettings.json");
        const api = settings(root);
        for (const contents of ["{bad", "null", "[]", " ".repeat(65_537)]) {
            await fs.writeFile(file, contents);
            await assert.rejects(api.getSettings());
            await assert.rejects(api.updateSettings({ logsDir: "replacement" }));
            assert.equal(await fs.readFile(file, "utf8"), contents);
        }
        await fs.writeFile(file, "{}");
        assert.equal((await api.getSettings()).logsDir, root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("Native log sessions bind handles to a renderer, bound pending dialogs and dispose on owner close", async () => {
    const disposed: string[] = [];
    const store = new (sessions().LogSessionStore)((value: string) => { disposed.push(value); });
    const owner = event();
    const releases = Array.from({ length: 8 }, () => store.reserve(owner));
    assert.throws(() => store.reserve(owner), /Too many/);
    for (const release of releases) { release(); release(); }
    store.add(owner, "handle", "resource");
    assert.throws(() => store.get(event(2), "handle"), /another renderer/);
    assert.equal(store.get(owner, "handle"), "resource");
    owner.sender.emit("destroyed");
    await tick();
    assert.deepEqual(disposed, ["resource"]);
    assert.equal(owner.sender.listenerCount("destroyed"), 0);
    assert.equal(store.get(owner, "handle"), undefined);
});

test("Native log imports preserve Unicode split across byte chunks and close files after EOF", async () => {
    const content = Buffer.from("A😀雪éZ");
    let offset = 0;
    let closed = 0;
    const api = load("native/import.ts", {
        electron: { dialog: { showOpenDialog: async () => ({ filePaths: ["fixture"] }) } }, "./logSessions": sessions(),
        "node:fs/promises": { open: async () => ({ stat: async () => ({ isFile: () => true }), close: async () => { closed++; }, read: async (buffer: Buffer, start: number, size: number) => {
            const bytesRead = Math.min(size, content.length - offset);
            content.copy(buffer, start, offset, offset + bytesRead);
            offset += bytesRead;
            return { bytesRead };
        } }) }
    });
    const owner = event();
    const id = await api.startNativeLogImport(owner);
    await assert.rejects(api.readNativeLogChunk(owner, id, -1), /chunk size/);
    await assert.rejects(api.readNativeLogChunk(owner, id, 1_048_577), /chunk size/);
    await assert.rejects(api.readNativeLogChunk(event(2), id, 2), /another renderer/);
    let result = "";
    for (;;) {
        const chunk = await api.readNativeLogChunk(owner, id, 2);
        if (chunk === null) break;
        result += chunk;
    }
    assert.equal(result, content.toString());
    assert.equal(closed, 1);
    await api.closeNativeLogImport(owner, id);
    assert.equal(closed, 1);
});

test("Native log export errors reject instead of waiting forever for drain or reporting success", async () => {
    let writeDone!: (error?: Error) => void;
    const stream = Object.assign(new EventEmitter(), { write: (_chunk: string, done: typeof writeDone) => { writeDone = done; return false; }, destroy() {}, end(done: () => void) { done(); } });
    const api = load("native/export.ts", {
        electron: { dialog: { showSaveDialog: async () => ({ filePath: "fixture" }) } }, "./logSessions": sessions(),
        "node:fs": { createWriteStream: () => stream }
    });
    const owner = event();
    const id = await api.startNativeLogExport(owner, "logs.json");
    await assert.rejects(api.writeNativeLogChunk(event(2), id, "text"), /another renderer/);
    await assert.rejects(api.writeNativeLogChunk(owner, id, "x".repeat(1_048_577)), /chunk size/);
    const write = api.writeNativeLogChunk(owner, id, "text");
    await assert.rejects(api.writeNativeLogChunk(owner, id, "concurrent"), /in progress/);
    const error = new Error("disk failure");
    stream.emit("error", error);
    writeDone(error);
    await assert.rejects(write, /disk failure/);
    await assert.rejects(api.finishNativeLogExport(owner, id), /disk failure/);
    assert.equal(owner.sender.listenerCount("destroyed"), 0);
});

function logUtilities(native: Record<string, unknown>, db: Record<string, unknown>) {
    return load("utils/settingsUtils.ts", {
        "@streamparser/json/jsonparser.js": { __esModule: true, default: JSONParser }, "@utils/web": {}, "@webpack/common": { Toasts: { show() {}, genId: randomUUID, Type: {} } },
        "native-file-system-adapter": {}, "..": { Native: native }, "../db": db
    }, { IS_WEB: false }, "\nexport { writeNativeChunk };\n");
}

test("Log imports keep existing records and do not clear them when a later JSON chunk is malformed", async () => {
    const records = new Map<string, unknown>([["existing", { untouched: true }]]);
    let closed = 0;
    const newMessage = { id: "new", channel_id: "channel", timestamp: "2026-09-08", future: { keep: true } };
    const chunks: Array<string | null> = [JSON.stringify({ messages: [{ message: newMessage }, { message: { ...newMessage, id: "existing" } }] }), null];
    const api = logUtilities({ getSettingsNative: async () => ({}), startNativeLogImport: async () => "file", readNativeLogChunk: async () => chunks.shift() ?? null, closeNativeLogImport: async () => { closed++; } }, {
        hasMessageIDB: async (id: string) => records.has(id),
        addMessagesBulkIDB: async (messages: any[]) => { for (const message of messages) records.set(message.id, message); }
    });
    await api.importLogs();
    assert.deepEqual(records.get("existing"), { untouched: true });
    assert.deepEqual(records.get("new"), newMessage);
    chunks.push('{"messages":[{"message":', null);
    await api.importLogs();
    assert.equal(records.size, 2);
    assert.equal(closed, 2);
});

test("Log exports split large text without breaking surrogate pairs and finalize failed streams", async () => {
    const chunks: string[] = [];
    let finished = 0;
    const api = logUtilities({ writeNativeLogChunk: async (_id: string, chunk: string) => { chunks.push(Buffer.from(chunk).toString()); }, startNativeLogExport: async () => "file", finishNativeLogExport: async () => { finished++; } }, {
        async *iterateAllMessagesIDB() { throw new Error("database read failed"); }
    });
    const content = "x".repeat(65_535) + "😀" + "雪".repeat(70_000);
    await api.writeNativeChunk("file", content);
    assert.equal(chunks.join(""), content);
    assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 1_048_576));
    await api.exportLogs();
    assert.equal(finished, 1);
});

test("Message cleanup excludes transient React state before serialization and leaves shared user data untouched", () => {
    const api = load("utils/cleanUp.ts", { "@webpack/common": { MessageStore: {} }, "./index": { getGuildIdByChannel: () => undefined, isGhostPinged: () => false } });
    const privateRender: any = {};
    privateRender.cycle = privateRender;
    const author = Object.freeze({ id: "self", phone: "private-phone", email: "private-email" });
    const message = { id: "message", channel_id: "channel", author, customRenderedContent: privateRender, content: "ciphertext", embeds: [] };
    for (const source of [message, { toJS: () => message }]) {
        const cleaned = api.cleanupMessage(source);
        assert.equal(cleaned.customRenderedContent, undefined);
        assert.equal(cleaned.author.phone, undefined);
        assert.equal(cleaned.author.email, undefined);
        assert.equal(cleaned.content, "ciphertext");
    }
    assert.equal(author.phone, "private-phone");
    assert.equal(author.email, "private-email");
});

test("Stopping MessageLoggerEnhanced clears runtime data and prevents delayed startup work from returning", async () => {
    let finish!: (limit: number) => void;
    let nativeInit = 0;
    let menuSetups = 0;
    let clearedClasses = 0;
    let clearedUrls = 0;
    const original = () => "ordinary-message";
    const MessageStore = { getMessage: original };
    const cachedMessages = new Map([["message", { id: "message", channel_id: "private-channel", deleted: true }]]);
    const api = load("index.tsx", {
        "@components/Icons": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/Logger": { Logger: class { error() {} } }, "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack": { findByPropsLazy: () => ({}) }, "@webpack/common": { MessageStore }, "./styles.css": {},
        "./components/LogsButton": {}, "./components/LogsModal": {}, "./db": { cachedMessages }, "./LoggedMessageManager": {},
        "./settings": { settings: { store: { attachmentSizeLimitInMegabytes: 12 } } },
        "./utils": {
            getNative: () => ({ updateAttachmentSizeLimit: () => new Promise(resolve => { finish = resolve; }), init: async () => { nativeInit++; } }),
            messageJsonToMessageClass: Object.assign(() => "logged-message", { clear: () => { clearedClasses++; } })
        },
        "./utils/constants": { MAX_ATTACHMENT_SIZE_LIMIT_MEGABYTES: 50, DEFAULT_ATTACHMENT_SIZE_LIMIT_MEGABYTES: 12 },
        "./utils/contextMenu": { setupContextMenuPatches: () => { menuSetups++; }, removeContextMenuBindings() {} },
        "./utils/index": {}, "./utils/LimitedMap": { LimitedMap: Map }, "./utils/parseQuery": {},
        "./utils/saveImage": { clearAttachmentBlobUrlCache: () => { clearedUrls++; } }, "./utils/saveImage/ImageManager": {}
    });
    const starting = api.default.start();
    assert.equal((MessageStore.getMessage as any)("other-channel", "message"), "ordinary-message");
    assert.equal((MessageStore.getMessage as any)("private-channel", "message"), "logged-message");
    api.cacheSentMessages.set("cached", "private-data");
    const installed = MessageStore.getMessage;
    const laterWrapper = () => installed();
    MessageStore.getMessage = laterWrapper;
    api.default.stop();
    assert.equal(MessageStore.getMessage, laterWrapper);
    assert.equal(cachedMessages.size, 0);
    assert.equal(api.cacheSentMessages.size, 0);
    assert.equal(clearedClasses, 1);
    assert.equal(clearedUrls, 1);
    finish(12);
    await starting;
    assert.equal(nativeInit, 0);
    assert.equal(menuSetups, 0);
    assert.equal(MessageStore.getMessage(), "ordinary-message");
});
