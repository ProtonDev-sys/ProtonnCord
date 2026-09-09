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

import * as commandTypes from "../packages/discord-types/enums/commands";

const code = transpileModule(readFileSync("src/api/Commands/index.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText;

function fixture() {
    const botMessages: object[] = [];
    const mocks: Record<string, object> = {
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/text": { makeCodeblock: (value: string) => value },
        "./types": commandTypes,
        "./commandHelpers": { sendBotMessage(_channel: string, message: object) { botMessages.push(message); } }
    };
    const api = runInNewContext(code + "\nexports;", {
        exports: {}, console: { warn() {}, error() {} },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const builtIns = [
        { name: "shrug", displayName: "shrug", id: "-1", options: [{}] },
        { name: "me", displayName: "me", id: "-2", options: [{}] }
    ];
    api._init(builtIns);
    return { api, builtIns, botMessages };
}

const command = (name: string) => ({ name, description: name, execute() {} });
const group = (name: string) => ({ ...command(name), options: [{ name: "first", description: "first", type: 1 }] });

test("command groups reject a duplicate parent and preserve the original owner", () => {
    const { api } = fixture();
    const original = group("group");
    api.registerCommand(original, "first-owner");
    assert.throws(() => api.registerCommand(group("group"), "second-owner"), /already exists/);
    assert.equal(api.commands.group, original);
    assert.equal(api.commands["group first"].rootCommand, original);
    assert.equal(api.unregisterCommand("group"), true);
    assert.equal(Object.keys(api.commands).length, 0);
});

test("direct command registration rolls back a partial group while preserving a colliding child", () => {
    const { api, builtIns } = fixture();
    const owner = command("group last");
    api.registerCommand(owner, "owner");
    const before = [...builtIns];
    const partial = { ...group("group"), options: [...group("group").options, { name: "last", description: "last", type: 1 }] };
    assert.throws(() => api.registerCommand(partial, "failed"), /already exists/);
    assert.deepEqual(builtIns, before);
    assert.deepEqual(Object.keys(api.commands), ["group last"]);
    assert.equal(api.commands["group last"], owner);
});

test("command cleanup cannot remove host commands and prototype names are ordinary registry keys", () => {
    const { api, builtIns } = fixture();
    assert.equal(api.unregisterCommand("shrug"), false);
    assert.equal(api.unregisterCommand("constructor"), false);
    for (const name of ["constructor", "__proto__"]) {
        const own = command(name);
        api.registerCommand(own, "fixture");
        assert.equal(api.commands[name], own);
        assert.equal(api.unregisterCommand(name), true);
        assert.equal(api.unregisterCommand(name), false);
    }
    assert.equal(builtIns.length, 2);
});

test("command dispatch observes cross-realm promises and thenable failures", async () => {
    const { api, botMessages } = fixture();
    for (const execute of [
        () => Promise.reject(new Error("cross realm")),
        () => ({ then(_resolve: unknown, reject: (error: Error) => void) { reject(new Error("thenable")); } })
    ]) {
        await api._handleCommand({ ...command("fixture"), isVencordCommand: true, execute }, [], { channel: { id: "local-only" } });
    }
    assert.equal(botMessages.length, 2);
});
