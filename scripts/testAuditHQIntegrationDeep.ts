import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const element = (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...props as object, children } });

function descendants(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(descendants);
    if (!node || typeof node !== "object") return [];
    return [node, ...descendants(node.props?.children)];
}

test("remembered users shared across collections render once in search", () => {
    const first = { id: "shared", tag: "friend", username: "friend" };
    const latest = { ...first, tag: "friend updated" };
    const fixture = load("iRememberYou/components/ui.tsx", {
        "@webpack/common": { React: { createElement: element, useState: () => ["friend", () => {}] } }
    }, "\nexports.SearchElement = SearchElement;");
    const rendered = fixture.SearchElement({ usersCollection: {
        first: { users: { shared: first } }, second: { users: { shared: latest } }
    } });
    const rows = descendants(rendered).filter(node => node.props?.user);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].props.key, "shared");
});

test("keyword entry identity remains stable after a preceding entry is deleted", () => {
    const entries = [{ regex: "first", whitelist: [], blacklist: [] }, { regex: "second", whitelist: [], blacklist: [] }];
    const fixture = load("keywordNotify/components/KeywordEntries.tsx", {
        "..": { keywordEntries: entries, cl: () => "", persistKeywordEntries: async () => {} },
        "@utils/react": { useForceUpdater: () => () => {} },
        "@components/margins": { Margins: {} }, "@utils/misc": { classes: () => "" }
    });
    const before = descendants(fixture.KeywordEntries()).filter(node => node.props?.title?.startsWith?.("Keyword Entry"));
    entries.splice(0, 1);
    const after = descendants(fixture.KeywordEntries()).filter(node => node.props?.title?.startsWith?.("Keyword Entry"));
    assert.notEqual(before[0].props.key, before[1].props.key);
    assert.equal(after[0].props.key, before[1].props.key);
    assert.equal(after[0].props.title, "Keyword Entry 1");
});

test("failed jump requests do not notify a replacement account", async () => {
    let account = "original";
    let reject!: (error: Error) => void;
    const toasts: any[] = [];
    const fixture = load("jumpTo/index.tsx", { "@webpack/common": {
        UserStore: { getCurrentUser: () => ({ id: account }) },
        Constants: { Endpoints: { MESSAGES: () => "messages" } },
        RestAPI: { get: () => new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }) },
        Toasts: { show: (toast: any) => toasts.push(toast), Type: { FAILURE: "failure" }, genId: () => "toast" }
    } }, "\nexports.jumpToLastMessage = jumpToLastMessage;");
    const request = fixture.jumpToLastMessage("channel");
    account = "replacement";
    reject(new Error("Offline fixture failure"));
    await request;
    assert.deepEqual(toasts, []);
    account = "original";
    const current = fixture.jumpToLastMessage("channel");
    reject(new Error("Offline fixture failure"));
    await current;
    assert.equal(toasts.length, 1);
});

