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
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function load(file: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}, expose = "") {
    const imports: Record<string, unknown> = {
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {}, GUILD_IDS: {} },
        "@api/Settings": { migratePluginSettings() {}, definePluginSettings(def: any) { return { store: Object.fromEntries(Object.entries(def).map(([key, value]: [string, any]) => [key, value.default])) }; } },
        "@utils/css": { classNameFactory: () => () => "" },
        ...mocks
    };
    const code = transpileModule(readFileSync(file, "utf8") + expose, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, Promise, console, URL, File, Blob, crypto, queueMicrotask,
        require(name: string) { if (name.endsWith(".css")) return {}; assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; },
        ...globals
    });
}

function timerFixture() {
    const timers = new Map<number, () => void>();
    let id = 0;
    return { timers, setTimeout(callback: () => void) { timers.set(++id, callback); return id; }, clearTimeout(key: number) { timers.delete(key); } };
}

test("MessagePeek cancels pending startup delays and checks account again before queued fetches", async () => {
    const timers = timerFixture();
    let account = "self";
    const fetched: string[] = [];
    const plugin = load("src/equicordplugins/messagePeek/index.tsx", {
        "@api/PluginManager": {}, "@components/Icons": {}, "@equicordplugins/betterActivities": {}, "@plugins/showMeYourName": {}, "@utils/misc": {},
        "@vencord/discord-types/enums": { MessageFlags: {} },
        "@webpack": {
            findCssClassesLazy: () => ({}), findByCodeLazy: () => () => false, findComponentByCodeLazy: () => () => null,
            findByPropsLazy: () => ({ fetchMessages: ({ channelId }: any) => fetched.push(channelId) })
        },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: account }) }, ChannelStore: { getSortedPrivateChannels: () => Array.from({ length: 10 }, (_, id) => ({ id: String(id) })) }, MessageStore: { getLastMessage: () => null } }
    }, timers).default;
    const start = plugin.start();
    await nextTurn();
    assert.equal(fetched.length, 5);
    assert.equal(timers.timers.size, 1);
    plugin.stop();
    await start;
    assert.equal(timers.timers.size, 0);
    assert.equal(fetched.length, 5);
    const restart = plugin.start();
    account = "other";
    await restart;
    assert.equal(fetched.length, 5);
});

function microphone(deferred = false) {
    let account = "self";
    let deafened = false;
    let finish!: () => void;
    const calls: boolean[] = [];
    let toggles = 0;
    const module = load("src/equicordplugins/micLoopbackTester/index.tsx", {
        "@api/UserArea": {},
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) }, VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice" }) },
            MediaEngineStore: { isSelfDeaf: () => deafened }, showToast() {}, Toasts: { Type: {} },
            VoiceActions: {
                setLoopback: (_name: string, enabled: boolean) => { calls.push(enabled); if (enabled && deferred) return new Promise<void>(resolve => { finish = resolve; }); },
                toggleSelfDeaf: () => { toggles++; deafened = !deafened; }
            }
        }
    }, {}, "\nexports.toggle = toggleLoopback;\n");
    return { ...module, calls, finish: () => finish(), setAccount: (id: string) => { account = id; }, toggles: () => toggles, deafened: () => deafened };
}

test("microphone stop undoes a late enable without changing deafening and deduplicates toggles", async () => {
    const f = microphone(true);
    f.default.start();
    const toggle = f.toggle();
    await Promise.resolve();
    await f.toggle();
    const stopped = f.default.stop();
    f.finish();
    await Promise.all([toggle, stopped]);
    assert.deepEqual(f.calls, [true, false]);
    assert.equal(f.toggles(), 0);
});

test("microphone restores only the deafening change owned by the same account", async () => {
    for (const changedAccount of [false, true]) {
        const f = microphone();
        f.default.start();
        await f.toggle();
        assert.equal(f.deafened(), true);
        if (changedAccount) f.setAccount("other");
        await f.default.stop();
        assert.equal(f.toggles(), changedAccount ? 1 : 2);
    }
});

function commands() {
    const timers = timerFixture();
    const sent: any[] = [];
    let upload: any;
    const utils = load("src/equicordplugins/moreCommands/utils.ts", { "@webpack/common": { DraftType: {}, UploadAttachmentStore: { getUpload: () => upload } } });
    const plugin = load("src/equicordplugins/moreCommands/index.ts", {
        "./utils": utils, "gifenc": {}, "@utils/discord": {},
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {}, findOption: (opts: any[], name: string, fallback: unknown) => opts.find(option => option.name === name)?.value ?? fallback, sendBotMessage: (...args: any[]) => sent.push(args) },
        "@api/MessageEvents": { removeMessagePreSendListener() {}, removeMessagePreEditListener() {} },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) }, SelectedChannelStore: { getChannelId: () => "channel" } }
    }, timers).default;
    return { plugin, utils, timers, sent, setUpload: (value: any) => { upload = value; }, command: (name: string) => plugin.commands.find((command: any) => command.name === name) };
}

test("MoreCommands cancels countdown work and preserves existing render props", async () => {
    const f = commands();
    const original = Object.freeze({ children: "hello", other: 7 });
    const changed = f.plugin.uwuifyProps(original);
    assert.equal(original.children, "hello");
    assert.notEqual(changed, original);
    assert.equal(changed.other, 7);
    const pending = f.command("countdown").execute([{ name: "number", value: 3 }], { channel: { id: "channel" } });
    assert.equal(f.sent.length, 1);
    f.plugin.stop();
    await pending;
    assert.equal(f.sent.length, 1);
    assert.equal(f.timers.timers.size, 0);
});

