/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, isMethodDeclaration, isObjectLiteralExpression, isPropertyAssignment, isRegularExpressionLiteral, isStringLiteral, ModuleKind, type Node, ScriptTarget, transpileModule } from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";

const pluginSource = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8");
const cacheSource = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/attachmentCache.ts", import.meta.url), "utf8");
const patches: { match: RegExp; replace: string; }[] = [];
let helper = "";
function visit(node: Node) {
    if (isMethodDeclaration(node) && node.name.getText() === "encryptedMediaProxyUrl") helper = node.getText();
    if (isObjectLiteralExpression(node)) {
        const property = (name: string) => node.properties.find(value => isPropertyAssignment(value) && value.name.getText() === name);
        const replacement = property("replace");
        if (replacement && isPropertyAssignment(replacement) && isStringLiteral(replacement.initializer) && replacement.initializer.text.includes("$self.encryptedMediaProxyUrl")) {
            const match = property("match");
            assert.ok(match && isPropertyAssignment(match) && isRegularExpressionLiteral(match.initializer));
            const literal = match.initializer.getText();
            const end = literal.lastIndexOf("/");
            patches.push({ match: canonicalizeMatch(new RegExp(literal.slice(1, end), literal.slice(end + 1))), replace: replacement.initializer.text });
        }
    }
    node.forEachChild(visit);
}
visit(createSourceFile("index.tsx", pluginSource, ScriptTarget.Latest, true));
assert.ok(helper);
assert.equal(patches.length, 3);
const cacheFunctions = createSourceFile("attachmentCache.ts", cacheSource, ScriptTarget.Latest, true).statements
    .filter(node => isFunctionDeclaration(node) && ["objectUrl", "isEncryptedAttachmentMediaUrl"].includes(node.name?.text ?? ""))
    .map(node => node.getText()).join("\n");

type ProxyUrl = { searchParams: { append(key: string, value: string): void; }; toString(): string; };

function fixture() {
    const registered = new Map([["blob:https://discord.com/secure-image", { isMedia: true }], ["blob:https://discord.com/secure-file", { isMedia: false }]]);
    const plugin = runInNewContext(transpileModule(`${cacheFunctions}\nconst plugin = { ${helper} }; plugin;`, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext },
    }).outputText, { exports: {}, downloadReferences: registered }) as { encryptedMediaProxyUrl(value: unknown): ProxyUrl | null; };
    const hostCalls: unknown[] = [];
    const hostResult = { searchParams: { append() {} }, toString: () => "host-url" };
    const host = { A: { toURLSafe: (value: unknown) => {
        hostCalls.push(value);
        return value == null ? null : hostResult;
    } } };
    const source = 'function image(e){let u=U.A.toURLSafe(e.proxy_url);return u}function eligible(e){return null!=U.A.toURLSafe(e.proxyUrl)}function embed(e){let u=U.A.toURLSafe(e.proxyUrl);return null==u?null:u}return{image,eligible,embed};';
    let patched = source;
    for (const patch of patches) {
        assert.equal([...patched.matchAll(new RegExp(patch.match.source, "g"))].length, 1);
        patched = patched.replace(patch.match, patch.replace);
    }
    const renderers = new Function("$self", "U", patched)(plugin, host) as {
        image(props: { proxy_url?: unknown; }): ProxyUrl | null;
        eligible(props: { proxyUrl?: unknown; }): boolean;
        embed(props: { proxyUrl?: unknown; }): ProxyUrl | null;
    };
    return { plugin, registered, hostCalls, hostResult, ...renderers };
}

test("media proxy patches preserve host rendering for ordinary URLs and missing or non-string values", () => {
    const { plugin, image, eligible, embed, hostCalls, hostResult } = fixture();
    for (const value of [undefined, null, "", 0, false, {}, new URL("https://media.discordapp.net/image.png"),
        "https://media.discordapp.net/attachments/ordinary.png", "blob:https://discord.com/unregistered", "blob:https://discord.com/secure-file"]) {
        assert.equal(plugin.encryptedMediaProxyUrl(value), null);
        const expected = value == null ? null : hostResult;
        assert.equal(image({ proxy_url: value }), expected);
        assert.equal(eligible({ proxyUrl: value }), expected !== null);
        assert.equal(embed({ proxyUrl: value }), expected);
        assert.deepEqual(hostCalls.splice(0), [value, value, value]);
    }
});

test("registered encrypted media bypass host sanitization and preserve blob URLs when size parameters are appended", () => {
    const { image, eligible, embed, registered, hostCalls, hostResult } = fixture();
    for (const value of ["blob:https://discord.com/secure-image", "blob:https://discord.com/secure-image#preview"]) {
        assert.equal(eligible({ proxyUrl: value }), true);
        for (const result of [image({ proxy_url: value }), embed({ proxyUrl: value })]) {
            assert.ok(result);
            result.searchParams.append("width", "640");
            assert.equal(result.toString(), value);
        }
    }
    assert.deepEqual(hostCalls, []);
    registered.clear();
    assert.equal(image({ proxy_url: "blob:https://discord.com/secure-image" }), hostResult);
    assert.deepEqual(hostCalls, ["blob:https://discord.com/secure-image"]);
});
