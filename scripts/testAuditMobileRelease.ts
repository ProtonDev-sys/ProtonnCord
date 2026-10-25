/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

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
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const json = (data: unknown) => JSON.stringify(data, null, 2) + "\n";

function fixture(t: TestContext, buildAttempt = 1, manifestAttempt = buildAttempt, manifestFormat: number | boolean = 1) {
    const directory = mkdtempSync(join(tmpdir(), "mobile-release-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const dist = join(directory, "dist");
    mkdirSync(dist);
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

test("fresh builds and retries retain their validated build attempt", t => {
    for (const [buildAttempt, currentAttempt] of [[1, 1], [2, 2], [1, 2]]) {
        const build = fixture(t, buildAttempt);
        const result = validate(build.dist, { GITHUB_RUN_ATTEMPT: String(currentAttempt) });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, build.tag + "\n");
    }
});

test("mixed identities and checksums fail validation", t => {
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
        const result = validate(build.dist);
        assert.notEqual(result.status, 0, "invalid build must fail validation");
        assert.match(result.stderr, /Refusing Mobile publication:/);
        assert.equal(result.stdout, "");
    }
});

test("package and release attempt identities must agree", t => {
    for (const build of [fixture(t, 1, 2), fixture(t, 3), fixture(t, 1, 1, true)]) {
        const result = validate(build.dist);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
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
        const result = validate(build.dist);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
    }
});
