// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { publishMobile } from "./publish-mobile.mjs";

const sha = "a".repeat(40);
const older = "b".repeat(40);
const tag = "mobile-build-123456789-1";
const runtimeTag = "mobile-runtime-ccccccc";
const hash = data => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const file = (name, text) => {
    const data = Buffer.from(text);
    return { name, data, size: data.length, digest: hash(data) };
};
// The Python validator owns ZIP/index semantics; this fixture exercises publication
// against an independently retained set, including files outside SHA256SUMS.
const files = [
    file("desktop-commit.txt", `${sha}\n`), file("REVENGE-LICENSE", "retained license"),
    file("revenge.bundle", "retained runtime"), file("revenge-runtime-source.zip", "retained source"),
    file("toolchain.json", JSON.stringify({ revengeRuntimeRevision: "c".repeat(40), runtimeRelease: runtimeTag })),
    file("index.json", JSON.stringify({ immutableBuild: tag })), file("SHA256SUMS", "retained checksum manifest\n"),
    file("uk.co.protonn.secure-messaging.zip", "retained plugin")
];
const runtimeFiles = files.filter(file => ["revenge.bundle", "revenge-runtime-source.zip", "REVENGE-LICENSE", "toolchain.json"].includes(file.name));

function github() {
    const releases = new Map(), refs = new Map(), bytes = new Map();
    const writes = [], reads = [];
    let nextId = 1;
    const state = { head: sha, afterWrite: null, afterRead: null };
    function addAsset(release, file) {
        const asset = { id: nextId++, name: file.name, size: file.size, digest: file.digest, state: "uploaded" };
        release.assets.push(asset);
        bytes.set(asset.id, Buffer.from(file.data));
        return asset;
    }
    function seed(tag, retained, { target = sha, draft = false } = {}) {
        const release = { id: nextId++, tag_name: tag, target_commitish: target, draft, prerelease: true, immutable: !draft && tag !== "mobile-nightly",
            name: tag === runtimeTag ? "Pinned Revenge Next runtime for ProtonnCord Mobile" : tag === "mobile-nightly" ? "ProtonnCord Mobile nightly" : `Mobile nightly ${target}`, assets: [] };
        releases.set(release.id, release);
        for (const file of retained) addAsset(release, file);
        if (!draft) refs.set(tag, target);
        return release;
    }
    const metadata = release => release && structuredClone(Object.fromEntries(Object.entries(release).filter(([key]) => key !== "assets")));
    async function api(method, path, body, upload = false) {
        const url = new URL(path, "https://fixture.invalid");
        const parts = url.pathname.split("/").slice(1);
        let result;
        const release = releases.get(Number(parts[1]));
        if (method === "GET") {
            if (url.pathname === "/git/ref/heads/nightly") result = { ref: "refs/heads/nightly", object: { type: "commit", sha: state.head } };
            else if (url.pathname.startsWith("/git/ref/tags/")) {
                const name = parts[3];
                result = refs.has(name) ? { ref: `refs/tags/${name}`, object: { type: "commit", sha: refs.get(name) } } : null;
            } else if (url.pathname.startsWith("/releases/tags/")) result = metadata([...releases.values()].find(release => release.tag_name === parts[2] && !release.draft)) ?? null;
            else if (url.pathname === "/releases") {
                const start = (Number(url.searchParams.get("page")) - 1) * 100;
                result = [...releases.values()].slice(start, start + 100).map(metadata);
            } else if (release && parts[2] === "assets") result = structuredClone(release.assets);
            else if (release && parts.length === 2) result = metadata(release);
            else throw new Error(`Unexpected fixture read ${path}`);
            state.afterRead?.({ path, result });
            return result;
        }
        if (method === "POST" && url.pathname === "/releases") {
            assert.equal([...releases.values()].some(release => release.tag_name === body.tag_name), false, "duplicate release creation");
            const created = seed(body.tag_name, [], { target: body.target_commitish, draft: body.draft });
            Object.assign(created, body);
            result = metadata(created);
        } else if (method === "POST" && release && parts[2] === "assets") {
            assert.equal(upload, true);
            assert.equal(release.immutable, false, "cannot change immutable release assets");
            const name = url.searchParams.get("name");
            assert.equal(release.assets.some(asset => asset.name === name), false, "no clobber on upload");
            result = structuredClone(addAsset(release, file(name, body)));
        } else if (method === "PATCH" && release && parts.length === 2) {
            Object.assign(release, body);
            if (!release.draft) {
                if (!refs.has(release.tag_name)) refs.set(release.tag_name, release.target_commitish);
                release.immutable = release.tag_name !== "mobile-nightly";
            }
            result = metadata(release);
        } else if (method === "PATCH" && url.pathname.startsWith("/git/refs/tags/")) {
            refs.set(parts[3], body.sha);
            result = { ref: `refs/tags/${parts[3]}`, object: { type: "commit", sha: body.sha } };
        } else if (method === "POST" && url.pathname === "/git/refs") {
            refs.set(body.ref.slice("refs/tags/".length), body.sha);
            result = { ref: body.ref, object: { type: "commit", sha: body.sha } };
        } else if (method === "DELETE" && parts[0] === "releases" && parts[1] === "assets") {
            const owner = [...releases.values()].find(release => release.assets.some(asset => asset.id === Number(parts[2])));
            const asset = owner?.assets.find(asset => asset.id === Number(parts[2]));
            assert.ok(owner?.tag_name === "mobile-nightly" || (owner?.draft && !owner.immutable && asset?.state === "starter" && asset.size === 0), "uploaded durable assets must never be deleted");
            owner.assets = owner.assets.filter(asset => asset.id !== Number(parts[2]));
            bytes.delete(Number(parts[2]));
            result = null;
        } else throw new Error(`Unexpected fixture mutation ${method} ${path}`);
        const write = { method, path, name: url.searchParams.get("name"), release: release?.tag_name ?? body?.tag_name };
        writes.push(write);
        state.afterWrite?.(write);
        return result;
    }
    const readAsset = async id => { reads.push(id); assert.ok(bytes.has(id)); return Buffer.from(bytes.get(id)); };
    return { api, readAsset, seed, addAsset, releases, refs, bytes, writes, reads, state,
        run: () => publishMobile({ api, readAsset, sha, tag, files }) };
}

