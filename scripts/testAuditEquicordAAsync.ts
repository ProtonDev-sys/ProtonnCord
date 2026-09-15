/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { normalizeStoredGuildIcon } from "../src/equicordplugins/clientsideGuildIcons/iconStorage";
import * as mcpPolicy from "../src/equicordplugins/discordMcp.desktop/policy";

function loadPlugin(path: string, helpers = "", mocks: Record<string, any> = {}, globals: Record<string, any> = {}) {
    const settings: any = { store: {} };
    const defaults = {
        "@api/Settings": {
            definePluginSettings: (options: any) => {
                settings.def = options;
                for (const [key, value] of Object.entries<any>(options)) {
                    settings.store[key] = value.default ?? value.options?.find((v: any) => v.default)?.value;
                }
                return settings;
            }
        },
        "@utils/types": { default: (plugin: any) => plugin, OptionType: {} },
        "@utils/constants": { EquicordDevs: {}, Devs: {} },
        "@utils/Logger": { Logger: class { error() { } } }
    };
    const output = transpileModule(readFileSync(`src/equicordplugins/${path}`, "utf8") + helpers, {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, esModuleInterop: false }
    }).outputText;
    const exports: any = {};
    runInNewContext(output, {
        exports, TextDecoder, Uint8Array, atob, setTimeout, clearTimeout,
        console: { error() { } },
        require: (id: string) => mocks[id] ?? defaults[id] ?? {},
        ...globals
    });
    return { ...exports, settings };
}

test("AtSomeone uses the send destination and leaves empty channels unchanged", () => {
    let preSend: any;
    const { default: plugin } = loadPlugin("atSomeone/index.ts", "", {
        "@api/MessageEvents": { addMessagePreSendListener: (fn: any) => { preSend = fn; } },
        "@webpack/common": {
            ChannelStore: { getChannel: (id: string) => ({
                guild: { guild_id: "g" }, empty: { guild_id: "empty" }, dm: { recipients: ["recipient"] }
            }[id]) },
            GuildMemberStore: { getMembers: (id: string) => id === "g" ? [{ userId: "member" }] : [] }
        }
    });
    plugin.start();
    for (const [channel, expected] of [["guild", "<@member>"], ["dm", "<@recipient>"], ["empty", "@someone"], ["missing", "@someone"]]) {
        const message = { content: "@someone" };
        preSend(channel, message);
        assert.equal(message.content, expected);
    }
});

test("Base64 returns Unicode text and rejects invalid UTF-8", () => {
    const { decodeBase64Strings } = loadPlugin("baseDecoder/index.tsx", "\nexport { decodeBase64Strings };\n");
    const text = "Hello, café 日本語 👋";
    assert.deepEqual(Array.from(decodeBase64Strings([Buffer.from(text).toString("base64"), "/w=="])), [text]);
});

function directory(entries: any[]) {
    return {
        name: "folder", isDirectory: true,
        createReader: () => {
            let read = false;
            return { readEntries: (resolve: any) => { resolve(read ? [] : entries); read = true; } };
        }
    };
}

test("AutoZipper propagates file errors and archive limits from directory callbacks", async () => {
    const { readDirectoryEntry } = loadPlugin("autoZipper/index.ts", "\nexport { readDirectoryEntry };\n");
    const oversized = { name: "large", isFile: true, file: (resolve: any) => resolve({ size: 101 * 1024 * 1024 }) };
    await assert.rejects(readDirectoryEntry(directory([oversized])), /too large/);
    const unreadable = { name: "broken", isFile: true, file: (_: any, reject: any) => reject(new Error("read failed")) };
    await assert.rejects(readDirectoryEntry(directory([directory([unreadable])])), /read failed/);
    const entry = { name: "__proto__", isFile: true, file: (resolve: any) => resolve({ size: 1, arrayBuffer: async () => new Uint8Array([42]).buffer }) };
    const files = await readDirectoryEntry(directory([entry]));
    assert.equal(files.__proto__[0], 42);
});

