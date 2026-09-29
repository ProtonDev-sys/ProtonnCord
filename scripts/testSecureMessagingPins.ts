/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, isObjectLiteralExpression, isPropertyAssignment, isStringLiteral, isVariableStatement, JsxEmit, ModuleKind, type Node, ScriptTarget, transpileModule } from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";

const source = createSourceFile("index.tsx", readFileSync("src/equicordplugins/secureMessaging.desktop/index.tsx", "utf8"), ScriptTarget.Latest, true);
const names = new Set(["renderSecurePreviewContent", "renderSecurePreviewAccessories"]);
const functions = source.statements.filter(node =>
    isFunctionDeclaration(node) && node.name && names.has(node.name.text) ||
    isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === "renderSecureMessageAccessory")
).map(node => node.getText(source)).join("\n");
const compiled = transpileModule(functions, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
let replacements: { match: RegExp; replace: string; }[] = [];
function visit(node: Node) {
    if (isObjectLiteralExpression(node) && node.properties.some(property =>
        isPropertyAssignment(property) && property.name.getText(source) === "find" &&
        isStringLiteral(property.initializer) && property.initializer.text === ".hideAccessories"
    )) replacements = runInNewContext(`(${node.getText(source)})`).replacement;
    node.forEachChild(visit);
}
visit(source);

// Relevant shape of Discord's ChannelMessage preview, observed in module 636922.
// Pins can omit accessories, and the original content slot otherwise renders the wire payload.
const previewSource = `function Preview(e){let{message:t,inlineEditor:G}=e;return({
childrenAccessories:e.hideAccessories?void 0:(0,C.J)(e,z,J),
childrenMessageContent:G??(Q?(0,_.A)(e,V):(0,v.A)(e,V)),childrenSystemMessage:(0,j.A)({...e})
})}`;

function fixture() {
    let previewContext = false;
    let protection = "ready";
    const context = { Provider: "SecurePreviewProvider" };
    const calls: object[] = [];
    const React = {
        useContext: (value: unknown) => { assert.equal(value, context); return previewContext; },
        createElement: (type: unknown, props: object | null, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    };
    const runtime = runInNewContext(`${compiled}\n({ renderSecurePreviewContent, renderSecurePreviewAccessories, renderSecureMessageAccessory })`, {
        React, getSecureMessagePreviewContext: () => context,
        get screenCaptureProtectionStatus() { return protection; },
        isEncryptedMessage: (content: string) => content.startsWith("PCEM3:"),
        isKeyAnnouncement: (content: string) => content.startsWith("PCKA1:"),
        ErrorBoundary: "ErrorBoundary",
        SecureMessageAccessory: ({ message }: { message: object; }) => { calls.push(message); return "secure component"; },
    });
    let patched = previewSource;
    assert.equal(replacements.length, 2);
    for (const { match, replace } of replacements) {
        const regex = canonicalizeMatch(new RegExp(match.source, match.flags));
        assert.equal([...patched.matchAll(new RegExp(regex.source, "g"))].length, 1);
        patched = patched.replace(regex, replace.replaceAll("$self", "plugin"));
    }
    const original = (props: { message: { content: string; }; }) => props.message.content;
    const Preview = runInNewContext(`(${patched})`, {
        plugin: runtime, z: false, J: false, Q: false, V: null,
        C: { J: (props: object) => [React.createElement(runtime.renderSecureMessageAccessory, props), "native media"] },
        _: { A: original }, v: { A: original }, j: { A: () => null },
    });
    function render(node: any): unknown {
        if (Array.isArray(node)) return node.map(render);
        if (!node || typeof node !== "object") return node;
        if (node.type === context.Provider) {
            const previous = previewContext;
            previewContext = node.props.value;
            try { return render(node.props.children); } finally { previewContext = previous; }
        }
        return render(typeof node.type === "function" ? node.type(node.props) : node.props.children);
    }
    return { calls, runtime, render, Preview, setProtection: (value: string) => { protection = value; } };
}

test("encrypted pins render through the secure component even with accessories hidden", () => {
    for (const content of ["PCEM3:encrypted", "PCKA1:announcement"]) {
        for (const hideAccessories of [true, false]) {
            const h = fixture();
            const message = { content, id: "pin", channel_id: "original-channel", author: { id: "original-author" } };
            const result = h.Preview({ message, hideAccessories });
            const rendered = JSON.stringify(h.render([result.childrenMessageContent, result.childrenAccessories]));
            assert.doesNotMatch(rendered, /PCEM3:|PCKA1:/);
            assert.equal(h.calls.length, 1, "visible accessories must not duplicate plaintext or key-review controls");
            assert.equal(h.calls[0], message, "decryption retains the original message, author and channel binding");
            if (!hideAccessories) assert.match(rendered, /native media/);
        }
    }
});

test("all capture-protection states use the existing guarded secure component", () => {
    for (const status of ["ready", "pending", "failed", "screenshot"]) {
        const h = fixture();
        h.setProtection(status);
        h.render(h.Preview({ message: { content: "PCEM3:encrypted" }, hideAccessories: true }).childrenMessageContent);
        assert.equal(h.calls.length, 1, status);
    }
});

test("ordinary previews and stopped-plugin content keep Discord's fallback", () => {
    const h = fixture();
    assert.equal(h.Preview({ message: { content: "ordinary text" }, hideAccessories: true }).childrenMessageContent, "ordinary text");
    h.setProtection("disabled");
    assert.equal(h.Preview({ message: { content: "PCEM3:encrypted" }, hideAccessories: true }).childrenMessageContent, "PCEM3:encrypted");
    assert.equal(h.calls.length, 0);
});

test("an active inline editor retains priority over the decrypted preview", () => {
    const h = fixture();
    const inlineEditor = { editor: true };
    assert.equal(h.Preview({ message: { content: "PCEM3:encrypted" }, inlineEditor }).childrenMessageContent, inlineEditor);
    assert.equal(h.calls.length, 0);
});

test("preview context stays local so the normal timeline still renders its accessory", () => {
    const h = fixture();
    const message = { content: "PCEM3:encrypted" };
    h.render(h.Preview({ message, hideAccessories: false }).childrenAccessories);
    assert.equal(h.calls.length, 0);
    h.render(h.runtime.renderSecureMessageAccessory({ message }));
    assert.equal(h.calls.length, 1);
});
