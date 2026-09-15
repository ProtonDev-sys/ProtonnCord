/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture() {
    let account = "first";
    let groupId = "one";
    const reads: ((value: unknown) => void)[] = [];
    const users: ((value: unknown) => void)[] = [];
    const writes: { key: string; value: any; }[] = [];
    const notifications: unknown[] = [];
    const modules: Record<string, any> = {
        "@api/DataStore": {
            delMany: async () => {},
            getMany: () => new Promise(resolve => reads.push(resolve)),
            set: async (key: string, value: unknown) => { writes.push({ key, value }); }
        },
        "@api/Notices": {},
        "@api/Notifications": { showNotification: (value: unknown) => notifications.push(value) },
        "@utils/discord": { getUniqueUsername: () => "Fixture User" },
        "@utils/Logger": { Logger: class { error() {} } },
        "@vencord/discord-types/enums": { ChannelType: { GROUP_DM: 3 }, RelationshipType: { FRIEND: 1, INCOMING_REQUEST: 3 } },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: account }) },
            UserUtils: { getUser: () => new Promise(resolve => users.push(resolve)) },
            GuildStore: { getGuilds: () => ({}) },
            GuildMemberStore: { isMember: () => true },
            ChannelStore: { getSortedPrivateChannels: () => [{ id: groupId, type: 3, name: groupId, rawRecipients: [] }] },
            RelationshipStore: { getMutableRelationships: () => new Map(), getRelationshipType: () => 0 },
            GuildAvailabilityStore: { isUnavailable: () => false }
        },
        "./settings": { __esModule: true, default: { store: { offlineRemovals: true, friends: true, friendRequestCancels: true, groups: true, servers: true } } }
    };
    const load = (path: string) => {
        const code = transpileModule(readFileSync(path, "utf8"), {
            fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
        }).outputText;
        return runInNewContext(code + "\nexports;", { exports: {}, Map, require: (name: string) => modules[name] });
    };
    const utils = load("src/plugins/relationshipNotifier/utils.ts");
    modules["./utils"] = utils;
    const events = load("src/plugins/relationshipNotifier/functions.ts");
    utils.resetState(true);
    return { utils, events, reads, users, writes, notifications, modules,
        setAccount: (value: string) => account = value, setGroup: (value: string) => groupId = value };
}

test("relationship startup ignores storage results completed after stop or account changes", async () => {
    for (const stop of [false, true]) {
        const api = fixture();
        const pending = api.utils.syncAndRunChecks();
        await setImmediate();
        assert.equal(api.reads.length, 1);
        if (stop) api.utils.resetState(false);
        else api.setAccount("second");
        api.reads[0]([new Map(), new Map(), { friends: ["removed"], requests: [] }]);
        await pending;
        assert.equal(api.writes.length, 0);
        assert.equal(api.notifications.length, 0);
        assert.equal(api.users.length, 0);
    }
});

test("relationship event lookups cannot notify a stopped session", async () => {
    const api = fixture();
    const pending = api.events.onRelationshipRemove({ relationship: { type: 1, id: "removed" } });
    await setImmediate();
    api.utils.resetState(false);
    api.users[0]({ getAvatarURL: () => "fixture" });
    await pending;
    assert.equal(api.notifications.length, 0);
});

test("relationship persistence snapshots cannot be mutated by a later sync and failures are contained", async () => {
    const api = fixture();
    await api.utils.syncGroups();
    const first = api.writes[0].value;
    api.setGroup("two");
    await api.utils.syncGroups();
    assert.deepEqual([...first.keys()], ["one"]);
    assert.deepEqual([...api.writes[1].value.keys()], ["two"]);
    api.modules["@api/DataStore"].set = () => Promise.reject(new Error("Store unavailable"));
    await api.utils.syncGroups();
    api.modules["@api/DataStore"].getMany = () => { throw new Error("Read unavailable"); };
    await api.utils.syncAndRunChecks();
});
