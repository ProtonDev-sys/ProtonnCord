/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("connection organization lookups validate responses and forward caller cancellation", async () => {
    const requests: { url: string; options: RequestInit; }[] = [];
    let response: unknown = { invalid: true };
    const mocks = {
        "@api/PluginManager": {}, "@api/Settings": { definePluginSettings: () => ({}) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@components/Flex": {}, "@components/Icons": {}, "@plugins/openInApp": {},
        "@utils/constants": { Devs: {} }, "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { findByCodeLazy: () => () => ({}), findByPropsLazy: () => ({}) },
        "@webpack/common": {}, "./styles.css": {}, "./VerifiedIcon": {}
    };
    const path = "src/plugins/showConnections/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const fetchOrgs = runInNewContext(code + "\nfetchGithubOrgs;", {
        exports: {}, AbortSignal, require: (name: string) => mocks[name],
        fetch: async (url: string, options: RequestInit) => { requests.push({ url, options }); return { ok: true, json: async () => response }; }
    });
    const controller = new AbortController();
    assert.equal((await fetchOrgs("fixture user", controller.signal)).length, 0);
    assert.equal(requests[0].url, "https://api.github.com/users/fixture%20user/orgs");
    controller.abort();
    assert.equal(requests[0].options.signal!.aborted, true);
    response = [{ login: "fixture-org" }, {}, null];
    assert.equal((await fetchOrgs("fixture", new AbortController().signal)).length, 1);
});

test("server list tooltip and visible counts use the same subscribed snapshots", () => {
    let online = true;
    const react = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const mocks = {
        "@api/Settings": { definePluginSettings: () => ({ store: { mode: 3 } }) },
        "@api/ServerList": {}, "@components/BaseText": {}, "@components/ErrorBoundary": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => (text: string) => text },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "./styles.css": {},
        "@webpack/common": {
            RelationshipStore: { getFriendIDs: () => ["friend"] }, PresenceStore: { getStatus: () => online ? "online" : "offline" },
            GuildStore: { getGuilds: () => ({ joined: {} }), getGuildCount: () => 1 },
            UserGuildJoinRequestStore: { computeGuildIds: () => ["joined", "pending"] },
            useStateFromStores: (_stores: unknown, getter: () => unknown) => getter(), Tooltip: "Tooltip"
        }
    };
    const path = "src/plugins/serverListIndicators/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const plugin = runInNewContext(code + "\nexports.default;", { exports: {}, React: react, require: (name: string) => mocks[name] });
    const tooltip = () => plugin.renderIndicator().props.children[0].props.children[0];
    const first = tooltip();
    assert.equal(first.props.text, "1 Friends, 2 Servers");
    const rows = first.props.children[0]({}).props.children;
    assert.deepEqual(rows.map((row: any) => row.props.count), [1, 2]);
    online = false;
    assert.equal(tooltip().props.text, "0 Friends, 2 Servers");
});

test("platform status rendering uses fixed hooks without mutating the host presence store", () => {
    let subscriptions = 0;
    const hostStatus = Object.freeze({ desktop: "idle" });
    const mocks = {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }), migratePluginSetting() {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { filters: { byCode() {} }, mapMangledModuleLazy: () => ({}) },
        "@webpack/common": {
            AuthenticationStore: { getId: () => "self" },
            PresenceStore: { getClientStatus: () => hostStatus, getState: () => { throw new Error("Unexpected host mutation"); } },
            SessionsStore: { getSessions: () => ({ one: { status: "idle", clientInfo: { client: "desktop" } },
                two: { status: "online", clientInfo: { client: "desktop" } } }) },
            useStateFromStores: (_stores: unknown, getter: () => unknown) => { subscriptions++; return getter(); },
            useMemo: (getter: () => unknown) => getter()
        }
    };
    const path = "src/plugins/platformIndicators/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const getStatus = runInNewContext(code + "\nuseClientStatus;", { exports: {}, require: (name: string) => mocks[name] });
    assert.equal(getStatus({ id: "self" }).desktop, "online");
    assert.equal(getStatus({ id: "other" }), hostStatus);
    assert.equal(getStatus(null), null);
    assert.equal(subscriptions, 6);
    assert.equal(hostStatus.desktop, "idle");
});

