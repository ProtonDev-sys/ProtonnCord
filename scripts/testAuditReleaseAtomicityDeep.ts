import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGithubApi, readReleaseFiles, releaseUpdateChannel, REQUIRED_ASSETS } from "./releaseUpdateChannel.mjs";

const oldSha = "a".repeat(40);
const newSha = "b".repeat(40);
const advancedSha = "c".repeat(40);
const repository = "ProtonDev-sys/ProtonnCord";
const hash = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const files = REQUIRED_ASSETS.map(name => {
    const data = Buffer.from(`${name}:${newSha}`);
    return { name, data, size: data.length, digest: hash(data) };
});
type Asset = { id: number; name: string; size: number; digest: string; state: string; browser_download_url: string; };
type Release = { id: number; tag_name: string; target_commitish: string; name: string; body: string; draft: boolean; prerelease: boolean; immutable: boolean; assets: Asset[]; };
type Call = { method: string; path: string; body?: Record<string, unknown> | Buffer; upload?: boolean; };

class GithubFixture {
    branch: string;
    channel: string;
    refs = new Map<string, string>();
    releases = new Map<number, Release>();
    calls: Call[] = [];
    before: (call: Call) => void = () => {};
    after: (call: Call) => void = () => {};
    nextId = 10;
    latest = 1;
    releaseList: (() => Release[]) | undefined;

    constructor(branch = "nightly", previous = true) {
        this.branch = branch;
        this.channel = branch === "main" ? "latest" : branch;
        this.refs.set(`heads/${branch}`, newSha);
        if (previous) {
            this.refs.set(`tags/${this.channel}`, oldSha);
            this.releases.set(1, {
                id: 1, tag_name: this.channel, target_commitish: oldSha,
                name: `Protonn Cord ${branch} ${oldSha}`, body: "previous release notes", draft: false,
                prerelease: branch !== "main", immutable: false,
                assets: files.map((file, index) => {
                    const data = Buffer.from(`${file.name}:${oldSha}`);
                    return { id: 1000 + index, name: file.name, size: data.length, digest: hash(data), state: "uploaded", browser_download_url: this.download(this.channel, file.name) };
                }),
            });
        }
        this.releases.set(2, {
            id: 2, tag_name: "unrelated", target_commitish: advancedSha, name: "Unrelated prerelease",
            body: "unrelated", draft: false, prerelease: true, immutable: false, assets: [],
        });
        this.refs.set("tags/unrelated", advancedSha);
    }

    download(tag: string, name: string) {
        return `https://github.com/${repository}/releases/download/${tag}/${name}`;
    }

    assetDownload(release: Release, name: string) {
        return this.download(release.draft ? `untagged-${release.id.toString(16).padStart(20, "0")}` : release.tag_name, name);
    }

    publicRelease() {
        return [...this.releases.values()].find(release => release.tag_name === this.channel && !release.draft);
    }

    assertAtomic() {
        for (const release of this.releases.values()) {
            if (release.draft || release.id === 2) continue;
            const sha = release.name.split(" ").at(-1);
            assert.equal(this.refs.get(`tags/${release.tag_name}`), sha, "public tag and release title cannot disagree");
            assert.equal(release.assets.length, files.length, "public asset set must always be complete");
            for (const asset of release.assets) {
                assert.equal(asset.digest, hash(Buffer.from(`${asset.name}:${sha}`)), "public artifacts must agree with the declared SHA");
                assert.equal(asset.browser_download_url, this.download(release.tag_name, asset.name));
            }
        }
        assert.equal(this.refs.get("tags/unrelated"), advancedSha);
        assert.equal(this.releases.get(2)?.body, "unrelated");
    }

    api = async (method: string, path: string, body?: Record<string, unknown> | Buffer, upload = false): Promise<unknown> => {
        const call = { method, path, body, upload };
        this.calls.push(call);
        this.before(call);
        const result = this.dispatch(call);
        this.assertAtomic();
        this.after(call);
        return structuredClone(result);
    };

