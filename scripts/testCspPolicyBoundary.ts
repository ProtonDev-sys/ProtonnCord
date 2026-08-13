/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strict as assert } from "assert";
import { access, readFile } from "fs/promises";

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

    console.log("CSP policy boundary tests passed.");
}

void main();
