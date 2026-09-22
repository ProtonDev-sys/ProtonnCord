/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createSourceFile, isArrayLiteralExpression, isFunctionDeclaration, isMethodDeclaration, isObjectLiteralExpression, isPropertyAssignment, isRegularExpressionLiteral, isStringLiteral, ModuleKind, type Node, ScriptTarget, transpileModule } from "typescript";

import { safeDownloadFilename } from "../src/equicordplugins/secureMessaging.desktop/downloadFilename";
import { canonicalizeMatch } from "../src/utils/patches";
import { discordImageHelpersSource, discordImageMenuSource, discordMediaViewerAnalyticsSource, discordMediaViewerSource, discordNativeImageSource } from "./fixtures/discordImageActions";

const source = createSourceFile("index.tsx", readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8"), ScriptTarget.Latest, true);
const methodNames = new Set(["encryptedImageMenuOptions", "canUseEncryptedImage", "encryptedImageMenuUrl", "encryptedMediaActionGuard", "encryptedImageFilename"]);
const methods: string[] = [];
const patches = new Map<string, Array<{ match: RegExp; replace: string; }>>();
function visit(node: Node) {
    if (isMethodDeclaration(node) && methodNames.has(node.name.getText(source))) methods.push(node.getText(source));
    if (isObjectLiteralExpression(node)) {
        const properties = node.properties.filter(isPropertyAssignment);
        const find = properties.find(property => property.name.getText(source) === "find")?.initializer;
        if (find && isStringLiteral(find) && ['id:"copy-image"', '"Copy image method called outside native app"', 'id:"media-viewer-details"'].includes(find.text)) {
            const replacements = properties.find(property => property.name.getText(source) === "replacement")?.initializer;
            assert.ok(replacements && isArrayLiteralExpression(replacements));
            patches.set(find.text, replacements.elements.map(replacement => {
                assert.ok(isObjectLiteralExpression(replacement));
                const fields = replacement.properties.filter(isPropertyAssignment);
                const match = fields.find(field => field.name.getText(source) === "match")!.initializer;
                const replace = fields.find(field => field.name.getText(source) === "replace")!.initializer;
                assert.ok(isRegularExpressionLiteral(match) && isStringLiteral(replace));
                const literal = match.getText(source);
                const end = literal.lastIndexOf("/");
                return { match: canonicalizeMatch(new RegExp(literal.slice(1, end), literal.slice(end + 1))), replace: replace.text };
            }));
        }
    }
    node.forEachChild(visit);
}
visit(source);

test("the viewer selector chooses its control factory even when analytics loads first", () => {
    const selector = [...patches.keys()].find(key => key.includes("media-viewer"));
    assert.ok(selector);
    const factories = new Map([
        [700331, discordMediaViewerAnalyticsSource],
        [315790, discordMediaViewerSource],
        [115184, discordImageMenuSource],
        [803316, discordImageHelpersSource],
        [19575, discordNativeImageSource],
    ]);
    assert.deepEqual([...factories].filter(([, body]) => body.includes("trackMediaViewerImageSaved")).map(([id]) => id), [700331, 315790],
        "the old selector incorrectly selected the earlier analytics module");
    assert.deepEqual([...factories].filter(([, body]) => body.includes(selector)).map(([id]) => id), [315790]);
    assert.equal([...factories].find(([, body]) => body.includes(selector))?.[0], 315790);
});

function patched(source: string, find: string): string {
    assert.ok(source.includes(find));
    for (const replacement of patches.get(find)!) {
        assert.equal([...source.matchAll(new RegExp(replacement.match.source, "g"))].length, find === 'id:"media-viewer-details"' && replacement.match.global ? 2 : 1);
        const next = source.replace(replacement.match, replacement.replace);
        assert.notEqual(next, source, "a failed grouped replacement must not leave a partial fixture");
        source = next;
    }
    return source;
}

function moduleExports(source: string, modules: Record<number, unknown>, globals: Record<string, unknown> = {}) {
    const exports: Record<string, any> = {};
    const require = Object.assign((id: number) => modules[id] ?? {}, {
        d: (target: object, entries: Record<string, () => unknown>) => Object.entries(entries).forEach(([key, get]) => Object.defineProperty(target, key, { get })),
    });
    runInNewContext(`(${source.replace(/^\d+\(/, "function(")})`, globals)({}, exports, require);
    return exports;
}

function fixture(guarded = true, modernDialog = true) {
    const image = "blob:https://discord.com/secure-image#private-photo.png";
    const registry = new Map([[image, { filename: "private-photo.png", contentType: "image/png" }]]);
    const calls = { clipboard: [] as Array<{ name: string; bytes: number; }>, saves: [] as string[], directories: [] as unknown[], fetches: [] as string[], downloads: [] as string[], links: [] as string[], transcodes: 0 };
    let userId = "self";
    let fetchGate: Promise<unknown> = Promise.resolve();
    let transcodeGate: Promise<unknown> = Promise.resolve();
    let canceled = false;
    let blockedChannel = false;
    let lastDirectory: unknown;
    const context = {
        NativeImageActions: {} as Record<string, any>, screenCaptureProtectionStatus: "ready", screenCaptureProtectionGeneration: 1, secureOperationGeneration: 1,
        UserStore: { getCurrentUser: () => ({ id: userId }) }, safeDownloadFilename,
        encryptedAttachmentMediaInfo: (url: unknown) => userId === "self" && typeof url === "string" ? registry.get(url) ?? null : null,
        secureOperationIsCurrent: (generation: number, user: string) => generation === context.secureOperationGeneration && user === userId,
    };
    const plugin = runInNewContext(transpileModule(`({${methods.join(",")}})`, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext },
    }).outputText, context) as Record<string, (...args: any[]) => any>;
    plugin.downloadEncryptedAttachment = (url: string) => {
        if (!context.encryptedAttachmentMediaInfo(url)) return false;
        calls.downloads.push(url);
        return true;
    };
    const types = { U: (url: string, mime?: string) => mime?.split("/")[1] ?? /\.([^/.]+)$/.exec(new URL(url).pathname)?.[1] };
    const native = runInNewContext(guarded ? patched(discordNativeImageSource, '"Copy image method called outside native app"') : discordNativeImageSource, {
        $self: plugin, l: () => (value: boolean) => assert.ok(value), f: { isPlatformEmbedded: true }, I: types,
        N: new Set(["webp", "avif"]), S: new Set(["jpg", "jpeg", "jfif", "png"]), C: new Set(["jpg", "jpeg", "jfif", "png", "webp", "gif", "tiff", "bmp", "avif"]),
        p: { A: { toURLSafe: (url: string) => new URL(url) } }, V: (name: string) => decodeURIComponent(name), m: Buffer,
        E: { w: { get: () => lastDirectory, set: (_key: string, value: unknown) => { lastDirectory = value; } } }, U: "lastImageSaveDirectory",
        k: /[^a-zA-Z0-9]/g, F: /\.[^.]*$/,
        H: async (url: string) => { calls.fetches.push(url); await fetchGate; return new Uint8Array([1, 2, 3]).buffer; },
        j: async (bytes: ArrayBuffer) => { calls.transcodes++; await transcodeGate; return bytes; },
        g: {
            clipboard: { copyImage: (bytes: Uint8Array, name: string) => calls.clipboard.push({ name, bytes: bytes.length }) },
            fileManager: {
                saveWithDialog: async (_bytes: unknown, name: string, directory: unknown) => {
                    calls.saves.push(name); calls.directories.push(directory);
                    return canceled ? null : "fixture-directory";
                },
                ...(modernDialog && { saveWithDialog2: async (_bytes: unknown, name: string, directory: unknown) => {
                    calls.saves.push(name); calls.directories.push(directory);
                    return { canceledByUser: canceled, directory: "fixture-directory" };
                } }),
            },
        },
    }) as Record<string, (...args: any[]) => any>;
    context.NativeImageActions = native;
    const helpers = moduleExports(discordImageHelpersSource, {
        376304: { XD: () => false }, 679164: { BX: () => false }, 68935: { NO: () => false }, 403362: { iT: () => false },
        998218: { A: { toURLSafe: (url: string) => new URL(url), isDiscordAssetUrl: (url: string) => /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//.test(url) } },
        19575: { Ay: native }, 229531: types,
    });
    const menuSource = patched(discordImageMenuSource, 'id:"copy-image"');
    const menuExports = moduleExports(menuSource, {
        477900: { jsx: (_type: unknown, props: any) => props }, 691540: { P0() {} }, 857250: { o() {} }, 97483: { Ck: {} },
        477782: { Dr: "MenuItem" }, 191023: { ImageIcon: "ImageIcon" }, 803316: helpers, 207133: { A: () => blockedChannel },
        174459: { default: { track() {} } }, 723702: { isPlatformEmbedded: true }, 38405: { A: { captureException() {} } },
        19575: { Ay: native, _0: { SAVED: "saved", ERRORED: "errored", CANCELED: "canceled" } }, 179581: { N: () => ({}) },
        652215: { HAw: {} }, 375708: { intl: { string: (key: string) => key }, t: {} },
    }, { $self: plugin });
    const viewerSource = patched(discordMediaViewerSource, 'id:"media-viewer-details"');
    const viewerTree = createSourceFile("viewer.js", `(${viewerSource.replace(/^\d+\(/, "function(")})`, ScriptTarget.Latest, true);
    const viewerFunctions: string[] = [];
    function selectViewerFunction(node: Node) {
        if (isFunctionDeclaration(node) && node.name && ["em", "ef", "eg", "eE"].includes(node.name.text)) viewerFunctions.push(node.getText(viewerTree));
        node.forEachChild(selectViewerFunction);
    }
    selectViewerFunction(viewerTree);
    const viewer = runInNewContext(`${viewerFunctions.join("\n")}\n({em,ef,eg})`, {
        $self: plugin, Z: helpers, en: { isPlatformEmbedded: true }, ei: { Ay: native, _0: { SAVED: "saved", ERRORED: "errored" } },
        i: { jsx: (_type: unknown, props: unknown) => props, jsxs: (_type: unknown, props: unknown) => props },
        l: { useState: (initial: unknown) => [initial, () => {}], useRef: () => ({}), useCallback: (callback: unknown) => callback },
        y: { l: { markActionPerformed() {}, trackMediaViewerImageSaved() {}, trackMediaViewerImageCopied() {} }, N: {} },
        er: { intl: { string: (key: unknown) => key }, t: {} }, L: { P0() {} }, w: { o() {} }, V: { Ck: {} },
        ec: "NativeToolbarButton", U: { DownloadIcon: "DownloadIcon" }, et: { h: ({ href }: { href: string; }) => calls.links.push(href) },
        Q: { Q_: { useSetting: () => false } }, B: { Y: { Animation: { NONE: 0 } } }, F: { MoreHorizontalIcon: "MoreHorizontalIcon" },
        K: { A: () => null }, X: { rX: "MenuGroup", Dr: "MenuItem" }, q: { CopyIcon: "CopyIcon" }, z: { LinkIcon: "LinkIcon" }, G: { W: "Menu" },
    }) as { em(props: unknown): any; eg(props: unknown): any; ef(props: unknown): any; };
    return {
        image, registry, calls, native, plugin, context,
        viewer,
        menu: (url = image, options: object = {}) => menuExports.A(url, { getChannelId: () => "fixture" }, options),
        setFetchGate: (gate: Promise<unknown>) => { fetchGate = gate; }, setTranscodeGate: (gate: Promise<unknown>) => { transcodeGate = gate; },
        switchAccount: () => { userId = "other"; }, cancelSave: () => { canceled = true; }, blockChannel: () => { blockedChannel = true; },
    };
}

test("the native viewer exposes image Download and More Copy with original Save behavior", async () => {
    const h = fixture();
    const item = { type: "IMAGE", original: h.image, url: h.image, contentType: "image/png", animated: false };
    const download = h.viewer.em({ item });
    assert.equal(download.icon, "DownloadIcon");
    await download.onClick();
    assert.deepEqual(h.calls.saves, ["private-photo.png"]);
    const more = h.viewer.eg({ item });
    const menu = h.viewer.ef(more.renderPopout());
    const copy = menu.children[0].children[0];
    assert.equal(copy.id, "media-viewer-copy-image");
    await copy.action();
    assert.deepEqual(h.calls.fetches, [h.image, h.image]);
    assert.equal(h.calls.clipboard.length, 1);
});

test("the native viewer routes only registered video downloads to the authenticated downloader", async () => {
    const h = fixture();
    h.registry.set(h.image, { filename: "video.webm", contentType: "video/webm" });
    const item = { type: "VIDEO", original: h.image, url: h.image, contentType: undefined };
    await h.viewer.em({ item }).onClick();
    assert.deepEqual(h.calls.downloads, [h.image], "normalization cannot add format=png to a registered video URL");
    assert.deepEqual(h.calls.links, []);
    const ordinary = "https://cdn.discordapp.com/video.webm";
    await h.viewer.em({ item: { ...item, original: ordinary, url: ordinary, contentType: "video/webm" } }).onClick();
    assert.deepEqual(h.calls.links, [ordinary]);
});

test("held viewer Download and More Copy controls cannot run after registry revocation", async () => {
    const h = fixture();
    const item = { type: "IMAGE", original: h.image, url: h.image, contentType: "image/png", animated: false };
    const download = h.viewer.em({ item });
    const copy = h.viewer.ef(h.viewer.eg({ item }).renderPopout()).children[0].children[0];
    h.registry.clear();
    await download.onClick();
    await copy.action();
    assert.deepEqual(h.calls.fetches, []);
    assert.deepEqual(h.calls.saves, []);
    assert.deepEqual(h.calls.clipboard, []);
});

test("registered images retain native copy/save items, exact blob URLs and authenticated MIME", async () => {
    const h = fixture();
    const menu = h.menu();
    assert.deepEqual(Array.from(menu, (item: any) => item?.id), ["copy-image", "save-image"]);
    await menu[0].action();
    await menu[1].action();
    assert.deepEqual(h.calls.fetches, [h.image, h.image]);
    assert.deepEqual(h.calls.clipboard, [{ name: "image.png", bytes: 3 }]);
    assert.deepEqual(h.calls.saves, ["private-photo.png"]);
    h.cancelSave();
    assert.equal(await h.native.saveImage(h.image, "image/png"), "canceled");
    assert.deepEqual(h.calls.directories, [undefined, "fixture-directory"], "native Save remembers its last directory");
});

test("native WebP conversion is retained and GIF keeps only the native save action", async () => {
    const h = fixture();
    h.registry.set(h.image, { contentType: "image/webp", filename: "image.webp" });
    await h.menu()[0].action();
    assert.equal(h.calls.transcodes, 1);
    assert.equal(h.calls.clipboard[0].name, "image.png");
    h.registry.set(h.image, { contentType: "image/gif", filename: "image.gif" });
    assert.equal(h.menu()[0], null);
    assert.equal(h.menu()[1].id, "save-image");
});

test("unregistered URLs delegate unchanged while hidden or non-image media stay excluded", () => {
    const h = fixture();
    assert.equal(h.menu("blob:https://discord.com/spoof#image.png"), null);
    assert.equal(h.plugin.canUseEncryptedImage("https://cdn.discordapp.com/image.png"), null);
    assert.equal(h.plugin.encryptedImageMenuUrl("https://cdn.discordapp.com/image.png"), null);
    assert.equal(h.plugin.encryptedImageFilename("https://cdn.discordapp.com/image.png"), null);
    assert.equal(h.menu("https://cdn.discordapp.com/image.png")[0].id, "copy-image");
    assert.equal(h.menu(h.image, { shouldHideMediaOptions: true }), null);
    h.blockChannel();
    assert.equal(h.menu(), null);
    h.registry.set(h.image, { contentType: "video/webm", filename: "clip.webm" });
    assert.equal(h.plugin.canUseEncryptedImage(h.image), null);
    assert.equal(h.plugin.encryptedImageMenuUrl(h.image), null);
});

test("a failed native guard patch cannot expose secure image menu actions", () => {
    const h = fixture(false);
    assert.equal(h.menu(), null);
    assert.equal(h.menu("https://cdn.discordapp.com/image.png")[0].id, "copy-image");
});

for (const stage of ["fetch", "transcode", "save fetch", "legacy save fetch"] as const) for (const invalidation of ["lock", "account", "revocation", "screenshot"] as const) {
    test(`${invalidation} during ${stage} blocks the final native clipboard/dialog handoff`, async () => {
        const h = fixture(true, stage !== "legacy save fetch");
        const gate = Promise.withResolvers<void>();
        if (stage === "transcode") {
            h.registry.set(h.image, { contentType: "image/webp", filename: "image.webp" });
            h.setTranscodeGate(gate.promise);
        } else h.setFetchGate(gate.promise);
        const pending = stage.includes("save") ? h.native.saveImage(h.image, "image/png") : h.native.copyImage(h.image, stage === "transcode" ? "image/webp" : "image/png");
        const rejected = stage === "legacy save fetch"
            ? pending.then((status: string) => assert.equal(status, "errored", "native legacy dialogs preserve their error enum"))
            : assert.rejects(pending, /no longer available/);
        await setImmediate();
        if (invalidation === "account") h.switchAccount();
        else if (invalidation === "revocation") h.registry.clear();
        else if (invalidation === "lock") h.context.secureOperationGeneration++;
        else h.context.screenCaptureProtectionStatus = "screenshot";
        gate.resolve();
        await rejected;
        assert.equal(h.calls.clipboard.length, 0);
        assert.equal(h.calls.saves.length, 0);
    });
}

test("held native actions reject screenshot mode before fetching and ordinary actions remain unchanged", async () => {
    const h = fixture();
    h.context.screenCaptureProtectionStatus = "screenshot";
    await assert.rejects(h.native.copyImage(h.image, "image/png"), /no longer available/);
    await assert.rejects(h.native.saveImage(h.image, "image/png"), /no longer available/);
    assert.equal(h.calls.fetches.length, 0);
    await h.native.copyImage("https://cdn.discordapp.com/image.png", "image/png");
    assert.equal(h.calls.clipboard.length, 1);
});

test("menu closures retained before revocation cannot start later native actions", async () => {
    const h = fixture();
    const menu = h.menu();
    h.registry.clear();
    await menu[0].action();
    await menu[1].action();
    assert.equal(h.calls.fetches.length, 0);
    assert.equal(h.calls.clipboard.length, 0);
    assert.equal(h.calls.saves.length, 0);
});

test("save dialog filenames reject path/control/reserved names and retain bounded extensions", () => {
    for (const name of ["../private.png", "C:\\private.png", "\0private.png", "CON.png", "..", "😀".repeat(200) + ".png"]) {
        const safe = safeDownloadFilename(name);
        assert.doesNotMatch(safe, /[<>:"/\\|?*\u0000-\u001f]/u);
        assert.notEqual(safe, "..");
        assert.doesNotMatch(safe, /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu);
        assert.ok(Buffer.byteLength(safe) <= 220);
    }
    assert.equal(safeDownloadFilename("photo.png"), "photo.png");
    assert.equal(safeDownloadFilename("photo.png", 1), "photo (1).png");
});
