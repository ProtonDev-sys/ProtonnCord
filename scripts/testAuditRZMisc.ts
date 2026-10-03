/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
function definePluginSettings(defs: any) {
    return { defs, store: Object.fromEntries(Object.entries(defs).map(([key, value]: [string, any]) => [key, value.default ?? value.options?.find((option: any) => option.default)?.value])) };
}
function load(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}, expose = "") {
    return loadTestModule("src/equicordplugins/" + file, {
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {}, makeRange: () => [] },
        "@utils/constants": { EquicordDevs: {}, Devs: {} },
        "@api/Settings": { definePluginSettings },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/Logger": { Logger: class { error() {} } },
        ...mocks
    }, { React, URL, URLSearchParams, AbortSignal, console, File, Uint8Array, ...globals }, expose);
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}

test("RZ8-03/04: resolved role/everyone mentions and DM allowlist retain global restrictions", () => {
    let channel: any = { id: "12345678901234567", guild_id: "guild" };
    let resolved: any;
    let streamer = false;
    const notices: unknown[] = [];
    const api = load("toastNotifications/index.tsx", {
        "@components/Button": {},
        "@webpack": {
            findByPropsLazy: () => ({ isGuildOrCategoryOrChannelMuted: () => false, isChannelMuted: () => true }),
            findStoreLazy: () => ({ getAllSettings: () => ({ userGuildSettings: { guild: { message_notifications: 1 } } }) })
        },
        "@webpack/common": {
            ChannelStore: { getChannel: () => channel }, UserStore: { getCurrentUser: () => ({ id: "self" }) },
            MessageStore: { getMessage: () => resolved, getMessages: () => undefined },
            SelectedChannelStore: { getChannelId: () => "other" }, RelationshipStore: { isFriend: () => false },
            PresenceStore: { getStatus: () => "online" }, StreamerModeStore: { get enabled() { return streamer; } }
        },
        "./components/Notifications": { showNotification: (notice: unknown) => notices.push(notice), teardownNotifications() {} }
    });
    const plugin = api.default;
    const message = { id: "message", channel_id: channel.id, author: { id: "sender" }, content: "<@&role>", mentionRoles: ["role"] };
    for (const content of ["<@&role>", "@everyone", "@here"]) {
        resolved = { ...message, content, mentioned: true };
        plugin.flux.MESSAGE_CREATE({ message: { ...message, content } });
    }
    assert.equal(notices.length, 3);
    resolved = { ...message, mentioned: false };
    plugin.flux.MESSAGE_CREATE({ message });
    assert.equal(notices.length, 3);
    channel = { id: channel.id, isDM: () => true, isGroupDM: () => false };
    api.settings.store.directMessages = false;
    api.settings.store.groupMessages = false;
    api.settings.store.notifyFor = channel.id;
    plugin.start();
    plugin.flux.MESSAGE_CREATE({ message });
    assert.equal(notices.length, 4);
    channel.isDM = () => false;
    channel.isGroupDM = () => true;
    plugin.flux.MESSAGE_CREATE({ message });
    assert.equal(notices.length, 5);
    streamer = true;
    plugin.flux.MESSAGE_CREATE({ message });
    assert.equal(notices.length, 5);
    streamer = false;
    api.settings.store.notifyFor = "";
    plugin.start();
    plugin.flux.MESSAGE_CREATE({ message });
    assert.equal(notices.length, 5);
});

test("RZ8-09: remote-only avatars have no removal action; local overrides can be removed with retry", async () => {
    const userId = "12345678901234567";
    let fail = false;
    const writes: any[] = [];
    const api = load("userpfp/index.tsx", {
        "@api/DataStore": { get: async () => ({}), set: async (_key: string, value: unknown) => { if (fail) throw new Error("disk"); writes.push(value); } },
        ...Object.fromEntries(["@components/Button", "@components/Flex", "@components/Heart", "@components/Icons", "@components/margins", "@components/Notice", "@utils/discord", "./AvatarModal"].map(name => [name, {}])),
        "@webpack": { extractAndLoadChunksLazy: () => () => undefined }, "@webpack/common": {}
    }, { IS_DEV: false, fetch: async () => ({ ok: true, json: async () => ({ avatars: { [userId]: "https://example.invalid/remote.png" } }) }) });
    await api.default.start();
    const modal = load("userpfp/AvatarModal.tsx", {
        "@components/Heading": {}, "@components/margins": { Margins: {} }, ".": api,
        "@webpack/common": { React: { ...React, useRef: (current: unknown) => ({ current }), useEffect() {} },
            useState: (value: unknown) => [value, () => undefined], UserStore: { getUser: () => undefined }, Modal: "modal" }
    });
    const render = () => modal.SetAvatarModal({ userId, modalProps: { onClose() {} } });
    assert.equal(render().props.actions.length, 1);
    await api.saveAvatar(userId, "https://example.invalid/local.png");
    assert.equal(render().props.actions[0].text, "Remove Local Override");
    fail = true;
    await assert.rejects(api.saveAvatar(userId, null), /disk/);
    assert.equal(api.hasLocalAvatar(userId), true);
    fail = false;
    await render().props.actions[0].onClick();
    assert.equal(api.hasLocalAvatar(userId), false);
    assert.equal(api.data.avatars[userId], "https://example.invalid/remote.png");
    assert.equal(render().props.actions.length, 1);
    assert.deepEqual(Object.keys(writes.at(-1)), []);
});