test("AutoZipper cancels delayed upload prompts on navigation and stop", () => {
    let selected = "original";
    const pending: Array<() => void> = [];
    const uploads: any[] = [];
    const { default: plugin, queueUpload } = loadPlugin("autoZipper/index.ts", "\nexport { queueUpload };\n", {
        "@webpack/common": {
            SelectedChannelStore: { getChannelId: () => selected },
            ChannelStore: { getChannel: (id: string) => ({ id }) },
            DraftType: { ChannelMessage: 0 },
            UploadHandler: { promptToUpload: (...args: any[]) => uploads.push(args) }
        }
    }, { document: { addEventListener() { }, removeEventListener() { } }, setTimeout: (fn: () => void) => pending.push(fn) });
    plugin.start();
    queueUpload([{}], "original", 0);
    selected = "different";
    pending.shift()!();
    assert.equal(uploads.length, 0);
    selected = "original";
    queueUpload([{}], "original", 0);
    plugin.stop();
    plugin.start();
    pending.shift()!();
    assert.equal(uploads.length, 0);
    queueUpload([{}], "original", 1);
    pending.shift()!();
    assert.equal(uploads[0][1].id, "original");
});

test("Animalese stop and restart use independent loads and discard queued messages", async () => {
    const requests: Array<() => void> = [];
    let created = 0;
    let played = 0;
    class AudioContext {
        sampleRate = 100;
        constructor() { created++; }
        close() { return Promise.resolve(); }
        decodeAudioData() { return Promise.resolve({ length: 1, getChannelData: () => new Float32Array([1]) }); }
        createBuffer(_: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
        createBufferSource() { return { playbackRate: {}, connect() { }, start() { played++; } }; }
        createGain() { return { gain: {}, connect() { } }; }
    }
    const { default: plugin, settings } = loadPlugin("animalese/index.ts", "", {
        "@webpack/common": { SelectedChannelStore: { getChannelId: () => "channel" }, UserStore: {} }
    }, {
        AudioContext,
        fetch: () => new Promise(resolve => requests.push(() => resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })))
    });
    const first = plugin.start();
    const staleMessage = plugin.flux.MESSAGE_CREATE({ type: "MESSAGE_CREATE", message: { content: "a", author: {} }, channelId: "channel" });
    plugin.stop();
    const second = plugin.start();
    assert.equal(requests.length, 60);
    requests.splice(0).forEach(resolve => resolve());
    await Promise.all([first, second, staleMessage]);
    assert.equal(created, 2);
    assert.equal(played, 0);
    settings.store.soundQuality = "low";
    const message = plugin.flux.MESSAGE_CREATE({ type: "MESSAGE_CREATE", message: { content: "a", author: {} }, channelId: "channel" });
    assert.equal(requests.length, 30);
    requests.splice(0).forEach(resolve => resolve());
    await message;
    assert.equal(played, 1);
});

test("Banner conversion rejects image and canvas failures without replacing the URL", async () => {
    const images: any[] = [];
    const { default: plugin } = loadPlugin("bannersEverywhere/index.tsx", "", {}, {
        Image: class { constructor() { images.push(this); } },
        document: { createElement: () => ({ getContext: () => ({ drawImage() { throw new Error("tainted canvas"); } }) }) }
    });
    const imageFailure = plugin.gifToPng("image");
    const rejectedImage = assert.rejects(imageFailure, /Failed to load banner/);
    images[0].onerror();
    await rejectedImage;
    const canvasFailure = plugin.gifToPng("canvas");
    const rejectedCanvas = assert.rejects(canvasFailure, /tainted canvas/);
    images[1].onload();
    await rejectedCanvas;
});

test("local guild icon writes preserve concurrent changes and cannot recreate stopped URLs", async () => {
    let saved: any = {};
    let nextWrite: Promise<void> | undefined;
    let objectUrls = 0;
    const { default: plugin, saveGuildIcon, data } = loadPlugin("clientsideGuildIcons/index.tsx", "\nexport { saveGuildIcon };\n", {
        "@api/DataStore": { get: async () => saved, set: async (_: any, value: any) => { await nextWrite; saved = value; } },
        "./iconStorage": { normalizeStoredGuildIcons: async (icons: any) => ({ icons, needsWrite: false }) },
        "@webpack/common": { GuildStore: { getGuild: () => undefined } }
    }, { URL: { createObjectURL: () => `blob:${++objectUrls}`, revokeObjectURL() { } } });
    await plugin.start();
    await Promise.all([saveGuildIcon({ id: "a" }, {}), saveGuildIcon({ id: "b" }, {})]);
    assert.deepEqual(Object.keys(saved).sort(), ["a", "b"]);
    let release!: () => void;
    nextWrite = new Promise(resolve => { release = resolve; });
    const pending = saveGuildIcon({ id: "c" }, {});
    await Promise.resolve();
    plugin.stop();
    release();
    await pending;
    assert.equal(Object.keys(data.icons).length, 0);
    assert.equal(objectUrls, 2);
    assert.equal(await normalizeStoredGuildIcon("data:image/png;base64,%%%"), null);
});

