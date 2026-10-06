/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { unzipSync } from "fflate";

const directory = resolve(process.argv[2] ?? "dist/public-release");
const digest = data => createHash("sha256").update(data).digest("hex");
const metadata = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
for (const line of (await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n")) {
    const [hash, name] = line.split("  ");
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]+$/u);
    assert.equal(digest(await readFile(join(directory, name))), hash, `release checksum: ${name}`);
}
for (const platform of ["Windows", "Linux"]) {
    const entries = unzipSync(await readFile(join(directory, `ProtonnCord-${metadata.version}-${platform}.zip`)));
    const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
    assert.equal(manifest.revision, metadata.revision);
    assert.deepEqual(Object.keys(entries).sort(), [...Object.keys(manifest.files), "manifest.json", "payload.sha256"].sort());
    for (const [name, hash] of Object.entries(manifest.files)) {
        assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]+$/u);
        assert.equal(digest(entries[name]), hash, `bundle checksum: ${name}`);
    }
    if (platform !== "Windows" || process.platform !== "win32") continue;
    const processes = spawnSync("powershell.exe", ["-NoProfile", "-Command", "if (Get-Process DiscordDevelopment -ErrorAction SilentlyContinue) { exit 1 }"], { encoding: "utf8" });
    assert.equal(processes.status, 0, "Close DiscordDevelopment before the disposable installer test");
    const fixture = await mkdtemp(join(tmpdir(), "protonn-release-fixture-"));
    try {
        const bundle = join(fixture, "bundle"), data = join(fixture, "data"), discord = join(fixture, "discord-dev");
        const resources = join(discord, "app-0.0.1", "resources");
        await mkdir(bundle); await mkdir(resources, { recursive: true });
        for (const [name, bytes] of Object.entries(entries)) await writeFile(join(bundle, name), bytes);
        const original = Buffer.from("Disposable Discord application fixture. No account data.");
        await writeFile(join(resources, "app.asar"), original);
        function run(action, location = discord) {
            return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(bundle, "Install.ps1"), "-Action", action, "-DiscordPath", location, "-DataDirectory", data], {
                encoding: "utf8", timeout: 60_000,
                env: { ...process.env, APPDATA: fixture, LOCALAPPDATA: fixture },
            });
        }
        const installed = run("Install");
        assert.equal(installed.status, 0, installed.stdout + installed.stderr);
        assert.deepEqual(await readFile(join(resources, "_app.asar")), original);
        assert.equal(digest(await readFile(join(data, "desktop.asar"))), manifest.files["desktop.asar"]);
        const uninstalled = run("Uninstall");
        assert.equal(uninstalled.status, 0, uninstalled.stdout + uninstalled.stderr);
        assert.deepEqual(await readFile(join(resources, "app.asar")), original);
        assert.equal((await readdir(resources)).includes("_app.asar"), false);
        await writeFile(join(data, "desktop.asar"), "previous installation");
        assert.equal(run("Install", join(fixture, "missing-dev")).status, 1);
        assert.equal(await readFile(join(data, "desktop.asar"), "utf8"), "previous installation", "failed install restores the previous payload");
        await writeFile(join(bundle, "desktop.asar"), "tampered download");
        const tampered = run("Install");
        assert.equal(tampered.status, 1);
        assert.match(tampered.stdout, /Checksum failed/u);
        assert.deepEqual(await readFile(join(resources, "app.asar")), original, "tampered payload never patches Discord");
        assert.equal(await readFile(join(data, "desktop.asar"), "utf8"), "previous installation");
        console.log("Disposable Windows install, uninstall, rollback and tamper rejection passed.");
    } finally {
        assert.equal(resolve(fixture, ".."), resolve(tmpdir()));
        await rm(fixture, { recursive: true, force: true });
    }
}
console.log("Release archive contents, provenance and SHA-256 checks passed.");