test("logger delete-and-replace contains failures and never retries or crosses accounts", async () => {
    for (const scenario of ["delete-reject", "send-reject", "send-false", "stale-before", "stale-after", "success"]) {
        let account = "original";
        let deletions = 0;
        let sends = 0;
        const toasts: string[] = [];
        const fixture = load("messageLoggerEnhanced/utils/contextMenu.tsx", {
            ".": { hasListId: () => false },
            "../index": { settings: { store: { hideMessageFromMessageLoggers: true, hideMessageFromMessageLoggersDeletedMessage: "deleted" } } },
            "@webpack/common": {
                React: { createElement: element }, Menu: { MenuItem: "item", MenuSeparator: "separator" },
                UserStore: { getCurrentUser: () => ({ id: account }) },
                Toasts: { Type: { FAILURE: "failure" }, genId: () => "toast", show: (toast: any) => toasts.push(toast.message) },
                MessageActions: {
                    deleteMessage: async () => {
                        deletions++;
                        if (scenario === "delete-reject") throw new Error("Offline delete failure");
                        if (scenario === "stale-after") account = "replacement";
                    },
                    _sendMessage: async () => {
                        sends++;
                        if (scenario === "send-reject") throw new Error("Offline send failure");
                        return { ok: scenario !== "send-false" };
                    }
                }
            }
        });
        const children: any[] = [];
        fixture.contextMenuPath(children, { navId: "message", message: { id: "message", channel_id: "channel", author: { id: account }, deleted: false } });
        const action = descendants(children).find(node => node.props?.id === "hide-from-message-loggers").props.action;
        if (scenario === "stale-before") account = "replacement";
        await action();
        assert.equal(deletions, scenario === "stale-before" ? 0 : 1);
        assert.equal(sends, ["delete-reject", "stale-before", "stale-after"].includes(scenario) ? 0 : 1);
        assert.equal(toasts.length, ["delete-reject", "send-reject", "send-false"].includes(scenario) ? 1 : 0);
        if (scenario.startsWith("send-")) assert.match(toasts[0], /Message deleted, but/);
    }
});

test("music volume menus flush explicit closes but cancel unmounts and stale devices", () => {
    for (const player of ["spotify", "tidal"]) {
        const values: number[] = [];
        const events: string[] = [];
        const cleanups: (() => void)[] = [];
        const store = { volume: 50, device: { id: "original" }, setVolume: (value: number) => values.push(value) };
        const debounce = (callback: (...args: any[]) => void) => {
            let pending: any[] | undefined;
            const deferred = (...args: any[]) => { pending = args; };
            deferred.cancel = () => { pending = undefined; };
            deferred.flush = () => {
                const args = pending;
                pending = undefined;
                if (args) callback(...args);
            };
            return deferred;
        };
        const common = {
            React: { createElement: element }, Menu: { Menu: "menu", MenuItem: "item", MenuControlItem: "control", MenuSliderControl: "slider" },
            lodash: { debounce }, useMemo: (factory: () => unknown) => factory(),
            useEffect: (effect: () => () => void) => cleanups.push(effect()),
            useStateFromStores: (_stores: unknown, callback: () => unknown) => callback(),
            FluxDispatcher: { dispatch: () => events.push("closed") }
        };
        const filename = player === "spotify" ? "spotify/PlayerComponent.tsx" : "tidal/TidalPlayer.tsx";
        const storeImport = player === "spotify" ? "./SpotifyStore" : "./TidalStore";
        const component = load(`musicControls/${filename}`, {
            "@webpack/common": common,
            [storeImport]: { [player === "spotify" ? "SpotifyStore" : "TidalStore"]: store },
            "../settings": { settings: { store: {} } }
        }, "\nexports.AlbumContextMenu = AlbumContextMenu;").AlbumContextMenu;
        const menu = component({ track: { album: { id: "album", image: "cover" } } });
        const control = menu.props.children.find((child: any) => child.props.control).props.control({}, null);
        control.props.onChange(65);
        assert.deepEqual(values, []);
        menu.props.onClose();
        assert.deepEqual(values, [65]);
        assert.deepEqual(events, ["closed"]);
        control.props.onChange(75);
        cleanups.forEach(cleanup => cleanup());
        menu.props.onClose();
        assert.deepEqual(values, [65]);
        if (player === "spotify") {
            control.props.onChange(85);
            store.device.id = "replacement";
            menu.props.onClose();
            assert.deepEqual(values, [65]);
        }
    }
});

