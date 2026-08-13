/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strict as assert } from "assert";
import { readFile } from "fs/promises";
import { posix, win32 } from "path";

import {
    parseUserpluginRepositoryUrl,
    resolveUserpluginDirectory
} from "../src/equicordplugins/userpluginInstaller.dev/repositorySafety";

async function main() {
    const validCases = [
    ["https://github.com/owner/repository", "owner", "repository"],
    ["https://gitlab.com/owner/repo-name.git", "owner", "repo-name"],
    ["https://codeberg.org/owner/repo.name/", "owner", "repo.name"],
    ["https://git.example.org/owner/repo_name", "owner", "repo_name"],
    ["https://plugins.nin0.dev/example-plugin", "nin0", "example-plugin"]
] as const;

    for (const [url, owner, repo] of validCases) {
    const parsed = parseUserpluginRepositoryUrl(url);
    assert.ok(parsed, `${url} should be accepted`);
    assert.equal(parsed.owner, owner);
    assert.equal(parsed.repo, repo);
    }

    for (const url of [
    "https://github.com/owner/.",
    "https://github.com/owner/..",
    "https://github.com/owner/...",
    "https://github.com/owner/.git",
    "https://github.com/owner/repo/child",
    "https://github.com/owner/%2e%2e",
    "https://github.com/owner/repo?token=secret",
    "https://user:pass@github.com/owner/repo",
    "https://github.com:8443/owner/repo",
    "http://github.com/owner/repo",
    "https://evil.example/owner/repo"
    ]) assert.equal(parseUserpluginRepositoryUrl(url), null, `${url} must be rejected`);

    assert.equal(resolveUserpluginDirectory("/workspace/src/userplugins", "safe-plugin", posix), "/workspace/src/userplugins/safe-plugin");
    assert.equal(resolveUserpluginDirectory("C:\\workspace\\src\\userplugins", "safe-plugin", win32), "C:\\workspace\\src\\userplugins\\safe-plugin");

    for (const name of [".", "..", "...", ".git", "../outside", "child/name", "child\\name", "C:\\outside", "/outside"]) {
    assert.throws(() => resolveUserpluginDirectory("/workspace/src/userplugins", name, posix));
    assert.throws(() => resolveUserpluginDirectory("C:\\workspace\\src\\userplugins", name, win32));
    }

    const nativeSource = await readFile(new URL("../src/equicordplugins/userpluginInstaller.dev/native.ts", import.meta.url), "utf8");
    assert.match(nativeSource, /parseUserpluginRepositoryUrl\(link\)/, "native code must parse the URL itself");
    assert.match(nativeSource, /getUserpluginPath\(repo\)/, "all repository paths must use the direct-child resolver");
    assert.match(nativeSource, /\["clone", "--", link, destination\]/, "git clone must receive the validated destination explicitly");
    assert.match(nativeSource, /lstat\(destination\)\)\.isSymbolicLink\(\)/, "cleanup must reject symbolic links and junctions");
    assert.doesNotMatch(nativeSource, /initPluginInstall\(_, link: string, source:/, "renderer URL fields must not be trusted");
    assert.doesNotMatch(nativeSource, /rm\(join\([^\n]*userplugins[^\n]*(?:repo|name)/, "recursive deletion must not join an untrusted name");

    console.log("Userplugin repository path safety tests passed.");
}

void main();