test("upload accepted before failure resumes the same draft without replacing any bytes", async () => {
    const remote = github();
    const runtime = remote.seed(runtimeTag, runtimeFiles, { target: older });
    let uploads = 0;
    remote.state.afterWrite = write => {
        if (write.name && ++uploads === 3) throw new Error("connection lost after successful upload");
    };
    await assert.rejects(remote.run(), /connection lost/u);
    const draft = [...remote.releases.values()].find(release => release.tag_name === tag);
    assert.equal(draft.draft, true);
    assert.equal(draft.assets.length, 3);
    const retainedIds = draft.assets.map(asset => asset.id);
    remote.state.afterWrite = null;
    assert.deepEqual(await remote.run(), { tag });
    assert.equal(draft.draft, false);
    assert.deepEqual(draft.assets.slice(0, 3).map(asset => asset.id), retainedIds);
    assert.equal(draft.assets.length, files.length);
    assert.equal(remote.writes.filter(write => write.release === tag && write.name).length, files.length);
    assert.equal(runtime.target_commitish, older, "pinned runtime can belong to an older desktop commit");
    assert.equal(remote.writes.some(write => write.release === runtimeTag), false);
    assert.equal(remote.refs.get("mobile-nightly"), sha);
    for (const asset of [...draft.assets, ...runtime.assets]) assert.ok(remote.reads.includes(asset.id), `verified bytes for ${asset.name}`);
    const before = remote.writes.length;
    await remote.run();
    assert.equal(remote.writes.length, before, "matching public releases and index are reused without writes");
});

test("an empty failed-upload placeholder can be recovered without replacing uploaded assets", async () => {
    const remote = github();
    const build = remote.seed(tag, files.slice(0, 3), { draft: true });
    remote.seed(runtimeTag, runtimeFiles, { target: older });
    const placeholderId = build.assets[0].id;
    const retainedIds = build.assets.slice(1).map(asset => asset.id);
    Object.assign(build.assets[0], { state: "starter", size: 0, digest: null });
    await remote.run();
    assert.equal(build.draft, false);
    assert.equal(build.assets.length, files.length);
    assert.ok(retainedIds.every(id => build.assets.some(asset => asset.id === id)));
    assert.deepEqual(remote.writes.filter(write => write.method === "DELETE").map(write => write.path), [`/releases/assets/${placeholderId}`]);
});

test("both new immutable releases are fully verified and public before creating the pointer", async () => {
    const remote = github();
    remote.state.afterWrite = write => {
        if (write.release !== "mobile-nightly") return;
        const durable = [...remote.releases.values()].filter(release => release.tag_name !== "mobile-nightly");
        assert.equal(durable.length, 2);
        for (const release of durable) {
            assert.equal(release.draft, false);
            for (const asset of release.assets) assert.ok(remote.reads.includes(asset.id));
        }
    };
    await remote.run();
    assert.equal([...remote.releases.values()].find(release => release.tag_name === runtimeTag).assets.length, 4);
    assert.equal(remote.refs.get("mobile-nightly"), sha);
});

