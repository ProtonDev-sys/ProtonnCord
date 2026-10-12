// SPDX-License-Identifier: GPL-3.0-or-later
// Uses Windows' built-in .NET Framework compiler; no extra installer framework.
import { extractFile } from "@electron/asar";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EQUILOTL_RELEASE, getArtifact, ensureCachedArtifact } from "./runInstaller.mjs";

if (process.platform !== "win32") throw new Error("Build the Windows installer on Windows.");
const repository = "ProtonDev-sys/ProtonnCord";
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid source commit.");
const archive = resolve("dist/desktop.asar");
const main = extractFile(archive, "patcher.js").toString("utf8");
for (const expected of [`// Protonn Cord ${commit}`, "// Standalone: true", "// Development: false", "// Updater Disabled: false", repository])
    if (!main.includes(expected)) throw new Error(`desktop.asar does not match the installer build: ${expected}`);

const artifact = getArtifact("win32");
const cli = await ensureCachedArtifact(artifact);
const output = resolve("dist/windows");
mkdirSync(output, { recursive: true });
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const metadata = {
    repository,
    commit,
    version: JSON.parse(readFileSync("package.json", "utf8")).version,
    updateBranch: "nightly",
    archiveSha256: hash(archive),
    installerSha256: artifact.sha256,
    installerSource: `https://github.com/Equicord/Equilotl/tree/${EQUILOTL_RELEASE.commit}`,
    installerVersion: EQUILOTL_RELEASE.tag
};
const manifest = join(output, "ProtonnCordSetup.json");
writeFileSync(manifest, JSON.stringify(metadata, null, 2) + "\n");
const executable = join(output, "ProtonnCordSetup.exe");
execFileSync(join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), [
    "/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/checked+", "/warnaserror+", "/codepage:65001",
    "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
    `/resource:${archive},desktop.asar`, `/resource:${cli},EquilotlCli.exe`, `/resource:${manifest},installer.json`,
    `/out:${executable}`, resolve("scripts/windows/ProtonnCordSetup.cs")
], { stdio: "inherit" });
copyFileSync("LICENSE", join(output, "ProtonnCordSetup-LICENSE.txt"));
writeFileSync(join(output, "ProtonnCordSetup.exe.sha256"), `${hash(executable)}  ProtonnCordSetup.exe\n`);
console.log(`Built ${executable} for ProtonnCord nightly ${commit}.`);
