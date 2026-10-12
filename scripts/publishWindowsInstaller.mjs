// SPDX-License-Identifier: GPL-3.0-or-later
// Publish one verified installer without changing the in-app update channel.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
const identity = { tag_name: tag, target_commitish: sha, name: `ProtonnCord ${metadata.version} — Windows nightly`,
    body, prerelease: true };
const current = async () => {
    const ref = await api("GET", "/git/ref/heads/nightly");
    requireState(ref?.ref === "refs/heads/nightly" && ref.object?.type === "commit", "Invalid nightly branch response.");
    return ref.object.sha === sha;
};
const getRelease = () => api("GET", `/releases/tags/${tag}`);
const verifyIdentity = release => requireState(release && Number.isSafeInteger(release.id)
    && Object.entries(identity).every(([key, value]) => release[key] === value), "Unexpected Windows release identity.");
const getAssets = id => api("GET", `/releases/${id}/assets?per_page=100`);
const verifyAsset = assets => requireState(Array.isArray(assets) && assets.length === 1 && assets[0].name === name
    && assets[0].size === data.length && assets[0].digest === `sha256:${checksum}` && assets[0].state === "uploaded",
"The staged Windows executable does not match the tested artifact.");

if (!await current()) {
    console.log(`Skipping stale Windows installer for ${sha}.`);
} else {
    let release = await getRelease();
    if (!release) {
        try { release = await api("POST", "/releases", { ...identity, draft: true, make_latest: "false" }); }
        catch (error) { release = await getRelease(); if (!release) throw error; }
    }
    verifyIdentity(release);
    let assets = await getAssets(release.id);
    if (release.draft && Array.isArray(assets) && assets.length === 0) {
        try { await api("POST", `/releases/${release.id}/assets?name=${name}`, data, true); }
        catch (error) {
            assets = await getAssets(release.id);
            if (!Array.isArray(assets) || assets.length === 0) throw error;
        }
        assets = await getAssets(release.id);
    }
    verifyAsset(assets);
    requireState(await current(), "Nightly advanced; the Windows installer remains staged.");
    const existingTag = await api("GET", `/git/ref/tags/${tag}`);
    requireState(!existingTag || (existingTag.ref === `refs/tags/${tag}`
        && existingTag.object?.type === "commit" && existingTag.object.sha === sha), "Unexpected Windows tag target.");
    if (release.draft) {
        try { await api("PATCH", `/releases/${release.id}`, { draft: false, make_latest: "false" }); }
        catch (error) { if ((await getRelease())?.draft !== false) throw error; }
    }
    const published = await getRelease();
    verifyIdentity(published);
    requireState(published.id === release.id && published.draft === false, "Windows release did not publish.");
    const publishedTag = await api("GET", `/git/ref/tags/${tag}`);
    requireState(publishedTag?.object?.type === "commit" && publishedTag.object.sha === sha, "Published Windows tag mismatch.");
    const publishedAssets = await getAssets(release.id);
    verifyAsset(publishedAssets);
    const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    requireState(publishedAssets[0].browser_download_url === url, "Unexpected Windows download endpoint.");
    console.log(`Published ${url} (${checksum}).`);
}