function loadActivityToggle() {
    let accounts = [{ type: "spotify", id: "first", showActivity: false, revoked: false }];
    let cursor = 0;
    const hooks: any[] = [];
    const effects: (() => void)[] = [];
    const requests: { resolve(): void; reject(error: Error): void; }[] = [];
    const notices: unknown[] = [];
    const react = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const mocks: Record<string, object> = {
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@api/Settings": { definePluginSettings: () => ({ use: () => ({ location: "PANEL" }) }) },
        "@api/UserSettings": { getUserSettingLazy: () => ({ useSetting: () => true }) },
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": {
            findComponentByCodeLazy: () => "Button",
            findByPropsLazy: () => ({ setShowActivity: () => new Promise<void>((resolve, reject) => requests.push({ resolve, reject })) })
        },
        "@webpack/common": {
            ConnectedAccountsStore: { getAccounts: () => accounts },
            Menu: { Menu: "Menu", MenuCheckboxItem: "Checkbox" }, Popout: "Popout",
            useStateFromStores: (_stores: unknown, getter: () => unknown) => getter(),
            useState: (initial: unknown) => {
                const index = cursor++;
                if (!(index in hooks)) hooks[index] = initial;
                return [hooks[index], (value: unknown) => hooks[index] = value];
            },
            useRef: (initial: unknown) => hooks[cursor++] ??= { current: initial },
            useEffect: (callback: () => void, deps: unknown[]) => {
                const index = cursor++;
                if (!hooks[index] || deps.some((value, i) => value !== hooks[index][i])) {
                    hooks[index] = deps;
                    effects.push(callback);
                }
            },
            Toasts: { genId: () => "toast", Type: {}, show: (notice: unknown) => notices.push(notice) }
        }
    };
    const path = "src/plugins/gameActivityToggle/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const plugin = runInNewContext(code + "\nexports.default;", {
        exports: {}, React: react, require: (name: string) => mocks[name] ?? { default: {} }
    });
    const render = () => {
        cursor = 0;
        const element = plugin.userAreaButton.render({});
        effects.splice(0).forEach(effect => effect());
        return element;
    };
    const checkbox = () => render().props.renderPopout({ closePopout() {} }).props.children[0].props;
    return { render, checkbox, requests, notices, setAccounts: (next: typeof accounts) => accounts = next };
}

test("GameActivityToggle rolls back failed Spotify updates and prevents overlapping clicks", async () => {
    const { checkbox, requests, notices } = loadActivityToggle();
    const pending = checkbox().action();
    assert.equal(checkbox().checked, true);
    await checkbox().action();
    assert.equal(requests.length, 1);
    requests[0].reject(new Error("Update failed"));
    await pending;
    assert.equal(checkbox().checked, false);
    assert.equal(notices.length, 1);
});

test("GameActivityToggle syncs switched accounts without applying an older rollback", async () => {
    const { checkbox, render, requests, setAccounts } = loadActivityToggle();
    const pending = checkbox().action();
    setAccounts([{ type: "spotify", id: "second", showActivity: true, revoked: false }]);
    render();
    requests[0].reject(new Error("Update failed"));
    await pending;
    assert.equal(checkbox().checked, true);
    setAccounts([]);
    assert.equal(render().props.ariaChecked, true);
});

