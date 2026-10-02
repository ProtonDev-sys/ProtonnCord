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

const root = "src/equicordplugins/songSpotlight.desktop/";
const prefix = "@equicordplugins/songSpotlight.desktop/";
const song = (id: string) => ({ service: "spotify", type: "track", id });
const sid = (value: any) => `${value.service}:${value.type}:${value.id}`;
const React = { createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };

function load(file: string, mocks: Record<string, unknown>, extra = "", globals = {}) {
    const code = transpileModule(readFileSync(root + file, "utf8") + extra, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext, jsx: JsxEmit.React }
    }).outputText;
    const imports = Object.fromEntries(Array.from(code.matchAll(/require\("([^"]+)"\)/g), match => [match[1], {}]));
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, URL, Headers, AbortSignal, structuredClone, ...globals,
        require: (name: string) => ({ ...imports, ...mocks })[name]
    });
}

function hooks() {
    const slots: any[] = [];
    let cursor = 0;
    const effects: (() => void)[] = [];
    return {
        begin() { cursor = 0; },
        flush() { effects.splice(0).forEach(effect => effect()); },
        useState(value: any) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = value;
            return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
        },
        useRef(value: any) {
            const index = cursor++;
            return slots[index] ??= { current: value };
        },
        useEffect(effect: () => void, deps: any[]) {
            const index = cursor++;
            if (!slots[index] || deps.some((value, i) => value !== slots[index][i])) effects.push(effect);
            slots[index] = deps;
        },
        useMemo: (fn: () => any) => fn(),
        useCallback: (fn: unknown) => fn
    };
}

function find(node: any, predicate: (node: any) => boolean): any {
    if (!node || typeof node !== "object") return;
    if (predicate(node)) return node;
    for (const child of (Array.isArray(node) ? node : node.props?.children ?? [])) {
        const found = find(child, predicate);
        if (found) return found;
    }
}

function settingsFixture(initial: any[], template?: any[]) {
    const hook = hooks();
    let self = { data: initial };
    const tokens: Record<string, boolean> = { owner: true, other: true };
    const notices: string[] = [];
    const api = load("ui/settings/index.tsx", {
        "@webpack/common": {
            ...hook, UserStore: { getCurrentUser: () => ({ id: "owner" }) },
            useStateFromStores: (_: unknown, fn: () => unknown) => fn(),
            Parser: { parse: () => "command" }, Toasts: { Type: { FAILURE: "failure" } },
            showToast: (message: string) => notices.push(message)
        },
        "@components/Button": { Button: "button" },
        [prefix + "lib/stores/AuthorizationStore"]: { useAuthorizationStore: () => ({ isAuthorized: () => true, deleteTokens: (id: string) => { delete tokens[id]; } }) },
        [prefix + "lib/stores/SongStore"]: { useSongStore: () => ({ self }) },
        [prefix + "lib/utils"]: { cl: (value: string) => value },
        [prefix + "lib/api"]: { apiConstants: { songLimit: 6 } },
        [prefix + "ui/settings/SongList"]: { __esModule: true, default: "list" },
        [prefix + "service"]: { Native: { validateSong: async () => true } },
        "@song-spotlight/api/structs": { UserDataSchema: { max: () => ({ safeParse: (data: any) => ({ data }) }) } },
        "@song-spotlight/api/util": { sid },
        "@utils/clipboard": { readClipboard: async () => JSON.stringify([song("duplicate"), song("duplicate")]) }
    }, "\nexport { ImportButton };\n");
    return {
        api, notices, tokens,
        update(data: any[]) { self = { data }; },
        render() { hook.begin(); const tree = api.default({ templateData: template }); hook.flush(); return tree; }
    };
}

test("RZ4-04: refresh follows pristine drafts but preserves unsaved edits and templates", () => {
    const fixture = settingsFixture([song("original")]);
    let tree = fixture.render();
    fixture.update([song("refresh")]);
    fixture.render();
    tree = fixture.render();
    const list = find(tree, node => node.type === "list");
    assert.equal(list.props.localData[0].id, "refresh");
    list.props.setLocalData([song("draft")]);
    fixture.update([song("external")]);
    fixture.render();
    assert.equal(find(fixture.render(), node => node.type === "list").props.localData[0].id, "draft");
    const suggested = settingsFixture([song("existing")], [song("existing"), song("suggested")]);
    suggested.render();
    assert.equal(find(suggested.render(), node => node.type === "list").props.localData.length, 2);
    assert.equal(find(suggested.render(), node => node.type === "button" && node.props.children.includes("Save")).props.disabled, false);
});

test("RZ4-03 and preserved RZ4-01: duplicate imports do not mutate drafts; sign-out is account scoped", async () => {
    const fixture = settingsFixture([]);
    let imported = false;
    const pending: boolean[] = [];
    const button = fixture.api.ImportButton({ overwrite: false, pending: false, setPending: (value: boolean) => pending.push(value), onImport: () => { imported = true; } });
    await button.props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(imported, false);
    assert.equal(pending.at(-1), false);
    assert.match(fixture.notices[0], /Invalid/);
    find(fixture.render(), node => node.type === "button" && node.props.children.includes("Sign out")).props.onClick();
    assert.deepEqual(fixture.tokens, { other: true });
});

