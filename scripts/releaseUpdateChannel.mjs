import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "ProtonDev-sys/ProtonnCord";
const SHA = /^[a-f0-9]{40}$/u;
export const REQUIRED_ASSETS = [
    "desktop.asar", "equibop.asar", "patcher.js", "preload.js", "renderer.js", "renderer.css",
    "equibopMain.js", "equibopPreload.js", "equibopRenderer.js", "equibopRenderer.css",
    "browser.js", "browser.css", "ProtonnCord.user.js", "ProtonnCord.user.js.LEGAL.txt",
    "extension-chrome.zip", "extension-firefox.zip", "plugins.json", "equicordplugins.json",
    "vencordplugins.json", "devs.json",
];

function requireState(condition, message) {
    if (!condition) throw new Error(message);
}

function digest(data) {
    return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export async function readReleaseFiles(directory) {
    const names = (await readdir(directory)).sort();
    requireState(names.length > 0 && names.length < 100, "Invalid release asset count");
    const files = [];
    let total = 0;
    for (const name of names) {
        requireState(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) && !name.endsWith("."), "Unsafe asset name");
        const path = resolve(directory, name);
        const stat = await lstat(path);
        requireState(stat.isFile() && stat.size > 0 && stat.size <= 128 * 1024 * 1024, `Invalid asset ${name}`);
        total += stat.size;
        requireState(total <= 512 * 1024 * 1024, "Release assets exceed memory budget");
        const data = await readFile(path);
        requireState(data.length === stat.size, `Asset changed while reading ${name}`);
        files.push({ name, data, size: data.length, digest: digest(data) });
    }
    return files;
}

export function createGithubApi(token, fetcher = fetch, { timeoutMs = 60_000, budgetMs = 12 * 60_000 } = {}) {
    requireState(typeof token === "string" && token.length > 0, "Missing GITHUB_TOKEN");
    const deadline = Date.now() + budgetMs;
    return async (method, path, body, upload = false) => {
        requireState(Date.now() < deadline, "Release network budget exhausted");
        const url = `https://${upload ? "uploads" : "api"}.github.com/repos/${REPOSITORY}${path}`;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                requireState(Date.now() < deadline, "Release network budget exhausted");
                const signal = AbortSignal.timeout(Math.min(timeoutMs, Math.max(1, deadline - Date.now())));
                const timeout = new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("GitHub request timed out")), { once: true }));
                const response = await Promise.race([fetcher(url, {
                    method, redirect: "error", signal,
                    headers: {
                        Accept: "application/vnd.github+json",
                        Authorization: `Bearer ${token}`,
                        "User-Agent": "ProtonnCord-channel-release",
                        "X-GitHub-Api-Version": "2026-03-10",
                        ...(method === "GET" ? { "Cache-Control": "no-cache" } : {}),
                        ...(body === undefined ? {} : { "Content-Type": upload ? "application/octet-stream" : "application/json" }),
                    },
                    body: body === undefined ? undefined : upload ? body : JSON.stringify(body),
                }), timeout]);
                if (method === "GET" && response.status === 404) {
                    void response.body?.cancel().catch(() => undefined);
                    return null;
                }
                if (!response.ok) {
                    void response.body?.cancel().catch(() => undefined);
                    throw Object.assign(new Error(`GitHub ${method} ${path}: HTTP ${response.status}`), { status: response.status });
                }
                if (response.status === 204) return null;
                if (Number(response.headers.get("content-length") ?? 0) > 4 * 1024 * 1024) {
                    void response.body?.cancel().catch(() => undefined);
                    throw new Error("GitHub response too large");
                }
                let size = 0;
                const chunks = [];
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await Promise.race([reader.read(), timeout]);
                        if (done) break;
                        size += value.length;
                        requireState(size <= 4 * 1024 * 1024, "GitHub response too large");
                        chunks.push(value);
                    }
                } finally {
                    void reader.cancel().catch(() => undefined);
                    reader.releaseLock();
                }
                return JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (error) {
                if (method !== "GET" || attempt === 2 || (error.status && error.status < 500 && error.status !== 429)) throw error;
            }
        }
    };
}

