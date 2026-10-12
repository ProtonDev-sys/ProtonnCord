/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

function loadPermissions() {
    const source = readFileSync("src/main/patcher.ts", "utf8");
    const start = source.indexOf("function isDiscordOrigin(");
    const end = source.indexOf("if (!IS_VANILLA)");
    assert.ok(start >= 0 && end > start);
    const code = transformSync(`${source.slice(start, end)}\nmodule.exports = { isDiscordMediaPermission, installDiscordMediaPermissionBypass };`, { loader: "ts" }).code;
    let check: any;
    let request: any;
    const session = {
        setPermissionCheckHandler(handler: any) { check = handler; },
        setPermissionRequestHandler(handler: any) { request = handler; },
    };
    const module = { exports: {} as any };
    runInNewContext(code, { module, electron: { session: { defaultSession: session } } });
    return { ...module.exports, session, get check() { return check; }, get request() { return request; } };
}

const discord = { getURL: () => "https://discord.com/channels/@me" };

test("foreign media requesters cannot borrow their Discord embedding origin", () => {
    const { isDiscordMediaPermission } = loadPermissions();
    for (const permission of ["media", "microphone", "camera", "audioCapture", "videoCapture"]) {
        assert.equal(isDiscordMediaPermission(discord, permission, {
            embeddingOrigin: "https://discord.com", securityOrigin: "https://attacker.invalid", isMainFrame: false,
        }, "https://discord.com"), false);
    }
});

test("opaque origins take precedence over a Discord document URL", () => {
    const { isDiscordMediaPermission } = loadPermissions();
    assert.equal(isDiscordMediaPermission(discord, "media", {
        securityOrigin: "null", requestingUrl: "https://discord.com/opaque", isMainFrame: true,
    }), false);
    assert.equal(isDiscordMediaPermission(discord, "media", {
        securityOrigin: "https://attacker.invalid", requestingUrl: "https://discord.com/", isMainFrame: true,
    }), false);
});

test("missing requester identity never falls back to an embedding page", () => {
    const { isDiscordMediaPermission } = loadPermissions();
    for (const details of [undefined, {}, { embeddingOrigin: "https://discord.com" }, { isMainFrame: false }]) {
        assert.equal(isDiscordMediaPermission(discord, "media", details), false);
    }
    assert.equal(isDiscordMediaPermission(discord, "media", { isMainFrame: true }), true);
});

test("actual Discord requester identity retains camera and microphone behavior", () => {
    const { isDiscordMediaPermission } = loadPermissions();
    for (const origin of ["https://discord.com", "https://ptb.discord.com", "https://canary.discordapp.com"]) {
        assert.equal(isDiscordMediaPermission(null, "media", { securityOrigin: origin, mediaTypes: ["audio"] }), true);
        assert.equal(isDiscordMediaPermission(discord, "media", { requestingUrl: `${origin}/channels/@me`, mediaTypes: ["video"] }), true);
        assert.equal(isDiscordMediaPermission(null, "camera", undefined, origin), true);
    }
    for (const origin of ["http://discord.com", "https://discord.com.attacker.invalid", "https://discord.com:444", "null", ""]) {
        assert.equal(isDiscordMediaPermission(discord, "media", { securityOrigin: origin }), false);
    }
    assert.equal(isDiscordMediaPermission(discord, "notifications", { securityOrigin: "https://discord.com" }), false);
    assert.equal(isDiscordMediaPermission(discord, "media", { securityOrigin: "https://discord.com", mediaTypes: ["other"] }), false);
});

test("permission wrappers preserve the host handler for rejected bypasses", () => {
    const fixture = loadPermissions();
    fixture.installDiscordMediaPermissionBypass();
    let checks = 0;
    let requests = 0;
    fixture.session.setPermissionCheckHandler(() => { checks++; return false; });
    fixture.session.setPermissionRequestHandler((_contents: unknown, _permission: string, callback: (allowed: boolean) => void) => { requests++; callback(false); });
    const hostile = { embeddingOrigin: "https://discord.com", securityOrigin: "https://attacker.invalid", isMainFrame: false };
    assert.equal(fixture.check(discord, "media", "https://discord.com", hostile), false);
    fixture.request(discord, "media", (allowed: boolean) => assert.equal(allowed, false), hostile);
    assert.equal(checks, 1);
    assert.equal(requests, 1);
    assert.equal(fixture.check(discord, "media", "https://discord.com", { securityOrigin: "https://discord.com" }), true);
    fixture.request(discord, "media", (allowed: boolean) => assert.equal(allowed, true), { requestingUrl: "https://discord.com/channels/@me" });
    assert.equal(checks, 1);
    assert.equal(requests, 1);
});
