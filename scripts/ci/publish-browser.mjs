// SPDX-License-Identifier: GPL-3.0-or-later
// Publication only: the controller supplies the exact-SHA full-test gate and lock.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repository = "ProtonDev-sys/ProtonnCord";
const archiveNames = ["extension-chrome.zip", "extension-firefox.zip", "extension-sources.zip"];
const files = [...archiveNames, "archives.sha256", "release-sha.txt"];
const stores = {
    chrome: ["CHROME_EXTENSION_ID", "CHROME_PUBLISHER_ID", "CHROME_CLIENT_ID", "CHROME_CLIENT_SECRET", "CHROME_REFRESH_TOKEN"],
    firefox: ["FIREFOX_EXTENSION_ID", "FIREFOX_JWT_ISSUER", "FIREFOX_JWT_SECRET"],
    edge: ["EDGE_PRODUCT_ID", "EDGE_CLIENT_ID", "EDGE_API_KEY"]
};
const numericVersion = /^v?[0-9]+(?:\.[0-9]+){2,3}$/u;
const requireState = (condition, message) => { if (!condition) throw new Error(message); };

async function checkedHash(path) {
    const stat = await lstat(path);
    requireState(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512 * 1024 * 1024, "Invalid release asset file.");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}

export function planDraftResume(assets) {
    const uploaded = [];
    const placeholders = [];
    const seen = new Set();
    for (const asset of assets) {
        requireState(files.includes(asset.name) && !seen.has(asset.name), "Unexpected or duplicate durable release asset.");
        seen.add(asset.name);
        if (asset.state === "uploaded" && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 512 * 1024 * 1024) uploaded.push(asset.name);
        else {
            requireState(asset.state === "starter" && asset.size === 0 && Number.isSafeInteger(asset.id) && asset.id > 0, "Invalid incomplete release asset; existing uploaded assets cannot be replaced.");
            placeholders.push(asset.id);
        }
    }
    return { uploaded, placeholders, missing: files.filter(name => !uploaded.includes(name)) };
}

export function compareVersions(left, right) {
    requireState(numericVersion.test(left) && numericVersion.test(right), "Invalid numeric version.");
    const a = left.replace(/^v/u, "").split(".").map(BigInt);
    const b = right.replace(/^v/u, "").split(".").map(BigInt);
    for (let i = 0; i < 4; i++) {
        if ((a[i] ?? 0n) !== (b[i] ?? 0n)) return (a[i] ?? 0n) > (b[i] ?? 0n) ? 1 : -1;
    }
    return 0;
}

export function planVersion(tags, version, sha, retry) {
    tags = tags.filter(tag => /^v[0-9]+(?:\.[0-9]+){2,3}$/u.test(tag.name));
    const existingTag = tags.find(tag => tag.name === version);
    if (retry) requireState(!existingTag || existingTag.commit?.sha === sha, "Existing version tag belongs to a different commit.");
    const latest = tags.reduce((best, tag) => compareVersions(tag.name, best) > 0 ? tag.name : best, "v0.0.0");
    return { existingTag, latest, skip: compareVersions(latest, version) > 0
        || Boolean(existingTag && !retry) || (!existingTag && compareVersions(latest, version) === 0) };
}

export async function verifyArchives(directory, sha) {
    requireState(/^[a-f0-9]{40}$/u.test(sha), "Invalid archive source SHA.");
    for (const name of files) {
        const stat = await lstat(join(directory, name));
        requireState(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512 * 1024 * 1024, `Invalid archive file: ${name}`);
    }
    requireState(await readFile(join(directory, "release-sha.txt"), "utf8") === `${sha}\n`, "Archive source SHA mismatch.");
    const lines = (await readFile(join(directory, "archives.sha256"), "utf8")).split("\n");
    requireState(lines.length === 4 && lines[3] === "", "Invalid archive checksum manifest.");
    for (const [i, name] of archiveNames.entries()) {
        requireState(new RegExp(`^[a-f0-9]{64}  ${name.replaceAll(".", "\\.")}$`, "u").test(lines[i]), `Invalid checksum entry: ${name}`);
        requireState(lines[i] === `${await checkedHash(join(directory, name))}  ${name}`, `Archive checksum mismatch: ${name}`);
    }
}

// In particular, do not pass another store's secrets or GitHub tokens to a publisher.
export function processEnvironment(source = process.env) {
    const environment = {};
    for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME"])
        if (source[key]) environment[key] = source[key];
    environment.CI = "true";
    return environment;
}