function load(filename: string, imports: Record<string, any> = {}, expose = "", globals: Record<string, unknown> = {}) {
    const settings: any = { store: {}, use: () => settings.store };
    const defaults: Record<string, any> = {
        "@utils/types": { default: (plugin: unknown) => plugin, OptionType: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@api/Settings": { definePluginSettings(options: Record<string, any>) {
            for (const [name, option] of Object.entries(options)) settings.store[name] = option.default;
            return settings;
        } },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack": { proxyLazyWebpack: (factory: () => unknown) => factory(), findComponentByCodeLazy: () => "icon" },
        "@components/settings": { wrapTab: (component: unknown) => component }
    };
    const code = transpileModule(readFileSync(`src/equicordplugins/${filename}`, "utf8") + expose, {
        fileName: filename,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, esModuleInterop: false }
    }).outputText;
    const exports: any = {};
    runInNewContext(code, {
        exports, Set, Map, Promise, setTimeout, clearTimeout, React: { createElement: element },
        require: (name: string) => imports[name] ?? defaults[name] ?? {},
        ...globals
    });
    return { ...exports, settings };
}

function hiddenFixture(saved: string[] = []) {
    const folders = [{ folderId: 7, guildIds: ["individual", "folder-member"] }];
    const sorted = { getGuildFolders: () => folders, getFlattenedGuildIds: () => folders.flatMap(folder => folder.guildIds) };
    const store = load("hideServers/HiddenServersStore.ts", {
        "@api/DataStore": { get: async () => saved, set: async () => {}, del: async () => {} },
        "@webpack/common": {
            Flux: { Store: class { emitChange() {} } }, SortedGuildStore: sorted,
            GuildStore: { getGuild: (id: string) => ({ id }) }
        }
    }).HiddenServersStore;
    const plugin = load("hideServers/index.tsx", {
        "./HiddenServersStore": { HiddenServersStore: store },
        "@webpack/common": { SortedGuildStore: sorted, useStateFromStores: (_stores: unknown, callback: () => unknown) => callback() }
    }).default;
    return { store, plugin, folders };
}

test("new folder hides preserve individual hides and include later members everywhere", () => {
    const { store, plugin, folders } = hiddenFixture();
    try {
        store.addHiddenGuild("individual");
        store.addHiddenFolder("7", folders[0].guildIds);
        assert.deepEqual(Array.from(store.hiddenGuilds), ["individual", "folder-7"]);
        folders[0].guildIds.push("later-member");
        assert.equal(store.hiddenGuildsDetail().some((guild: { id: string; }) => guild.id === "later-member"), true);
        assert.equal(plugin.filteredGuildResults([{ type: "GUILD", record: { id: "later-member" } }]).length, 0);
        assert.equal(plugin.filteredGuildResults([{ type: "CHANNEL", record: { guild_id: "later-member" } }]).length, 0);
        store.removeHiddenFolder("7", folders[0].guildIds);
        assert.deepEqual(Array.from(store.hiddenGuilds), ["individual"]);
        assert.equal(plugin.filteredGuildResults([{ type: "GUILD", record: { id: "later-member" } }]).length, 1);
    } finally { store.unload(); }
});

test("legacy mixed folder hides never discard ambiguous individually hidden IDs", async () => {
    const { store, folders } = hiddenFixture(["folder-7", "individual", "folder-member", "unknown-field"]);
    try {
        await store.load();
        store.removeHiddenFolder("7", folders[0].guildIds);
        assert.deepEqual(Array.from(store.hiddenGuilds), ["individual", "folder-member", "unknown-field"]);
    } finally { store.unload(); }
});

test("icon discovery is safe before readiness and subscriptions dispose", () => {
    const core = load("_core/concatenatedModules.tsx");
    let notifications = 0;
    const dispose = core.subscribeIconsModule(() => notifications++);
    const viewer = load("iconViewer/components/IconsTab.tsx", {}, "\nexports.getIcons = getIcons;");
    assert.deepEqual(Object.keys(viewer.getIcons(undefined)), []);
    const icons = { ExampleIcon: () => null, ignored: () => null, NotAnIcon: "not a function" };
    core.default.setIconsModule(icons);
    assert.equal(notifications, 1);
    assert.deepEqual(Object.keys(viewer.getIcons(core.default.iconsModule)), ["ExampleIcon"]);
    dispose();
    core.default.setIconsModule({ OtherIcon: () => null });
    assert.equal(notifications, 1);
});

