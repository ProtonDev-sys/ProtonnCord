import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

function loadMention() {
    let accountId: string | undefined = "current-account";
    let users: Record<string, { id: string; }> = { first: { id: "first" } };
    let reads = 0;
    const listeners = new Set<() => void>();
    const dmUsers = new Set<string>();
    const settings = { globalMention: true, onlyDMUsers: false };
    const plugin = loadTestModule("src/equicordplugins/universalMention/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: settings }) },
        "@components/Notice": { Notice: {} },
        "@utils/constants": { EquicordDevs: { justjxke: {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: { BOOLEAN: 1 } },
        "@webpack/common": {
            UserStore: {
                getCurrentUser: () => accountId ? { id: accountId } : undefined,
                getUsers: () => { reads++; return users; },
                addChangeListener: (listener: () => void) => listeners.add(listener),
                removeChangeListener: (listener: () => void) => listeners.delete(listener)
            },
            ChannelStore: { getDMFromUserId: (userId: string) => dmUsers.has(userId) }
        }
    }, {}).default;
    return {
        plugin, listeners, dmUsers, settings,
        switchAccount(id: string | undefined) { accountId = id; },
        get reads() { return reads; },
        addUser(id: string) { users[id] = { id }; for (const listener of listeners) listener(); },
        replaceUsers(id: string) { users = { [id]: { id } }; for (const listener of listeners) listener(); }
    };
}

test("UniversalMention invalidates changed users without rebuilding unchanged queries", () => {
    const fixture = loadMention();
    fixture.plugin.start?.();
    assert.equal(fixture.plugin.useFilter().map(user => user.id).join(","), "first");
    fixture.plugin.useFilter();
    assert.equal(fixture.reads, 1);
    fixture.addUser("second");
    assert.equal(fixture.plugin.useFilter().map(user => user.id).join(","), "first,second");
    assert.equal(fixture.reads, 2);
    fixture.replaceUsers("another-account");
    assert.equal(fixture.plugin.useFilter().map(user => user.id).join(","), "another-account");
});

test("UniversalMention isolates cached users across account changes and logout", () => {
    const fixture = loadMention();
    fixture.plugin.start?.();
    fixture.plugin.useFilter();
    fixture.switchAccount("next-account");
    fixture.plugin.useFilter();
    assert.equal(fixture.reads, 2);
    fixture.switchAccount(undefined);
    assert.equal(fixture.plugin.useFilter().length, 0);
    assert.equal(fixture.reads, 2);
    fixture.plugin.stop?.();
    assert.equal(fixture.listeners.size, 0);
});

test("UniversalMention clears cache on stop and preserves dynamic DM filtering", () => {
    const fixture = loadMention();
    fixture.plugin.start?.();
    fixture.plugin.useFilter();
    fixture.settings.onlyDMUsers = true;
    assert.equal(fixture.plugin.useFilter().length, 0);
    fixture.dmUsers.add("first");
    assert.equal(fixture.plugin.useFilter(true)[0].userId, "first");
    assert.equal(fixture.reads, 1);
    fixture.plugin.stop?.();
    assert.equal(fixture.listeners.size, 0);
    fixture.replaceUsers("restarted-account");
    fixture.settings.onlyDMUsers = false;
    fixture.plugin.start?.();
    assert.equal(fixture.plugin.useFilter().map(user => user.id).join(","), "restarted-account");
    assert.equal(fixture.listeners.size, 1);
    fixture.plugin.stop?.();
    assert.equal(fixture.listeners.size, 0);
});
