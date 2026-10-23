/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { load } from "yaml-js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginId = "uk.co.protonn.secure-messaging";
const pluginZip = `${pluginId}.zip`;
const context = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: "ProtonDev-sys/ProtonnCord",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_NUMBER: "174",
    GITHUB_RUN_ATTEMPT: "2",
};
const workflow = load(readFileSync(join(root, ".github/workflows/mobile.yml"), "utf8"));
const publish = workflow.jobs.publish.steps.find((step: any) => step.name === "Publish immutable build then update nightly index");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const json = (data: unknown) => JSON.stringify(data, null, 2) + "\n";

function fixture(t: TestContext, buildAttempt = 1, manifestAttempt = buildAttempt, manifestFormat: number | boolean = 1) {
    const directory = mkdtempSync(join(tmpdir(), "mobile-release-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const dist = join(directory, "dist");
    mkdirSync(dist);
    symlinkSync(join(root, "mobile"), join(directory, "mobile"), "dir");
    const version = `0.2.174.${buildAttempt}-nightly`;
    const tag = `mobile-build-42-${buildAttempt}`;
    const manifest = JSON.parse(readFileSync(join(root, "mobile/plugins/secure-messaging/manifest.json"), "utf8"));
    manifest.version = `0.2.174.${manifestAttempt}-nightly`;
    manifest.format = manifestFormat;
    const bytes = zipSync({
        "manifest.json": strToU8(json(manifest)),
        "index.js": strToU8("module.exports = {};"),
        "plugin.jar": strToU8("native fixture"),
    });
    const config = JSON.parse(readFileSync(join(root, "mobile/repo.config.json"), "utf8"));
    const index = {
        format: 1, name: config.name, description: config.description,
        plugins: {
            [pluginId]: {
                name: manifest.name, description: manifest.description, author: manifest.author, icon: manifest.icon,
                channels: { latest: version, beta: version, nightly: version },
                versions: { [version]: {
                    url: `https://github.com/${context.GITHUB_REPOSITORY}/releases/download/${tag}/${pluginZip}`,
                    sha256: sha256(bytes), size: bytes.length, dependencies: manifest.dependencies,
                } },
            },
        },
    };
    const assets: Record<string, Uint8Array> = {
        [pluginZip]: bytes,
        "revenge.bundle": strToU8("pinned runtime fixture"),
        "revenge-runtime-source.zip": strToU8("pinned source fixture"),
        "REVENGE-LICENSE": strToU8("license fixture"),
        "desktop-commit.txt": strToU8(context.GITHUB_SHA + "\n"),
        "toolchain.json": readFileSync(join(root, "mobile/toolchain.json")),
        "index.json": strToU8(json(index)),
    };
    assets.SHA256SUMS = strToU8([pluginZip, "revenge.bundle", "revenge-runtime-source.zip"]
        .map(name => `${sha256(assets[name])}  ${name}\n`).join(""));
    for (const [name, data] of Object.entries(assets)) writeFileSync(join(dist, name), data);
    return { directory, dist, index, version, tag, assets };
}

function validate(dist: string, overrides: Record<string, string> = {}) {
    return spawnSync("python3", ["-B", join(root, "mobile/tools/validate_release.py"), dist], {
        cwd: root, env: { ...context, ...overrides }, encoding: "utf8",
    });
}

function publishFixture(build: ReturnType<typeof fixture>, conflict = false, newerNightly = false) {
    const bin = join(build.directory, "bin");
    mkdirSync(bin);
    const calls = join(build.directory, "calls.jsonl");
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env python3
import json, os, sys
with open(os.environ["MOBILE_TEST_CALLS"], "a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
if os.environ["MOBILE_TEST_CONFLICT"] == "1" and sys.argv[1:3] == ["release", "create"]:
    sys.exit(1)
if sys.argv[1:3] == ["api", f"repos/{os.environ['GITHUB_REPOSITORY']}/git/ref/tags/mobile-nightly"]:
    print(f"commit {os.environ['GITHUB_SHA']}")
`);
    writeFileSync(join(bin, "git"), `#!/usr/bin/env python3
import os, sys
if sys.argv[1:] == ["rev-parse", "FETCH_HEAD"]:
    print(os.environ["MOBILE_TEST_NIGHTLY"])
elif sys.argv[1:] != ["fetch", "--no-tags", "origin", "refs/heads/nightly"]:
    sys.exit(1)
`);
    for (const name of ["gh", "git"]) chmodSync(join(bin, name), 0o755);
    const script = publish.run.replaceAll("${{ github.run_id }}", context.GITHUB_RUN_ID)
        .replaceAll("${{ github.run_attempt }}", context.GITHUB_RUN_ATTEMPT);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
        cwd: build.directory,
        env: { ...context, PATH: `${bin}:${context.PATH}`, MOBILE_TEST_CALLS: calls,
            MOBILE_TEST_CONFLICT: conflict ? "1" : "0", MOBILE_TEST_NIGHTLY: newerNightly ? "b".repeat(40) : context.GITHUB_SHA },
        encoding: "utf8",
    });
    return { result, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [] };
}

test("publish-only retry retains the downloaded build's tag, version and bytes", t => {
    const build = fixture(t);
    const { result, calls } = publishFixture(build);
    assert.equal(result.status, 0, result.stderr);
    const created = calls.find(args => args[0] === "release" && args[1] === "create");
    assert.ok(created);
    assert.equal(created[2], build.tag, "attempt 2 must publish the artifact's attempt-1 tag");
    assert.equal(created[created.indexOf("--target") + 1], context.GITHUB_SHA);
    assert.deepEqual(calls.slice(-3), [
        ["release", "upload", "mobile-nightly", "dist/index.json", "--clobber"],
        ["api", "--method", "PATCH", `repos/${context.GITHUB_REPOSITORY}/git/refs/tags/mobile-nightly`,
            "--field", `sha=${context.GITHUB_SHA}`, "--field", "force=true"],
        ["api", `repos/${context.GITHUB_REPOSITORY}/git/ref/tags/mobile-nightly`,
            "--jq", '.object.type + " " + .object.sha'],
    ]);
    assert.deepEqual(readdirSync(build.dist).sort(), Object.keys(build.assets).sort());
    for (const [name, bytes] of Object.entries(build.assets)) assert.deepEqual(readFileSync(join(build.dist, name)), Buffer.from(bytes));
});

test("fresh builds and full reruns use their own validated attempt", t => {
    for (const attempt of [1, 2]) {
        const build = fixture(t, attempt);
        const result = validate(build.dist, { GITHUB_RUN_ATTEMPT: String(attempt) });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, build.tag + "\n");
    }
});

test("immutable conflicts abort before runtime or nightly pointer writes", t => {
    const build = fixture(t);
    const { result, calls } = publishFixture(build, true);
    assert.notEqual(result.status, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), ["release", "create", build.tag]);
});

test("a newer nightly revision keeps its current channel pointer", t => {
    const { result, calls } = publishFixture(fixture(t), false, true);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls.some(args => args[1] === "create"));
    assert.ok(calls.every(args => !args.includes("mobile-nightly")));
});

test("mixed identities and checksums fail before any release request", t => {
    const mutations: Array<(build: ReturnType<typeof fixture>) => void> = [
        build => writeFileSync(join(build.dist, "desktop-commit.txt"), "b".repeat(40) + "\n"),
        build => writeFileSync(join(build.dist, "toolchain.json"), "{}\n"),
        build => { build.index.plugins[pluginId].versions[build.version].url = `https://github.com/${context.GITHUB_REPOSITORY}/releases/download/mobile-build-43-1/${pluginZip}`; },
        build => { build.index.plugins[pluginId].versions[build.version].url += "?redirect=elsewhere"; },
        build => { build.index.plugins[pluginId].channels.beta = "0.2.174.2-nightly"; },
        build => { build.index.plugins[pluginId].versions[build.version].sha256 = "b".repeat(64); },
        build => { build.index.plugins[pluginId].versions[build.version].size++; },
        build => { build.index.plugins[pluginId].versions[build.version].dependencies = {}; },
        build => writeFileSync(join(build.dist, "revenge.bundle"), "changed runtime"),
        build => writeFileSync(join(build.dist, "SHA256SUMS"), readFileSync(join(build.dist, "SHA256SUMS"), "utf8").split("\n")[0] + "\n"),
        build => writeFileSync(join(build.dist, "SHA256SUMS"), readFileSync(join(build.dist, "SHA256SUMS"), "utf8").replaceAll("\n", "\v")),
        build => writeFileSync(join(build.dist, "SHA256SUMS"), readFileSync(join(build.dist, "SHA256SUMS"), "utf8").replaceAll("\n", "\r\n")),
        build => writeFileSync(join(build.dist, "unexpected.txt"), "extra asset"),
        build => rmSync(join(build.dist, "REVENGE-LICENSE")),
    ];
    for (const mutate of mutations) {
        const build = fixture(t);
        mutate(build);
        writeFileSync(join(build.dist, "index.json"), json(build.index));
        const { result, calls } = publishFixture(build);
        assert.notEqual(result.status, 0, "invalid build must abort publication");
        assert.match(result.stderr, /Refusing Mobile publication:/);
        assert.deepEqual(calls, []);
    }
});

test("package and workflow attempt identities must agree", t => {
    for (const build of [fixture(t, 1, 2), fixture(t, 3), fixture(t, 1, 1, true)]) {
        const { result, calls } = publishFixture(build);
        assert.notEqual(result.status, 0);
        assert.deepEqual(calls, []);
    }
    const build = fixture(t);
    const invalidContexts: Array<Record<string, string>> = [
        { GITHUB_RUN_NUMBER: "175" }, { GITHUB_RUN_ID: "43" }, { GITHUB_RUN_ATTEMPT: "0" },
        { GITHUB_RUN_ID: "42; echo injected" }, { GITHUB_REPOSITORY: "../../elsewhere" }, { GITHUB_SHA: "nightly" },
    ];
    for (const overrides of invalidContexts) {
        const result = validate(build.dist, overrides);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
    }
});

test("ambiguous JSON, symlinks and oversized identities are rejected", t => {
    const mutations: Array<(build: ReturnType<typeof fixture>) => void> = [
        build => writeFileSync(join(build.dist, "index.json"), json(build.index).replace('"format": 1', '"format": 1, "format": 1')),
        build => writeFileSync(join(build.dist, "index.json"), json({ ...build.index, format: true })),
        build => writeFileSync(join(build.dist, "index.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json(build.index), "utf16le")])),
        build => writeFileSync(join(build.dist, "index.json"), " ".repeat(65_537)),
        build => { rmSync(join(build.dist, "index.json")); symlinkSync(join(root, "mobile/toolchain.json"), join(build.dist, "index.json")); },
    ];
    for (const mutate of mutations) {
        const build = fixture(t);
        mutate(build);
        const { result, calls } = publishFixture(build);
        assert.notEqual(result.status, 0);
        assert.deepEqual(calls, []);
    }
});

test("actual Mobile artifacts are validated before upload and again after the full Test gate", () => {
    const steps = workflow.jobs.publish.steps;
    const gate = steps.findIndex((step: any) => step.run === "node scripts/requireReleaseValidation.mjs");
    const download = steps.findIndex((step: any) => step.uses?.startsWith("actions/download-artifact@"));
    assert.ok(gate >= 0 && download > gate && steps.indexOf(publish) > download);
    const build = workflow.jobs.build.steps;
    const validation = build.findIndex((step: any) => step.run?.includes("tools/validate_release.py"));
    const upload = build.findIndex((step: any) => step.uses?.startsWith("actions/upload-artifact@"));
    assert.ok(validation >= 0 && upload > validation);
    assert.match(build[validation].run, /sha256sum .*\n\s*python3 -B \.\.\/\.\.\/tools\/validate_release\.py \./);
});