    dispatch({ method, path, body, upload }: Call): unknown {
        if (method === "GET" && path.startsWith("/git/ref/")) {
            const ref = path.slice("/git/ref/".length);
            const sha = this.refs.get(ref);
            return sha ? { ref: `refs/${ref}`, object: { type: "commit", sha } } : null;
        }
        if (method === "POST" && path === "/git/refs") {
            const fields = body as { ref: string; sha: string; };
            assert.equal(this.refs.has(fields.ref.slice(5)), false);
            this.refs.set(fields.ref.slice(5), fields.sha);
            return {};
        }
        if (method === "PATCH" && path.startsWith("/git/refs/tags/")) {
            const fields = body as { sha: string; force: boolean; };
            assert.equal(fields.force, true);
            this.refs.set(path.slice("/git/refs/".length), fields.sha);
            return {};
        }
        if (method === "GET" && path.startsWith("/releases?")) return this.releaseList ? this.releaseList() : [...this.releases.values()];
        if (method === "GET" && path === "/releases/latest") return [...this.releases.values()].find(release => release.id === this.latest && !release.draft && !release.prerelease) ?? null;
        if (method === "GET" && path.startsWith("/releases/tags/")) return [...this.releases.values()].find(release => release.tag_name === path.slice("/releases/tags/".length) && !release.draft) ?? null;
        if (method === "POST" && path === "/releases") {
            const release = { ...(body as Record<string, unknown>), id: this.nextId++, immutable: false, assets: [] } as unknown as Release;
            assert.equal(release.draft, true, "new releases must always start private");
            this.releases.set(release.id, release);
            return release;
        }
        const match = /^\/releases\/(\d+)(\/assets.*)?$/u.exec(path);
        if (match) {
            const release = this.releases.get(Number(match[1]));
            assert.ok(release);
            if (method === "GET") return match[2] ? release.assets : release;
            if (method === "POST") {
                assert.equal(upload, true);
                assert.equal(release.draft, true, "only drafts may receive asset writes");
                const name = new URL(`https://fixture${path}`).searchParams.get("name")!;
                assert.equal(release.assets.some(asset => asset.name === name), false, "no clobber uploads");
                const data = body as Buffer;
                const asset = { id: this.nextId++, name, size: data.length, digest: hash(data), state: "uploaded", browser_download_url: this.assetDownload(release, name) };
                release.assets.push(asset);
                return asset;
            }
            if (method === "PATCH") {
                const { make_latest, ...fields } = body as Record<string, unknown>;
                Object.assign(release, fields);
                for (const asset of release.assets) asset.browser_download_url = this.assetDownload(release, asset.name);
                if (make_latest === "true") this.latest = release.id;
                return release;
            }
        }
        if (method === "DELETE" && path.startsWith("/releases/assets/")) {
            const id = Number(path.split("/").at(-1));
            const release = [...this.releases.values()].find(candidate => candidate.assets.some(asset => asset.id === id));
            assert.ok(release?.draft, "deletes are restricted to own draft starter assets");
            release.assets = release.assets.filter(asset => asset.id !== id);
            return null;
        }
        throw new Error(`Unexpected API operation ${method} ${path}`);
    }

    run() {
        return releaseUpdateChannel({ api: this.api, branch: this.branch, sha: newSha, runId: "1234", files });
    }
}

const unavailable = () => Object.assign(new Error("fixture unavailable"), { status: 503 });
const isPromotion = (call: Call) => call.method === "PATCH" && call.path.startsWith("/releases/") && (call.body as Record<string, unknown>)?.draft === false && call.path !== "/releases/1";

