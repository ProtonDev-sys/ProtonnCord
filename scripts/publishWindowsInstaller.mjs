// SPDX-License-Identifier: GPL-3.0-or-later
// Publish one verified installer without changing the in-app update channel.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { publishInstaller } from "./publishInstaller.mjs";
import { createGithubApi } from "./releaseUpdateChannel.mjs";

const repository = "ProtonDev-sys/ProtonnCord";
const { GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SHA: sha, GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: attempt, GITHUB_TOKEN } = process.env;
const requireState = (condition, message) => { if (!condition) throw new Error(message); };
requireState(GITHUB_REPOSITORY === repository && GITHUB_REF_NAME === "nightly"
    && /^[a-f0-9]{40}$/u.test(sha ?? "") && /^\d+$/u.test(runId ?? "") && /^\d+$/u.test(attempt ?? ""),
"Windows publication requires an exact nightly workflow identity.");

const name = "ProtonnCordSetup.exe";
const directory = "dist/windows";
const data = await readFile(`${directory}/${name}`);
const metadata = JSON.parse(await readFile(`${directory}/ProtonnCordSetup.json`, "utf8"));
const checksum = createHash("sha256").update(data).digest("hex");
requireState(data.length > 0 && data.length <= 128 * 1024 * 1024 && data.subarray(0, 2).toString() === "MZ",
    "The Windows artifact is not a bounded executable.");
requireState((await readFile(`${directory}/${name}.sha256`, "utf8")) === `${checksum}  ${name}\n`
    && metadata.repository === repository && metadata.commit === sha && metadata.updateBranch === "nightly"
    && /^\d+(?:\.\d+){2,3}$/u.test(metadata.version), "Windows artifact identity or checksum mismatch.");

const api = createGithubApi(GITHUB_TOKEN);
const tag = `windows-${runId}-${attempt}`;
requireState(/^https:\/\/github\.com\/Equicord\/Equilotl\/tree\/[a-f0-9]{40}$/u.test(metadata.installerSource ?? ""),
    "Invalid pinned installer source.");
const body = `Close Discord, run **${name}**, and select your Discord installation. ProtonnCord updates follow nightly.\n\n`
    + `[Source and license](https://github.com/${repository}/tree/${sha}) · `
    + `[Pinned installer source](${metadata.installerSource})\n\n`
    + `SHA-256: \`${checksum}\`\n`;
await publishInstaller({ api, repository, sha, tag, name, data, checksum,
    title: `ProtonnCord ${metadata.version} — Windows nightly`, body, platform: "Windows" });
