/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isMethodDeclaration, isObjectLiteralExpression, isPropertyAssignment, isRegularExpressionLiteral, isStringLiteral, JsxEmit, ModuleKind, type Node, type ObjectLiteralExpression, ScriptTarget, transpileModule } from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";

const source = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8");
const parsed = createSourceFile("index.tsx", source, ScriptTarget.Latest, true);

function property(object: ObjectLiteralExpression, name: string) {
    const found = object.properties.find(value => isPropertyAssignment(value) && value.name.getText() === name);
    assert.ok(found && isPropertyAssignment(found), `Missing ${name}`);
    return found.initializer;
}

function regex(node: Node) {
    assert.ok(isRegularExpressionLiteral(node));
    const literal = node.getText();
    const end = literal.lastIndexOf("/");
    return canonicalizeMatch(new RegExp(literal.slice(1, end), literal.slice(end + 1)));
}

const patches = new Map<string, { find: string | RegExp; match: RegExp; replace: string; }>();
let handlerSource = "";
let fileActionsSource = "";
function visit(node: Node) {
    if (isObjectLiteralExpression(node) && node.properties.some(value => isPropertyAssignment(value) && value.name.getText() === "find") &&
        /\$self\.(?:downloadEncryptedAttachment|encryptedFileActions|renderZipPreview)/.test(node.getText())) {
        const find = property(node, "find");
        const replacement = property(node, "replacement");
        assert.ok(isObjectLiteralExpression(replacement));
        const replace = property(replacement, "replace");
        assert.ok(isStringLiteral(replace));
        const text = node.getText();
        const kind = text.includes("renderZipPreview") ? "zip" : text.includes("encryptedFileActions") ? "file" : text.includes("getDefaultLinkInterceptor") ? "common" : "video";
        patches.set(kind, {
            find: isStringLiteral(find) ? canonicalizeMatch(find.text) : regex(find),
            match: regex(property(replacement, "match")),
            replace: replace.text,
        });
    }
    if (isMethodDeclaration(node) && node.name.getText() === "downloadEncryptedAttachment") handlerSource = node.getText();
    if (isMethodDeclaration(node) && node.name.getText() === "encryptedFileActions") fileActionsSource = node.getText();
    node.forEachChild(visit);
}
visit(parsed);
assert.equal(patches.size, 3);
assert.ok(handlerSource && fileActionsSource);
visit(createSourceFile("zipPreview.tsx", readFileSync(new URL("../src/equicordplugins/zipPreview/index.tsx", import.meta.url), "utf8"), ScriptTarget.Latest, true));
assert.equal(patches.size, 4);

function patch(kind: string, fixture: string, checkFind = true) {
    const selected = patches.get(kind);
    assert.ok(selected);
    if (checkFind) assert.ok(typeof selected.find === "string" ? fixture.includes(selected.find) : selected.find.test(fixture));
    const matches = [...fixture.matchAll(new RegExp(selected.match.source, "g"))];
    assert.equal(matches.length, 1, `${kind} download callback must match exactly once`);
    return fixture.replace(selected.match, selected.replace);
}

function downloadHandler() {
    const registered = new Set(["blob:https://discord.com/secure-first", "blob:https://discord.com/secure-second"]);
    const saved: string[] = [];
    const nativeDownload = Symbol("NativeAttachmentDownload");
    const script = transpileModule(`const plugin = { ${handlerSource}, ${fileActionsSource} }; plugin;`, {
        fileName: "index.tsx",
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ESNext },
    }).outputText;
    const plugin = runInNewContext(script, {
        isEncryptedAttachmentDownloadUrl: (url: string) => registered.has(url),
        saveEncryptedAttachment: async (url: string) => { saved.push(url); },
        NativeAttachmentDownload: nativeDownload,
        React: { createElement: (type: unknown, props: Record<string, unknown>) => ({ type, props }) },
    }) as {
        downloadEncryptedAttachment(url: unknown, event?: ReturnType<typeof clickEvent>): boolean;
        encryptedFileActions(url: unknown, original?: () => unknown): unknown;
    };
    return { plugin, saved, registered, nativeDownload };
}

function clickEvent(href?: string) {
    return {
        currentTarget: href === undefined ? undefined : { href },
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
    };
}