test("color discovery replaces the snapshot and notifies only mounted listeners", () => {
    let discovered!: (module: unknown) => void;
    const colors = load("iconViewer/utils.ts", {
        "@webpack": { findByPropsLazy: () => ({}), waitFor: (_properties: unknown, callback: typeof discovered) => { discovered = callback; } }
    });
    const initial = colors.getCssColorKeys();
    let notifications = 0;
    const dispose = colors.subscribeCssColorKeys(() => notifications++);
    discovered({ colors: { PRIMARY: { css: "red" } } });
    assert.notEqual(colors.getCssColorKeys(), initial);
    assert.deepEqual(Array.from(colors.getCssColorKeys()), ["PRIMARY"]);
    assert.equal(notifications, 1);
    dispose();
    discovered({ colors: { SECONDARY: { css: "blue" } } });
    assert.equal(notifications, 1);
});

function ignoreFixture() {
    let account = "self";
    let hooks = 0;
    const dispatches: any[] = [];
    const common = {
        React: { createElement: element, useState: (initial: unknown) => { hooks++; return [initial, () => {}]; } },
        UserStore: { getCurrentUser: () => ({ id: account }) },
        FluxDispatcher: { dispatch: (event: unknown) => dispatches.push(event) },
        Menu: { MenuSeparator: "separator", MenuCheckboxItem: "checkbox" }
    };
    const plugin = load("ignoreCalls/index.tsx", { "@webpack/common": common }).default;
    return { plugin, dispatches, setAccount: (value: string) => { account = value; }, hooks: () => hooks };
}

test("ignore-calls context patches do not inject hooks into host components", () => {
    const fixture = ignoreFixture();
    const children: any[] = [];
    fixture.plugin.contextMenus["user-context"](children, { channel: { id: "dm", type: 1, recipients: ["friend"] } });
    assert.equal(fixture.hooks(), 0);
    const rendered = children[0].type(children[0].props);
    assert.equal(fixture.hooks(), 1);
    fixture.setAccount("other");
    rendered.props.children[2].props.action();
    assert.equal(fixture.plugin.settings.store.permanentlyIgnoredUsers, "");
});

test("permanent direct-message ignore accepts user IDs while preserving saved channel IDs", () => {
    const fixture = ignoreFixture();
    fixture.plugin.settings.store.permanentlyIgnoredUsers = "friend, legacy-dm";
    fixture.plugin.flux.CALL_UPDATE({ channelId: "dm", ringing: ["self", "friend"] });
    assert.equal(fixture.plugin.renderIgnore({ id: "dm", type: 1, recipients: ["friend"] }), null);
    fixture.plugin.flux.CALL_UPDATE({ channelId: "legacy-dm", ringing: ["self"] });
    assert.equal(fixture.plugin.renderIgnore({ id: "legacy-dm" }), null);
    assert.equal(fixture.dispatches.length, 2);
    assert.equal(fixture.plugin.settings.store.permanentlyIgnoredUsers, "friend, legacy-dm");
});

test("ingtoninator protects scheme-less links and always chooses an eligible unfinished word", () => {
    const fixture = load("ingtoninator/index.tsx", {}, "\nexports.getWords = getWords; exports.chooseRandomWord = chooseRandomWord; exports.handleMessage = handleMessage;", {
        Math: Object.assign(Object.create(Math), { random: () => 0 })
    });
    const links = "HTTPS://localhost/path www.example.com/path discord.gg/invite example.org/hello";
    assert.equal(fixture.getWords(links).length, 0);
    assert.equal(fixture.getWords("prefixhttps://example.com/path").length, 0);
    assert.equal(fixture.chooseRandomWord("WORDINGTON friend").word, "friend");
    const message = { content: `${links} friend` };
    fixture.handleMessage("channel", message);
    assert.equal(message.content, `${links} friendington`);
});
