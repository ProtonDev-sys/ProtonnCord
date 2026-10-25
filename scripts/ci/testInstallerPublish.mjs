// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { publishInstaller } from "../publishInstaller.mjs";

const sha = "a".repeat(40), older = "b".repeat(40), tag = "windows-42-1";
const data = Buffer.from("tested installer bytes"), checksum = createHash("sha256").update(data).digest("hex");
const repository = "fixture/installers", name = "installer.exe", title = "Tested installer", body = `Source: ${sha}`;
const identity = { tag_name: tag, target_commitish: sha, name: title, body, prerelease: true };

function github() {
    const releases = new Map(), refs = new Map(), bytes = new Map(), writes = [], reads = [], pages = [];
    const state = { head: sha, afterWrite: null, failReads: false, page: null };
    let nextId = 1, headReads = 0;
    const metadata = release => release ? structuredClone(Object.fromEntries(Object.entries(release).filter(([key]) => key !== "assets"))) : null;
    const seed = (overrides = {}) => {
        const release = { ...identity, id: nextId++, draft: true, immutable: false, assets: [], ...overrides };
        releases.set(release.id, release);
        if (!release.draft) refs.set(release.tag_name, release.target_commitish);
        return release;
    };
    const asset = (release, overrides = {}) => {
        const value = { id: nextId++, name, size: data.length, digest: `sha256:${checksum}`, state: "uploaded",
            browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`, ...overrides };
        release.assets.push(value);
        bytes.set(value.id, Buffer.from(data));
        return value;
    };
    async function api(method, path, payload, upload) {
        const url = new URL(path, "https://fixture.invalid"), parts = url.pathname.split("/").slice(1);
        const release = releases.get(Number(parts[1]));
        if (method === "GET") {
            if (state.failReads) throw new Error("offline during recovery");
            if (url.pathname === "/git/ref/heads/nightly") { headReads++; return { ref: "refs/heads/nightly", object: { type: "commit", sha: state.head } }; }
            if (parts[0] === "git" && parts[2] === "tags") return refs.has(parts[3]) ? { ref: `refs/tags/${parts[3]}`, object: { type: "commit", sha: refs.get(parts[3]) } } : null;
            // GitHub's tag endpoint deliberately cannot discover retained drafts.
            if (parts[1] === "tags") return metadata([...releases.values()].find(value => !value.draft && value.tag_name === parts[2]));
            if (url.pathname === "/releases") {
                assert.equal(url.searchParams.get("per_page"), "100");
                const page = Number(url.searchParams.get("page"));
                assert.ok(Number.isSafeInteger(page) && page >= 1);
                pages.push(page);
                return structuredClone(state.page ? state.page(page) : [...releases.values()].slice((page - 1) * 100, page * 100).map(metadata));
            }
            if (release && parts[2] === "assets") return structuredClone(release.assets);
            if (release && parts.length === 2) return metadata(release);
            throw new Error(`Unexpected fixture read ${path}`);
        }
        const write = { method, path, headReads, verified: release?.assets.length === 1 && reads.includes(release.assets[0].id) };
        writes.push(write);
        let result;
        if (method === "POST" && url.pathname === "/releases") result = metadata(seed(payload));
        else if (method === "POST" && release && parts[2] === "assets") {
            assert.equal(upload, true);
            assert.deepEqual(payload, data);
            result = structuredClone(asset(release, { name: url.searchParams.get("name") }));
        } else if (method === "PATCH" && release && parts.length === 2) {
            Object.assign(release, payload);
            if (!release.draft) { release.immutable = true; if (!refs.has(release.tag_name)) refs.set(release.tag_name, release.target_commitish); }
            result = metadata(release);
        } else if (method === "DELETE" && parts[1] === "assets") {
            const owner = [...releases.values()].find(value => value.assets.some(item => item.id === Number(parts[2])));
            assert.ok(owner, "asset exists");
            owner.assets = owner.assets.filter(item => item.id !== Number(parts[2]));
            bytes.delete(Number(parts[2]));
            result = null;
        } else throw new Error(`Unexpected fixture mutation ${method} ${path}`);
        state.afterWrite?.(write);
        return result;
    }
    const readAsset = async id => { reads.push(id); assert.ok(bytes.has(id)); return Buffer.from(bytes.get(id)); };
    return { api, seed, asset, releases, refs, bytes, writes, reads, pages, state,
        run: (overrides = {}) => publishInstaller({ api, readAsset, repository, sha, tag, name, data, checksum, title, body, platform: "Windows", ...overrides }) };
}

test("new publication verifies bytes before publishing; published retries never write", async () => {
    const remote = github();
    await remote.run();
    const [release] = remote.releases.values();
    assert.equal(release.draft, false);
    assert.equal(remote.refs.get(tag), sha);
    assert.deepEqual(remote.writes.map(write => write.method), ["POST", "POST", "PATCH"]);
    assert.ok(remote.writes.every((write, index, all) => write.headReads > (all[index - 1]?.headReads ?? 0)), "fresh nightly check for every mutation");
    assert.equal(remote.writes.at(-1).verified, true, "read real bytes before publishing");
    await remote.run();
    assert.equal(remote.writes.length, 3);
    assert.equal(release.assets.length, 1);
});

test("interrupted accepted draft/upload resumes the same hidden draft; uncertain writes can recover immediately", async t => {
    for (const stage of ["draft", "upload", "delete", "publish"]) for (const offline of [true, false]) await t.test(`${stage}, offline=${offline}`, async () => {
        const remote = github();
        if (stage === "delete") remote.asset(remote.seed(), { state: "starter", size: 0, digest: null });
        const matches = write => stage === "draft" ? write.path === "/releases" : stage === "upload" ? write.path.includes("/assets?") : write.method === (stage === "delete" ? "DELETE" : "PATCH");
        remote.state.afterWrite = write => {
            if (!matches(write)) return;
            remote.state.afterWrite = null;
            remote.state.failReads = offline;
            throw new Error("connection lost after accepted write");
        };
        if (offline) await assert.rejects(remote.run()); else await remote.run();
        const [release] = remote.releases.values(), retainedId = release.id, uploadedId = release.assets[0]?.id;
        remote.state.failReads = false;
        if (offline && stage !== "publish") {
            assert.equal(release.draft, true);
            assert.equal(await remote.api("GET", `/releases/tags/${tag}`), null);
        }
        await remote.run();
        assert.equal(remote.releases.size, 1);
        assert.equal(release.id, retainedId);
        assert.equal(release.draft, false);
        assert.equal(release.assets.length, 1);
        if (uploadedId) assert.equal(release.assets[0].id, uploadedId);
        assert.equal(remote.writes.filter(write => write.path.includes("/assets?")).length, 1);
        assert.equal(remote.writes.filter(write => write.method === "PATCH").length, 1);
    });
});

test("only a single expected-name zero-byte starter on a mutable draft is cleaned", async () => {
    const remote = github(), release = remote.seed();
    const placeholder = remote.asset(release, { state: "starter", size: 0, digest: null });
    await remote.run();
    assert.deepEqual(remote.writes.map(write => write.method), ["DELETE", "POST", "PATCH"]);
    assert.equal(remote.writes[0].path, `/releases/assets/${placeholder.id}`);
    assert.ok(remote.writes.every((write, index, all) => write.headReads > (all[index - 1]?.headReads ?? 0)));
    assert.notEqual(release.assets[0].id, placeholder.id);
});

test("conflicting identities, tag targets and unsafe retained assets fail before writes", async t => {
    const cases = {
        duplicate: remote => remote.seed(),
        sha: (_, release) => { release.target_commitish = older; },
        title: (_, release) => { release.name += " changed"; },
        body: (_, release) => { release.body += " changed"; },
        prerelease: (_, release) => { release.prerelease = false; },
        tag: remote => remote.refs.set(tag, older),
        nonzero: (_, release) => { Object.assign(release.assets[0], { state: "starter", size: 1, digest: null }); },
        wrongname: (_, release) => { Object.assign(release.assets[0], { name: "other.exe", state: "starter", size: 0, digest: null }); },
        extra: (remote, release) => remote.asset(release, { name: "extra" }),
        "extra placeholder": (remote, release) => { Object.assign(release.assets[0], { state: "starter", size: 0, digest: null }); remote.asset(release, { name: "extra" }); },
        "uploaded empty": (_, release) => { Object.assign(release.assets[0], { size: 0, digest: null }); },
        size: (_, release) => { release.assets[0].size++; },
        digest: (_, release) => { release.assets[0].digest = `sha256:${"0".repeat(64)}`; },
        state: (_, release) => { release.assets[0].state = "processing"; },
        bytes: (remote, release) => { remote.bytes.get(release.assets[0].id)[0] ^= 1; },
        immutable: (_, release) => { release.immutable = true; release.assets = []; },
        "immutable uploaded": (_, release) => { release.immutable = true; },
        "immutable placeholder": (_, release) => { release.immutable = true; Object.assign(release.assets[0], { state: "starter", size: 0, digest: null }); },
        "public placeholder": (remote, release) => { release.draft = false; remote.refs.set(tag, sha); Object.assign(release.assets[0], { state: "starter", size: 0, digest: null }); },
        "public missing": (remote, release) => { release.draft = false; remote.refs.set(tag, sha); release.assets = []; }
    };
    for (const [label, mutate] of Object.entries(cases)) await t.test(label, async () => {
        const remote = github(), release = remote.seed();
        remote.asset(release);
        mutate(remote, release);
        await assert.rejects(remote.run());
        assert.equal(remote.writes.length, 0);
    });
    const remote = github();
    remote.refs.set(tag, older);
    await assert.rejects(remote.run());
    assert.equal(remote.writes.length, 0, "tag conflict prevents draft creation too");
});

test("stale nightly skips initially and stops between every pair of mutations", async t => {
    const stale = github();
    stale.state.head = older;
    await stale.run();
    assert.equal(stale.writes.length, 0);
    for (const stage of ["draft", "upload", "delete"]) await t.test(stage, async () => {
        const remote = github();
        if (stage !== "draft") { const release = remote.seed(); if (stage === "delete") remote.asset(release, { size: 0, state: "starter", digest: null }); }
        remote.state.afterWrite = () => { remote.state.head = older; };
        await assert.rejects(remote.run());
        assert.equal(remote.writes.length, 1);
        assert.equal([...remote.releases.values()][0].draft, true);
    });
});

test("draft discovery paginates and rejects malformed, oversized or exhausted scans", async t => {
    const remote = github();
    for (let index = 0; index < 100; index++) remote.seed({ tag_name: `unrelated-${index}` });
    const retained = remote.seed();
    await remote.run({ readAsset: undefined });
    assert.equal(retained.draft, false);
    assert.equal(remote.releases.size, 101);
    assert.ok(remote.pages.includes(2));
    const unrelated = { ...identity, id: 999, tag_name: "unrelated", draft: true };
    for (const [label, page] of Object.entries({ malformed: () => ({}), "malformed entry": () => [null], oversized: () => Array(101).fill(unrelated), exhausted: () => Array(100).fill(unrelated) })) await t.test(label, async () => {
        const remote = github();
        remote.state.page = page;
        await assert.rejects(remote.run());
        assert.equal(remote.writes.length, 0);
        assert.ok(remote.pages.length <= 10 && remote.pages.every(page => page <= 10));
        if (label === "exhausted") assert.deepEqual(remote.pages, Array.from({ length: 10 }, (_, index) => index + 1));
    });
});