const commonFixture = 'function Download(p){let{href:u,mimeType:m,onClick:c}=p,l=R.useMemo(()=>U.V.getDefaultLinkInterceptor(u),[u]),h=R.useCallback(e=>{A.default.track(B.HAw.MEDIA_DOWNLOAD_BUTTON_TAPPED,{attachment_type:m?.[0],attachment_subtype:m?.[1]}),c?.(),l?.(e)},[l,m,c]);return{href:u,onClick:h}}return Download;';
const videoFixture = 'function preview(u){return window.open(u,"_blank")}function Video(u,m){return R.useCallback(()=>{if(null==u)return;let p=m?.split("/");A.default.track(B.HAw.MEDIA_DOWNLOAD_BUTTON_TAPPED,{attachment_type:p?.[0],attachment_subtype:p?.[1]}),window.open(u,"_blank")},[u,m])}return{Video,preview,testId:"discord-web-video-player-download-btn"};';
const fileFixture = 'function File(e){let{url:u,onClick:h,renderAdjacentContent:c}=e;return J.jsxs("div",{className:join(S.outer),children:[J.jsxs("div",{className:S.inner,children:[]}),{href:u,onClick:h,alt:G.t.g6KdFv},null!=c&&c()]})}return File;';

test("generic encrypted file rows gain a native download icon when their action slot is empty", () => {
    const { plugin, nativeDownload, saved } = downloadHandler();
    const render = new Function("$self", "G", "J", "S", "join", patch("file", fileFixture))(plugin, { t: { g6KdFv: "synthetic-file-alt" } }, {
        jsxs: (_type: string, props: { children: Record<string, unknown>[]; }) => ({ ...props.children[1], actions: props.children[2] }),
    }, { outer: "file", inner: "details" }, (value: string) => value) as (props: {
        url: string;
        onClick(): void;
        renderAdjacentContent?: () => unknown;
    }) => { href: string; onClick(): void; actions: { type: unknown; props: { href: string; mimeType: string[]; }; }; };
    const filenameClick = () => undefined;
    for (const original of [undefined, () => undefined, () => null, () => false]) {
        const row = render({ url: "blob:https://discord.com/secure-first", onClick: filenameClick, renderAdjacentContent: original });
        assert.equal(row.href, "blob:https://discord.com/secure-first");
        assert.equal(row.onClick, filenameClick);
        assert.equal(row.actions.type, nativeDownload);
        assert.equal(row.actions.props.href, row.href);
        assert.deepEqual(Array.from(row.actions.props.mimeType), ["application", "octet-stream"]);
    }
    assert.deepEqual(saved, []);
});

test("file action fallback preserves existing controls and leaves ordinary file rows unchanged", () => {
    const { plugin, registered } = downloadHandler();
    const existing = { type: "existing-control" };
    let calls = 0;
    const original = () => { calls++; return existing; };
    assert.equal(plugin.encryptedFileActions("blob:https://discord.com/secure-first", original), existing);
    assert.equal(calls, 1);
    for (const content of [0, "", "existing action"]) {
        assert.equal(plugin.encryptedFileActions("blob:https://discord.com/secure-first", () => content), content);
    }
    registered.clear();
    for (const url of ["https://example.com/ordinary.txt", "blob:https://discord.com/secure-first", null, undefined, 0, {}]) {
        assert.equal(plugin.encryptedFileActions(url, original), existing);
        assert.equal(plugin.encryptedFileActions(url), undefined);
        for (const content of [null, false]) assert.equal(plugin.encryptedFileActions(url, () => content), content);
    }
    assert.equal(calls, 7);
});

test("native file download controls and ZipPreview patches both match in either plugin order", () => {
    patch("zip", patch("file", fileFixture).replaceAll("$self", "Vencord.Plugins.plugins.SecureMessaging"));
    patch("file", patch("zip", fileFixture).replaceAll("$self", "Vencord.Plugins.plugins.ZipPreview"));
});

