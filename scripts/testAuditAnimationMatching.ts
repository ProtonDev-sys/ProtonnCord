/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { pluginPatches } from "./utils/discordClientFixture";

const settings = { store: { icons: true, roleGradients: true } };
const patches: any[] = pluginPatches("src/plugins/alwaysAnimate/index.ts", { settings });
const properties = ["canAnimate", "animateGradient"] as const;

function patchFor(property: typeof properties[number]) {
    const patch = patches.find(patch => patch.find === `${property}:`);
    assert.ok(patch);
    return patch;
}

function originalMatcher(property: string) {
    return new RegExp(`${property}:.+?([,}].*?\\))`, "g");
}

function originalReplace(property: string) {
    return (match: string, rest: string) => rest.match(/}=.+/) == null ? `${property}:!0${rest}` : match;
}

function matches(source: string, expression: RegExp) {
    return Array.from(source.matchAll(expression), match => ({ offset: match.index, match: match[0], rest: match[1] }));
}

test("captured guild-icon options retain their native values while animation stays opt-in", () => {
    // Discord-owned source data from Canary 502239; the GPL header covers the test wrapper.
    // Complete captured factory SHA-256: 9de671f3c5723a1cfe6c21dad4eac37e619f8ecdce7deb8bfc6f076f85ef1b53.
    const source = "t6.Ay.getGuildIconURL({id:e.id,icon:e.icon,canAnimate:!1,size:42})";
    const patch = patchFor("canAnimate");
    const globals = { e: { id: "guild", icon: "animated-icon" }, t6: { Ay: { getGuildIconURL: (options: unknown) => options } } };
    assert.equal(runInNewContext(source, globals).canAnimate, false);
    const transformed = source.replace(patch.replacement.match, patch.replacement.replace);
    assert.equal(JSON.stringify(runInNewContext(transformed, globals)), JSON.stringify({ id: "guild", icon: "animated-icon", canAnimate: true, size: 42 }));
    for (const property of properties) {
        const current = patchFor(property);
        const key = property === "canAnimate" ? "icons" : "roleGradients";
        assert.equal(current.all, true);
        assert.equal(current.noWarn, true);
        assert.equal(typeof current.replacement.replace, "function", "Callbacks must retain ordinary timing classification");
        assert.equal(current.predicate(), true);
        settings.store[key] = false;
        assert.equal(current.predicate(), false);
        settings.store[key] = true;
    }
});

test("animation matching preserves captures and replacements across delimiters, line terminators, and following global matches", () => {
    const values = [""];
    const alphabet = ["a", ",", "}", ")", "="];
    let level = [""];
    for (let length = 1; length <= 5; length++) {
        level = level.flatMap(prefix => alphabet.map(character => prefix + character));
        values.push(...level);
    }
    for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
        for (const value of ["", "a", "a,", "a}", "a,}", "a,}=x", "a,})"])
            for (let offset = 0; offset <= value.length; offset++) values.push(value.slice(0, offset) + terminator + value.slice(offset));
    }
    values.push(",value})", "}value})", "a,,}})tail)", "a,}=)", "a,}='text')", "a,quote:'}=')", "\ud83d\ude00,})", "\ud83d,})");
    for (const property of properties) {
        const { match, replace } = patchFor(property).replacement;
        for (const value of values) {
            const source = `${property}:${value}; next({${property}:normal,tail:1});`;
            assert.deepEqual(matches(source, match), matches(source, originalMatcher(property)), JSON.stringify({ property, value }));
            assert.equal(source.replace(match, replace), source.replace(originalMatcher(property), originalReplace(property)));
        }
    }
});

test("destructuring no-ops consume their entire original match without patching nested fields", () => {
    for (const property of properties) {
        const { match, replace } = patchFor(property).replacement;
        const destructuring = `let{${property}:a,nested:{${property}:b}}=props;fn()`;
        const source = `${destructuring};fn({${property}:c});fn({${property}:d})`;
        const before = matches(source, originalMatcher(property));
        assert.equal(before.length, 3);
        assert.equal(replace(before[0].match, before[0].rest), before[0].match);
        assert.equal(source.replace(match, replace), `${destructuring};fn({${property}:!0});fn({${property}:!0})`);
    }
});

test("a long malformed delimiter tail is rejected within a bounded execution budget", () => {
    // A separate process bounds regressions without a tight timing assertion in the audit runner.
    const child = spawnSync(process.execPath, ["-e", String.raw`
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const vm = require("node:vm");
        for (const { property, source, flags, replacement } of JSON.parse(fs.readFileSync(0, "utf8"))) {
            const match = new RegExp(source, flags);
            const replace = vm.runInNewContext("(" + replacement + ")");
            const malformed = property + ":x" + ",".repeat(300_000);
            const input = malformed + "\nfn({" + property + ":value})";
            assert.equal(input.replace(match, replace), malformed + "\nfn({" + property + ":!0})");
        }
    `], {
        input: JSON.stringify(properties.map(property => {
            const { match, replace } = patchFor(property).replacement;
            return { property, source: match.source, flags: match.flags, replacement: String(replace) };
        })),
        encoding: "utf8",
        timeout: 5_000
    });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
});
