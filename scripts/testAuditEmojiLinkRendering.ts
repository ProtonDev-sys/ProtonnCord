/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";

const source = ts.createSourceFile("index.tsx", readFileSync("src/plugins/fakeNitro/index.tsx", "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
const nodes: ts.Node[] = [];
function collect(node: ts.Node) { nodes.push(node); ts.forEachChild(node, collect); }
collect(source);
const renderPatch = nodes.find(node => ts.isObjectLiteralExpression(node) && node.properties.some(property =>
    ts.isPropertyAssignment(property) && property.name.getText(source) === "find" && ts.isStringLiteral(property.initializer)
    && property.initializer.text === '["strong","em","u","text","inlineCode","s","spoiler"]'));
assert.ok(renderPatch);
const methodNames = ["shouldKeepEmojiLink", "trimContent", "clearEmptyArrayItems", "ensureChildrenIsArray", "patchFakeNitroEmojisOrRemoveStickersLinks"];
const methods = methodNames.map(name => nodes.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name)!.getText(source));
const regex = nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(source) === "fakeNitroEmojiRegex") as ts.VariableDeclaration;
// Evaluate only the local render patch and renderer helpers, without loading any send or permission hooks.
const compiled = ts.transpileModule(`const fakeNitroEmojiRegex=${regex.initializer!.getText(source)}; exports.plugin={${methods.join(",")}}; exports.patch=${renderPatch.getText(source)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

type AstNode = { type: string; target?: string; content?: string; };
const emojiUrl = "https://cdn.discordapp.com/emojis/123.png?name=wave";
const emoji: AstNode = { type: "link", target: emojiUrl };
const ordinaryLink: AstNode = { type: "link", target: "https://example.invalid/image.png" };
const text: AstNode = { type: "text", content: "ordinary text" };
const imageEmbed = { type: "image" };
const conditions = {
    legacy: 'N=1!==t.length||1!==n.length||!_(t[0])?t:[]',
    current: 'N=(0,a.k5)(n)&&(0,a.iz)((0,a.dn)(t,_))?[]:t'
};

function fixture(shape: keyof typeof conditions, enabled: boolean, hideEmpty = false) {
    const settings = { store: { transformEmojis: enabled, transformStickers: false, transformCompoundSentence: false } };
    const exports: any = {};
    runInNewContext(compiled, {
        exports, settings, URL,
        EmojiStore: { getCustomEmojiById: () => undefined },
        lodash: { cloneDeep: structuredClone },
        Parser: { defaultRules: { customEmoji: { react: (node: object) => ({ type: "customEmoji", props: node }) } } },
        Logger: class { error(error: unknown) { throw error; } }
    });
    const { plugin, patch } = exports;
    let kept = 0;
    const originalKeep = plugin.shouldKeepEmojiLink;
    plugin.shouldKeepEmojiLink = (node: AstNode) => {
        assert.ok(node, "empty content must never be passed to the emoji-link helper");
        kept++;
        return originalKeep(node);
    };
    const original = `function(t,n,options={}){let N=t,S=false,B=false;options.hideSimpleEmbedContent!==false&&(${conditions[shape]});let C=renderAst(N);return{hasSpoilerEmbeds:S,hasBailedAst:B,content:C}}`;
    let patched = original;
    const matches: number[] = [];
    for (const replacement of patch.replacement) {
        if (!replacement.predicate()) continue;
        const match = canonicalizeMatch(replacement.match);
        matches.push(Array.from(patched.matchAll(new RegExp(match.source, "g"))).length);
        patched = patched.replace(match, (...args: any[]) => replacement.replace(...args).replaceAll("$self", "plugin"));
    }
    const isLink = (node: AstNode) => node.type === "link" || node.type === "attachmentLink";
    const render = runInNewContext(`(${patched})`, {
        plugin, _: isLink,
        a: {
            k5: (embeds: object[]) => embeds.length === 1,
            dn: (ast: AstNode[], predicate: (node: AstNode) => boolean) => (hideEmpty && !ast.length) || ast.length === 1 && ast.every(predicate),
            iz: (onlyLinks: boolean) => onlyLinks
        },
        renderAst: (ast: AstNode[]) => ast.map(node => isLink(node)
            ? { type: {}, props: { trusted: true, href: node.target } }
            : node.content)
    });
    return { render: (ast: AstNode[], embeds: object[] = [imageEmbed], options = {}) => render(ast, embeds, options).content, kept: () => kept, matches };
}

for (const shape of ["legacy", "current"] as const) {
    test(`${shape} emoji link rendering preserves emoji content and normal embed hiding`, () => {
        const f = fixture(shape, true);
        const rendered = f.render([emoji]);
        assert.equal(rendered.length, 1, "the emoji link survives native embed hiding so it can render as an emoji");
        assert.equal(rendered[0].type, "customEmoji");
        assert.equal(rendered[0].props.emojiId, "123");
        assert.equal(rendered[0].props.name, "wave");
        assert.equal(f.render([ordinaryLink]).length, 0, "ordinary single-link embeds still hide their duplicate text");
        assert.deepEqual(Array.from(f.render([text])), ["ordinary text"]);
        assert.equal(f.render([ordinaryLink], []).length, 1, "links without embeds remain visible");
        assert.equal(f.render([ordinaryLink], [imageEmbed, imageEmbed]).length, 1, "multiple embeds keep the original link text");
        assert.equal(f.render([ordinaryLink], [imageEmbed], { hideSimpleEmbedContent: false }).length, 1);
        assert.deepEqual(Array.from(f.render([text, ordinaryLink], [])), ["ordinary text", { type: {}, props: { trusted: true, href: ordinaryLink.target } }]);
        assert.deepEqual(f.matches, [1, 1], "each enabled render patch matches exactly once");
    });

    test(`${shape} emoji rendering respects the disabled setting and empty AST`, () => {
        const disabled = fixture(shape, false);
        assert.equal(disabled.render([emoji]).length, 0, "disabled transformation leaves Discord's original hiding intact");
        assert.equal(disabled.render([emoji], [], { hideSimpleEmbedContent: false })[0].props.href, emojiUrl);
        assert.equal(disabled.kept(), 0);
        const enabled = fixture(shape, true, true);
        assert.equal(enabled.render([]).length, 0);
        assert.equal(enabled.kept(), 0, "even an empty AST accepted by a host hide guard never reaches shouldKeepEmojiLink");
    });
}