for (const branch of ["main", "nightly", "staging"]) {
    test(`${branch}: promote complete draft with matching SHA, preserve endpoints and retry idempotently`, async () => {
        const fixture = new GithubFixture(branch);
        const result = await fixture.run();
        assert.equal(fixture.publicRelease()?.id, result.releaseId);
        assert.equal(fixture.publicRelease()?.prerelease, branch !== "main");
        assert.equal(fixture.releases.get(1)?.draft, true, "old assets remain available for recovery");
        assert.equal(fixture.releases.get(1)?.assets.length, files.length);
        const uploads = fixture.calls.filter(call => call.upload).length;
        assert.equal(uploads, files.length);
        assert.deepEqual(await fixture.run(), result);
        assert.equal(fixture.calls.filter(call => call.upload).length, uploads);
        const archived = fixture.calls.findIndex(call => call.method === "PATCH" && call.path === "/releases/1");
        assert.ok(fixture.calls.slice(0, archived).filter(call => call.upload).length === files.length);
        fixture.assertAtomic();
    });
}

test("first channel release also stages every asset before publication", async () => {
    const fixture = new GithubFixture("main", false);
    await fixture.run();
    assert.equal(fixture.publicRelease()?.target_commitish, newSha);
    fixture.assertAtomic();
});

test("successful draft POST uses its returned ID despite a persistently cached release listing", async () => {
    const fixture = new GithubFixture();
    const cached = structuredClone([...fixture.releases.values()]);
    fixture.releaseList = () => cached;
    fixture.after = call => {
        if (isPromotion(call)) {
            const staged = fixture.releases.get(10)!;
            assert.equal(staged.assets.length, files.length);
        }
        if (call.upload) {
            const staged = fixture.releases.get(10)!;
            assert.ok(staged.assets.every(asset => asset.browser_download_url === fixture.assetDownload(staged, asset.name)));
            assert.ok(staged.assets.every(asset => asset.browser_download_url.includes("/untagged-")));
        }
    };
    const result = await fixture.run();
    assert.equal(result.releaseId, 10);
    assert.equal(fixture.calls.filter(call => call.method === "POST" && call.path === "/releases").length, 1);
    assert.equal(fixture.releases.size, 3);
    assert.equal(fixture.publicRelease()?.id, 10);
    fixture.assertAtomic();
});

test("lost draft POST response with cached listing fails closed without blind duplicate creation", async () => {
    const fixture = new GithubFixture();
    const cached = structuredClone([...fixture.releases.values()]);
    fixture.releaseList = () => cached;
    fixture.after = call => {
        if (call.method === "POST" && call.path === "/releases") throw unavailable();
    };
    await assert.rejects(fixture.run());
    assert.equal(fixture.calls.filter(call => call.method === "POST" && call.path === "/releases").length, 1);
    assert.equal(fixture.releases.size, 3);
    assert.equal(fixture.releases.get(10)?.draft, true);
    assert.equal(fixture.publicRelease()?.id, 1);
    assert.equal(fixture.refs.get("tags/nightly"), oldSha);
    assert.ok(!fixture.calls.some(call => call.upload || call.method === "PATCH" || call.method === "DELETE"));
    const retryStart = fixture.calls.length;
    await assert.rejects(fixture.run(), /refusing duplicate creation/u);
    assert.ok(fixture.calls.slice(retryStart).every(call => call.method === "GET"));
    assert.equal(fixture.calls.filter(call => call.method === "POST" && call.path === "/releases").length, 1);
    fixture.releaseList = undefined;
    fixture.after = () => {};
    await fixture.run();
    assert.equal(fixture.calls.filter(call => call.method === "POST" && call.path === "/releases").length, 1);
    assert.equal(fixture.publicRelease()?.id, 10);
    fixture.assertAtomic();
});

