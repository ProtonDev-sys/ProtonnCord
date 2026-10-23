import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { canaryJoinGuild, stableJoinGuild } from "./fixtures/discordJoinGuild";
import { applyPatch, pluginPatches } from "./utils/discordClientFixture";

function fixture(source: string, request: Promise<unknown>, quarantined = false) {
    const events: any[] = [];
    const patches = pluginPatches("src/plugins/newGuildSettings/index.tsx");
    const patched = applyPatch(source, patches.find((patch: any) => patch.find === "{joinGuild:"));
    const load = (id: number) => { assert.equal(id, 608401); return { default: async (props: any) => events.push(["navigate", props]) }; };
    const render = runInNewContext(`(${patched})`, {
        plugin: { applyDefaultSettings: async (guild: string) => events.push(["settings", guild]) },
        y: { default: { getCurrentUser: () => ({ hasFlag: () => quarantined }) } },
        P: { nhx: { QUARANTINED: "quarantined" }, Rsh: { GUILD_JOIN: (guild: string) => `/guilds/${guild}` },
            Q4z: { DIRECTORY_ENTRY: "directory" }, t02: Object.fromEntries(["USER_GUILD_JOIN_LARGE_GUILD_UNDERAGE_DISALLOWED", "TOO_MANY_USER_GUILDS", "GUILD_AT_CAPACITY", "UNKNOWN_GUILD", "USER_GUILD_JOIN_AGE_RESTRICTED_IOS_DISALLOWED"].map(value => [value, value])) },
        p: { default: () => events.push(["quarantined"]) }, s: { h: { wait: (fn: Function) => fn(), dispatch: (event: unknown) => events.push(["dispatch", event]) } },
        L: { A: { getGuildId: () => "guild" } }, O: { A: { getGuild: () => undefined } }, R: { Ay: { getChannelId: () => "channel" } },
        a: { Bo: { put: (args: unknown) => { events.push(["request", args]); return request; } }, fT: () => "reject" },
        S: { default: { getSessionId: () => "session" } }, _: { q: (guild: string) => events.push(["verification", guild]) }, n: load
    });
    return { join: render, events };
}

for (const [channel, source] of [["Stable", stableJoinGuild], ["Canary", canaryJoinGuild]]) {
    test(`${channel} guild defaults wait for successful native joining and preserve its response and navigation`, async () => {
        const pending = Promise.withResolvers<unknown>();
        const f = fixture(source, pending.promise);
        const task = f.join("guild", { source: "directory", loadId: "load" });
        assert.equal(f.events.some(([type]) => type === "settings"), false, "an initial GUILD_JOIN dispatch does not mean joining succeeded");
        const response = { body: { id: "guild", welcome_screen: { description: "Welcome" }, approximate_presence_count: 7 } };
        pending.resolve(response);
        assert.equal(await task, response);
        assert.deepEqual(f.events.filter(([type]) => type === "settings"), [["settings", "guild"]]);
        assert.ok(f.events.findIndex(([type]) => type === "navigate") < f.events.findIndex(([type]) => type === "settings"));
        assert.ok(f.events.some(([type, event]) => type === "dispatch" && event.type === "WELCOME_SCREEN_UPDATE"));
        assert.ok(f.events.some(([type, event]) => type === "dispatch" && event.type === "ONLINE_GUILD_MEMBER_COUNT_UPDATE"));
        const manual = fixture(source, Promise.resolve(response));
        await manual.join("guild", { autoNavigate: false });
        assert.equal(manual.events.some(([type]) => type === "navigate"), false);
        assert.deepEqual(manual.events.filter(([type]) => type === "settings"), [["settings", "guild"]]);
    });

    test(`${channel} failed, lurking, pending approval, verification and quarantined joins never apply guild defaults`, async () => {
        const pending = Promise.withResolvers<unknown>();
        const failed = fixture(source, pending.promise);
        const error = new Error("Join failed");
        const task = failed.join("guild");
        pending.reject(error);
        await assert.rejects(task, (actual: unknown) => actual === error);
        assert.equal(failed.events.some(([type]) => type === "settings"), false);
        for (const [body, options, event] of [
            [{}, { lurker: true }, undefined],
            [{ join_request: { status: "PENDING" } }, {}, "USER_GUILD_JOIN_REQUEST_UPDATE"],
            [{ show_verification_form: true }, {}, "verification"],
        ] as const) {
            const response = { body };
            const f = fixture(source, Promise.resolve(response));
            assert.equal(await f.join("guild", options), response);
            assert.equal(f.events.some(([type]) => type === "settings"), false);
            if (event) assert.ok(f.events.some(([type, data]) => type === event || (type === "dispatch" && data.type === event)));
        }
        const quarantine = fixture(source, Promise.resolve({ body: {} }), true);
        await assert.rejects(quarantine.join("guild"));
        assert.deepEqual(quarantine.events, [["quarantined"]]);
    });
}