test("a corrupt accepted upload cannot publish its draft or the discovery index", async () => {
    const remote = github();
    remote.state.afterWrite = write => {
        if (write.name !== files.at(-1).name) return;
        const draft = [...remote.releases.values()].find(release => release.tag_name === tag);
        remote.bytes.get(draft.assets.at(-1).id)[0] ^= 1;
    };
    await assert.rejects(remote.run(), /bytes differ/u);
    assert.equal([...remote.releases.values()].find(release => release.tag_name === tag).draft, true);
    assert.equal([...remote.releases.values()].some(release => release.tag_name === "mobile-nightly"), false);
});

test("a failure after updating the index can retry with public immutable releases", async () => {
    const remote = github();
    const build = remote.seed(tag, files);
    remote.seed(runtimeTag, runtimeFiles, { target: older });
    const pointer = remote.seed("mobile-nightly", [file("index.json", "previous index")], { target: older });
    remote.state.afterWrite = write => {
        if (write.release === "mobile-nightly" && write.name === "index.json") throw new Error("lost response after pointer upload");
    };
    await assert.rejects(remote.run(), /lost response/u);
    assert.equal(remote.refs.get("mobile-nightly"), older);
    const uploadedId = pointer.assets[0].id;
    remote.state.afterWrite = null;
    const before = remote.writes.length;
    await remote.run();
    assert.deepEqual(remote.writes.slice(before).map(write => [write.method, write.path]), [["PATCH", "/git/refs/tags/mobile-nightly"]]);
    assert.equal(pointer.assets[0].id, uploadedId);
    assert.equal(remote.refs.get("mobile-nightly"), sha);
    assert.equal(build.assets.length, files.length);
});

test("conflicting draft/public identities, asset metadata and bytes fail before writes", async t => {
    const cases = {
        "different desktop target": (remote, build) => { build.target_commitish = older; },
        "different Git tag target": remote => remote.refs.set(tag, older),
        "public asset missing": (remote, build) => { build.assets.pop(); },
        "unknown draft asset": (remote, build) => remote.addAsset(build, file("unexpected.txt", "unknown")),
        "duplicate draft name": (remote, build) => remote.addAsset(build, files[0]),
        "incorrect asset digest": (remote, build) => { build.assets[0].digest = `sha256:${"f".repeat(64)}`; },
        "same-size tampered bytes with matching claimed digest": (remote, build) => { remote.bytes.get(build.assets[0].id)[0] ^= 1; },
        "nonzero failed-upload placeholder": (remote, build) => { Object.assign(build.assets[0], { state: "starter", size: 1, digest: null }); },
        "non-prerelease identity": (remote, build) => { build.prerelease = false; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
        const remote = github();
        const draft = !name.startsWith("public") && name !== "different Git tag target";
        const build = remote.seed(tag, draft ? files.slice(0, 3) : files, { draft });
        remote.seed(runtimeTag, runtimeFiles, { target: older });
        mutate(remote, build);
        await assert.rejects(remote.run(), /mismatch|incomplete|Unexpected|duplicate|Conflicting|bytes differ/u);
        assert.equal(remote.writes.length, 0);
    });
});

test("every pinned runtime asset is verified independently of the desktop SHA", async t => {
    for (const file of runtimeFiles) await t.test(file.name, async () => {
        const remote = github();
        const runtime = remote.seed(runtimeTag, runtimeFiles, { target: older });
        const asset = runtime.assets.find(asset => asset.name === file.name);
        remote.bytes.get(asset.id)[0] ^= 1;
        await assert.rejects(remote.run(), /bytes differ/u);
        assert.equal(remote.writes.length, 0, "runtime conflict is detected before creating a new Mobile release");
    });
});

test("stale builds leave the mutable pointer untouched, including advancement during publication", async t => {
    for (const when of ["already stale", "before index replacement", "before tag movement"]) await t.test(when, async () => {
        const remote = github();
        remote.seed(tag, files);
        remote.seed(runtimeTag, runtimeFiles, { target: older });
        const pointer = remote.seed("mobile-nightly", [file("index.json", "previous index")], { target: older });
        if (when === "already stale") remote.state.head = older;
        if (when === "before index replacement") remote.state.afterRead = ({ path }) => {
            if (path === `/releases/${pointer.id}/assets?per_page=100`) remote.state.head = older;
        };
        if (when === "before tag movement") remote.state.afterWrite = write => {
            if (write.release === "mobile-nightly" && write.name) remote.state.head = older;
        };
        if (when === "already stale") assert.deepEqual(await remote.run(), { skipped: true });
        else await assert.rejects(remote.run(), /Nightly advanced/u);
        assert.equal(remote.refs.get("mobile-nightly"), older);
        if (when !== "before tag movement") assert.equal(remote.writes.length, 0);
        else assert.equal(remote.writes.some(write => write.path.startsWith("/git/refs")), false);
    });
});
