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

const tick = () => new Promise(resolve => setImmediate(resolve));

test("pinned DM data clears on logout and prevents a channel appearing in multiple categories", async () => {
    let user: { id: string; } | undefined = { id: "first" };
    const categories = [{ id: "one", channels: ["channel"] }, { id: "two", channels: [] }];
    const mocks = {
        "@plugins/pinDms": { settings: { store: { userBasedCategoryList: { first: categories } } } },
        "@utils/react": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => user } }
    };
    const api = runInNewContext(source("src/plugins/pinDms/data.ts") + "\nexports;", {
        exports: {}, require: (name: string) => mocks[name]
    });
    await api.init();
    assert.equal(api.isPinned("channel"), true);
    api.addChannelToCategory("channel", "two");
    assert.deepEqual(categories[1].channels, []);
    user = undefined;
    await api.init();
    assert.equal(api.isPinned("channel"), false);
    assert.equal(api.currentUserCategories.length, 0);
    assert.equal(categories[0].channels.length, 1);
});

function source(path: string) {
    return transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
}

function loadKeepCurrentChannel() {
    const reads: { resolve(value: unknown): void; }[] = [];
    const writes: { value: unknown; resolve(): void; reject(error: Error): void; }[] = [];
    const transitions: string[] = [];
    const errors: unknown[] = [];
    const timers = new Set<Function>();
    const mocks: Record<string, object> = {
        "@api/DataStore": {
            get: () => new Promise(resolve => reads.push({ resolve })),
            set: (_key: string, value: unknown) => new Promise<void>((resolve, reject) => writes.push({ value, resolve, reject }))
        },
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack/common": {
            ChannelRouter: { transitionToChannel: (id: string) => transitions.push(id) },
            SelectedGuildStore: { getGuildId: () => "guild" }, SelectedChannelStore: { getChannelId: () => "selected" }
        }
    };
    const plugin = runInNewContext(source("src/plugins/keepCurrentChannel/index.ts") + "\nexports.default;", {
        exports: {}, require: (name: string) => mocks[name],
        setTimeout: (callback: Function) => { timers.add(callback); return callback; },
        clearTimeout: (callback: Function) => timers.delete(callback)
    });
    return { plugin, reads, writes, transitions, errors, timers };
}

test("KeepCurrentChannel cannot navigate from a read completed after stop or a newer selection", async () => {
    const first = loadKeepCurrentChannel();
    const stopped = first.plugin.start();
    await tick();
    await first.plugin.stop();
    first.reads[0].resolve({ guildId: "guild", channelId: "old" });
    await stopped;
    assert.deepEqual(first.transitions, []);

    const second = loadKeepCurrentChannel();
    const selected = second.plugin.start();
    await tick();
    second.plugin.flux.CHANNEL_SELECT({ guildId: "guild", channelId: "new" });
    second.reads[0].resolve({ guildId: "guild", channelId: "old" });
    await selected;
    assert.deepEqual(second.transitions, []);
});

test("KeepCurrentChannel serializes snapshots, handles failed persistence, and flushes stop", async () => {
    const { plugin, writes, errors, timers } = loadKeepCurrentChannel();
    plugin.flux.CHANNEL_SELECT({ guildId: "guild", channelId: "first" });
    plugin.flux.LOGOUT({ isSwitchingAccount: false });
    plugin.flux.CHANNEL_SELECT({ guildId: "guild", channelId: "second" });
    const stopped = plugin.stop();
    await tick();
    assert.equal(writes.length, 1);
    assert.equal((writes[0].value as { channelId: string; }).channelId, "first");
    writes[0].reject(new Error("Storage unavailable"));
    await tick();
    assert.equal((writes[1].value as { channelId: string; }).channelId, "second");
    writes[1].resolve();
    await stopped;
    assert.equal(errors.length, 1);
    assert.equal(timers.size, 0);
});

test("KeepCurrentChannel preserves invalid stored records without navigating or overwriting them", async () => {
    const { plugin, reads, writes, transitions, errors } = loadKeepCurrentChannel();
    const pending = plugin.start();
    await tick();
    reads[0].resolve({ channelId: 42, guildId: null });
    await pending;
    assert.deepEqual(transitions, []);
    assert.equal(writes.length, 0);
    assert.equal(errors.length, 1);
});

function loadMemberCountStore() {
    const queues: Function[][] = [];
    const preloads: { guildId: string; resolve(): void; }[] = [];
    let handlers: Record<string, Function> = {};
    const mocks: Record<string, object> = {
        "@utils/lazy": { proxyLazy: (factory: Function) => factory() },
        "@utils/misc": { sleep: async () => {} },
        "@utils/Queue": { Queue: class {
            tasks: Function[] = [];
            constructor() { queues.push(this.tasks); }
            push(task: Function) { this.tasks.push(task); }
        } },
        "@webpack/common": {
            Flux: { Store: class {
                constructor(_dispatcher: unknown, callbacks: Record<string, Function>) { handlers = callbacks; }
                emitChange() {}
            } },
            GuildChannelStore: { getDefaultChannel: (guildId: string) => ({ id: guildId + "-channel" }) },
            ChannelActionCreators: { preload: (guildId: string) => new Promise<void>(resolve => preloads.push({ guildId, resolve })) }
        }
    };
    const store = runInNewContext(source("src/plugins/memberCount/OnlineMemberCountStore.ts") + "\nexports.OnlineMemberCountStore;", {
        exports: {}, require: (name: string) => mocks[name]
    });
    return { store, queues, preloads, handlers };
}

test("MemberCount drops old queued preloads and does not clear a restarted request from an old completion", async () => {
    const { store, queues, preloads } = loadMemberCountStore();
    store.start();
    store.ensureCount("guild");
    store.ensureCount("queued");
    const active = queues[1][0]();
    store.stop();
    store.start();
    store.ensureCount("guild");
    const restartedQueue = queues.at(-1)!;
    const restarted = restartedQueue[0]();
    await queues[1][1]();
    assert.equal(preloads.length, 2);
    preloads[0].resolve();
    await active;
    store.ensureCount("guild");
    assert.equal(restartedQueue.length, 1);
    preloads[1].resolve();
    await restarted;
});

test("MemberCount clears account counts and stays inactive after plugin stop", () => {
    const { store, handlers, queues } = loadMemberCountStore();
    store.start();
    handlers.ONLINE_GUILD_MEMBER_COUNT_UPDATE({ guildId: "guild", count: 42 });
    assert.equal(store.getCount("guild"), 42);
    handlers.LOGOUT();
    assert.equal(store.getCount("guild"), undefined);
    store.ensureCount("guild");
    assert.equal(queues.at(-1)!.length, 0);
    handlers.CONNECTION_OPEN();
    store.ensureCount("guild");
    assert.equal(queues.at(-1)!.length, 1);
    store.stop();
    handlers.CONNECTION_OPEN();
    handlers.ONLINE_GUILD_MEMBER_COUNT_UPDATE({ guildId: "guild", count: 99 });
    store.ensureCount("guild");
    assert.equal(store.getCount("guild"), undefined);
    assert.equal(queues.at(-1)!.length, 0);
});