test("RZ8-10: reverse concurrent unfurls merge latest embeds and abandon deleted messages", async () => {
    const requests: ReturnType<typeof deferred<any>>[] = [];
    const captured = { id: "message", channel_id: "channel", content: "https://example.invalid/a https://example.invalid/b", embeds: [] };
    let current: any = captured;
    const api = load("showMessageEmbeds/index.tsx", {
        "@api/ContextMenu": {}, "@components/Icons": {}, "@utils/misc": { parseUrl: () => true },
        "@api/MessageUpdater": { updateMessage: (_channel: string, _id: string, fields: object) => { current = { ...current, ...fields }; } },
        "@webpack": { findByCodeLazy: () => (_channel: string, _id: string, embed: unknown) => embed },
        "@webpack/common": { ChannelStore: { getChannel: () => ({ id: "channel" }) }, MessageStore: { getMessage: () => current },
            Constants: { Endpoints: {} }, RestAPI: { post: () => { const request = deferred<any>(); requests.push(request); return request.promise; } } }
    }, {}, "\nexport { unfurlEmbed };\n");
    const one = api.unfurlEmbed("https://example.invalid/a", captured);
    const two = api.unfurlEmbed("https://example.invalid/b", captured);
    requests[1].resolve({ body: { embeds: [{ url: "https://example.invalid/b" }] } });
    await two;
    requests[0].resolve({ body: { embeds: [{ url: "https://example.invalid/a" }] } });
    await one;
    assert.deepEqual(Array.from(current.embeds, (embed: any) => embed.url), ["https://example.invalid/a", "https://example.invalid/b"]);
    const three = api.unfurlEmbed("https://example.invalid/a", captured);
    requests[2].resolve({ body: { embeds: [{ url: "https://example.invalid/a" }] } });
    await three;
    assert.equal(current.embeds.length, 2);
    const four = api.unfurlEmbed("https://example.invalid/a", captured);
    current = undefined;
    requests[3].resolve({ body: { embeds: [{ url: "https://example.invalid/a" }] } });
    await four;
    assert.equal(current, undefined);
});

test("RZ8-13: legacy MP3/WAV choices save unchanged OGG bytes with an OGG filename", async () => {
    const settings = load("voiceChannelLog/settings.ts", {}).default;
    assert.deepEqual(Array.from(settings.defs.soundboardFileType.options, (option: any) => option.value), [".ogg"]);
    for (const desktop of [true, false]) {
        for (const suffix of [".ogg", ".mp3", ".wav"]) {
            const bytes = new TextEncoder().encode("OggSfixture");
            let saved: any;
            const api = load("voiceChannelLog/utils.ts", {
                "@api/AudioPlayer": {}, "@utils/web": { saveFile: (file: File) => { saved = file; } },
                "@webpack": { findByPropsLazy: () => ({}) }, "@webpack/common": {},
                "./settings": { __esModule: true, default: { store: { soundboardFileType: suffix } } }
            }, { IS_DISCORD_DESKTOP: desktop, fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }),
                DiscordNative: { fileManager: { saveWithDialog: async (data: Uint8Array, name: string) => { saved = { data, name }; } } } });
            await api.downloadSound("sound");
            assert.equal(saved.name, "sound.ogg");
            assert.deepEqual(desktop ? saved.data : new Uint8Array(await saved.arrayBuffer()), bytes);
            if (!desktop) assert.equal(saved.type, "audio/ogg");
        }
    }
});