test("published assets require exact channel download URLs, never draft or foreign endpoints", async () => {
    for (const branch of ["main", "nightly", "staging"]) {
        const channel = branch === "main" ? "latest" : branch;
        const name = files[0].name;
        const exact = `https://github.com/${repository}/releases/download/${channel}/${name}`;
        const invalid = [
            exact.replace(`/${channel}/`, "/untagged-043767bd3625763ef320/"),
            exact.replace(`/${channel}/`, "/another-tag/"),
            exact.replace(repository, "foreign/repository"),
            exact.replace("github.com", "github.com.attacker.invalid"),
            exact.replace("https:", "http:"),
            exact.replace("github.com", "user@github.com"),
            exact.replace(name, "wrong.asar"),
            `${exact}?download=1`,
            `${exact}#fragment`,
            `${exact}/extra`,
        ];
        for (const endpoint of invalid) {
            const fixture = new GithubFixture(branch);
            const api = async (...args: Parameters<typeof fixture.api>) => {
                const result = await fixture.api(...args);
                const release = fixture.publicRelease();
                if (release?.id === 10 && args[0] === "GET" && args[1] === "/releases/10/assets?per_page=100") {
                    (result as Asset[])[0].browser_download_url = endpoint;
                }
                return result;
            };
            await assert.rejects(releaseUpdateChannel({ api, branch, sha: newSha, runId: "1234", files }), /Invalid asset download endpoint/u);
            assert.equal(fixture.publicRelease()?.id, 10);
            assert.equal(fixture.refs.get(`tags/${channel}`), newSha);
            assert.equal(fixture.releases.get(1)?.draft, true);
            fixture.assertAtomic();
        }
    }
});

for (const phase of ["create", "upload", "archive", "tag", "promote"]) {
    test(`lost response after ${phase} reconciles without duplicate or public piecemeal writes`, async () => {
        const fixture = new GithubFixture("main");
        let fired = false;
        fixture.after = call => {
            const match = phase === "create" ? call.method === "POST" && call.path === "/releases"
                : phase === "upload" ? call.upload
                    : phase === "archive" ? call.method === "PATCH" && call.path === "/releases/1" && (call.body as Record<string, unknown>).draft === true
                        : phase === "tag" ? call.method === "PATCH" && call.path === "/git/refs/tags/latest"
                            : isPromotion(call);
            if (match && !fired) { fired = true; throw unavailable(); }
        };
        await fixture.run();
        assert.ok(fired);
        assert.equal(fixture.publicRelease()?.target_commitish, newSha);
        assert.equal(fixture.calls.filter(call => call.upload).length, files.length);
    });
}

test("upload failure leaves old release/tag untouched, then resumes partial draft", async () => {
    const fixture = new GithubFixture();
    fixture.before = call => { if (call.upload && call.path.includes("name=equibop.asar")) throw unavailable(); };
    await assert.rejects(fixture.run(), /unavailable/u);
    assert.equal(fixture.publicRelease()?.id, 1);
    assert.equal(fixture.refs.get("tags/nightly"), oldSha);
    const uploaded = fixture.releases.get(10)?.assets.length;
    assert.ok(uploaded && uploaded < files.length);
    fixture.before = () => {};
    await fixture.run();
    assert.equal(fixture.calls.filter(call => call.upload && call.path.includes("name=desktop.asar")).length, 1);
});

test("GitHub starter asset after 502 is removed only from staging and retried", async () => {
    const fixture = new GithubFixture();
    fixture.before = call => { if (call.upload) throw unavailable(); };
    await assert.rejects(fixture.run());
    const staged = fixture.releases.get(10)!;
    staged.assets.push({ id: 999, name: files[0].name, size: 0, digest: "", state: "starter", browser_download_url: fixture.assetDownload(staged, files[0].name) });
    fixture.before = () => {};
    await fixture.run();
    assert.deepEqual(fixture.calls.filter(call => call.method === "DELETE").map(call => call.path), ["/releases/assets/999"]);
});