test("RZ4-02 and RZ4-06: steal loads existing songs, enforces limits, and catches parser failure", async () => {
    for (const mode of ["success", "duplicate", "full", "parseFailure", "accountSwitch"]) {
        let account = "owner";
        const drafts: any[][] = [];
        const notices: string[] = [];
        let reads = 0;
        const api = load("ui/songs/index.tsx", {
            "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: account }) }, showToast: (value: string) => notices.push(value), Toasts: { Type: {} } },
            [prefix + "lib/api"]: { apiConstants: { songLimit: 6 }, getData: async () => {
                reads++;
                if (mode === "accountSwitch") account = "other";
                return mode === "full" ? Array.from({ length: 6 }, (_, i) => song(String(i))) : [song(mode === "duplicate" ? "suggested" : "existing")];
            } },
            [prefix + "lib/stores/SongStore"]: { useSongStore: { getState: () => ({ users: {} }) } },
            [prefix + "service"]: { Native: { parseLink: async () => {
                if (mode === "parseFailure") throw new Error("offline fixture");
                return song("suggested");
            } } },
            [prefix + "ui/settings"]: { openSettingsModal: (data: any[]) => drafts.push(data) },
            "@song-spotlight/api/util": { sid }
        }, "\nexport { stealSong };\n");
        await api.stealSong("fixture link");
        assert.equal(drafts.length, mode === "success" ? 1 : 0);
        if (mode === "success") assert.deepEqual(Array.from(drafts[0], value => value.id), ["existing", "suggested"]);
        if (mode === "parseFailure") assert.match(notices[0], /Failed/);
        assert.equal(reads, mode === "parseFailure" ? 0 : 1);
    }
});

test("RZ4-10: delayed profile JSON cannot update the cache after account switch", async () => {
    let account = "owner";
    let resolve!: (data: unknown) => void;
    let parsing!: () => void;
    const started = new Promise<void>(yes => { parsing = yes; });
    const body = new Promise(yes => { resolve = yes; });
    const updates: unknown[] = [];
    const api = load("lib/api.ts", {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: account }) }, showToast() {}, Toasts: { Type: {} } },
        "@song-spotlight/api/structs": { UserDataSchema: { max: () => ({ parse: (data: unknown) => data }) } },
        "./stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({ getToken: () => undefined }) } },
        "./stores/SongStore": { useSongStore: { getState: () => ({ users: {}, update: (data: unknown) => updates.push(data) }) } }
    }, "", { fetch: async () => ({ ok: true, headers: new Headers(), json: () => { parsing(); return body; } }) });
    const request = api.listData("profile");
    await started;
    account = "other";
    resolve([song("stale")]);
    await assert.rejects(request, /account changed/);
    assert.equal(updates.length, 0);
});

test("RZ4-05: drag cancellation clears markers without reordering; successful drop reorders", () => {
    const hook = hooks();
    let data = [song("first"), song("second")];
    let changes = 0;
    const api = load("ui/settings/SongList.tsx", {
        "@webpack/common": { ...hook, React },
        [prefix + "lib/utils"]: { cl: (value: string) => value },
        [prefix + "lib/api"]: { apiConstants: { songLimit: 6 } },
        "@song-spotlight/api/util": { sid }
    });
    const render = () => {
        hook.begin();
        return api.default({ localData: data, setLocalData: (next: any[]) => { data = next; changes++; } });
    };
    let tree = render();
    const entries = tree.props.children[0];
    entries.slice(0, 2).forEach((entry: any, i: number) => entry.props.setSongRef(i, { getBoundingClientRect: () => ({ top: i * 40, bottom: (i + 1) * 40, height: 40 }) }));
    entries[0].props.onDrag(0, { clientY: 79 });
    tree = render();
    tree.props.children[0][0].props.onDragEnd();
    assert.equal(changes, 0);
    tree = render();
    assert.equal(tree.props.children[0][1].props.insert, undefined);
    tree.props.children[0][0].props.onDrag(0, { clientY: 79 });
    tree = render();
    tree.props.onDrop({ preventDefault() {} });
    assert.equal(changes, 1);
    assert.deepEqual(Array.from(data, value => value.id), ["second", "first"]);
});

test("RZ4-07: compact player reveals controls on keyboard focus", () => {
    const css = readFileSync(root + "style.css", "utf8");
    assert.match(css, /\.vc-songspotlight-song:focus-within \.vc-songspotlight-song-player\s*\{\s*opacity: 1;/);
    assert.match(readFileSync(root + "ui/common.tsx", "utf8"), /<button[\s\S]*aria-label=\{state \? "Pause song preview" : "Play song preview"\}/);
});
