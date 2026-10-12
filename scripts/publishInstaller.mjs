// SPDX-License-Identifier: GPL-3.0-or-later
// Stage one tested installer; never replace an existing asset or update-channel tag.
export async function publishInstaller({ api, repository, sha, tag, name, data, checksum, title, body, platform }) {
    const requireState = (condition, message) => { if (!condition) throw new Error(message); };
    const identity = { tag_name: tag, target_commitish: sha, name: title, body, prerelease: true };
    const current = async () => {
        const ref = await api("GET", "/git/ref/heads/nightly");
        requireState(ref?.ref === "refs/heads/nightly" && ref.object?.type === "commit", "Invalid nightly branch response.");
        return ref.object.sha === sha;
    };
    const getRelease = () => api("GET", `/releases/tags/${tag}`);
    const verifyIdentity = release => requireState(release && Number.isSafeInteger(release.id)
        && Object.entries(identity).every(([key, value]) => release[key] === value), `Unexpected ${platform} release identity.`);
    const getAssets = id => api("GET", `/releases/${id}/assets?per_page=100`);
    const verifyAsset = assets => requireState(Array.isArray(assets) && assets.length === 1 && assets[0].name === name
        && assets[0].size === data.length && assets[0].digest === `sha256:${checksum}` && assets[0].state === "uploaded",
    `The staged ${platform} installer does not match the tested artifact.`);

    if (!await current()) {
        console.log(`Skipping stale ${platform} installer for ${sha}.`);
        return;
    }
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
    requireState(await current(), `Nightly advanced; the ${platform} installer remains staged.`);
    const existingTag = await api("GET", `/git/ref/tags/${tag}`);
    requireState(!existingTag || (existingTag.ref === `refs/tags/${tag}`
        && existingTag.object?.type === "commit" && existingTag.object.sha === sha), `Unexpected ${platform} tag target.`);
    if (release.draft) {
        try { await api("PATCH", `/releases/${release.id}`, { draft: false, make_latest: "false" }); }
        catch (error) { if ((await getRelease())?.draft !== false) throw error; }
    }
    const published = await getRelease();
    verifyIdentity(published);
    requireState(published.id === release.id && published.draft === false, `${platform} release did not publish.`);
    const publishedTag = await api("GET", `/git/ref/tags/${tag}`);
    requireState(publishedTag?.object?.type === "commit" && publishedTag.object.sha === sha, `Published ${platform} tag mismatch.`);
    const publishedAssets = await getAssets(release.id);
    verifyAsset(publishedAssets);
    const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    requireState(publishedAssets[0].browser_download_url === url, `Unexpected ${platform} download endpoint.`);
    console.log(`Published ${url} (${checksum}).`);
}