async function main() {
    const { values } = parseArgs({ options: {
        sha: { type: "string", default: process.env.GITHUB_SHA },
        archives: { type: "string", default: "dist" },
        store: { type: "string", default: "all" },
        retry: { type: "boolean", default: false },
        "recover-if-matching": { type: "boolean", default: false },
        help: { type: "boolean", default: false }
    } });
    if (values.help) {
        console.log("Usage: node scripts/ci/publish-browser.mjs --sha <40hex> [--archives dist] [--store all|none|chrome|firefox|edge] [--retry]\nRun on main only after exact-SHA validation. Retries restore immutable GitHub archives; no builds or dependency installs run here.");
        return;
    }
    const sha = values.sha;
    requireState(/^[a-f0-9]{40}$/u.test(sha ?? ""), "Set --sha to the validated full commit SHA.");
    requireState(!process.env.GITHUB_SHA || process.env.GITHUB_SHA === sha, "GITHUB_SHA differs from --sha.");
    requireState(process.versions.node.split(".")[0] === "24", "Node 24 is required.");
    requireState((process.env.PROTONN_CORD_BUILD_CHANNEL ?? process.env.GITHUB_REF_NAME) === "main", "Only main publishes browser extensions.");
    requireState(!process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY === repository, "Unexpected release repository.");
    requireState(["all", "none", ...Object.keys(stores)].includes(values.store), "Invalid --store selection.");
    const checkout = await realpath(process.cwd());
    const baseline = processEnvironment();
    const github = { ...baseline, GH_PROMPT_DISABLED: "1" };
    if (process.env.GH_CONFIG_DIR) github.GH_CONFIG_DIR = process.env.GH_CONFIG_DIR;
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) github.GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    function run(command, args, environment = baseline, cwd = checkout) {
        const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        requireState(!result.error && result.status === 0, `${command} ${args[0]} failed (${result.error?.code ?? result.status}).`);
        return result.stdout.trim();
    }
    const git = (...args) => run("git", args);
    const gh = (...args) => run("gh", args, github);
    const api = (...args) => JSON.parse(gh("api", "--hostname", "github.com", ...args));
    const pages = endpoint => api("--paginate", "--slurp", endpoint).flat();
    function assertCheckout() {
        requireState(git("rev-parse", "HEAD") === sha, "Checkout HEAD differs from the validated SHA.");
        requireState(git("status", "--porcelain", "--untracked-files=no") === "", "Publication requires clean tracked source.");
    }
    assertCheckout();
    requireState(await realpath(git("rev-parse", "--show-toplevel")) === checkout, "Run from the repository root.");
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    requireState(numericVersion.test(pkg.version ?? "") && !pkg.version.startsWith("v"), "Invalid package version.");
    const version = `v${pkg.version}`;
    const artifactTag = `browser-extension-${version}`;
    function assertCurrentHead() {
        assertCheckout();
        const ref = api(`repos/${repository}/git/ref/heads/main`);
        requireState(ref.object?.type === "commit" && ref.object.sha === sha, "Superseded browser release: main has moved. No further publication is allowed.");
    }
    assertCurrentHead();
    const retained = values["recover-if-matching"] ? pages(`repos/${repository}/releases?per_page=100`).filter(release => release.tag_name === artifactTag) : null;
    const retry = values.retry || Boolean(retained?.length === 1 && retained[0].target_commitish === sha);
    const { existingTag, latest, skip } = planVersion(pages(`repos/${repository}/tags?per_page=100`), version, sha, retry);
    if (skip) {
        console.log(`No new browser version to publish (${version}; latest ${latest}). Use --retry only for this exact version's failed store.`);
        return;
    }
    const releases = retained ?? pages(`repos/${repository}/releases?per_page=100`).filter(release => release.tag_name === artifactTag);
    requireState(releases.length <= 1, "Duplicate durable browser releases.");
    const durable = releases[0];
    requireState(!durable || durable.target_commitish === sha, "Durable archives belong to a different commit.");
    requireState(durable || (!existingTag && !retry), "An existing version or retry requires durable archives; rebuilding is prohibited.");
    const scratch = await mkdtemp(join(tmpdir(), "protonn-browser-release-"));
    try {
        const archives = join(scratch, "archives");
        await mkdir(archives);
        const download = (directory, names) => {
            if (names.length) gh("release", "download", artifactTag, "--repo", `github.com/${repository}`, "--dir", directory,
                ...names.flatMap(name => ["--pattern", name]));
        };
        async function copyInput(directory) {
            const input = resolve(values.archives);
            await verifyArchives(input, sha);
            for (const name of files) await copyFile(join(input, name), join(directory, name));
            await verifyArchives(directory, sha);
        }
        if (durable) {
            requireState(Number.isSafeInteger(durable.id) && durable.id > 0, "Invalid durable release identity.");
            const { uploaded, placeholders, missing } = planDraftResume(pages(`repos/${repository}/releases/${durable.id}/assets?per_page=100`));
            if (missing.length) {
                requireState(durable.draft === true && !existingTag, "A tagged or published release must have complete durable archives; replacing assets is prohibited.");
                const snapshot = join(scratch, "retained");
                await mkdir(snapshot);
                await copyInput(snapshot);
                // Validate all existing bytes before making any recovery writes.
                await download(archives, uploaded);
                for (const name of uploaded)
                    requireState(await checkedHash(join(archives, name)) === await checkedHash(join(snapshot, name)), `Retained archives differ from existing asset: ${name}`);
                for (const id of placeholders) {
                    // GitHub leaves zero-byte "starter" placeholders after some
                    // interrupted uploads. They contain no durable archive bytes.
                    const placeholder = api(`repos/${repository}/releases/assets/${id}`);
                    requireState(placeholder.id === id && placeholder.state === "starter" && placeholder.size === 0 && files.includes(placeholder.name), "Failed-upload placeholder changed; retry after the upload settles.");
                    assertCurrentHead();
                    gh("api", "--hostname", "github.com", "--method", "DELETE", `repos/${repository}/releases/assets/${id}`);
                }
                assertCurrentHead();
                gh("release", "upload", artifactTag, "--repo", `github.com/${repository}`, ...missing.map(name => join(snapshot, name)));
                // Download again to prove completeness, including resumed assets.
                const restored = join(scratch, "restored");
                await mkdir(restored);
                download(restored, files);
                await verifyArchives(restored, sha);
                for (const name of files) {
                    requireState(await checkedHash(join(restored, name)) === await checkedHash(join(snapshot, name)), `Recovered asset differs from retained archive: ${name}`);
                    await copyFile(join(restored, name), join(archives, name));
                }
                console.log(`Resumed incomplete draft ${artifactTag} without replacing uploaded assets.`);
            } else download(archives, files);
        } else {
            await copyInput(archives);
            assertCurrentHead();
            gh("release", "create", artifactTag, "--repo", `github.com/${repository}`, "--draft", "--target", sha,
                "--title", artifactTag, "--notes", "Exact browser extension archives; do not replace assets.", ...files.map(name => join(archives, name)));
            const restored = join(scratch, "restored");
            await mkdir(restored);
            download(restored, files);
            await verifyArchives(restored, sha);
            for (const name of files)
                requireState(await checkedHash(join(restored, name)) === await checkedHash(join(archives, name)), `Uploaded asset differs from validated archive: ${name}`);
        }
        await verifyArchives(archives, sha);
        console.log(`Verified durable archives in ${artifactTag}.`);
        if (!existingTag) {
            assertCurrentHead();
            const tag = api("--method", "POST", `repos/${repository}/git/tags`, "-f", `tag=${version}`, "-f", `message=Version ${version}`, "-f", `object=${sha}`, "-f", "type=commit");
            requireState(/^[a-f0-9]{40}$/u.test(tag.sha ?? ""), "Invalid annotated tag identity.");
            assertCurrentHead();
            api("--method", "POST", `repos/${repository}/git/refs`, "-f", `ref=refs/tags/${version}`, "-f", `sha=${tag.sha}`);
        }
        const failures = [];
        for (const [store, names] of Object.entries(stores)) {
            if (values.store !== "all" && values.store !== store) continue;
            const present = names.filter(name => process.env[name]?.trim());
            if (!present.length && values.store === "all") {
                console.log(`Skipping ${store}: credentials are not configured.`);
                continue;
            }
            if (present.length !== names.length) {
                failures.push(`${store}: missing ${names.filter(name => !present.includes(name)).join(", ")}`);
                continue;
            }
            // Resolve only the reviewed installed dependency. Never invoke npm, npx,
            // pnpm install or a PATH publisher while store credentials are available.
            const publisher = join(checkout, "node_modules/@equicord/publish-browser-extension");
            const installed = JSON.parse(await readFile(join(publisher, "package.json"), "utf8"));
            const pin = pkg.devDependencies?.["@equicord/publish-browser-extension"];
            requireState(pin === "4.0.8" && installed.version === pin && installed.name === "@equicord/publish-browser-extension", "Install the reviewed publisher from the frozen lockfile before loading store credentials.");
            const cli = await realpath(join(publisher, "dist/cli.mjs"));
            const root = await realpath(publisher);
            requireState(!relative(root, cli).startsWith("..") && !isAbsolute(relative(root, cli)), "Publisher CLI escapes its package.");
            const storeDirectory = join(scratch, store);
            await mkdir(storeDirectory);
            const environment = { ...baseline, HOME: storeDirectory, USERPROFILE: storeDirectory, XDG_CONFIG_HOME: storeDirectory };
            for (const name of names) environment[name] = process.env[name];
            const args = store === "firefox"
                ? ["--firefox-zip", join(archives, archiveNames[1]), "--firefox-sources-zip", join(archives, archiveNames[2])]
                : [`--${store}-zip`, join(archives, archiveNames[0])];
            await verifyArchives(archives, sha);
            assertCurrentHead();
            // A fresh working directory prevents the CLI's .env.submit loader from
            // importing credentials belonging to other stores from the checkout.
            const result = spawnSync(process.execPath, [cli, ...args], { cwd: storeDirectory, env: environment, timeout: 15 * 60_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true });
            if (result.error || result.status !== 0) failures.push(`${store}: publisher failed (${result.error?.code ?? result.status}); retry --retry --store ${store}`);
            else console.log(`Published ${store} ${version}.`);
            // Provider responses can contain request headers. Do not print them.
        }
        requireState(!failures.length, `Browser publication incomplete; durable archives are retained. ${failures.join("; ")}`);
        console.log(`Browser release ${version} (${sha}) completed; durable archives: ${artifactTag}.`);
    } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        // Do not serialize child-process errors, their environments or API replies.
        console.error(`Browser publication: ${error.message}`);
        process.exitCode = 1;
    });
}