export async function releaseUpdateChannel({ api, branch, sha, runId, files }) {
    requireState(["main", "nightly", "staging"].includes(branch) && SHA.test(sha) && /^\d+$/u.test(runId), "Invalid release identity");
    requireState(files.length > 0 && files.length < 100, "Invalid release asset count");
    const names = new Set(files.map(file => file.name));
    requireState(names.size === files.length && REQUIRED_ASSETS.every(name => names.has(name)), "Missing required release assets");
    for (const file of files)
        requireState(file.size > 0 && file.size === file.data.length && file.digest === digest(file.data), `Invalid local asset ${file.name}`);

    const channel = branch === "main" ? "latest" : branch;
    const stageTag = `protonn-channel-${branch}-${runId}-${sha}`;
    const title = `Protonn Cord ${branch} ${sha}`;
    const manifest = files.map(({ name, size, digest }) => ({ name, size, digest })).sort((left, right) => left.name.localeCompare(right.name));
    const getRelease = id => api("GET", `/releases/${id}`);
    const getRef = tag => api("GET", `/git/ref/tags/${tag}`);
    const getPublic = () => api("GET", `/releases/tags/${channel}`);
    const currentHead = async () => {
        const head = await api("GET", `/git/ref/heads/${branch}`);
        requireState(head?.ref === `refs/heads/${branch}` && head.object?.type === "commit" && SHA.test(head.object.sha), "Invalid branch head");
        return head.object.sha === sha;
    };
    const assets = async id => {
        const result = await api("GET", `/releases/${id}/assets?per_page=100`);
        requireState(Array.isArray(result) && result.length < 100, "Invalid or excessive release assets");
        requireState(new Set(result.map(asset => asset.name)).size === result.length, "Duplicate release assets");
        return result;
    };
    const matches = (asset, file) => asset.name === file.name && asset.size === file.size && asset.digest === file.digest && asset.state === "uploaded";
    const verifyAssets = async (id, tag, draft = false) => {
        const result = await assets(id);
        requireState(result.length === files.length && files.every(file => result.some(asset => matches(asset, file))), "Release asset verification failed");
        requireState(result.every(asset => {
            const url = new URL(asset.browser_download_url);
            const prefix = `/${REPOSITORY}/releases/download/`;
            const parts = url.pathname.slice(prefix.length).split("/");
            return url.origin === "https://github.com" && !url.username && !url.password && !url.search && !url.hash
                && url.pathname.startsWith(prefix) && parts.length === 2 && parts[1] === asset.name
                && (parts[0] === tag || (draft && /^untagged-[a-f0-9]{1,64}$/u.test(parts[0])));
        }), "Invalid asset download endpoint");
    };
    const reconcile = async (write, check) => {
        let failure;
        for (let attempt = 0; attempt < 3; attempt++) {
            try { await write(); } catch (error) { failure = error; }
            if (await check()) return;
            if (failure?.status && failure.status < 500 && failure.status !== 429 && failure.status !== 422) throw failure;
        }
        throw failure ?? new Error("GitHub mutation did not converge");
    };
    const edit = async (id, fields) => reconcile(
        () => api("PATCH", `/releases/${id}`, fields),
        async () => {
            const release = await getRelease(id);
            return release && Object.entries(fields).every(([key, value]) => key === "make_latest" || release[key] === value);
        },
    );
    const setRef = async (tag, value, allowed) => {
        const before = await getRef(tag);
        requireState(!before || (before.ref === `refs/tags/${tag}` && allowed.includes(before.object?.sha)), "Unexpected tag owner or SHA");
        if (before?.object.sha === value) return;
        await reconcile(
            () => before ? api("PATCH", `/git/refs/tags/${tag}`, { sha: value, force: true }) : api("POST", "/git/refs", { ref: `refs/tags/${tag}`, sha: value }),
            async () => (await getRef(tag))?.object?.sha === value,
        );
    };
    const findStage = async () => {
        for (let page = 1; page <= 10; page++) {
            const releases = await api("GET", `/releases?per_page=100&page=${page}`);
            requireState(Array.isArray(releases), "Invalid release listing");
            const found = releases.filter(release => {
                let journal;
                try { journal = JSON.parse(release.body); } catch { }
                return release.tag_name === stageTag || journal?.stageTag === stageTag;
            });
            requireState(found.length <= 1, "Ambiguous staging release");
            if (found.length) return found[0];
            if (releases.length < 100) return null;
        }
        throw new Error("Release discovery pagination budget exhausted");
    };

    let staged = await findStage();
    if (!staged && !await currentHead()) return { skipped: true };
    if (!staged) {
        requireState(!await getRef(stageTag), "Staging tag exists without a discoverable release; refusing duplicate creation");
        const previous = await getPublic();
        const previousRef = await getRef(channel);
        requireState(!previous || (!previous.draft && previous.tag_name === channel && !previous.immutable && previousRef), "Channel release cannot be safely replaced");
        requireState(!previousRef || (previousRef.ref === `refs/tags/${channel}` && SHA.test(previousRef.object?.sha)), "Invalid channel reference");
        const journal = {
            stageTag, branch, sha, runId, manifest,
            previous: previous ? { id: previous.id, name: previous.name, prerelease: previous.prerelease } : null,
            previousSha: previousRef?.object.sha ?? null,
        };
        const body = JSON.stringify(journal);
        await setRef(stageTag, sha, [sha]);
        let creationFailure;
        try {
            staged = await api("POST", "/releases", { tag_name: stageTag, target_commitish: sha, name: title, body, draft: true, prerelease: branch !== "main", make_latest: "false" });
        } catch (error) {
            creationFailure = error;
        }
        for (let attempt = 0; !staged && attempt < 3; attempt++) staged = await findStage();
        requireState(staged && Number.isSafeInteger(staged.id) && staged.body === body, creationFailure?.message ?? "Release creation outcome is uncertain");
    }
    const journal = JSON.parse(staged.body);
    requireState(journal.stageTag === stageTag && journal.branch === branch && journal.sha === sha && journal.runId === runId && JSON.stringify(journal.manifest) === JSON.stringify(manifest), "Staging release identity mismatch");
    requireState(staged.name === title && staged.target_commitish === sha && staged.prerelease === (branch !== "main"), "Staging release SHA or semantics mismatch");
    requireState((await getRef(stageTag))?.object?.sha === sha, "Staging tag SHA mismatch");
    requireState(journal.previousSha === null || SHA.test(journal.previousSha), "Invalid recovery SHA");
    requireState(journal.previous === null || (Number.isSafeInteger(journal.previous.id) && typeof journal.previous.name === "string" && typeof journal.previous.prerelease === "boolean"), "Invalid recovery release");
    const backupTag = `${stageTag}-previous`;
    const verifyPublished = async () => {
        const published = await getPublic();
        requireState(published?.id === staged.id && published.name === title && !published.draft && published.prerelease === (branch !== "main"), "Published channel identity mismatch");
        requireState((await getRef(channel))?.object?.sha === sha, "Published channel SHA mismatch");
        await verifyAssets(staged.id, channel);
        if (branch === "main") requireState((await api("GET", "/releases/latest"))?.id === staged.id, "Stable release is not latest");
    };
    if (!staged.draft) {
        await verifyPublished();
        return { releaseId: staged.id };
    }
    requireState(staged.tag_name === stageTag || staged.tag_name === channel, "Unexpected staging tag");
    const existing = await assets(staged.id);
    requireState(existing.every(asset => names.has(asset.name)), "Unexpected staging assets");
    for (const file of files) {
        const found = existing.find(asset => asset.name === file.name);
        if (found) {
            if (matches(found, file)) continue;
            requireState(found.state === "starter" && found.size === 0 && Number.isSafeInteger(found.id), `Conflicting staging asset ${file.name}`);
            requireState((await getRelease(staged.id))?.draft === true, "Cannot modify published assets");
            await reconcile(
                () => api("DELETE", `/releases/assets/${found.id}`),
                async () => !(await assets(staged.id)).some(asset => asset.id === found.id),
            );
        }
        await reconcile(
            () => api("POST", `/releases/${staged.id}/assets?name=${encodeURIComponent(file.name)}`, file.data, true),
            async () => (await assets(staged.id)).some(asset => matches(asset, file)),
        );
    }
    await verifyAssets(staged.id, staged.tag_name, true);
    const old = journal.previous ? await getRelease(journal.previous.id) : null;
    requireState(!journal.previous || (old && old.name === journal.previous.name && old.prerelease === journal.previous.prerelease && !old.immutable && ((old.tag_name === channel && !old.draft) || (old.tag_name === backupTag && old.draft))), "Recovery release changed");
    if (old) requireState((await assets(old.id)).every(asset => names.has(asset.name)), "Would drop an existing client asset");
    const publicRelease = await getPublic();
    requireState(!publicRelease || publicRelease.id === old?.id, "Channel changed since staging");
    if (!await currentHead() && (!old || !old.draft)) return { skipped: true };

    try {
        if (old) {
            await setRef(backupTag, journal.previousSha, [journal.previousSha]);
            await edit(old.id, { tag_name: backupTag, draft: true });
        }
        requireState(await currentHead(), "Branch advanced before promotion");
        requireState(!await getPublic(), "Channel occupied before promotion");
        await setRef(channel, sha, [journal.previousSha, sha]);
        requireState(await currentHead(), "Branch advanced before publication");
        await edit(staged.id, { tag_name: channel, target_commitish: sha, draft: false, make_latest: branch === "main" ? "true" : "false" });
        await verifyPublished();
        return { releaseId: staged.id };
    } catch (error) {
        const observed = await getRelease(staged.id);
        if (!observed || !observed.draft) throw error;
        requireState(observed.name === title && observed.target_commitish === sha && [stageTag, channel].includes(observed.tag_name), "Recovery staging release changed");
        const remaining = await getPublic();
        requireState(!remaining || remaining.id === old?.id, "Cannot roll back a changed public channel");
        await edit(staged.id, { tag_name: stageTag });
        if (journal.previousSha) await setRef(channel, journal.previousSha, [sha, journal.previousSha]);
        if (old) await edit(old.id, { tag_name: channel, draft: false, make_latest: branch === "main" ? "true" : "false" });
        throw error;
    }
}

async function main() {
    try {
        requireState(process.env.GITHUB_REPOSITORY === REPOSITORY, "Unexpected release repository");
        const result = await releaseUpdateChannel({
            api: createGithubApi(process.env.GITHUB_TOKEN), branch: process.env.GITHUB_REF_NAME,
            sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
            files: await readReleaseFiles(resolve("dist/release")),
        });
        console.log(result.skipped ? "Skipping stale channel build." : `Verified channel release ${result.releaseId}.`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