test("ImageZoom owns only its active image root and can render again after stop/restart", () => {
    const roots: { renders: number; unmounts: number; render(): void; unmount(): void; }[] = [];
    const elements: { removed: boolean; remove(): void; classList: { add(): void; }; }[] = [];
    const mocks: Record<string, object> = {
        "@api/Settings": { definePluginSettings: () => ({ store: { size: 100, zoom: 2 } }) },
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "./constants": { ELEMENT_ID: "image" },
        "@webpack/common": { createRoot: () => {
            const root = { renders: 0, unmounts: 0, render() { this.renders++; }, unmount() { this.unmounts++; } };
            roots.push(root);
            return root;
        } }
    };
    const path = "src/plugins/imageZoom/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const plugin = runInNewContext(code + "\nexports.default;", {
        exports: {}, React: { createElement: () => ({}) }, require: (name: string) => mocks[name] ?? {},
        document: { body: { appendChild() {} }, createElement: () => {
            const element = { removed: false, remove() { this.removed = true; }, classList: { add() {} } };
            elements.push(element);
            return element;
        } }
    });
    const active = { props: { id: "image" } };
    const unrelated = { props: { id: "other" } };
    plugin.start();
    plugin.start();
    assert.equal(elements.length, 1);
    assert.equal(Object.keys(plugin.makeProps(unrelated)).length, 0);
    plugin.renderMagnifier(active);
    plugin.unMountMagnifier(unrelated);
    assert.equal(roots[0].unmounts, 0);
    plugin.stop();
    assert.equal(roots[0].unmounts, 1);
    assert.equal(plugin.root, null);
    assert.equal(elements[0].removed, true);
    plugin.renderMagnifier(active);
    assert.equal(roots.length, 1);
    plugin.start();
    plugin.renderMagnifier(active);
    assert.equal(roots.length, 2);
    assert.equal(roots[1].renders, 1);
    plugin.unMountMagnifier(active);
    assert.equal(roots[1].unmounts, 1);
});

test("ImageZoom uses viewport image coordinates, preserves external URLs, and restores media attributes", () => {
    let cursor = 0;
    let draggable: string | null = "true";
    const hooks: any[] = [];
    const effects: (() => void)[] = [];
    const cleanups: (() => void)[] = [];
    const handlers = new Map<string, Function>();
    const media = {
        getAttribute: () => draggable,
        setAttribute: (_name: string, value: string) => draggable = value,
        removeAttribute: () => draggable = null
    };
    const imageElement = { querySelector: () => media, getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 80 }) };
    const store = { zoom: NaN, size: Infinity, zoomSpeed: NaN, invertScroll: false, saveZoomValues: true };
    const mocks: Record<string, object> = {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@plugins/imageZoom": { settings: { store } },
        "@plugins/imageZoom/constants": { ELEMENT_ID: "image" },
        "@plugins/imageZoom/utils/waitFor": { waitFor: (_condition: Function, ready: Function) => { ready(); return () => {}; } },
        "@utils/css": { classNameFactory: () => () => "lens" },
        "@webpack/common": {
            useState: (initial: unknown) => {
                const index = cursor++;
                if (!(index in hooks)) hooks[index] = initial;
                return [hooks[index], (value: unknown) => hooks[index] = value];
            },
            useRef: (initial: unknown) => hooks[cursor++] ??= { current: initial },
            useMemo: (compute: Function) => compute(),
            useLayoutEffect: (callback: () => () => void, deps: unknown[]) => {
                const index = cursor++;
                if (!hooks[index] || deps.some((value, i) => value !== hooks[index][i])) {
                    hooks[index] = deps;
                    effects.push(() => { cleanups[index]?.(); cleanups[index] = callback(); });
                }
            }
        }
    };
    const path = "src/plugins/imageZoom/components/Magnifier.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const component = runInNewContext(code + "\nexports.Magnifier;", {
        exports: {}, URL, require: (name: string) => mocks[name],
        React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) },
        document: {
            getElementById: (id: string) => id === "image" ? imageElement : null,
            addEventListener: (name: string, handler: Function) => handlers.set(name, handler),
            removeEventListener: (name: string) => handlers.delete(name)
        }
    });
    const instance = { props: { src: "https://images.example.invalid/attachments/image.png?signature=preserve", animated: false }, state: { mouseOver: true, mouseDown: true, readyState: "READY" } };
    const render = () => {
        cursor = 0;
        const result = component({ instance, size: Infinity, zoom: NaN });
        effects.splice(0).forEach(effect => effect());
        return result;
    };
    render();
    assert.equal(draggable, "false");
    const event = { button: 0, clientX: 60, clientY: 70, pageX: 160, pageY: 270 };
    handlers.get("mousedown")!(event);
    let lens = render();
    assert.equal(lens.props.style.width, "100px");
    assert.equal(lens.props.style.transform, "translate(110px, 220px)");
    assert.equal(lens.props.children[0].props.style.transform, "translate(-50px, -50px)");
    assert.equal(lens.props.children[0].props.src, instance.props.src);
    handlers.get("wheel")!({ ...event, deltaY: Infinity });
    assert.equal(Number.isFinite(store.zoom), true);
    instance.props.src = "https://media.discordapp.net/attachments/image.png";
    render();
    lens = render();
    assert.equal(lens.props.children[0].props.src, "https://cdn.discordapp.com/attachments/image.png?animated=true");
    cleanups.forEach(cleanup => cleanup?.());
    assert.equal(draggable, "true");
    assert.equal(handlers.size, 0);
});