test("native download anchors use the clicked href even when React reuses their callback", () => {
    const { plugin, saved } = downloadHandler();
    let callback: { dependencies: unknown[]; value: (event: ReturnType<typeof clickEvent>) => void; } | undefined;
    let interceptions = 0;
    let downloadCallbacks = 0;
    let analytics = 0;
    const interceptor = () => { interceptions++; };
    const onDownload = () => { downloadCallbacks++; };
    const render = new Function("$self", "R", "U", "A", "B", patch("common", commonFixture))(plugin, {
        useMemo: (calculate: () => unknown) => calculate(),
        useCallback: (value: (event: ReturnType<typeof clickEvent>) => void, dependencies: unknown[]) => {
            if (!callback || dependencies.some((dependency, index) => dependency !== callback?.dependencies[index])) callback = { value, dependencies };
            return callback.value;
        },
    }, { V: { getDefaultLinkInterceptor: () => interceptor } }, { default: { track: () => { analytics++; } } }, {
        HAw: { MEDIA_DOWNLOAD_BUTTON_TAPPED: "synthetic-download" },
    }) as (props: { href: string; onClick(): void; }) => { onClick(event: ReturnType<typeof clickEvent>): void; };
    const first = render({ href: "blob:https://discord.com/secure-first", onClick: onDownload });
    const second = render({ href: "blob:https://discord.com/secure-second", onClick: onDownload });
    assert.equal(second.onClick, first.onClick);
    const encryptedClick = clickEvent("blob:https://discord.com/secure-second");
    second.onClick(encryptedClick);
    assert.deepEqual(saved, ["blob:https://discord.com/secure-second"]);
    assert.equal(encryptedClick.prevented, true);
    assert.equal(encryptedClick.stopped, true);
    assert.equal(interceptions + downloadCallbacks + analytics, 0);

    for (const href of ["https://example.com/ordinary-file.txt", "blob:https://discord.com/unregistered", undefined]) {
        const event = clickEvent(href);
        second.onClick(event);
        assert.equal(event.prevented, false);
        assert.equal(event.stopped, false);
    }
    assert.equal(interceptions, 3);
    assert.equal(downloadCallbacks, 3);
    assert.equal(analytics, 3);
    assert.equal(saved.length, 1);
});

test("native video downloads intercept registered files while preview and ordinary downloads keep working", () => {
    const { plugin, saved } = downloadHandler();
    const opened: unknown[][] = [];
    const controls = new Function("$self", "R", "A", "B", "window", patch("video", videoFixture))(plugin, {
        useCallback: (callback: () => void) => callback,
    }, { default: { track: () => undefined } }, { HAw: { MEDIA_DOWNLOAD_BUTTON_TAPPED: "synthetic-download" } }, {
        open: (...args: unknown[]) => { opened.push(args); },
    }) as { Video(url: string | null, mime: string): () => void; preview(url: string): void; };
    controls.Video("blob:https://discord.com/secure-first", "video/mp4")();
    assert.deepEqual(saved, ["blob:https://discord.com/secure-first"]);
    assert.equal(opened.length, 0);
    controls.Video("https://example.com/ordinary.mp4", "video/mp4")();
    controls.Video("blob:https://discord.com/unregistered", "video/mp4")();
    controls.Video(null, "video/mp4")();
    controls.preview("blob:https://discord.com/secure-first");
    assert.deepEqual(opened, [
        ["https://example.com/ordinary.mp4", "_blank"],
        ["blob:https://discord.com/unregistered", "_blank"],
        ["blob:https://discord.com/secure-first", "_blank"],
    ]);
    assert.equal(saved.length, 1);
});

test("unregistered or invalid download values cannot invoke the native save path", () => {
    const { plugin, saved, registered } = downloadHandler();
    registered.clear();
    for (const value of ["blob:https://discord.com/secure-first", null, undefined, 0, {}]) {
        const event = clickEvent();
        assert.equal(plugin.downloadEncryptedAttachment(value, event), false);
        assert.equal(event.prevented, false);
        assert.equal(event.stopped, false);
    }
    assert.deepEqual(saved, []);
});

const fixtureIndex = process.argv.indexOf("--public-fixture");
if (fixtureIndex !== -1) {
    const filename = process.argv[fixtureIndex + 1];
    assert.ok(filename, "Pass the public source excerpt artifact after --public-fixture");
    const artifact = JSON.parse(readFileSync(filename, "utf8")) as {
        origin: string;
        commonDownload: { source: string; };
        videoDownload: { source: string; };
        genericFile: { source: string; };
    };
    assert.equal(new URL(artifact.origin).origin, "https://discord.com");
    patch("common", artifact.commonDownload.source);
    patch("video", artifact.videoDownload.source, false);
    patch("file", artifact.genericFile.source);
    patch("zip", patch("file", artifact.genericFile.source).replaceAll("$self", "Vencord.Plugins.plugins.SecureMessaging"));
    patch("file", patch("zip", artifact.genericFile.source).replaceAll("$self", "Vencord.Plugins.plugins.ZipPreview"));
    process.stdout.write("All three download patches match their public source excerpts exactly once, including either ZipPreview patch order. Downloaded source was not executed.\n");
}