test("keyword filtering survives invalid expressions and clearing settings", () => {
    const { default: plugin, settings, containsBlockedKeywords } = loadPlugin("blockKeywords/index.tsx", "", {
        "@utils/css": { classNameFactory: () => (name: string) => name }
    });
    settings.store.blockedWords = "(,valid";
    settings.store.useRegex = true;
    plugin.start();
    assert.equal(containsBlockedKeywords({ content: "valid", embeds: [] }), true);
    settings.store.blockedWords = "";
    plugin.start();
    assert.equal(containsBlockedKeywords({ content: "valid", embeds: [] }), false);
});

test("clean channel names retain original editing names and invalidate on name or type changes", () => {
    const { default: plugin } = loadPlugin("cleanChannelName/index.ts", "", {
        "@webpack/common": { ChannelStore: {} }
    });
    const channel = { id: "channel", name: "HELLO|WORLD", type: 0 };
    plugin.cleanChannelName(channel);
    assert.equal(channel.name, "HELLO-WORLD");
    assert.equal(channel.name, "HELLO-WORLD");
    plugin.flux.CHANNEL_SETTINGS_INIT({ channelId: channel.id });
    assert.equal(channel.name, "HELLO|WORLD");
    channel.name = "NEW|NAME";
    plugin.flux.CHANNEL_SETTINGS_CLOSE();
    assert.equal(channel.name, "NEW-NAME");
    channel.type = 2;
    assert.equal(channel.name, "NEW NAME");
});

test("clip cancellation covers pending slot reservation and completed PUT stages", async () => {
    for (const stage of ["reserve", "put"]) {
        let release!: () => void;
        let reached!: () => void;
        const barrier = new Promise(resolve => { release = () => resolve(undefined); });
        const ready = new Promise<void>(resolve => { reached = resolve; });
        let puts = 0;
        let messages = 0;
        const { uploadClipFile, abortActiveClipUploads, getClipCreatedAt } = loadPlugin("clipUpload.desktop/upload.ts", "", {
            "@utils/misc": { isObject: (value: any) => value != null && typeof value === "object" },
            "@webpack/common": {
                Constants: { Endpoints: { MESSAGE_CREATE_ATTACHMENT_UPLOAD: () => "reserve", MESSAGES: () => "send" } },
                showToast() { }, Toasts: { Type: {} }, SnowflakeUtils: { fromTimestamp: () => "nonce" },
                RestAPI: { post: async ({ url }: any) => {
                    if (url === "send") { messages++; return { ok: true }; }
                    if (stage === "reserve") { reached(); await barrier; }
                    return { body: { attachments: [{ upload_url: "fixture", upload_filename: "fixture" }] } };
                } }
            }
        }, {
            VencordNative: { pluginHelpers: { ClipUpload: {} } }, AbortController, DOMException, File,
            fetch: async () => { puts++; reached(); await barrier; return { ok: true }; }
        });
        const pending = uploadClipFile(new File(["clip"], "clip.mp4", { type: "video/mp4" }), { fileName: "clip.mp4", channelId: "channel" });
        await ready;
        abortActiveClipUploads();
        release();
        assert.equal(await pending, false);
        assert.equal(messages, 0);
        assert.equal(puts, stage === "put" ? 1 : 0);
        assert.ok(!Number.isNaN(Date.parse(getClipCreatedAt({ createdAt: NaN }))));
    }
});

test("clip FFmpeg disposal cancels an in-flight load without overwriting its replacement", async () => {
    const loads: Array<() => void> = [];
    const instances: any[] = [];
    const { getFFmpeg, disposeFFmpeg } = loadPlugin("clipUpload.desktop/ffmpeg.ts", "\nexport { getFFmpeg };\n", {
        "@ffmpeg/ffmpeg": { FFmpeg: class { loaded = false; terminated = false; constructor() { instances.push(this); } terminate() { this.terminated = true; } } },
        "@utils/ffmpeg": { loadFFmpeg: (instance: any) => new Promise(resolve => loads.push(() => { instance.loaded = true; resolve(undefined); })) },
        "@utils/Logger": { Logger: class { info() { } } }
    });
    const old = getFFmpeg();
    const rejected = assert.rejects(old, /canceled/);
    disposeFFmpeg();
    const replacement = getFFmpeg();
    loads[0]();
    await rejected;
    loads[1]();
    assert.equal(await replacement, instances[1]);
    assert.equal(await getFFmpeg(), instances[1]);
    assert.equal(instances[0].terminated, true);
});

