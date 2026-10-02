import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { createSourceFile, JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("transcriber clipboard feedback awaits success and ignores stale completions", async () => {
    const source = readFileSync("src/equicordplugins/voiceMessageTranscriber.desktop/index.tsx", "utf8");
    const start = source.indexOf("    const copy = useCallback(");
    const end = source.indexOf("\n\n    useEffect", start);
    assert.ok(start >= 0 && end > start);
    assert.match(source.slice(end), /\+\+copySequenceRef.current/);
    const exports: { copy?: (target: string, text: string) => Promise<void>; } = {};
    const copied: unknown[] = [];
    const errors: string[] = [];
    const timers: (() => void)[] = [];
    const copySequenceRef = { current: 0 };
    let write: () => Promise<void> = async () => { throw new Error("clipboard denied"); };
    const code = transpileModule(source.slice(start, end) + "\nexports.copy = copy;", {
        compilerOptions: { target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(code, {
        exports, generation: 0, copySequenceRef, copyTimerRef: { current: null },
        useCallback: (callback: unknown) => callback,
        copyToClipboard: () => write(), setCopied: (value: unknown) => copied.push(value),
        setError: (value: string) => errors.push(value),
        setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
        clearTimeout() {}
    });
    await exports.copy!("transcript", "text");
    assert.deepEqual(copied, []);
    assert.equal(timers.length, 0);
    assert.deepEqual(errors, ["Failed to copy text to the clipboard."]);
    let finishWrite!: () => void;
    write = () => new Promise(resolve => { finishWrite = resolve; });
    const successful = exports.copy!("transcript", "text");
    assert.deepEqual(copied, []);
    finishWrite();
    await successful;
    assert.deepEqual(copied, ["transcript"]);
    assert.equal(timers.length, 1);
    timers[0]();
    assert.deepEqual(copied, ["transcript", null]);
    const stale = exports.copy!("translation", "text");
    copySequenceRef.current++;
    finishWrite();
    await stale;
    assert.deepEqual(copied, ["transcript", null]);
    assert.equal(timers.length, 1);
});

function loadModule<T>(path: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, extra = ""): T {
    const exports = {};
    const source = transpileModule(readFileSync(path, "utf8") + extra, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    runInNewContext(source, {
        exports, Buffer, Uint8Array, Float32Array, URL, AbortSignal, AbortController,
        require(name: string) {
            assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name} in ${path}`);
            return imports[name];
        },
        ...globals
    });
    return exports as T;
}

test("sticker search identifiers are unique without renumbering legacy catalog IDs", () => {
    const { characters } = loadModule<{ characters: { id: string; searchId?: string; name: string; }[]; }>("src/equicordplugins/sekaiStickers/characters.json.ts", {});
    assert.equal(characters.filter(character => character.id === "81").length, 2);
    const searchIds = characters.map(character => character.searchId ?? character.id);
    assert.equal(new Set(searchIds).size, characters.length);
    for (const [query, expected] of [["81", "Haruka 01"], ["375", "Ena 16"]]) {
        let results: any[] = [];
        const react = {
            createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
            useState: () => [query, () => {}],
            useMemo: (factory: () => any[]) => { results = factory(); return results; }
        };
        const api = loadModule<{ default(props: object): unknown; }>("src/equicordplugins/sekaiStickers/Components/Picker.tsx", {
            "@components/Flex": {}, "@equicordplugins/sekaiStickers/characters.json": { characters }, "@vencord/discord-types": {},
            "@webpack/common": { React: react }
        });
        api.default({ modalProps: {}, setCharacter: () => {} });
        const matches = results.filter(Boolean);
        assert.equal(matches.length, 1);
        assert.equal(characters[matches[0].props.key].name, expected);
    }
});

test("voice log startup participants have their later rejoin recorded", () => {
    const entries: { type: string; userId: string; }[] = [];
    let now = 100000;
    const api = loadModule<{ default: any; }>("src/equicordplugins/voiceChannelLog/index.tsx", {
        "@api/ContextMenu": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@vencord/discord-types/enums": { ChannelType: {} }, "@webpack": { findByPropsLazy: () => ({}) },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "owner" }) }, SelectedChannelStore: { getVoiceChannelId: () => "channel" }, VoiceStateStore: { getVoiceStatesForChannel: () => ({ other: { channelId: "channel", mute: false, deaf: false, selfVideo: false } }) }, RelationshipStore: { isBlocked: () => false } },
        "./components/LogsButton": {}, "./components/VoiceChannelLogModal": {}, "./types": {},
        "./logs": { addLogEntry: (entry: typeof entries[number]) => entries.push(entry), setCallStartTime: () => {} },
        "./settings": { __esModule: true, default: { store: { logJoinLeave: true } } }
    }, { Date: class extends Date { static now() { return now; } } });
    api.default.start();
    entries.length = 0;
    api.default.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "other", channelId: null, oldChannelId: "channel" }] });
    now += 6000;
    api.default.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "other", channelId: "channel", oldChannelId: null }] });
    assert.deepEqual(entries.map(entry => entry.type), ["leave", "join"]);
    api.default.stop();
});

test("voice logs bound retention while maintaining immutable subscriber snapshots", () => {
    const api = loadModule<{ addLogEntry(entry: any): void; getVcLogs(channel: string): any[]; clearLogs(channel: string): void; }>("src/equicordplugins/voiceChannelLog/logs.ts", {});
    api.addLogEntry({ channelId: "channel", sequence: 0 });
    const snapshot = api.getVcLogs("channel");
    for (let sequence = 1; sequence < 5000; sequence++) api.addLogEntry({ channelId: "channel", sequence });
    assert.equal(snapshot.length, 1);
    assert.equal(api.getVcLogs("channel").length, 1000);
    assert.equal(api.getVcLogs("channel")[0].sequence, 4000);
    for (let channel = 0; channel < 100; channel++) api.addLogEntry({ channelId: `channel-${channel}` });
    assert.equal(api.getVcLogs("channel").length, 0);
    assert.equal(api.getVcLogs("channel-99").length, 1);
    api.clearLogs("channel-99");
    assert.equal(api.getVcLogs("channel-99").length, 0);
});

test("sticker exports cannot open an upload prompt after modal unmount", () => {
    for (const unmount of [false, true]) {
        const cleanups: (() => void)[] = [];
        const refs: { current: any; }[] = [];
        let callback!: (blob: Blob | null) => void;
        let prompts = 0;
        let closes = 0;
        const react = {
            createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
            useState: (value: unknown) => [value, () => {}],
            useRef: (value: unknown) => { const ref = { current: value }; refs.push(ref); return ref; },
            useMemo: (factory: () => unknown) => factory(),
            useEffect: (effect: () => (() => void)) => { cleanups.push(effect()); }
        };
        const api = loadModule<{ default(props: object): any; }>("src/equicordplugins/sekaiStickers/Components/SekaiStickersModal.tsx", {
            "@components/Flex": {}, "@components/FormSwitch": {}, "@components/Heading": {},
            "@equicordplugins/sekaiStickers/characters.json": { characters: Array.from({ length: 50 }, () => ({ character: "fixture", img: "fixture.png", defaultText: { s: 47, r: 0, x: 148, y: 58 } })) },
            "@vencord/discord-types": {}, "./Canvas": {}, "./Picker": {},
            "@webpack/common": { React: react, Modal: "modal", ChannelStore: { getChannel: () => ({ id: "channel" }) }, SelectedChannelStore: { getChannelId: () => "channel" }, UploadHandler: { promptToUpload: () => { prompts++; } } }
        }, { Image: class {}, File, document: { fonts: { load: async () => {} } } });
        const modal = api.default({ modalProps: { onClose: () => { closes++; } }, settings: { store: { AutoCloseModal: true } } });
        refs[0].current = { toBlob: (handler: typeof callback) => { callback = handler; } };
        modal.props.actions[1].onClick();
        if (unmount) cleanups.forEach(cleanup => cleanup());
        callback(new Blob(["fixture"], { type: "image/png" }));
        assert.equal(prompts, unmount ? 0 : 1);
        assert.equal(closes, unmount ? 0 : 1);
        if (!unmount) cleanups.forEach(cleanup => cleanup());
    }
});

test("overlapping webpack protection restores the original descriptor only after the final caller", async () => {
    for (const hasOriginal of [false, true]) {
        const fixture = loadModule<{
            protectWebpack<T>(webpack: unknown[], body: () => Promise<T>): Promise<T>;
            prototype: object;
        }>("src/equicordplugins/webpackTarball/webpack.ts", {}, {}, "\nexport const prototype = Function.prototype;\n");
        const original = { value: "original", configurable: true, writable: false, enumerable: false };
        if (hasOriginal) Object.defineProperty(fixture.prototype, "m", original);
        let completeFirst!: () => void;
        let completeSecond!: () => void;
        const first = fixture.protectWebpack([], () => new Promise<void>(resolve => { completeFirst = resolve; }));
        const second = fixture.protectWebpack([], () => new Promise<void>(resolve => { completeSecond = resolve; }));
        assert.throws(() => Reflect.get(fixture.prototype, "m"));
        completeFirst();
        await first;
        assert.throws(() => Reflect.get(fixture.prototype, "m"));
        completeSecond();
        await second;
        assert.deepEqual(Object.getOwnPropertyDescriptor(fixture.prototype, "m"), hasOriginal ? original : undefined);
        await assert.rejects(fixture.protectWebpack([], async () => { throw new Error("fixture failure"); }), /fixture failure/);
        assert.deepEqual(Object.getOwnPropertyDescriptor(fixture.prototype, "m"), hasOriginal ? original : undefined);
        await fixture.protectWebpack([], () => fixture.protectWebpack([], async () => undefined));
        assert.deepEqual(Object.getOwnPropertyDescriptor(fixture.prototype, "m"), hasOriginal ? original : undefined);
    }
});

test("musiclink completion cannot post after stop, restart or account switch", async () => {
    for (const mode of ["stop", "restart", "switch", "normal", "failure"] as const) {
        let account = "owner";
        const lookup = deferred<{ links: { spotify: { url: string; }; }; }>();
        const sent: unknown[] = [];
        const notices: unknown[] = [];
        const plugin = loadModule<{ default: { start(): void; stop(): void; commands: { execute(opts: unknown[], ctx: unknown): Promise<void>; }[]; }; }>(
            "src/equicordplugins/songLink.desktop/index.tsx", {
                "@api/Commands": {
                    ApplicationCommandInputType: {}, ApplicationCommandOptionType: {},
                    findOption: () => "https://open.spotify.com/track/fixture",
                    sendBotMessage: (_channel: string, message: unknown) => notices.push(message)
                },
                "@api/Settings": { definePluginSettings: () => ({ store: { servicesSettings: { spotify: { enabled: true } }, includeMetadata: false } }) },
                "@utils/constants": { Devs: {}, EquicordDevs: {} },
                "@utils/discord": { sendMessage: async (_channel: string, message: unknown) => { sent.push(message); } },
                "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
                "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: account }) } },
                "./Providers": { Providers: { spotify: { name: "Spotify" } } }, "./Settings": {}, "./SongLinker": {}
            }, { VencordNative: { pluginHelpers: { SongLink: { getTrackData: () => lookup.promise } } } }
        ).default;
        plugin.start();
        const command = plugin.commands[0].execute([], { channel: { id: "channel" } });
        assert.equal(notices.length, 1);
        if (mode === "stop" || mode === "restart" || mode === "failure") plugin.stop();
        if (mode === "restart") plugin.start();
        if (mode === "switch") account = "other";
        if (mode === "failure") lookup.reject(new Error("fixture"));
        else lookup.resolve({ links: { spotify: { url: "https://open.spotify.com/track/fixture" } } });
        await command;
        assert.equal(sent.length, mode === "normal" ? 1 : 0);
        assert.equal(notices.length, 1);
        plugin.stop();
    }
});

test("SongLink preserves partial settings, separates distinct tracks and neutralizes metadata mentions", () => {
    const configured = { spotify: { enabled: false, openInNative: false, unknown: "retained" } };
    const api = loadModule<{
        getServiceSettings(key: string): { enabled: boolean; openInNative: boolean; unknown?: string; };
        extractMusicLinks(text: string): string[];
        getTrackKey(data: unknown, fallback: string): string;
        formatMessage(data: unknown): string;
    }>("src/equicordplugins/songLink.desktop/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {}, ApplicationCommandOptionType: {} },
        "@api/Settings": { definePluginSettings: () => ({ store: { servicesSettings: configured, includeMetadata: true } }) },
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": {}, "./Settings": {}, "./SongLinker": {},
        "./Providers": { Providers: { spotify: { name: "Spotify", native: true }, appleMusic: { name: "Apple Music", native: true } } }
    }, { VencordNative: { pluginHelpers: { SongLink: {} } } }, "\nexport { extractMusicLinks, getTrackKey, formatMessage };\n");
    assert.deepEqual({ ...api.getServiceSettings("spotify") }, { enabled: false, openInNative: false, unknown: "retained" });
    assert.deepEqual({ ...api.getServiceSettings("appleMusic") }, { enabled: true, openInNative: true });
    assert.equal(Object.hasOwn(configured, "appleMusic"), false);
    assert.deepEqual(Array.from(api.extractMusicLinks("(https://music.apple.com/us/album/song/123?i=456).")), ["https://music.apple.com/us/album/song/123?i=456"]);
    const first = { info: { title: "Same", artist: "Same" }, links: { appleMusic: { url: "https://music.apple.com/us/album/song/123?i=456" } } };
    const second = { ...first, links: { appleMusic: { url: "https://music.apple.com/us/album/song/123?i=789" } } };
    assert.notEqual(api.getTrackKey(first, "first"), api.getTrackKey(second, "second"));
    assert.equal(api.getTrackKey(first, "first"), api.getTrackKey(first, "alias"));
    const message = api.formatMessage({ ...first, info: { title: "@everyone\n# **title**", artist: "<@123> [label](link)" } });
    assert.equal(message.includes("@everyone"), false);
    assert.equal(message.includes("<@123>"), false);
    assert.ok(message.includes("\\*\\*title\\*\\*"));
    assert.ok(message.includes("- [Apple Music](<https://music.apple.com/us/album/song/123?i=456>)"));
});

test("Song Spotlight sign-out only removes the mounted current account's authorization", () => {
    let account = "owner";
    const tokens: Record<string, string> = { owner: "owner-token", other: "other-token" };
    const notices: unknown[] = [];
    const react = { createElement: (type: unknown, props: Record<string, any>, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const api = loadModule<{ default(props: object): any; }>("src/equicordplugins/songSpotlight.desktop/ui/settings/index.tsx", {
        "@components/BaseText": {}, "@components/Button": { Button: "button" }, "@components/ErrorBoundary": {}, "@components/Flex": {},
        "@equicordplugins/songSpotlight.desktop/lib/api": {}, "@equicordplugins/songSpotlight.desktop/lib/oauth2": {},
        "@equicordplugins/songSpotlight.desktop/lib/stores/AuthorizationStore": { useAuthorizationStore: () => ({
            isAuthorized: () => true, deleteTokens: (owner: string) => { assert.ok(owner); delete tokens[owner]; }
        }) },
        "@equicordplugins/songSpotlight.desktop/lib/stores/SongStore": { useSongStore: () => ({ self: { data: [] } }) },
        "@equicordplugins/songSpotlight.desktop/lib/utils": { cl: (value: string) => value },
        "@equicordplugins/songSpotlight.desktop/service": {}, "@equicordplugins/songSpotlight.desktop/ui/common": {},
        "@equicordplugins/songSpotlight.desktop/ui/settings/SongList": {}, "@song-spotlight/api/structs": {},
        "@song-spotlight/api/util": { sid: (value: unknown) => String(value) }, "@utils/clipboard": {}, "@utils/discord": {}, "@vencord/discord-types": {},
        "@webpack/common": {
            UserStore: { getCurrentUser: () => account ? { id: account } : undefined },
            useStateFromStores: (_stores: unknown, callback: () => unknown) => callback(),
            useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, () => undefined],
            useEffect: () => undefined, useMemo: (callback: () => unknown) => callback(),
            Parser: { parse: () => "command" }, Toasts: { Type: {} }, showToast: (value: unknown) => notices.push(value)
        }
    }, { React: react });
    const root = api.default({});
    function findSignOut(node: any): any {
        if (!node || typeof node !== "object") return;
        if (node.type === "button" && node.props.children.includes("Sign out")) return node;
        for (const child of node.props?.children ?? []) {
            const match = findSignOut(child);
            if (match) return match;
        }
    }
    const signOut = findSignOut(root);
    assert.ok(signOut);
    account = "other";
    signOut.props.onClick();
    assert.deepEqual(Object.keys(tokens), ["owner", "other"]);
    account = "";
    signOut.props.onClick();
    assert.equal(notices.length, 0);
    account = "owner";
    signOut.props.onClick();
    assert.deepEqual(tokens, { other: "other-token" });
    assert.equal(notices.length, 1);
});

test("all tracked owned R-Z TypeScript sources parse", () => {
    const paths = execFileSync("git", ["ls-files", "src/equicordplugins/*"], { encoding: "utf8" }).trim().split("\n")
        .filter(path => /^src\/equicordplugins\/[r-z]/i.test(path)
            && !/^src\/equicordplugins\/(secureMessaging\.desktop|secureMessagingForwarding\.desktop)\//.test(path));
    assert.ok(paths.length > 200);
    for (const path of paths.filter(path => /\.tsx?$/.test(path))) {
        const source = createSourceFile(path, readFileSync(path, "utf8"), ScriptTarget.Latest, true);
        const diagnostics = (source as typeof source & { parseDiagnostics: unknown[]; }).parseDiagnostics;
        assert.equal(diagnostics.length, 0, path);
    }
});

function themeFixture(response: Response, failRename = false) {
    const requests: { url: string; options: RequestInit; }[] = [];
    const writes: { path: string; content: Buffer; }[] = [];
    const renames: [string, string][] = [];
    const removals: string[] = [];
    const directory = normalize(join("themes", ".theme-download-fixture"));
    const api = loadModule<{
        downloadTheme(event: unknown, theme: unknown): Promise<void>;
        themeExists(event: unknown, theme: unknown): Promise<boolean>;
    }>("src/equicordplugins/themeLibrary/native.ts", {
        "@main/utils/constants": { THEMES_DIR: "themes" },
        "@main/utils/ensureSafePath": { ensureSafePath: (base: string, path: string) => join(base, path) },
        "fs": { existsSync: () => true },
        "fs/promises": {
            mkdtemp: async () => directory,
            writeFile: async (path: string, content: Buffer) => { writes.push({ path, content }); },
            rename: async (from: string, to: string) => {
                if (failRename) throw new Error("Rename failed");
                renames.push([from, to]);
            },
            rm: async (path: string) => { removals.push(path); }
        },
        "path": { join }
    }, { fetch: async (url: string, options: RequestInit) => { requests.push({ url, options }); return response; } });
    return { ...api, requests, writes, renames, removals, directory };
}

const theme = { name: "Fixture Theme", id: "fixture", content: "present" };

test("theme native rejects non-flat and Windows-special filenames before I/O", async () => {
    const fixture = themeFixture(new Response("body{}"));
    for (const name of ["../outside", "nested/theme", "nested\\theme", "stream:payload", "NUL", "con.backup", "LPT9", "name.", "name ", "bad\0name", "x".repeat(201)]) {
        assert.equal(await fixture.themeExists(null, { ...theme, name }), false, name);
        await assert.rejects(fixture.downloadTheme(null, { ...theme, name }), /Invalid theme name/);
    }
    await assert.rejects(fixture.downloadTheme(null, { ...theme, id: {} }), /Invalid theme/);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.writes.length, 0);
});

test("theme downloads stage bytes and rename instead of following the destination file", async () => {
    const content = "body { color: red; }";
    const fixture = themeFixture(new Response(content));
    await fixture.downloadTheme(null, theme);
    assert.equal(fixture.requests[0].options.redirect, "error");
    assert.equal(fixture.requests[0].options.credentials, "omit");
    assert.ok(fixture.requests[0].options.signal);
    assert.equal(fixture.writes[0].path, join(fixture.directory, "theme.css"));
    assert.equal(fixture.writes[0].content.toString(), content);
    assert.deepEqual(fixture.renames, [[join(fixture.directory, "theme.css"), join("themes", "Fixture Theme.theme.css")]]);
    assert.deepEqual(fixture.removals, [fixture.directory]);
});

test("theme downloads cancel rejected headers and enforce streamed byte limits", async () => {
    for (const headers of [{ status: 503 }, { headers: { "content-length": String(5 * 1024 * 1024 + 1) } }]) {
        let cancelled = 0;
        const fixture = themeFixture(new Response(new ReadableStream({ cancel() { cancelled++; } }), headers));
        await assert.rejects(fixture.downloadTheme(null, theme), /Theme (download failed|exceeds)/);
        assert.equal(cancelled, 1);
        assert.equal(fixture.writes.length, 0);
    }
    let cancelled = 0;
    const fixture = themeFixture(new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); },
        cancel() { cancelled++; }
    })));
    await assert.rejects(fixture.downloadTheme(null, theme), /5 MB/);
    assert.equal(cancelled, 1);
    assert.equal(fixture.writes.length, 0);
});

test("theme staging is cleaned if replacement fails", async () => {
    const fixture = themeFixture(new Response("body{}"), true);
    await assert.rejects(fixture.downloadTheme(null, theme), /Rename failed/);
    assert.deepEqual(fixture.removals, [fixture.directory]);
});

function audioFixture(response: Response) {
    const requests: RequestInit[] = [];
    const api = loadModule<{ fetchAudio(event: unknown, url: string): Promise<Uint8Array>; }>(
        "src/equicordplugins/voiceMessageTranscriber.desktop/native.ts", {
            "node:child_process": { execFile() { assert.fail("No subprocesses permitted"); } },
            "node:crypto": {}, "node:fs/promises": {}, "node:os": {}, "node:path": { join },
            "node:util": { promisify: () => () => assert.fail("No subprocesses permitted") },
            "@main/utils/constants": {}, "fflate": {},
            "./audioValidation": { isRecognizedAudioContainer: (bytes: Uint8Array) => bytes[0] === 0x4f },
            "./transcriptionData": {}
        }, { fetch: async (_url: string, options: RequestInit) => { requests.push(options); return response; } }
    );
    return { ...api, requests };
}

test("audio failures cancel their bodies without disclosing signed URLs or status text", async () => {
    let cancelled = 0;
    const fixture = audioFixture(new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 403, statusText: "secret-status" }));
    await assert.rejects(fixture.fetchAudio(null, "https://cdn.discordapp.com/attachments/1/2/voice.ogg?token=secret"), error => {
        assert.match(String(error), /403/);
        assert.doesNotMatch(String(error), /secret|token|https:/);
        return true;
    });
    assert.equal(cancelled, 1);
    assert.equal(fixture.requests[0].credentials, "omit");
    assert.equal(fixture.requests[0].cache, "no-store");
    assert.equal(fixture.requests[0].redirect, "error");
});

test("audio advertised oversize responses cancel before reading and valid audio still works", async () => {
    let cancelled = 0;
    const oversized = audioFixture(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-length": String(25 * 1024 * 1024 + 1) } }));
    await assert.rejects(oversized.fetchAudio(null, "https://cdn.discordapp.com/attachments/1/2/voice.ogg"), /25 MB/);
    assert.equal(cancelled, 1);
    const valid = audioFixture(new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53])));
    assert.deepEqual(await valid.fetchAudio(null, "https://cdn.discordapp.com/attachments/1/2/voice.ogg"), new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    await assert.rejects(valid.fetchAudio(null, "http://cdn.discordapp.com/attachments/1/2/voice.ogg"), /untrusted/);
    assert.equal(valid.requests.length, 1);
});

test("Gensokyo native requests have a deadline and cancel failed bodies", async () => {
    let cancelled = 0;
    const requests: RequestInit[] = [];
    const api = loadModule<{ fetchTrackData(): Promise<unknown>; }>("src/equicordplugins/richPresence/native.ts", {}, {
        fetch: async (_url: string, options: RequestInit) => {
            requests.push(options);
            return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 });
        }
    });
    await assert.rejects(api.fetchTrackData(), /503/);
    assert.ok(requests[0].signal);
    assert.equal(requests[0].redirect, "error");
    assert.equal(requests[0].credentials, "omit");
    assert.equal(cancelled, 1);
});

function statusFixture() {
    let userId = "account-a";
    let status = "online";
    let inVoice = true;
    const writes: string[] = [];
    const api = loadModule<{ default: { flux: { VOICE_CHANNEL_STATUS_UPDATE(): void; }; stop(): void; }; }>(
        "src/equicordplugins/statusWhileActive.desktop/index.ts", {
            "@api/Settings": { definePluginSettings: () => ({ store: { statusToSet: "dnd" } }) },
            "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => status, updateSetting: (value: string) => { writes.push(value); status = value; } }) },
            "@utils/constants": { EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: userId }) },
                VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: inVoice ? "voice" : null }) }
            }
        }
    );
    return { plugin: api.default, writes, setUser: (value: string) => { userId = value; }, setStatus: (value: string) => { status = value; }, leave: () => { inVoice = false; } };
}

test("automatic voice status restores only its own account and applied value", () => {
    const normal = statusFixture();
    normal.plugin.flux.VOICE_CHANNEL_STATUS_UPDATE();
    normal.leave();
    normal.plugin.flux.VOICE_CHANNEL_STATUS_UPDATE();
    assert.deepEqual(normal.writes, ["dnd", "online"]);
    const switched = statusFixture();
    switched.plugin.flux.VOICE_CHANNEL_STATUS_UPDATE();
    switched.setUser("account-b");
    switched.plugin.stop();
    assert.deepEqual(switched.writes, ["dnd"]);
    const manual = statusFixture();
    manual.plugin.flux.VOICE_CHANNEL_STATUS_UPDATE();
    manual.setStatus("invisible");
    manual.plugin.stop();
    assert.deepEqual(manual.writes, ["dnd"]);
    const switchedVoice = statusFixture();
    switchedVoice.plugin.flux.VOICE_CHANNEL_STATUS_UPDATE();
    switchedVoice.setUser("account-b");
    switchedVoice.leave();
    switchedVoice.plugin.flux.VOICE_CHANNEL_STATUS_UPDATE();
    assert.deepEqual(switchedVoice.writes, ["dnd"]);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
    return { promise, resolve, reject };
}

async function flushMicrotasks() {
    for (let attempt = 0; attempt < 20; attempt++) await Promise.resolve();
}

test("scheduled plugin stop invalidates pending startup and an older restarted startup", async () => {
    const loads: { pending: ReturnType<typeof deferred<void>>; isCurrent: () => boolean; }[] = [];
    let starts = 0;
    let recreates = 0;
    let changeInterval = () => {};
    let accountId = "owner";
    let modalOpens = 0;
    let finishRead = () => {};
    const api = loadModule<{ default: { start(): Promise<void>; stop(): void; onBeforeMessageSend(channel: string, message: { content: string; }, options: unknown): Promise<unknown>; }; }>("src/equicordplugins/scheduledMessages/index.tsx", {
        "./styles.css": {},
        "@api/Settings": { definePluginSettings: (options: { checkIntervalSeconds: { onChange(): void; }; }) => {
            changeInterval = options.checkIntervalSeconds.onChange;
            return { store: {} };
        } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "./components/ChatBarButton": { isScheduleModeEnabled: true, setScheduleModeEnabled: () => {} },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: accountId }) } },
        "./components/Icons": {},
        "./components/MessageAccessory": {},
        "./components/ScheduleTimeModal": { openScheduleTimeModal: () => { modalOpens++; } },
        "./components/ViewScheduledModal": {},
        "./utils": {
            loadScheduledMessages: (isCurrent: () => boolean) => {
                const pending = deferred<void>();
                loads.push({ pending, isCurrent });
                return pending.promise;
            },
            startScheduler: () => { starts++; },
            recreatePhantomMessages: () => { recreates++; },
            stopScheduler: () => {}, cleanupAllPhantomMessages: () => {}
        }
    }, {
        FileReader: class {
            result = "data:text/plain;base64,fixture";
            onload = () => {};
            readAsDataURL() { finishRead = () => this.onload(); }
        }
    });
    changeInterval();
    assert.equal(starts, 0);
    const first = api.default.start();
    api.default.stop();
    changeInterval();
    assert.equal(starts, 0);
    const second = api.default.start();
    assert.equal(loads[0].isCurrent(), false);
    assert.equal(loads[1].isCurrent(), true);
    loads[1].pending.resolve();
    await second;
    loads[0].pending.resolve();
    await first;
    assert.equal(starts, 1);
    assert.equal(recreates, 1);
    const third = api.default.start();
    api.default.stop();
    loads[2].pending.resolve();
    await third;
    assert.equal(starts, 1);
    const attachmentRead = api.default.onBeforeMessageSend("channel", { content: "owner private text" }, { uploads: [{ filename: "fixture.txt", item: { file: { type: "text/plain" } } }] });
    accountId = "other";
    finishRead();
    await attachmentRead;
    assert.equal(modalOpens, 0);
    accountId = "owner";
    await api.default.onBeforeMessageSend("channel", { content: "owner text" }, {});
    assert.equal(modalOpens, 1);
});

interface QueueFixtureMessage {
    id: string;
    ownerUserId?: string;
    channelId: string;
    content: string;
    scheduledTime: number;
    attachments?: { filename: string; data: string; type: string; }[];
    reactions?: { emoji: { id: null; name: string; }; count: number; }[];
}

function schedulerFixture(messages: QueueFixtureMessage[], options: { post?: Promise<void>; fetchMessages?: Promise<void>; showPhantoms?: boolean; retryReaction?: boolean; get?: () => Promise<QueueFixtureMessage[]>; onDelete?: () => void; } = {}) {
    const posts: string[] = [];
    const savedQueues: QueueFixtureMessage[][] = [];
    const reactions: string[] = [];
    const events: { type: string; }[] = [];
    const timers = new Map<number, { callback: () => void; delay: number; }>();
    const uploads: MockUpload[] = [];
    let nextTimer = 0;
    let accountId = "owner";
    class MockUpload extends EventEmitter {
        filename = "attachment.ogg";
        uploadedFilename = "uploaded";
        cancelled = false;
        constructor() { super(); uploads.push(this); }
        async upload() {}
        cancel() { this.cancelled = true; }
    }
    const api = loadModule<{
        loadScheduledMessages(isCurrent?: () => boolean): Promise<void>;
        startScheduler(): void;
        stopScheduler(): void;
        cleanupAllPhantomMessages(): void;
        createPhantomMessage(msg: QueueFixtureMessage): Promise<void>;
        getScheduledMessages(): QueueFixtureMessage[];
        addScheduledMessage(channelId: string, content: string, scheduledTime: number): Promise<{ success: boolean; }>;
    }>("src/equicordplugins/scheduledMessages/utils.ts", {
        "@api/DataStore": { get: options.get ?? (async () => messages.map(msg => ({ ...msg }))), set: async (_key: string, queue: QueueFixtureMessage[]) => { savedQueues.push(Array.from(queue, msg => ({ ...msg }))); } },
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@vencord/discord-types/enums": { CloudUploadPlatform: {} },
        ".": { settings: { store: { showPhantomMessages: options.showPhantoms ?? false, showNotifications: false, checkIntervalSeconds: 10 } } },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ isDM: () => false, isGroupDM: () => false, isMultiUserDM: () => false }) },
            CloudUploader: MockUpload,
            Constants: { Endpoints: { MESSAGES: (channel: string) => channel } },
            FluxDispatcher: { dispatch: (event: { type: string; }) => {
                events.push(event);
                if (event.type === "MESSAGE_DELETE") options.onDelete?.();
            } },
            MessageActions: { fetchMessages: () => options.fetchMessages ?? Promise.resolve() },
            MessageStore: { hasPresent: () => false, getMessages: () => ({ _array: [{ id: "actual-message", author: { id: "owner" }, content: messages[0]?.content }] }) },
            RestAPI: {
                post: ({ body }: { body: { content: string; }; }) => { posts.push(body.content); return options.post ?? Promise.resolve(); },
                put: async ({ url }: { url: string; }) => {
                    reactions.push(url);
                    if (options.retryReaction) throw { status: 429, body: { retry_after: 1 } };
                }
            },
            SnowflakeUtils: { fromTimestamp: () => "nonce" },
            UserStore: { getCurrentUser: () => ({ id: accountId, username: "fixture" }) }
        }
    }, {
        File: class {}, atob: () => "audio",
        setTimeout: (callback: () => void, delay: number) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
        clearTimeout: (timer: number) => { timers.delete(timer); }
    });
    return {
        ...api, posts, savedQueues, reactions, events, timers, uploads,
        setAccount: (id: string) => { accountId = id; },
        async fire(delay: number) {
            const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
            assert.ok(entry, `Missing timer with delay ${delay}`);
            timers.delete(entry[0]);
            entry[1].callback();
            await flushMicrotasks();
        }
    };
}

function queued(id: string): QueueFixtureMessage {
    return { id, ownerUserId: "owner", channelId: "channel", content: id, scheduledTime: 0 };
}

test("persisted queues send only for their owner and retain unowned legacy entries", async () => {
    const legacy = queued("legacy");
    delete legacy.ownerUserId;
    const fixture = schedulerFixture([legacy, queued("account-a")], { showPhantoms: true });
    await fixture.loadScheduledMessages();
    assert.equal(fixture.savedQueues.length, 0);
    fixture.setAccount("account-b");
    await fixture.createPhantomMessage(queued("account-a"));
    await fixture.createPhantomMessage(legacy);
    fixture.startScheduler();
    await flushMicrotasks();
    assert.deepEqual(fixture.posts, []);
    assert.equal(fixture.events.length, 0);
    assert.equal(fixture.getScheduledMessages().length, 2);
    assert.equal(fixture.getScheduledMessages()[0].ownerUserId, undefined);
    assert.equal(fixture.savedQueues.length, 0);
    await fixture.fire(10000);
    assert.deepEqual(fixture.posts, []);
    fixture.setAccount("owner");
    await fixture.fire(10000);
    assert.deepEqual(fixture.posts, ["account-a"]);
    assert.deepEqual(Array.from(fixture.getScheduledMessages(), msg => msg.id), ["legacy"]);
    assert.deepEqual(fixture.savedQueues.at(-1), [legacy]);
    fixture.stopScheduler();
});

test("newly scheduled messages persist creator ownership across stop and account changes", async () => {
    const fixture = schedulerFixture([]);
    await fixture.loadScheduledMessages();
    assert.equal((await fixture.addScheduledMessage("channel", "new", 0)).success, true);
    assert.equal(fixture.getScheduledMessages()[0].ownerUserId, "owner");
    assert.equal(fixture.savedQueues.at(-1)?.[0].ownerUserId, "owner");
    fixture.setAccount("account-b");
    fixture.startScheduler();
    await flushMicrotasks();
    assert.deepEqual(fixture.posts, []);
    fixture.stopScheduler();
    fixture.setAccount("owner");
    fixture.startScheduler();
    await flushMicrotasks();
    assert.deepEqual(fixture.posts, ["new"]);
    assert.equal(fixture.getScheduledMessages().length, 0);
    fixture.stopScheduler();
});

test("management UI exposes paused legacy entries even when their channel is unavailable", () => {
    const legacy = queued("legacy-content");
    delete legacy.ownerUserId;
    const api = loadModule<{ ViewScheduledModal(props: unknown): unknown; }>("src/equicordplugins/scheduledMessages/components/ViewScheduledModal.tsx", {
        "@components/Button": { Button: "button" },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/css": { classNameFactory: () => (value: string) => value },
        "@webpack/common": {
            ChannelStore: { getChannel: () => undefined },
            Modal: "modal",
            UserStore: { getCurrentUser: () => ({ id: "other-account" }) },
            useState: (value: unknown) => [value, () => {}]
        },
        "../utils": {
            getScheduledMessages: () => [legacy, queued("owned-content")],
            getChannelDisplayInfo: () => ({ name: "Unknown", avatar: "" })
        },
        "./Icons": { CalendarIcon: "calendar", TimerIcon: "timer" }
    }, { React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) } });
    const rendered = JSON.stringify(api.ViewScheduledModal({ rootProps: {}, close: () => {} }));
    assert.ok(rendered.includes("legacy-content"));
    assert.ok(rendered.includes("Paused — account ownership unknown"));
    assert.ok(rendered.includes("Paused — scheduled by another account"));
    assert.ok(rendered.includes("Clear All removes every queued message across accounts"));
});

test("logged-out scheduler keeps a bounded check and resumes only for the owning account", async () => {
    const fixture = schedulerFixture([queued("login")]);
    await fixture.loadScheduledMessages();
    fixture.setAccount("");
    assert.equal((await fixture.addScheduledMessage("channel", "logged-out", 0)).success, false);
    assert.equal(fixture.savedQueues.length, 0);
    fixture.startScheduler();
    assert.deepEqual(fixture.posts, []);
    assert.equal(fixture.timers.size, 1);
    await fixture.fire(10000);
    assert.deepEqual(fixture.posts, []);
    assert.equal(fixture.timers.size, 1);
    fixture.setAccount("owner");
    await fixture.fire(10000);
    assert.deepEqual(fixture.posts, ["login"]);
    fixture.stopScheduler();
    assert.equal(fixture.timers.size, 0);
});

test("stopped storage loads cannot replace the queue", async () => {
    const pending = deferred<QueueFixtureMessage[]>();
    const fixture = schedulerFixture([], { get: () => pending.promise });
    let current = true;
    const load = fixture.loadScheduledMessages(() => current);
    current = false;
    pending.resolve([queued("stale")]);
    await load;
    assert.equal(fixture.getScheduledMessages().length, 0);
});

test("stop cancels attachment uploads, preserves unsent queue and restart sends once", async () => {
    const message = { ...queued("attachment"), attachments: [{ filename: "audio.ogg", data: "audio", type: "audio/ogg" }] };
    const fixture = schedulerFixture([message]);
    await fixture.loadScheduledMessages();
    fixture.startScheduler();
    assert.equal(fixture.uploads.length, 1);
    fixture.stopScheduler();
    await flushMicrotasks();
    assert.equal(fixture.uploads[0].cancelled, true);
    assert.equal(fixture.uploads[0].listenerCount("complete"), 0);
    assert.equal(fixture.posts.length, 0);
    assert.equal(fixture.getScheduledMessages().length, 1);
    assert.equal(fixture.timers.size, 0);
    fixture.startScheduler();
    fixture.uploads[1].emit("complete");
    await flushMicrotasks();
    assert.deepEqual(fixture.posts, ["attachment"]);
    assert.equal(fixture.getScheduledMessages().length, 0);
    fixture.stopScheduler();
});

test("reentrant stop during phantom removal cannot start a message post", async () => {
    let stop = () => {};
    const fixture = schedulerFixture([queued("reentrant")], { onDelete: () => stop() });
    stop = fixture.stopScheduler;
    await fixture.loadScheduledMessages();
    fixture.startScheduler();
    await flushMicrotasks();
    assert.equal(fixture.posts.length, 0);
    assert.equal(fixture.getScheduledMessages().length, 1);
    assert.equal(fixture.timers.size, 0);
});

test("restart during an in-flight post does not duplicate it or send the next message from the old run", async () => {
    const posted = deferred<void>();
    const fixture = schedulerFixture([queued("first"), queued("second")], { post: posted.promise });
    await fixture.loadScheduledMessages();
    fixture.startScheduler();
    fixture.stopScheduler();
    fixture.startScheduler();
    assert.deepEqual(fixture.posts, ["first"]);
    posted.resolve();
    await flushMicrotasks();
    assert.deepEqual(fixture.posts, ["first"]);
    assert.equal(fixture.getScheduledMessages().length, 1);
    await fixture.fire(0);
    assert.deepEqual(fixture.posts, ["first", "second"]);
    assert.equal(fixture.getScheduledMessages().length, 0);
    fixture.stopScheduler();
});

test("inactive failed sends retain the queue after stop or account switch", async () => {
    for (const cancellation of ["stop", "account-switch"]) {
        const posted = deferred<void>();
        const fixture = schedulerFixture([queued(cancellation)], { post: posted.promise });
        await fixture.loadScheduledMessages();
        fixture.startScheduler();
        if (cancellation === "stop") fixture.stopScheduler();
        else fixture.setAccount("different-owner");
        posted.reject(new Error("Unsent request failed"));
        await flushMicrotasks();
        assert.equal(fixture.getScheduledMessages().length, 1, cancellation);
        assert.deepEqual(fixture.posts, [cancellation]);
        fixture.stopScheduler();
        assert.equal(fixture.timers.size, 0);
    }
});

test("stop clears reaction waits and prevents a reaction retry", async () => {
    const message = { ...queued("react"), reactions: [{ emoji: { id: null, name: "ok" }, count: 1 }] };
    const fixture = schedulerFixture([message], { retryReaction: true });
    await fixture.loadScheduledMessages();
    fixture.startScheduler();
    await flushMicrotasks();
    await fixture.fire(1500);
    assert.equal(fixture.reactions.length, 1);
    fixture.stopScheduler();
    await flushMicrotasks();
    assert.equal(fixture.reactions.length, 1);
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.getScheduledMessages().length, 0);
});

test("stop suppresses phantom dispatch after message history finishes loading", async () => {
    const history = deferred<void>();
    const fixture = schedulerFixture([], { showPhantoms: true, fetchMessages: history.promise });
    await fixture.createPhantomMessage(queued("phantom"));
    fixture.stopScheduler();
    fixture.cleanupAllPhantomMessages();
    history.resolve();
    await flushMicrotasks();
    assert.equal(fixture.events.filter(event => event.type === "MESSAGE_CREATE").length, 0);
});

test("timezone OAuth accepts only its captured callback origin and path", async () => {
    let databaseUrl = "https://fixture.invalid";
    let modal: any;
    const requests: { url: string; options: RequestInit; }[] = [];
    let authorized = 0;
    let closeAuth = () => {};
    const api = loadModule<{ authModal(callback: () => void): void; setTimezone(timezone: string): Promise<boolean>; deleteTimezone(): Promise<boolean>; }>("src/equicordplugins/timezones/database.tsx", {
        "@utils/index": { openModal: (render: (props: unknown) => unknown, options: { onCloseCallback(): void; }) => { modal = render({}); closeAuth = options.onCloseCallback; } },
        "@webpack/common": { showToast() { }, Toasts: { Type: {} } },
        ".": { settings: { store: { get databaseUrl() { return databaseUrl; } } } }
    }, {
        React: { createElement: (_type: unknown, props: unknown) => ({ props }) },
        console: { error() { }, warn() { } },
        fetch: async (url: URL, options: RequestInit) => { requests.push({ url: String(url), options }); return new Response("{}", { status: String(url).endsWith("/me") ? 401 : 200 }); }
    });
    api.authModal(() => { authorized++; });
    databaseUrl = "https://changed.invalid";
    for (const location of ["https://other.invalid/auth/discord/callback?code=fixture", "https://fixture.invalid/wrong", "https://name:pass@fixture.invalid/auth/discord/callback"]) {
        await modal.props.callback({ location });
        assert.equal(requests.length, 0);
    }
    await modal.props.callback({ location: "https://fixture.invalid/auth/discord/callback?code=fixture" });
    assert.equal(requests.length, 0);
    databaseUrl = "https://fixture.invalid";
    await modal.props.callback({ location: "https://fixture.invalid/auth/discord/callback?code=fixture" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.redirect, "error");
    assert.equal(requests[0].options.credentials, "include");
    assert.ok(requests[0].options.signal);
    assert.equal(authorized, 1);
    for (const action of [() => api.setTimezone("Etc/UTC"), () => api.deleteTimezone()]) {
        const pending = action();
        await flushMicrotasks();
        closeAuth();
        assert.equal(await pending, false);
    }
    assert.equal(requests.length, 3);
});

test("favorite GIF reachability cancels unused bodies and bounds each request", async () => {
    const requests: RequestInit[] = [];
    let cancellations = 0;
    const api = loadModule<{ isGifReachable(url: string): Promise<boolean>; }>("src/equicordplugins/saveFavoriteGIFs/index.tsx", {
        "@api/Commands": { ApplicationCommandInputType: {} }, "@api/Notifications": {}, "@api/PluginManager": {},
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@equicordplugins/equicordToolbox": { __esModule: true, default: {} },
        "@utils/constants": { Devs: {} }, "@utils/Logger": { Logger: class { } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@utils/web": {}, "@webpack/common": {}
    }, {
        fetch: async (_url: string, options: RequestInit) => {
            requests.push(options);
            return { ok: requests.length !== 1, body: { cancel: async () => { cancellations++; } } };
        }
    }, "\nexports.isGifReachable = isGifReachable;");
    assert.equal(await api.isGifReachable("https://fixture.invalid/gif"), true);
    assert.equal(cancellations, 2);
    assert.equal(requests.length, 2);
    for (const options of requests) {
        assert.equal(options.credentials, "omit");
        assert.ok(options.signal);
    }
});

test("an open scheduling form cannot claim old-account content after an account switch", async () => {
    let accountId = "owner";
    let scheduled = 0;
    let cleared = 0;
    const errors: string[] = [];
    const react = { createElement: (type: unknown, props: Record<string, any>, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const api = loadModule<{ ScheduleTimeModal(props: unknown): { props: { actions: { onClick(): Promise<void>; }[]; }; }; }>(
        "src/equicordplugins/scheduledMessages/components/ScheduleTimeModal.tsx", {
            "@components/Button": {}, "@components/Heading": {},
            "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
            "@utils/css": { classNameFactory: () => () => "" },
            "@webpack": { findByPropsLazy: () => ({ dispatchToLastSubscribed: () => { cleared++; } }) },
            "@webpack/common": {
                UserStore: { getCurrentUser: () => ({ id: accountId }) },
                ChannelStore: { getChannel: () => ({ isPrivate: () => false }) },
                useRef: (value: unknown) => ({ current: value }),
                useState: (value: string) => [value, (next: string) => errors.push(next)],
                UploadManager: { clearAll() { } }, DraftType: {}, Toasts: { Type: {} }, showToast() { }
            },
            "../utils": { getChannelDisplayInfo: () => ({}), addScheduledMessage: async () => { scheduled++; return { success: true }; } },
            "./Icons": {}
        }, { React: react }
    );
    const modal = api.ScheduleTimeModal({ channelId: "channel", content: "private owner text", rootProps: {}, close() { } });
    accountId = "other";
    await modal.props.actions[0].onClick();
    assert.equal(scheduled, 0);
    assert.equal(cleared, 0);
    assert.match(errors[0], /Account changed/);
    accountId = "owner";
    await modal.props.actions[0].onClick();
    assert.equal(scheduled, 1);
    assert.equal(cleared, 1);
});

test("AudioBookShelf credentials cannot follow redirects or use ambient cookies", async () => {
    const requests: RequestInit[] = [];
    const api = loadModule<{ authenticate(store: unknown, update: unknown): Promise<boolean>; fetchMediaData(store: unknown, update: unknown): Promise<unknown>; }>(
        "src/equicordplugins/richPresence/services/audiobookshelf.ts", {
            "@utils/Logger": { Logger: class { error() { } warn() { } } },
            "@webpack/common": { FluxDispatcher: {}, showToast() { } },
            "./assetCache": {}, "./polling": { createPresencePolling: () => ({}) }
        }, {
            fetch: async (_url: string, options: RequestInit) => {
                requests.push(options);
                return new Response(JSON.stringify(requests.length === 1 ? { user: { token: "fixture-token" } } : { sessions: [] }));
            }
        }, "\nexports.authenticate = authenticate; exports.fetchMediaData = fetchMediaData;"
    );
    const store = { abs_serverUrl: "https://fixture.invalid", abs_username: "fixture", abs_password: "fixture-password" };
    const update = { isCurrent: () => true, wait: <T>(value: Promise<T>) => value, signal: new AbortController().signal };
    assert.equal(await api.authenticate(store, update), true);
    assert.equal(await api.fetchMediaData(store, update), null);
    assert.equal(requests.length, 2);
    for (const options of requests) {
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "omit");
        assert.equal(options.signal, update.signal);
    }
});

test("split messages do not send further chunks after stop/start or account switch", async () => {
    for (const cancellation of ["restart", "account-switch", "ordinary-failure"]) {
        let accountId = "owner";
        const firstPost = deferred<void>();
        const posts: string[] = [];
        const restored: string[] = [];
        const api = loadModule<{ default: { start(): void; stop(): void; onBeforeMessageSend(channel: string, message: { content: string; }): Promise<{ cancel: boolean; }>; }; }>(
            "src/equicordplugins/splitLargeMessages/index.ts", {
                "@api/MessageEvents": { addMessageLengthBypassListener() { }, removeMessageLengthBypassListener() { } },
                "@api/Settings": { definePluginSettings: () => ({ store: { splitMode: "characters", sendDelay: 1 } }) },
                "@utils/constants": { EquicordDevs: {} },
                "@utils/discord": {
                    sendMessage: (_channel: string, message: { content: string; }) => { posts.push(message.content); return firstPost.promise; },
                    getCurrentChannel: () => ({ id: "channel" }),
                    insertTextIntoChatInputBox: (text: string) => restored.push(text),
                    copyWithToast() { assert.fail("No clipboard access permitted"); }
                },
                "@utils/Logger": { Logger: class { error() { } } },
                "@utils/misc": { sleep: async () => { } },
                "@utils/types": { __esModule: true, default: (value: unknown) => value, makeRange: () => [], OptionType: {} },
                "@webpack/common": {
                    UserStore: { getCurrentUser: () => ({ id: accountId }) },
                    ChannelStore: { getChannel: () => ({ rateLimitPerUser: 0 }) },
                    PermissionsBits: {}, PermissionStore: { can: () => false },
                    ComponentDispatch: { dispatchToLastSubscribed() { } },
                    Toasts: { show() { }, Type: {} }
                },
                "./splitMessage": { splitMessage: () => ["first", "unsent"] }
            }
        ).default;
        api.start();
        const pending = api.onBeforeMessageSend("channel", { content: "x".repeat(2001) });
        if (cancellation === "restart") { api.stop(); api.start(); }
        if (cancellation === "account-switch") accountId = "other";
        if (cancellation === "ordinary-failure") firstPost.reject(new Error("Not delivered"));
        else firstPost.resolve();
        assert.equal((await pending).cancel, true);
        assert.deepEqual(posts, ["first"], cancellation);
        assert.deepEqual(restored, cancellation === "restart" ? ["unsent"] : cancellation === "ordinary-failure" ? ["firstunsent"] : [], cancellation);
        api.stop();
    }
});

test("universal mention cache does not survive account switches, logout or stop", () => {
    let accountId: string | undefined = "first";
    let users = { member: { id: "member-first" } };
    const api = loadModule<{ default: { useFilter(map?: boolean): { id: string; }[]; stop(): void; }; }>("src/equicordplugins/universalMention/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { onlyDMUsers: false } }) },
        "@components/Notice": {},
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => accountId ? { id: accountId } : undefined, getUsers: () => users, removeChangeListener() {} },
            ChannelStore: {}
        }
    });
    assert.equal(api.default.useFilter()[0].id, "member-first");
    accountId = "second";
    users = { member: { id: "member-second" } };
    assert.equal(api.default.useFilter()[0].id, "member-second");
    accountId = undefined;
    assert.equal(api.default.useFilter().length, 0);
    accountId = "second";
    api.default.useFilter();
    api.default.stop();
    users = { member: { id: "new-member-second" } };
    assert.equal(api.default.useFilter()[0].id, "new-member-second");
});
