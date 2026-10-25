// SPDX-License-Identifier: GPL-3.0-or-later
// Publication only; publish-mobile.sh validates the retained exact-job artifacts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGithubApi, readReleaseFiles } from "../releaseUpdateChannel.mjs";

const repository = "ProtonDev-sys/ProtonnCord";
const shaPattern = /^[a-f0-9]{40}$/u;
const assetNames = ["REVENGE-LICENSE", "SHA256SUMS", "desktop-commit.txt", "index.json", "revenge-runtime-source.zip", "revenge.bundle", "toolchain.json", "uk.co.protonn.secure-messaging.zip"];
const runtimeNames = ["revenge.bundle", "revenge-runtime-source.zip", "REVENGE-LICENSE", "toolchain.json"];
const requireState = (condition, message) => { if (!condition) throw new Error(message); };
const digest = data => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const validId = id => Number.isSafeInteger(id) && id > 0;

export async function publishMobile({ api, readAsset, sha, tag, files }) {
    requireState(shaPattern.test(sha) && /^mobile-build-[1-9][0-9]{0,18}-[1-9][0-9]{0,18}$/u.test(tag), "Invalid Mobile release identity");
    requireState(files.length === assetNames.length && new Set(files.map(file => file.name)).size === files.length
        && assetNames.every(name => files.some(file => file.name === name)), "Expected exactly the eight retained Mobile assets");
    for (const file of files)
        requireState(file.size > 0 && file.size <= 32 * 1024 * 1024 && file.size === file.data.length && file.digest === digest(file.data), `Invalid retained asset: ${file.name}`);
    requireState(files.find(file => file.name === "desktop-commit.txt").data.toString("utf8") === `${sha}\n`, "Retained desktop SHA mismatch");
    const toolchain = JSON.parse(files.find(file => file.name === "toolchain.json").data.toString("utf8"));
    requireState(shaPattern.test(toolchain.revengeRuntimeRevision) && toolchain.runtimeRelease === `mobile-runtime-${toolchain.revengeRuntimeRevision.slice(0, 7)}`, "Invalid pinned runtime identity");

    const ref = tag => api("GET", `/git/ref/tags/${tag}`);
    const currentHead = async () => {
        const head = await api("GET", "/git/ref/heads/nightly");
        requireState(head?.ref === "refs/heads/nightly" && head.object?.type === "commit" && shaPattern.test(head.object.sha), "Invalid nightly branch identity");
        return head.object.sha === sha;
    };
    const guard = async () => requireState(await currentHead(), "Nightly advanced; no further Mobile publication is allowed");
    const assets = async id => {
        const result = await api("GET", `/releases/${id}/assets?per_page=100`);
        requireState(Array.isArray(result) && result.length < 100 && result.every(asset => validId(asset.id))
            && new Set(result.map(asset => asset.name)).size === result.length
            && new Set(result.map(asset => asset.id)).size === result.length, "Invalid, duplicate or excessive Mobile release assets");
        return result;
    };
    const findRelease = async tag => {
        // Unpublished drafts may not be discoverable through the tag endpoint.
        const published = await api("GET", `/releases/tags/${tag}`);
        if (published) return published;
        const found = [];
        for (let page = 1; page <= 10; page++) {
            const releases = await api("GET", `/releases?per_page=100&page=${page}`);
            requireState(Array.isArray(releases), "Invalid release listing");
            found.push(...releases.filter(release => release.tag_name === tag));
            requireState(found.length <= 1, "Ambiguous Mobile draft release");
            if (releases.length < 100) return found[0] ?? null;
        }
        throw new Error("Mobile release discovery pagination budget exhausted");
    };
    const verifyFile = async (asset, file) => {
        requireState(asset.state === "uploaded" && asset.size === file.size
            && (asset.digest == null || asset.digest === file.digest), `Conflicting Mobile asset: ${file.name}`);
        const bytes = await readAsset(asset.id);
        requireState(bytes.length === file.size && digest(bytes) === file.digest, `Mobile asset bytes differ: ${file.name}`);
    };
    const identity = async (release, spec) => {
        requireState(validId(release?.id) && release.tag_name === spec.tag && release.name === spec.title
            && release.prerelease === true && typeof release.draft === "boolean"
            && shaPattern.test(release.target_commitish) && (!spec.exactSha || release.target_commitish === sha), "Mobile release identity mismatch");
        const tagRef = await ref(spec.tag);
        requireState((release.draft && !tagRef) || (tagRef?.ref === `refs/tags/${spec.tag}`
            && tagRef.object?.type === "commit" && tagRef.object.sha === release.target_commitish), "Mobile release tag SHA mismatch");
    };
    const inspect = async spec => {
        const release = await findRelease(spec.tag);
        if (!release) {
            requireState(!await ref(spec.tag), "Mobile tag exists without a discoverable release");
            return { release: null, missing: spec.files, placeholders: [] };
        }
        await identity(release, spec);
        const existing = await assets(release.id);
        requireState(existing.every(asset => spec.files.some(file => file.name === asset.name)), "Unexpected Mobile release asset");
        // Only an empty failed-upload placeholder on this matching draft can be
        // removed. Every uploaded byte is verified and is never replaced.
        const placeholders = existing.filter(asset => release.draft && !release.immutable
            && asset.state === "starter" && asset.size === 0 && asset.digest == null);
        const uploaded = existing.filter(asset => !placeholders.includes(asset));
        for (const asset of uploaded) await verifyFile(asset, spec.files.find(file => file.name === asset.name));
        const missing = spec.files.filter(file => !uploaded.some(asset => asset.name === file.name));
        requireState(!missing.length || (release.draft && !release.immutable), "Published Mobile release is incomplete; replacing assets is prohibited");
        return { release, missing, placeholders };
    };
    const build = {
        tag, title: `Mobile nightly ${sha}`, exactSha: true, files,
        notes: `Android Secure Messaging built and tested against desktop revision ${sha}.`
    };
    const runtime = {
        tag: toolchain.runtimeRelease, title: "Pinned Revenge Next runtime for ProtonnCord Mobile", exactSha: false,
        files: files.filter(file => runtimeNames.includes(file.name)),
        notes: "Revenge runtime, corresponding upstream source, and license. Runtime updates are pinned separately from plugin updates."
    };
    // Check both releases before making any writes, including a reused runtime
    // whose desktop target may legitimately predate this build.
    const plans = [await inspect(build), await inspect(runtime)];
    if (!await currentHead()) return { skipped: true };
    for (const [i, spec] of [build, runtime].entries()) {
        let { release, missing, placeholders } = plans[i];
        if (!release) {
            await guard();
            release = await api("POST", "/releases", { tag_name: spec.tag, target_commitish: sha, name: spec.title,
                body: spec.notes, draft: true, prerelease: true, make_latest: "false" });
            await identity(release, spec);
        }
        for (const asset of placeholders) {
            const observed = await api("GET", `/releases/${release.id}`);
            await identity(observed, spec);
            requireState(observed.draft && !observed.immutable, "Cannot recover a published Mobile release");
            await guard();
            await api("DELETE", `/releases/assets/${asset.id}`);
        }
        for (const file of missing) {
            const observed = await api("GET", `/releases/${release.id}`);
            await identity(observed, spec);
            requireState(observed.draft && !observed.immutable, "Cannot upload to a published Mobile release");
            await guard();
            // No clobber or asset deletion: an uncertain upload is verified on retry.
            await api("POST", `/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`, file.data, true);
        }
        let verified = await inspect(spec);
        requireState(verified.release?.id === release.id && verified.missing.length === 0, "Mobile asset upload did not complete");
        if (verified.release.draft) {
            await guard();
            await api("PATCH", `/releases/${release.id}`, { draft: false, make_latest: "false" });
            verified = await inspect(spec);
        }
        requireState(verified.release?.id === release.id && verified.release.draft === false && !verified.missing.length, "Mobile release publication did not complete");
    }

    // Only this discovery index is mutable. Recheck the branch before every write.
    if (!await currentHead()) return { skipped: true };
    const channel = "mobile-nightly";
    let pointer = await findRelease(channel);
    if (!pointer) {
        await guard();
        pointer = await api("POST", "/releases", { tag_name: channel, target_commitish: sha, prerelease: true,
            name: "ProtonnCord Mobile nightly", draft: false, make_latest: "false",
            body: "Add this release download root as a Revenge plugin repository. Each index points to immutable, checksummed build assets." });
    }
    requireState(validId(pointer.id) && pointer.tag_name === channel && pointer.draft === false && pointer.prerelease === true
        && !pointer.immutable, "Mobile nightly pointer is not mutable");
    const index = files.find(file => file.name === "index.json");
    const existing = (await assets(pointer.id)).find(asset => asset.name === index.name);
    let matches = false;
    if (existing?.state === "uploaded" && existing.size === index.size && (existing.digest == null || existing.digest === index.digest))
        matches = digest(await readAsset(existing.id)) === index.digest;
    if (!matches) {
        if (existing) {
            await guard();
            await api("DELETE", `/releases/assets/${existing.id}`);
        }
        await guard();
        await api("POST", `/releases/${pointer.id}/assets?name=index.json`, index.data, true);
    }
    const before = await ref(channel);
    requireState(!before || (before.ref === `refs/tags/${channel}` && before.object?.type === "commit" && shaPattern.test(before.object.sha)), "Invalid mobile-nightly tag");
    if (before?.object.sha !== sha) {
        await guard();
        if (before) await api("PATCH", `/git/refs/tags/${channel}`, { sha, force: true });
        else await api("POST", "/git/refs", { ref: `refs/tags/${channel}`, sha });
    }
    const after = await ref(channel);
    requireState(after?.ref === `refs/tags/${channel}` && after.object?.type === "commit" && after.object.sha === sha, "Mobile nightly tag did not advance");
    const uploaded = (await assets(pointer.id)).find(asset => asset.name === index.name);
    requireState(uploaded, "Mobile nightly index is missing");
    await verifyFile(uploaded, index);
    return { tag };
}