test("corrupt staged digest and unexpected assets fail closed before channel mutation", async () => {
    for (const corruption of ["digest", "extra", "sha", "stage-ref", "manifest"]) {
        const fixture = new GithubFixture();
        fixture.before = call => { if (call.upload) throw unavailable(); };
        await assert.rejects(fixture.run());
        fixture.before = () => {};
        const staged = fixture.releases.get(10)!;
        if (corruption === "sha") staged.target_commitish = oldSha;
        else if (corruption === "stage-ref") fixture.refs.set(`tags/${staged.tag_name}`, oldSha);
        else if (corruption === "manifest") staged.body = staged.body.replace(newSha, oldSha);
        else staged.assets.push({ id: 999, name: corruption === "extra" ? "unexpected.asar" : files[0].name, size: files[0].size, digest: hash(Buffer.from("bad")), state: "uploaded", browser_download_url: fixture.assetDownload(staged, files[0].name) });
        await assert.rejects(fixture.run());
        assert.equal(fixture.publicRelease()?.id, 1);
        assert.equal(fixture.refs.get("tags/nightly"), oldSha);
    }
});

test("missing required assets and dropping older client assets cannot change public release", async () => {
    const fixture = new GithubFixture();
    await assert.rejects(releaseUpdateChannel({ api: fixture.api, branch: "nightly", sha: newSha, runId: "1234", files: files.slice(1) }), /required/u);
    assert.equal(fixture.calls.length, 0);
    fixture.releases.get(1)!.assets.push({ ...fixture.releases.get(1)!.assets[0], id: 999, name: "vesktop.asar" });
    fixture.assertAtomic = () => {};
    await assert.rejects(fixture.run(), /existing client asset/u);
    assert.equal(fixture.publicRelease()?.id, 1);
});

test("immutable old release and unauthorized discovery fail before staging writes", async () => {
    const fixture = new GithubFixture();
    fixture.releases.get(1)!.immutable = true;
    await assert.rejects(fixture.run(), /safely replaced/u);
    assert.ok(fixture.calls.every(call => call.method === "GET"));
    fixture.before = call => { if (call.path === "/releases/tags/nightly") throw Object.assign(new Error("forbidden"), { status: 403 }); };
    await assert.rejects(fixture.run(), /forbidden/u);
    assert.ok(fixture.calls.every(call => call.method === "GET"));
});

test("stale head at initial/final guard skips before hiding old release", async () => {
    for (const late of [false, true]) {
        const fixture = new GithubFixture();
        if (!late) fixture.refs.set("heads/nightly", advancedSha);
        else fixture.after = call => { if (call.upload) fixture.refs.set("heads/nightly", advancedSha); };
        assert.deepEqual(await fixture.run(), { skipped: true });
        assert.equal(fixture.publicRelease()?.id, 1);
        assert.equal(fixture.refs.get("tags/nightly"), oldSha);
        assert.ok(!fixture.calls.some(call => call.method === "PATCH"));
    }
});

test("head advance after archival restores old stable release and SHA", async () => {
    const fixture = new GithubFixture("main");
    fixture.after = call => { if (call.path === "/releases/1" && call.method === "PATCH" && (call.body as Record<string, unknown>).draft === true) fixture.refs.set("heads/main", advancedSha); };
    await assert.rejects(fixture.run(), /advanced/u);
    assert.equal(fixture.publicRelease()?.id, 1);
    assert.equal(fixture.refs.get("tags/latest"), oldSha);
    assert.equal(fixture.latest, 1);
    fixture.assertAtomic();
});

test("promotion failure restores old release, retry promotes already verified draft", async () => {
    const fixture = new GithubFixture("main");
    fixture.before = call => { if (isPromotion(call)) throw unavailable(); };
    await assert.rejects(fixture.run(), /unavailable/u);
    assert.equal(fixture.publicRelease()?.id, 1);
    assert.equal(fixture.refs.get("tags/latest"), oldSha);
    const uploads = fixture.calls.filter(call => call.upload).length;
    fixture.before = () => {};
    await fixture.run();
    assert.equal(fixture.publicRelease()?.target_commitish, newSha);
    assert.equal(fixture.calls.filter(call => call.upload).length, uploads);
});