test("clip file reads enforce size before allocation and close handles on every path", async () => {
    let size = 501 * 1024 * 1024;
    let closed = 0;
    const { readClipFile } = loadPlugin("clipUpload.desktop/native.ts", "\nexport { readClipFile };\n", {
        "@main/utils/constants": { DATA_DIR: path.resolve("fixture") },
        "path": path,
        "fs/promises": { open: async () => ({
            stat: async () => ({ size, isFile: () => true }),
            read: async (data: Buffer, offset: number) => {
                if (offset === 0) { data.set([1, 2, 3]); return { bytesRead: 3 }; }
                return { bytesRead: 0 };
            },
            close: async () => { closed++; }
        }) }
    }, { Buffer });
    await assert.rejects(readClipFile("fixture"), /size/);
    assert.equal(closed, 1);
    size = 3;
    assert.deepEqual(Array.from(await readClipFile("fixture")), [1, 2, 3]);
    assert.equal(closed, 2);
});

test("cursor sprite disposal releases every listener, animation frame and body shake style", () => {
    for (const name of ["fathorse", "oneko"]) {
        const signals: AbortSignal[] = [];
        const frames = new Set<number>();
        let removed = false;
        const body = { style: { transform: "scale(1)", willChange: "opacity" }, appendChild() { } };
        const addEventListener = (_: string, _fn: any, options: any) => { signals.push(options?.signal); };
        const window = {
            addEventListener, innerWidth: 1024, innerHeight: 768,
            localStorage: { getItem: () => null },
            requestAnimationFrame: () => { const id = frames.size + 1; frames.add(id); return id; },
            cancelAnimationFrame: (id: number) => frames.delete(id)
        };
        const { default: create } = loadPlugin(`cursorBuddy/${name}.js`, "", {}, {
            AbortController, window,
            requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame,
            document: { body, addEventListener, getElementById: () => null, createElement: () => ({ style: {}, remove: () => { removed = true; } }) },
            Image: class { }
        });
        const dispose = create({ shake: true, image: "fixture" });
        assert.ok(signals.length > 0);
        dispose();
        assert.ok(signals.every(signal => signal?.aborted));
        assert.equal(frames.size, 0);
        assert.equal(removed, true);
        assert.equal(body.style.transform, "scale(1)");
        assert.equal(body.style.willChange, "opacity");
    }
});

test("Discord MCP cannot start polling or send a pending reply after stop", async () => {
    let releaseInit!: () => void;
    let releaseMessage!: (value: any) => void;
    let polls = 0;
    let sends = 0;
    const channelId = "123456789012345678";
    const messageId = "234567890123456789";
    const { default: plugin, executeTool } = loadPlugin("discordMcp.desktop/index.ts", "\nexport { executeTool };\n", {
        "./policy": mcpPolicy,
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ id: channelId }) },
            Constants: { Endpoints: { MESSAGES: () => "messages" } },
            RestAPI: {
                get: () => new Promise(resolve => { releaseMessage = resolve; }),
                post: () => { sends++; }
            }
        }
    }, {
        VencordNative: { pluginHelpers: { DiscordMCP: {
            initializeBridge: () => new Promise<void>(resolve => { releaseInit = resolve; }),
            takeRequests: () => { polls++; }
        } } }
    });
    const starting = plugin.start();
    plugin.stop();
    releaseInit();
    await starting;
    assert.equal(polls, 0);
    const reply = executeTool("send_message", { channel_id: channelId, content: "fixture", reply_to_message_id: messageId });
    const rejected = assert.rejects(reply, /stopped before sending/);
    plugin.stop();
    releaseMessage({ body: [{ id: messageId, channel_id: channelId }] });
    await rejected;
    assert.equal(sends, 0);
});

