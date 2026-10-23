/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractFile } from "@electron/asar";
import { zipSync } from "fflate";

import { ensureCachedArtifact, EQUILOTL_ARTIFACTS, EQUILOTL_RELEASE } from "./runInstaller.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha256 = data => createHash("sha256").update(data).digest("hex");

export async function packagePublicRelease(directory = resolve(root, "dist/public-release")) {
    if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim())
        throw new Error("Commit the release source before packaging; source and binary provenance must agree.");
    const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const epoch = Number(execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const mtime = new Date(Math.max(epoch, 315532800) * 1000);
    const banner = extractFile(resolve(root, "dist/desktop.asar"), "patcher.js").toString("utf8").slice(0, 300);
    for (const expected of [`// Protonn Cord ${revision}`, "// Standalone: true", "// Development: false", "// Updater Disabled: false"])
        if (!banner.includes(expected)) throw new Error(`Desktop build does not match release provenance: ${expected}`);
    await mkdir(directory, { recursive: true });
    if ((await readdir(directory)).length) throw new Error("Public release output must be empty; choose a fresh directory.");
    const common = {
        "desktop.asar": await readFile(resolve(root, "dist/desktop.asar")),
        "LICENSE": await readFile(resolve(root, "LICENSE")),
        "README.txt": await readFile(resolve(root, "scripts/release/README.txt")),
        "THIRD-PARTY.txt": Buffer.from(`Protonn Cord ${version} (${revision})\nBased on Equicord and Vencord; GPL-3.0-or-later.\n\nInstaller: unmodified Equilotl ${EQUILOTL_RELEASE.tag}\nSource commit: ${EQUILOTL_RELEASE.commit}\nhttps://github.com/Equicord/Equilotl/tree/${EQUILOTL_RELEASE.commit}\nGPL-3.0; corresponding source is Equilotl-source.zip on this release.\nProtonnCord-source.zip contains this release's application source and dependency lockfiles.\n`),
    };
    if (!common["desktop.asar"].length) throw new Error("Desktop build is empty");
    const assets = [];
    async function save(name, bytes) {
        await writeFile(resolve(directory, name), bytes, { flag: "wx" });
        assets.push({ name, size: bytes.length, sha256: sha256(bytes) });
    }
    for (const [platform, artifact, launchers] of [
        ["Windows", EQUILOTL_ARTIFACTS.win32, ["Install.ps1", "Install.cmd", "Uninstall.cmd"]],
        ["Linux", EQUILOTL_ARTIFACTS.linux, ["install.sh"]],
    ]) {
        const entries = { ...common, [artifact.filename]: await readFile(await ensureCachedArtifact(artifact)) };
        for (const launcher of launchers) entries[launcher] = await readFile(resolve(root, "scripts/release", launcher));
        const files = Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, sha256(bytes)]));
        entries["manifest.json"] = Buffer.from(JSON.stringify({ version, revision, installer: EQUILOTL_RELEASE, files }, null, 2) + "\n");
        entries["payload.sha256"] = Buffer.from(`${files["desktop.asar"]}  desktop.asar\n${files[artifact.filename]}  ${artifact.filename}\n`);
        const zipEntries = Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, [bytes, { mtime }]]));
        await save(`ProtonnCord-${version}-${platform}.zip`, zipSync(zipEntries, { level: 6 }));
    }
    for (const name of ["extension-chrome.zip", "extension-firefox.zip", "ProtonnCord.user.js", "ProtonnCord.user.js.LEGAL.txt"])
        await save(name, await readFile(resolve(root, "dist", name)));
    await save("ProtonnCord-source.zip", execFileSync("git", ["archive", "--format=zip", revision], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
    const sourceResponse = await fetch(`https://codeload.github.com/Equicord/Equilotl/zip/${EQUILOTL_RELEASE.commit}`, { signal: AbortSignal.timeout(60_000) });
    if (!sourceResponse.ok) throw new Error(`Installer source download failed: ${sourceResponse.status}`);
    const sourceBytes = Buffer.from(await sourceResponse.arrayBuffer());
    if (!sourceBytes.length || sourceBytes.length > 16 * 1024 * 1024) throw new Error("Invalid installer source archive size");
    await save("Equilotl-source.zip", sourceBytes);
    await save("release.json", Buffer.from(JSON.stringify({ version, revision, installer: EQUILOTL_RELEASE, assets }, null, 2) + "\n"));
    await save("SHA256SUMS", Buffer.from(assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join("")));
    console.log(`Packaged ${assets.length} public release assets for ${version} (${revision}).`);
    return assets;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await packagePublicRelease(process.argv[2] ? resolve(process.argv[2]) : undefined);
