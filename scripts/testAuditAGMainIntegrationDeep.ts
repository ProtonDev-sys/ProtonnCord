import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const flush = () => new Promise(resolve => setImmediate(resolve));

function load(path: string, mocks: Record<string, unknown>) {
    return loadTestModule(path, {}, {
        structuredClone, console, require(name: string) {
            assert.ok(name in mocks, `Unexpected import ${name}`);
            return mocks[name];
        }
    }, "", { mockImports: false });
}

function bookmarkHarness(initial: Record<string, any>, failLoad = false) {
    const slots: any[] = [];
    let hookIndex = 0;
    let effects: (() => void)[] = [];
    let stored = structuredClone(initial);
    let failedWrite = false;
    let reads = 0;
    const writes: any[] = [];
    const holds: (() => void)[] = [];
    let holdWrites = false;
    const common: any = {
        useState(initialValue: unknown) {
            const index = hookIndex++;
            slots[index] ??= { value: initialValue };
            return [slots[index].value, (value: any) => {
                slots[index].value = typeof value === "function" ? value(slots[index].value) : value;
            }];
        },
        useMemo(factory: () => unknown, deps: unknown[]) {
            const index = hookIndex++;
            if (!slots[index] || deps.some((value, position) => !Object.is(value, slots[index].deps[position]))) {
                slots[index] = { value: factory(), deps };
            }
            return slots[index].value;
        },
        useEffect(factory: () => unknown, deps: unknown[]) {
            const index = hookIndex++;
            if (!slots[index] || deps.some((value, position) => !Object.is(value, slots[index].deps[position]))) {
                const previous = slots[index];
                const effect: any = { deps };
                slots[index] = effect;
                effects.push(() => { previous?.cleanup?.(); effect.cleanup = factory(); });
            }
        },
        useCallback: (callback: unknown) => callback,
        ChannelStore: { getChannel: () => undefined }, UserStore: {}
    };
    common.React = common;
    const reactUtils = load("src/utils/react.tsx", {
        "@webpack/common": common, "./lazyReact": {}, "./misc": {},
        "./Logger": { Logger: class { error() {} } }
    });
    const api = load("src/equicordplugins/channelTabs/util/bookmarks.ts", {
        "@webpack/common": common, "@utils/react": reactUtils, "./types": {},
        "./constants": { logger: { error() {} }, bookmarkFolderColors: { Black: "black" } },
        "@api/index": { DataStore: {
            get() { reads++; return failLoad && reads === 1 ? Promise.reject(new Error("offline load failure")) : Promise.resolve(structuredClone(stored)); },
            update(_key: string, update: (previous: unknown) => any) {
                const snapshot = update(stored);
                writes.push(snapshot);
                if (failedWrite) return Promise.reject(new Error("offline write failure"));
                if (holdWrites) return new Promise<void>(resolve => holds.push(() => { stored = snapshot; resolve(); }));
                stored = snapshot;
                return Promise.resolve();
            }
        } }
    });
    return {
        render(user = "user") {
            hookIndex = 0;
            const result = api.useBookmarks(user);
            const pending = effects;
            effects = [];
            pending.forEach(effect => effect());
            return result;
        },
        dispose() { slots.forEach(slot => slot?.cleanup?.()); },
        writes, holds,
        setFailedWrite(value: boolean) { failedWrite = value; },
        setHoldWrites(value: boolean) { holdWrites = value; },
        stored: () => stored
    };
}

test("bookmark load failures stay read-only and retry restores existing and unknown saved fields", async () => {
    const fixture = bookmarkHarness({ user: [{ channelId: "existing", guildId: "guild", name: "Existing", unknown: "preserved" }], sibling: ["untouched"] }, true);
    fixture.render();
    await flush();
    const [bookmarks, methods, state] = fixture.render();
    assert.equal(bookmarks, undefined);
    assert.equal(state.loadError, true);
    methods.addBookmark({ channelId: "discard", guildId: "guild" });
    assert.equal(fixture.writes.length, 0);
    state.retryLoad();
    fixture.render();
    await flush();
    const [loaded, loadedMethods] = fixture.render();
    assert.equal(loaded[0].unknown, "preserved");
    loadedMethods.addBookmark({ channelId: "new", guildId: "guild" });
    await flush();
    assert.deepEqual(fixture.stored().sibling, ["untouched"]);
    fixture.dispose();
});

test("failed bookmark saves retain the current snapshot and expose a working retry", async () => {
    const fixture = bookmarkHarness({ user: [] });
    fixture.render();
    await flush();
    fixture.setFailedWrite(true);
    fixture.render()[1].addBookmark({ channelId: "retained", guildId: "guild" });
    await flush();
    const [bookmarks, , state] = fixture.render();
    assert.equal(bookmarks[0].channelId, "retained");
    assert.equal(state.saveError, true);
    assert.deepEqual(fixture.stored().user, []);
    fixture.setFailedWrite(false);
    state.retrySave();
    await flush();
    assert.equal(fixture.stored().user[0].channelId, "retained");
    assert.equal(fixture.render()[2].saveError, false);
    fixture.dispose();
});

test("bookmark writes serialize immutable snapshots and disposal prevents stale edits", async () => {
    const fixture = bookmarkHarness({ user: [] });
    fixture.render();
    await flush();
    fixture.setHoldWrites(true);
    fixture.render()[1].addBookmark({ channelId: "first", guildId: "guild" });
    const methods = fixture.render()[1];
    methods.addBookmark({ channelId: "second", guildId: "guild" });
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0].user.length, 1);
    fixture.holds.shift()!();
    await flush();
    assert.equal(fixture.writes.length, 2);
    assert.equal(fixture.writes[1].user.length, 2);
    fixture.holds.shift()!();
    await flush();
    fixture.dispose();
    methods.addBookmark({ channelId: "obsolete", guildId: "guild" });
    assert.equal(fixture.writes.length, 2);
});

test("role visibility scans members once per invalidation and cleans up subscriptions", () => {
    const listeners = new Set<() => void>();
    let scans = 0;
    let blocked = true;
    const storeEvents = {
        addChangeListener: (listener: () => void) => listeners.add(listener),
        removeChangeListener: (listener: () => void) => listeners.delete(listener)
    };
    const plugin = load("src/equicordplugins/clientSideBlock/index.tsx", {
        "@api/Settings": { definePluginSettings: (options: any) => ({ store: Object.fromEntries(Object.entries(options).map(([name, option]: any) => [name, option.default])) }) },
        "@components/Paragraph": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": {
            React: {}, ChannelStore: {},
            GuildRoleStore: { getRole: () => ({}) },
            GuildMemberStore: { ...storeEvents, getMembers() { scans++; return [{ userId: "blocked", roles: ["first", "second"] }]; } },
            UserStore: { ...storeEvents, getUser: () => ({}) },
            RelationshipStore: { ...storeEvents, isBlocked: () => blocked }
        }
    }).default;
    plugin.start();
    assert.equal(plugin.isRoleAllBlockedMembers("first", "guild"), true);
    assert.equal(plugin.isRoleAllBlockedMembers("second", "guild"), true);
    assert.equal(scans, 1);
    blocked = false;
    listeners.forEach(listener => listener());
    assert.equal(plugin.isRoleAllBlockedMembers("first", "guild"), false);
    assert.equal(scans, 2);
    plugin.stop();
    assert.equal(listeners.size, 0);
});