test("Discord MCP attachment fetches forbid redirects and apply a timeout", async () => {
    let request: any;
    const { fetchAttachmentData } = loadPlugin("discordMcp.desktop/native.ts", "\nexport { fetchAttachmentData };\n", {
        "./policy": mcpPolicy, path,
        "@main/utils/constants": { DATA_DIR: path.resolve("fixture") }
    }, {
        URL, Buffer, AbortSignal,
        fetch: async (_: any, options: any) => {
            request = options;
            return { ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
        }
    });
    await fetchAttachmentData("https://cdn.discordapp.com/attachments/fixture");
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
    await assert.rejects(fetchAttachmentData("https://example.com/attachment"), /untrusted/);
});

test("element highlighter escapes inspected text and recognizes recorded special keys", () => {
    const { escapeHtml, matchesKeybind, settings } = loadPlugin("elementHighlighter.dev/index.tsx", "\nexport { escapeHtml, matchesKeybind };\n", {
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@webpack": { findComponentByCodeLazy: () => null }
    });
    assert.equal(escapeHtml('a & b < c "quoted"'), "a &amp; b &lt; c &quot;quoted&quot;");
    settings.store.keybind = ["space"];
    assert.equal(matchesKeybind({ key: " ", code: "Space" }), true);
    settings.store.keybind = ["esc"];
    assert.equal(matchesKeybind({ key: "Escape", code: "Escape" }), true);
});

test("support plugin cards use manifest metadata and protect enabled dependants", () => {
    const definitionCatalog = new Proxy({}, { get() { throw new Error("A plugin definition was loaded"); } });
    const manifest = { Optional: { name: "Optional" }, Consumer: { name: "Consumer", dependencies: ["Optional"] } };
    const { ChatPluginCard } = loadPlugin("equicordHelper/pluginCards.tsx", "", {
        "~plugins": { default: definitionCatalog, PluginManifest: manifest, ExcludedPlugins: {} },
        "@api/Settings": { useSettings() { } },
        "@api/PluginManager": { isPluginEnabled: (name: string) => name === "Consumer", isPluginRequired: () => false },
        "@components/ErrorBoundary": { default: { wrap: (component: any) => component } },
        "@webpack/common": { useMemo: (fn: any) => fn(), Tooltip: "tooltip" },
        "@components/settings/tabs/plugins/PluginCard": { PluginCard: "card" }
    }, {
        URL,
        React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children: children[0] } }) }
    });
    const card = ChatPluginCard({ url: "https://equicord.org/plugins/optional", description: "" });
    assert.equal(card.type, "tooltip");
    const child = card.props.children({});
    assert.equal(child.props.plugin, manifest.Optional);
    assert.equal(child.props.disabled, true);
});

test("friend tag writes retry failures and normalize malformed stored collections", async () => {
    let attempts = 0;
    let stored = "{}";
    const { GetData, SetData, queryFriendTags, replaceTags } = loadPlugin("friendTags/index.tsx", "\nexport { GetData, SetData, queryFriendTags }; export function replaceTags(tags: UserTagData[]) { SavedData = tags; }\n", {
        "@api/index": { DataStore: {
            get: async () => stored,
            set: async (_: string, value: string) => { if (++attempts === 1) throw new Error("temporary failure"); stored = value; }
        } },
        "@webpack/common": {
            ChannelStore: { getDMUserIds: () => ["1"] }, RelationshipStore: { getFriendIDs: () => [] },
            UserStore: { getUser: () => ({ id: "1", username: "fixture" }) }
        }
    });
    await GetData();
    assert.equal(queryFriendTags("&test").length, 0);
    replaceTags([{ tagName: "test", userIds: ["1"] }]);
    await SetData();
    await SetData();
    assert.equal(attempts, 2);
    assert.equal(JSON.parse(stored)[0].tagName, "test");
    assert.equal(queryFriendTags("&TEST")[0].record.id, "1");
});

test("Ghosted keeps a stable hook sequence as messages arrive and derives state in one render", () => {
    let lastMessage: any;
    const calls: string[] = [];
    const settings = { store: { exemptedChannels: "", maxInactiveTimeMs: 0, showDmIcons: true }, use: () => ({ exemptedChannels: "", maxInactiveTimeMs: 0 }) };
    const { Boo } = loadPlugin("ghosted/Boo.tsx", "", {
        ".": { settings, cl: (name: string) => name },
        "@webpack": { findCssClassesLazy: () => ({}) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "self" }) }, MessageStore: { getMessages: () => ({ last: () => lastMessage }) },
            useStateFromStores: (_: any, read: any) => { calls.push("store"); return read(); },
            useState: (initial: any) => { calls.push("state"); return [typeof initial === "function" ? initial() : initial, () => { }]; },
            useEffect: () => calls.push("effect")
        }
    }, { React: { createElement: (type: any, props: any) => ({ type, props }) } });
    const channel = { id: "channel", isGroupDM: () => false };
    assert.equal(Boo({ channel }), null);
    const initial = calls.splice(0);
    lastMessage = { id: "message", author: { id: "friend" }, content: "hello?", timestamp: new Date() };
    assert.ok(Boo({ channel }));
    assert.deepEqual(calls, initial);
});
