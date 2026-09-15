/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strict as assert } from "assert";
import { access, readFile } from "fs/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

async function main() {
    const cspSource = await readFile(new URL("../src/main/csp/index.ts", import.meta.url), "utf8");
    const policyLiteral = cspSource.match(/export const CspPolicies: PolicyMap = \{([\s\S]*?)\n\};/)?.[1];
    assert.ok(policyLiteral, "the static CSP policy map must remain reviewable");
    assert.doesNotMatch(policyLiteral, /^\s*["']\*["']\s*:/m, "CSP must not contain a global host wildcard");
    assert.doesNotMatch(policyLiteral, /frame-src/, "static hosts must not gain blanket frame permission");
    assert.match(cspSource, /if \(host === "\*"\) continue;/, "runtime must fail closed if a plugin adds a wildcard");
    assert.doesNotMatch(cspSource, /export const CSPSrc/, "a reusable all-directives capability must not be exported");

    await assert.rejects(
        access(new URL("../src/equicordplugins/equicordHelper/native.ts", import.meta.url)),
        "the required helper must not install a native CSP wildcard"
    );

    const compile = (source: string) => transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const settings = { store: { customCspRules: {} } };
    const { patchCsp, parsePolicy }: {
        patchCsp(headers: Record<string, string[]>): void;
        parsePolicy(policy: string): Record<string, string[]>;
    } = runInNewContext(`${compile(cspSource)}\n({ patchCsp, parsePolicy });`, {
        exports: {}, require: () => ({ NativeSettings: settings })
    });
    const headers = { "Content-Security-Policy": [
        "DEFAULT-SRC 'self'; default-src https://ignored.example; sandbox; object-src",
        "frame-ancestors 'none', base-uri 'self'"
    ] };
    patchCsp(headers);
    assert.equal(headers["Content-Security-Policy"].length, 3, "each policy must survive header rewriting");
    const policies = headers["Content-Security-Policy"].map(parsePolicy);
    assert.deepEqual(Array.from(policies[0]["default-src"]), ["'self'"], "the first directive wins regardless of case");
    assert.deepEqual(Array.from(policies[0].sandbox), [], "valueless directives remain present");
    assert.deepEqual(Array.from(policies[0]["object-src"]), [], "empty source lists remain present");
    assert.deepEqual(Array.from(policies[1]["frame-ancestors"]), ["'none'"]);
    assert.deepEqual(Array.from(policies[2]["base-uri"]), ["'self'"]);
    for (const policy of policies) assert.ok(policy["style-src"].includes("'unsafe-inline'"));

    const managerSource = await readFile(new URL("../src/main/csp/manager.ts", import.meta.url), "utf8");
    let prompts = 0;
    const { addCspRule } = runInNewContext(`${compile(managerSource)}\n({ addCspRule });`, {
        exports: {}, URL, IS_DISCORD_DESKTOP: true,
        require: () => ({
            NativeSettings: settings,
            ImageAndCssSrc: ["connect-src", "img-src", "style-src", "font-src"],
            dialog: { async showMessageBox() { prompts++; return { response: 0, checkboxChecked: false }; } }
        })
    });
    assert.equal(await addCspRule({}, "https://example.com", null, "Fixture"), "invalid");
    assert.equal(await addCspRule({}, "about:blank", ["img-src"], "Fixture"), "invalid");
    assert.equal(prompts, 0);
    assert.equal(await addCspRule({}, "https://example.com", ["img-src"], "Fixture"), "cancelled");
    assert.equal(prompts, 1);

    console.log("CSP policy boundary tests passed.");
}

void main();