test("IrcColors preserves existing DM colors when requested and handles finite lightness and a zero hash", () => {
    const store = { lightness: NaN, applyColorOnlyToUsersWithoutColor: true, applyColorOnlyInDms: false };
    const mocks: Record<string, object> = {
        "@api/Settings": {
            definePluginSettings: () => ({ store, use: () => store }),
            Settings: { plugins: { CustomUserColors: { enabled: false } } }
        },
        "@intrnl/xxhash64": { hash: (id: string) => id === "zero" ? 0n : 5n },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": { useMemo: (compute: Function) => compute(), UserStore: { getCurrentUser: () => ({ id: "me" }) } }
    };
    const path = "src/plugins/ircColors/index.ts";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const api = runInNewContext(code + "\n({plugin:exports.default,calculateNameColorForUser});", {
        exports: {}, require: (name: string) => mocks[name] ?? {}, console
    });
    const context = { message: { author: { id: "friend" } }, author: { colorString: "#123456" }, channel: { isPrivate: () => true } };
    assert.equal(api.plugin.calculateNameColorForMessageContext(context), "#123456");
    store.applyColorOnlyToUsersWithoutColor = false;
    assert.equal(api.plugin.calculateNameColorForMessageContext(context), "hsl(185, 100%, 70%)");
    assert.equal(api.calculateNameColorForUser("zero"), "hsl(0, 100%, 70%)");
    assert.equal(api.calculateNameColorForUser(undefined), undefined);
    store.lightness = 0;
    assert.equal(api.calculateNameColorForUser("zero"), "hsl(0, 100%, 0%)");
});

test("LoadingQuotes does not accumulate presets and preserves the original host quotes across settings changes", () => {
    const store = { enableDiscordPresetQuotes: true, enablePluginPresetQuotes: true, additionalQuotes: "custom", additionalQuotesDelimiter: "|" };
    const mocks: Record<string, object> = {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "file://quotes.txt": { __esModule: true, default: "# comment\npreset\n" }
    };
    const path = "src/plugins/loadingQuotes/index.ts";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const plugin = runInNewContext(code + "\nexports.default;", {
        exports: {}, require: (name: string) => mocks[name]
    });
    const quotes = ["host"];
    plugin.mutateQuotes(quotes);
    plugin.mutateQuotes(quotes);
    assert.deepEqual(quotes, ["host", "preset", "custom"]);
    store.enableDiscordPresetQuotes = false;
    store.enablePluginPresetQuotes = false;
    store.additionalQuotes = "";
    plugin.mutateQuotes(quotes);
    assert.equal(quotes.length, 1);
    store.enableDiscordPresetQuotes = true;
    plugin.mutateQuotes(quotes);
    assert.deepEqual(quotes, ["host"]);
});