test("failed post-promotion verification never rolls a public tag back underneath new assets", async () => {
    const fixture = new GithubFixture("main");
    let promoted = false;
    fixture.after = call => { if (isPromotion(call)) promoted = true; };
    fixture.before = call => { if (promoted && call.path === "/releases/latest") throw unavailable(); };
    await assert.rejects(fixture.run(), /unavailable/u);
    assert.equal(fixture.publicRelease()?.target_commitish, newSha);
    assert.equal(fixture.refs.get("tags/latest"), newSha);
    fixture.before = () => {};
    await fixture.run();
    fixture.assertAtomic();
});

test("tag movement failure restores prior stable metadata without publishing staging", async () => {
    const fixture = new GithubFixture("main");
    fixture.before = call => { if (call.method === "PATCH" && call.path === "/git/refs/tags/latest") throw unavailable(); };
    await assert.rejects(fixture.run(), /unavailable/u);
    assert.equal(fixture.publicRelease()?.id, 1);
    assert.equal(fixture.refs.get("tags/latest"), oldSha);
    fixture.assertAtomic();
});

test("head advancement after tag movement still rolls back before publishing", async () => {
    const fixture = new GithubFixture();
    fixture.after = call => { if (call.method === "PATCH" && call.path === "/git/refs/tags/nightly") fixture.refs.set("heads/nightly", advancedSha); };
    await assert.rejects(fixture.run(), /advanced/u);
    assert.equal(fixture.publicRelease()?.id, 1);
    assert.equal(fixture.refs.get("tags/nightly"), oldSha);
    assert.ok(!fixture.calls.some(isPromotion));
});

test("failed rollback keeps the channel unavailable rather than exposing old assets at new SHA", async () => {
    const fixture = new GithubFixture();
    fixture.before = call => {
        if (isPromotion(call) || (call.method === "PATCH" && call.path === "/git/refs/tags/nightly" && (call.body as Record<string, unknown>).sha === oldSha)) throw unavailable();
    };
    await assert.rejects(fixture.run(), /unavailable/u);
    assert.equal(fixture.publicRelease(), undefined);
    assert.equal(fixture.refs.get("tags/nightly"), newSha);
    assert.equal(fixture.releases.get(1)?.draft, true);
    fixture.assertAtomic();
    fixture.before = () => {};
    await fixture.run();
    assert.equal(fixture.publicRelease()?.target_commitish, newSha);
});

test("conflicting staging tags and pagination exhaustion never modify a public channel", async () => {
    const collision = new GithubFixture();
    collision.refs.set(`tags/protonn-channel-nightly-1234-${newSha}`, oldSha);
    await assert.rejects(collision.run(), /refusing duplicate creation/u);
    assert.ok(collision.calls.every(call => call.method === "GET"));
    const fixture = new GithubFixture();
    const requests: string[] = [];
    await assert.rejects(releaseUpdateChannel({
        api: async (method: string, path: string) => {
            assert.equal(method, "GET");
            requests.push(path);
            return Array.from({ length: 100 }, () => fixture.releases.get(2));
        },
        branch: "nightly", sha: newSha, runId: "1234", files,
    }), /pagination budget/u);
    assert.equal(requests.length, 10);
});