test("MoreCommands bounds repeat allocation, reverses code points and retains newer uploads", async () => {
    const f = commands();
    const transform = f.command("transform");
    assert.equal(transform.execute([{ name: "text", value: "A😀" }, { name: "reverse", value: true }]).content, "😀A");
    assert.throws(() => transform.execute([{ name: "text", value: "ab" }, { name: "repeat", value: 1_000_000 }]));
    f.command("wordcount").execute([{ name: "message", value: "  " }], { channel: { id: "channel" } });
    assert.match(f.sent[0][1].content, /0 words/);
    let removed = 0;
    const upload = { isImage: true, item: { file: new File(["image"], "fixture.png") }, removeFromMsgDraft: () => { removed++; } };
    f.setUpload(upload);
    const result = await f.utils.resolveImage([{ name: "image" }], { channel: { id: "channel" } });
    assert.equal(removed, 0);
    f.setUpload({ ...upload });
    result.clearInput();
    assert.equal(removed, 0);
    f.setUpload(upload);
    result.clearInput();
    assert.equal(removed, 1);
});

function stickers() {
    let account = "self";
    let draft = "";
    let cancelled = false;
    const sent: any[] = [];
    const checks: any[] = [];
    const inserted: string[] = [];
    const dispatched: any[] = [];
    const reply = { messageId: "reply" };
    const module = load("src/equicordplugins/moreStickers/upload.ts", {
        ".": { settings: { store: { promptToUpload: false } } },
        "./utils": { corsFetch: async () => ({ ok: true, blob: async () => new Blob(["image"]), arrayBuffer: async () => new ArrayBuffer(1) }) },
        "@api/MessageEvents": { _handlePreSend: async (...args: any[]) => { checks.push(args); return cancelled; } },
        "@utils/discord": { insertTextIntoChatInputBox: (text: string) => inserted.push(text) },
        "@vencord/discord-types/enums": { CloudUploadPlatform: {} },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) }, SelectedChannelStore: { getChannelId: () => "channel" },
            DraftStore: { getDraft: () => draft }, ChannelStore: { getChannel: () => ({ id: "channel" }) },
            PendingReplyStore: { getPendingReply: () => reply }, FluxDispatcher: { dispatch: (event: unknown) => dispatched.push(event) },
            MessageActions: { getSendMessageOptionsForReply: () => ({ messageReference: reply }), sendMessage: async (...args: any[]) => sent.push(args) },
            CloudUploader: class { constructor(public item: any) {} upload() { throw new Error("Upload must not bypass pre-send checks"); } },
            UploadHandler: { promptToUpload: async (...args: any[]) => sent.push(["prompt", ...args]) }
        }
    }, {
        Image: class { width = 10; height = 10; onload?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()); } },
        document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: (cb: (blob: Blob) => void) => cb(new Blob(["png"], { type: "image/png" })) }) }
    });
    module.startStickerUploads();
    const sticker = { id: "sticker", image: "https://example.invalid/sticker.jpg", title: "fixture", stickerPackId: "pack" };
    return { ...module, sent, checks, inserted, dispatched, setCancelled: (value: boolean) => { cancelled = value; }, setAccount: (id: string) => { account = id; }, setDraft: (value: string) => { draft = value; }, send: (options: any = {}) => module.sendSticker({ channelId: "channel", sticker, ctrlKey: false, shiftKey: false, ...options }) };
}

test("stickers run pre-send checks before upload, preserve cancelled replies and use actual PNG metadata", async () => {
    const f = stickers();
    f.setCancelled(true);
    assert.equal(await f.send(), false);
    assert.equal(f.sent.length, 0);
    assert.equal(f.dispatched.length, 0);
    const file = f.checks[0][2].attachmentsToUpload[0].item.file;
    assert.equal(file.name, "sticker.png");
    assert.equal(file.type, "image/png");
    f.setCancelled(false);
    assert.equal(await f.send(), true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.dispatched.length, 1);
});

test("sticker insertion keeps draft and reply ownership, and stop cancels pending pre-send continuation", async () => {
    const f = stickers();
    f.setDraft("existing text");
    assert.equal(await f.send({ shiftKey: true, ctrlKey: true }), true);
    assert.deepEqual(f.inserted, [" https://example.invalid/sticker.jpg"]);
    assert.equal(f.dispatched.length, 0);
    const pending = f.send({ shiftKey: true });
    f.stopStickerUploads();
    assert.equal(await pending, false);
    assert.equal(f.sent.length, 0);
});

test("sticker conversion cleans both temporary files on failure and stop terminates owned workers", async () => {
    const f = stickers();
    const deleted: string[] = [];
    let terminated = 0;
    const worker = { writeFile: async () => {}, exec: async () => 1, deleteFile: async (name: string) => { deleted.push(name); }, terminate: () => { terminated++; } };
    f.registerStickerWorker(worker);
    await assert.rejects(f.send({ sticker: { image: "https://example.invalid/fixture", isAnimated: true }, ffmpegState: { ffmpeg: worker, isLoaded: true } }));
    assert.equal(deleted.length, 2);
    assert.notEqual(deleted[0], deleted[1]);
    assert.equal(f.sent.length, 0);
    f.stopStickerUploads();
    assert.equal(terminated, 1);
    assert.equal(f.isStickerWorkerCurrent(worker), false);
});