async function main() {
    requireState(process.env.GITHUB_REPOSITORY === repository && process.env.PROTONN_CORD_BUILD_CHANNEL === "nightly", "Mobile publication requires the canonical nightly channel");
    const tag = process.argv[2];
    const match = /^mobile-build-([1-9][0-9]{0,18})-([1-9][0-9]{0,18})$/u.exec(tag ?? "");
    requireState(match && match[1] === process.env.GITHUB_RUN_ID && /^[1-9][0-9]{0,18}$/u.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
        && BigInt(match[2]) <= BigInt(process.env.GITHUB_RUN_ATTEMPT), "Mobile tag differs from retained job identity");
    const result = await publishMobile({
        api: createGithubApi(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
        readAsset: id => execFileSync("gh", ["api", "--hostname", "github.com", `repos/${repository}/releases/assets/${id}`, "-H", "Accept: application/octet-stream"],
            { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 + 1, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
        sha: process.env.GITHUB_SHA, tag, files: await readReleaseFiles(resolve("mobile/build/dist"))
    });
    console.log(result.skipped ? "A newer nightly commit exists; leaving its channel pointer intact." : `Verified Mobile publication ${result.tag}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    main().catch(error => { console.error(`Refusing Mobile publication: ${error.message}`); process.exitCode = 1; });