test("transport pins authenticated hosts and API version, times out stalled fetches, and enforces total budget", async () => {
    const api = createGithubApi("fixture-token", async (url, options) => {
        assert.ok(options);
        assert.equal(url, `https://uploads.github.com/repos/${repository}/releases/10/assets?name=desktop.asar`);
        assert.equal(options.redirect, "error");
        assert.ok(options.signal);
        assert.equal((options.headers as Record<string, string>)["X-GitHub-Api-Version"], "2026-03-10");
        assert.equal((options.headers as Record<string, string>).Authorization, "Bearer fixture-token");
        assert.equal(options.body, files[0].data);
        return new Response("{}", { status: 201 });
    });
    await api("POST", "/releases/10/assets?name=desktop.asar", files[0].data, true);
    let calls = 0;
    const expired = createGithubApi("fixture-token", async () => { calls++; return new Response("{}"); }, { budgetMs: 0 });
    await assert.rejects(expired("GET", "/releases"), /budget exhausted/u);
    assert.equal(calls, 0);
    const stalled = createGithubApi("fixture-token", () => new Promise<Response>(() => {}), { timeoutMs: 5 });
    const keepAlive = setInterval(() => {}, 100);
    try { await assert.rejects(stalled("GET", "/releases"), /timed out/u); } finally { clearInterval(keepAlive); }
});

test("a stopped process after archiving old release resumes via persisted journal", async () => {
    const fixture = new GithubFixture();
    fixture.before = call => { if (isPromotion(call)) throw unavailable(); };
    fixture.after = call => { if (call.method === "PATCH" && call.path.startsWith("/git/refs/tags/nightly")) throw unavailable(); };
    let reads = 0;
    const underlying = fixture.api;
    const interrupted = async (...args: Parameters<typeof underlying>) => {
        if (fixture.releases.get(1)?.draft && args[0] === "GET" && /^\/releases\/\d+$/u.test(args[1]) && ++reads >= 1) throw unavailable();
        return underlying(...args);
    };
    await assert.rejects(releaseUpdateChannel({ api: interrupted, branch: "nightly", sha: newSha, runId: "1234", files }));
    assert.equal(fixture.publicRelease(), undefined);
    fixture.before = () => {};
    fixture.after = () => {};
    await fixture.run();
    assert.equal(fixture.publicRelease()?.target_commitish, newSha);
});

test("transport bounds reads, handles 404 only on GET, and never blindly retries writes", async () => {
    let calls = 0;
    const unavailableFetch = async () => { calls++; return new Response("", { status: 503 }); };
    const api = createGithubApi("fixture-token", unavailableFetch);
    await assert.rejects(api("GET", "/releases"), /503/u);
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(api("POST", "/releases", {}), /503/u);
    assert.equal(calls, 1);
    const absent = createGithubApi("fixture-token", async () => new Response("", { status: 404 }));
    assert.equal(await absent("GET", "/releases/tags/nightly"), null);
    await assert.rejects(absent("POST", "/releases", {}), /404/u);
    const huge = createGithubApi("fixture-token", async () => new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } }));
    await assert.rejects(huge("GET", "/releases"), /too large/u);
    const oversized = createGithubApi("fixture-token", async () => new Response("x".repeat(4 * 1024 * 1024 + 1)));
    await assert.rejects(oversized("GET", "/releases"), /too large/u);
    const stalled = createGithubApi("fixture-token", async () => new Response(new ReadableStream({ start() {} })), { timeoutMs: 5 });
    const keepAlive = setInterval(() => {}, 100);
    try { await assert.rejects(stalled("GET", "/releases"), /timed out/u); } finally { clearInterval(keepAlive); }
});

test("local preparation rejects empty files and workflow invokes only atomic channel helper", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protonn-release-atomic-"));
    try {
        await writeFile(join(directory, "empty.asar"), "");
        await assert.rejects(readReleaseFiles(directory), /Invalid asset/u);
        await writeFile(join(directory, "empty.asar"), "contents");
        const read = await readReleaseFiles(directory);
        assert.equal(read[0].digest, hash(Buffer.from("contents")));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
    const workflow = await readFile(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
    assert.match(workflow, /node scripts\/releaseUpdateChannel\.mjs/u);
    assert.doesNotMatch(workflow, /gh release (upload|edit)|git (push|tag).*--force|--clobber/u);
    assert.match(workflow, /cancel-in-progress: false/u);
    assert.match(workflow, /git rev-parse FETCH_HEAD/u);
});
