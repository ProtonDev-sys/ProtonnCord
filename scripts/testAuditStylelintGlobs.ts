/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test, TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import stylelint from "stylelint";

const root = fileURLToPath(new URL("../", import.meta.url));
const configFile = join(root, ".stylelintrc.json");
const cli = join(dirname(createRequire(import.meta.url).resolve("stylelint/package.json")), "bin/stylelint.mjs");
const validCss = ".card {\n    color: red;\n}\n";

function fixture(t: TestContext, files: Record<string, string>) {
    const cwd = mkdtempSync(join(tmpdir(), "protonn-stylelint-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    for (const [name, contents] of Object.entries(files)) {
        const path = join(cwd, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
    }
    return cwd;
}

async function lint(cwd: string, options: Partial<stylelint.LinterOptions> = {}) {
    return stylelint.lint({ cwd, configFile, files: "**/*.css", allowEmptyInput: true, ...options });
}

function sources(cwd: string, result: stylelint.LinterResult) {
    return result.results.filter(file => !file.ignored)
        .map(file => relative(cwd, file.source!).split(sep).join("/"))
        .sort();
}

function runCli(cwd: string, args: string[]) {
    const result = spawnSync(process.execPath, [cli, "--config", configFile, ...args], {
        cwd, encoding: "utf8", timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
}

test("Stylelint retains the repository's CSS selection, userplugin exclusion and default vendor ignore", async t => {
    const cwd = fixture(t, {
        "src/base.css": validCss,
        "src/nested/theme.css": validCss,
        "src/nested/skip.css": validCss,
        "src/userplugins/local.css": "invalid {{{",
        "src/node_modules/vendor.css": "invalid {{{",
        "src/.hidden/theme.css": validCss,
        "elsewhere/outside.css": "invalid {{{",
        "src/not-css.txt": "invalid {{{",
    });
    const options = { files: "src/**/*.css", ignorePattern: ["src/userplugins"] };
    const result = await lint(cwd, options);
    assert.equal(result.errored, false);
    assert.deepEqual(sources(cwd, result), ["src/base.css", "src/nested/skip.css", "src/nested/theme.css"]);
    assert.deepEqual(sources(cwd, await lint(cwd, { ...options, files: [options.files, "!src/nested/skip.css"] })), [
        "src/base.css", "src/nested/theme.css",
    ]);
    assert.deepEqual(sources(cwd, await lint(cwd, { ...options, globbyOptions: { dot: true } })), [
        "src/.hidden/theme.css", "src/base.css", "src/nested/skip.css", "src/nested/theme.css",
    ]);
});

test("Stylelint accepts literal file paths containing glob characters and spaces", async t => {
    const names = ["square[box]/theme.css", "round(space)/theme.css", "curly{one,two}/theme.css", "plus+name/a b.css"];
    const cwd = fixture(t, Object.fromEntries(names.map(name => [name, validCss])));
    for (const name of names) {
        const result = await lint(cwd, { files: name });
        assert.equal(result.errored, false);
        assert.deepEqual(sources(cwd, result), [name]);
    }
});

test("Stylelint preserves brace, extglob, case and explicit ignore options", async t => {
    const cwd = fixture(t, { "alpha.css": validCss, "beta.css": validCss, "gamma.css": validCss });
    for (const files of ["{alpha,beta}.css", "+(alpha|beta).css"]) {
        assert.deepEqual(sources(cwd, await lint(cwd, { files })), ["alpha.css", "beta.css"]);
    }
    for (const [files, globbyOptions] of [
        ["{alpha,beta}.css", { braceExpansion: false }],
        ["+(alpha|beta).css", { extglob: false }],
    ] as const) {
        assert.deepEqual(sources(cwd, await lint(cwd, { files, globbyOptions })), []);
    }
    assert.deepEqual(sources(cwd, await lint(cwd, { files: "*.CSS", globbyOptions: { caseSensitiveMatch: false } })), [
        "alpha.css", "beta.css", "gamma.css",
    ]);
    assert.deepEqual(sources(cwd, await lint(cwd, { globbyOptions: { ignore: ["beta.css"] } })), ["alpha.css", "gamma.css"]);
});

test("Stylelint can include or exclude directory symlinks explicitly", async t => {
    const cwd = fixture(t, { "real/theme.css": validCss, "src/base.css": validCss });
    symlinkSync(join(cwd, "real"), join(cwd, "src/linked"), "junction");
    assert.deepEqual(sources(cwd, await lint(cwd, { files: "src/**/*.css" })), ["src/base.css", "src/linked/theme.css"]);
    assert.deepEqual(sources(cwd, await lint(cwd, { files: "src/**/*.css", globbyOptions: { followSymbolicLinks: false } })), [
        "src/base.css",
    ]);
});

test("Stylelint config ignoreFiles retains ordered negation, re-inclusion and all-negative lists", async t => {
    const cwd = fixture(t, { "keep.css": validCss, "drop.css": validCss });
    const cases = [
        { ignoreFiles: ["*.css", "!keep.css"], expected: ["keep.css"] },
        { ignoreFiles: ["*.css", "!keep.css", "keep.css"], expected: [] },
        { ignoreFiles: ["!keep.css"], expected: ["keep.css"] },
        { ignoreFiles: [], expected: ["drop.css", "keep.css"] },
    ];
    for (const { ignoreFiles, expected } of cases) {
        const result = await lint(cwd, { configFile: undefined, config: { rules: { "block-no-empty": true }, ignoreFiles } });
        assert.equal(result.errored, false);
        assert.deepEqual(sources(cwd, result), expected, JSON.stringify(ignoreFiles));
    }
});

test("Stylelint applies file-specific and basename overrides without changing the default rules", async t => {
    const cwd = fixture(t, { "nested/special.css": ".card {}", "nested/ordinary.css": ".card {}", ".hidden/special.css": ".card {}" });
    const result = await lint(cwd, {
        configFile: undefined,
        globbyOptions: { dot: true },
        config: {
            rules: { "color-no-invalid-hex": true },
            overrides: [{ files: "special.css", rules: { "block-no-empty": true } }],
        },
    });
    assert.deepEqual(result.results.filter(file => file.errored).map(file => relative(cwd, file.source!).split(sep).join("/")).sort(), [
        ".hidden/special.css", "nested/special.css",
    ]);
    assert.deepEqual(result.results.find(file => file.source!.endsWith("ordinary.css"))!.warnings, []);
});

test("Stylelint rejects unsupported glob options explicitly instead of silently changing their meaning", async t => {
    const cwd = fixture(t, { "theme.css": validCss });
    for (const name of ["cwd", "gitignore", "deep", "expandDirectories", "absolute", "signal"]) {
        await assert.rejects(lint(cwd, { globbyOptions: { [name]: true } }), new RegExp(`unknown option "${name}"`));
    }
    for (const invalid of [true, null, ["dot"]]) {
        await assert.rejects(lint(cwd, { globbyOptions: invalid as unknown as stylelint.GlobbyOptions }), /expected an object/);
    }
    const result = runCli(cwd, ["theme.css", "--globby-options", '{"cwd":"elsewhere"}']);
    assert.equal(result.status, 78);
    assert.match(result.stderr, /unknown option "cwd"/);
});

test("the installed Stylelint CLI still detects real rule violations, fixes CSS and prints configuration", async t => {
    const cwd = fixture(t, {
        "src/invalid.css": ".Bad_name {\n    colr: red;\n}\n",
        "src/fix.css": ".card {\n    color: #ffffff;\n}\n",
        "src/userplugins/local.css": "invalid {{{",
    });
    const result = runCli(cwd, ["src/**/*.css", "--ignore-pattern", "src/userplugins", "--formatter", "json"]);
    assert.equal(result.status, 2);
    const reports = JSON.parse(result.stderr) as stylelint.LintResult[];
    assert.deepEqual(reports.map(report => relative(cwd, report.source!).split(sep).join("/")).sort(), ["src/fix.css", "src/invalid.css"]);
    const rules = reports.flatMap(report => report.warnings.map(warning => warning.rule));
    for (const rule of ["selector-class-pattern", "property-no-unknown", "color-hex-length"]) assert.ok(rules.includes(rule), rule);
    const fixed = runCli(cwd, ["src/fix.css", "--fix"]);
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.equal(readFileSync(join(cwd, "src/fix.css"), "utf8"), ".card {\n    color: #fff;\n}\n");
    const printed = runCli(cwd, ["src/fix.css", "--print-config"]);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(JSON.parse(printed.stdout).rules["selector-class-pattern"][0], "^[a-z][a-zA-Z0-9]*(-[a-z0-9][a-zA-Z0-9]*)*$");
});

test("deeply nested brace input reaches the installed glob path without a recursive expansion crash", t => {
    const cwd = fixture(t, { "theme.css": validCss });
    const nested = "{".repeat(4900) + "theme.css" + "}".repeat(4900);
    const result = runCli(cwd, [nested, "--allow-empty-input"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /RangeError|Maximum call stack|out of memory/i);
});
