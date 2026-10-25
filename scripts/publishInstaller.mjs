// SPDX-License-Identifier: GPL-3.0-or-later
// Stage one tested installer; never replace an existing asset or update-channel tag.
import { createHash } from "node:crypto";

export async function publishInstaller({ api, readAsset, repository, sha, tag, name, data, checksum, title, body, platform }) {
    const requireState = (condition, message) => { if (!condition) throw new Error(message); };
    const digest = bytes => createHash("sha256").update(bytes).digest("hex");
    const validId = id => Number.isSafeInteger(id) && id > 0;
    requireState(/^[a-f0-9]{40}$/u.test(sha) && /^(?:android|windows)-[1-9][0-9]{0,18}-[1-9][0-9]{0,18}$/u.test(tag)
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) && data.length > 0 && checksum === digest(data), "Invalid tested installer identity.");
    const identity = { tag_name: tag, target_commitish: sha, name: title, body, prerelease: true };
    const current = async () => {
        const ref = await api("GET", "/git/ref/heads/nightly");
        requireState(ref?.ref === "refs/heads/nightly" && ref.object?.type === "commit", "Invalid nightly branch response.");
        return ref.object.sha === sha;
    };
    const getRelease = () => api("GET", `/releases/tags/${tag}`);
    const verifyIdentity = release => requireState(validId(release?.id) && typeof release.draft === "boolean"
        && Object.entries(identity).every(([key, value]) => release[key] === value), `Unexpected ${platform} release identity.`);
    const findRelease = async () => {
        let found = await getRelease();
        if (found) verifyIdentity(found);
        // The tag endpoint does not expose retained drafts. Exhaust the bounded
        // listing so an ambiguous tag can never cause another release creation.
        const seen = new Set();
        for (let page = 1; page <= 10; page++) {
            const releases = await api("GET", `/releases?per_page=100&page=${page}`);
            requireState(Array.isArray(releases) && releases.length <= 100
                && releases.every(release => validId(release?.id) && typeof release.tag_name === "string"), "Invalid installer release listing.");
            for (const release of releases.filter(release => release.tag_name === tag)) {
                verifyIdentity(release);
                requireState(!seen.has(release.id) && (!found || (found.id === release.id && found.draft === release.draft)), "Ambiguous installer release.");
                seen.add(release.id);
                found = release;
            }
            if (releases.length < 100) return found;
        }
        throw new Error("Installer release discovery pagination budget exhausted.");
    };
    const verifyTag = async () => {
        const ref = await api("GET", `/git/ref/tags/${tag}`);
        requireState(!ref || (ref.ref === `refs/tags/${tag}` && ref.object?.type === "commit" && ref.object.sha === sha), `Unexpected ${platform} tag target.`);
        return ref;
    };
    const getAssets = async id => {
        const assets = await api("GET", `/releases/${id}/assets?per_page=100`);
        requireState(Array.isArray(assets) && assets.length <= 1 && assets.every(asset => validId(asset?.id) && asset.name === name), `Unexpected ${platform} release assets.`);
        return assets;
    };
    const verifyAsset = async assets => {
        requireState(assets.length === 1 && assets[0].size === data.length
            && assets[0].digest === `sha256:${checksum}` && assets[0].state === "uploaded", `The staged ${platform} installer does not match the tested artifact.`);
        if (readAsset) {
            const bytes = await readAsset(assets[0].id);
            requireState(bytes.length === data.length && digest(bytes) === checksum, `The remote ${platform} installer bytes differ.`);
        }
    };
    const mutate = async (method, path, body, upload = false) => {
        await verifyTag();
        requireState(await current(), `Nightly advanced; the ${platform} installer remains staged.`);
        return api(method, path, body, upload);
    };

    if (!await current()) {
        console.log(`Skipping stale ${platform} installer for ${sha}.`);
        return;
    }
    let release = await findRelease();
    await verifyTag();
    if (!release) {
        try { release = await mutate("POST", "/releases", { ...identity, draft: true, make_latest: "false" }); }
        catch (error) { release = await findRelease(); if (!release) throw error; }
    }
    verifyIdentity(release);
    const mutable = async () => {
        const observed = await api("GET", `/releases/${release.id}`);
        verifyIdentity(observed);
        requireState(observed.id === release.id && observed.draft && !observed.immutable, `Cannot modify a published or immutable ${platform} release.`);
    };
    let assets = await getAssets(release.id);
    const placeholder = asset => asset?.state === "starter" && asset.size === 0 && asset.digest == null;
    if (release.draft && placeholder(assets[0])) {
        await mutable();
        const id = assets[0].id;
        assets = await getAssets(release.id);
        requireState(assets[0]?.id === id && placeholder(assets[0]), "Installer placeholder changed before recovery.");
        // Only an empty failed-upload starter on this exact mutable draft is removable.
        try { await mutate("DELETE", `/releases/assets/${id}`); }
        catch (error) { if ((await getAssets(release.id)).some(asset => asset.id === id)) throw error; }
        assets = await getAssets(release.id);
    }
    if (release.draft && assets.length === 0) {
        await mutable();
        requireState((await getAssets(release.id)).length === 0, "Installer assets changed before upload.");
        try { await mutate("POST", `/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, data, true); }
        catch (error) {
            assets = await getAssets(release.id);
            if (assets.length === 0) throw error;
        }
        assets = await getAssets(release.id);
    }
    await verifyAsset(assets);
    if (release.draft) {
        await mutable();
        await verifyAsset(await getAssets(release.id));
        try { await mutate("PATCH", `/releases/${release.id}`, { draft: false, make_latest: "false" }); }
        catch (error) {
            const observed = await findRelease();
            if (observed?.id !== release.id || observed.draft !== false) throw error;
        }
    }
    const published = await findRelease();
    verifyIdentity(published);
    requireState(published.id === release.id && published.draft === false, `${platform} release did not publish.`);
    requireState(await verifyTag(), `Published ${platform} tag mismatch.`);
    const publishedAssets = await getAssets(release.id);
    await verifyAsset(publishedAssets);
    const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    requireState(publishedAssets[0].browser_download_url === url, `Unexpected ${platform} download endpoint.`);
    console.log(`Published ${url} (${checksum}).`);
}
