/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { promoteChannels, SOAK_MS } from "./promoteChannels.mjs";

function fixture() {
    const now = Date.now();
    const heads = { nightly: "nightly-sha", staging: "old-staging", main: "old-main" };
    const runs = new Map();
    const writes = [];
    let nextId = 1;
    function run(branch, workflow, options = {}) {
        const sha = heads[branch];
        const key = `${branch}/${sha}/${workflow}`;
        const value = { id: nextId++, head_branch: branch, head_sha: sha, event: "push", created_at: new Date(now - SOAK_MS).toISOString(), status: "completed", conclusion: "success", ...options };
        runs.set(key, [value, ...runs.get(key) ?? []]);
        return value;
    }
    for (const workflow of ["test.yml", "build.yml", "mobile.yml"]) run("nightly", workflow);
    async function api(path, method = "GET", body) {
        if (method === "POST") {
            writes.push({ path, body });
            if (path === "merges") {
                if (heads[body.base] === body.head) return null;
                heads[body.base] = body.head;
                return { sha: body.head };
            }
            return null;
        }
        if (path.startsWith("branches/")) return { commit: { sha: heads[path.slice(9)] } };
        const url = new URL(`https://example.test/${path}`);
        const workflow = url.pathname.split("/")[3];
        return { workflow_runs: runs.get(`${url.searchParams.get("branch")}/${url.searchParams.get("head_sha")}/${workflow}`) ?? [] };
    }
    return { now, heads, writes, runs, run, api, tick: () => promoteChannels(api, now, () => {}) };
}

test("nightly must spend three full hours on the branch, even with successful checks", async () => {
    const h = fixture();
    h.run("nightly", "test.yml", { created_at: new Date(h.now - SOAK_MS + 1).toISOString() });
    await h.tick();
    assert.deepEqual(h.writes, []);
});

test("missing, failed, cancelled, skipped and pending nightly checks block promotion", async () => {
    for (const workflow of ["test.yml", "build.yml", "mobile.yml"]) {
        for (const conclusion of ["failure", "cancelled", "skipped", null, "missing"]) {
            const h = fixture();
            if (conclusion === "missing") h.runs.delete(`nightly/nightly-sha/${workflow}`);
            else h.run("nightly", workflow, { conclusion, status: conclusion === null ? "in_progress" : "completed" });
            await h.tick();
            assert.deepEqual(h.writes, [], `${workflow}: ${conclusion}`);
        }
    }
});

test("dispatch or PR runs cannot establish when a revision arrived on nightly", async () => {
    for (const event of ["workflow_dispatch", "pull_request"]) {
        const h = fixture();
        h.runs.delete("nightly/nightly-sha/test.yml");
        h.run("nightly", "test.yml", { event });
        await h.tick();
        assert.deepEqual(h.writes, []);
    }
});

test("a new nightly head cannot inherit its predecessor's age or successful checks", async () => {
    const h = fixture();
    h.heads.nightly = "new-sha";
    await h.tick();
    assert.deepEqual(h.writes, []);
});

test("promotion runs staging checks first, then merges main and dispatches all releases", async () => {
    const h = fixture();
    await h.tick();
    assert.equal(h.heads.staging, "nightly-sha");
    assert.equal(h.heads.main, "old-main");
    assert.deepEqual(h.writes.map(w => w.path), ["merges", "actions/workflows/test.yml/dispatches", "actions/workflows/build.yml/dispatches"]);
    h.run("staging", "test.yml", { event: "workflow_dispatch" });
    h.run("staging", "build.yml", { event: "workflow_dispatch" });
    h.writes.length = 0;
    await h.tick();
    assert.equal(h.heads.main, "nightly-sha");
    assert.deepEqual(h.writes.filter(w => w.path.endsWith("/dispatches")).map(w => [w.path, w.body.ref]), [
        ["actions/workflows/test.yml/dispatches", "main"],
        ["actions/workflows/build.yml/dispatches", "main"],
        ["actions/workflows/publish.yml/dispatches", "main"],
    ]);
    for (const workflow of ["test.yml", "build.yml", "publish.yml"]) h.run("main", workflow);
    h.writes.length = 0;
    await h.tick();
    assert.ok(h.writes.every(w => w.path === "merges"), "completed workflows are never dispatched twice");
});

test("failed staging checks block main; a successful manual rerun can resume", async () => {
    const h = fixture();
    await h.tick();
    h.run("staging", "test.yml", { conclusion: "failure" });
    h.run("staging", "build.yml");
    h.writes.length = 0;
    await h.tick();
    assert.equal(h.heads.main, "old-main");
    assert.equal(h.writes.length, 1, "failures are not automatically rerun");
    h.run("staging", "test.yml");
    await h.tick();
    assert.equal(h.heads.main, "nightly-sha");
});

test("a conflicting merge fails without dispatching releases or touching main", async () => {
    const h = fixture();
    await assert.rejects(promoteChannels(async (path, ...args) => {
        if (path === "merges") throw new Error("409 conflict");
        return h.api(path, ...args);
    }, h.now, () => {}), /409 conflict/);
    assert.deepEqual(h.writes, []);
    assert.equal(h.heads.main, "old-main");
});

test("diverged staging is validated at its merge commit before that exact SHA reaches main", async () => {
    const h = fixture();
    const api = async (path, method, body) => {
        if (path === "merges" && body.base === "staging") {
            if (h.heads.staging === "staging-merge") return null;
            h.heads.staging = "staging-merge";
            return { sha: "staging-merge" };
        }
        return h.api(path, method, body);
    };
    await promoteChannels(api, h.now, () => {});
    assert.equal(h.heads.main, "old-main");
    h.run("staging", "test.yml");
    h.run("staging", "build.yml");
    await promoteChannels(api, h.now, () => {});
    assert.equal(h.heads.main, "staging-merge");
    assert.ok(h.writes.some(w => w.path === "merges" && w.body.base === "main" && w.body.head === "staging-merge"));
});

test("staging moving after its checks prevents promotion to main", async () => {
    const h = fixture();
    h.heads.staging = "nightly-sha";
    h.run("staging", "test.yml");
    h.run("staging", "build.yml");
    let reads = 0;
    await promoteChannels(async (path, ...args) => {
        if (path === "branches/staging" && ++reads === 2) h.heads.staging = "untested-staging";
        return h.api(path, ...args);
    }, h.now, () => {});
    assert.equal(h.heads.main, "old-main");
});

test("nightly advancing during validation does not promote an unsoaked head", async () => {
    const h = fixture();
    let reads = 0;
    await promoteChannels(async (path, ...args) => {
        if (path === "branches/nightly" && ++reads === 2) h.heads.nightly = "new-sha";
        return h.api(path, ...args);
    }, h.now, () => {});
    assert.deepEqual(h.writes, []);
});

test("missing dispatches after a partial failure are retried without rerunning successful ones", async () => {
    const h = fixture();
    await assert.rejects(promoteChannels(async (path, ...args) => {
        if (path === "actions/workflows/build.yml/dispatches") throw new Error("temporary failure");
        return h.api(path, ...args);
    }, h.now, () => {}), /temporary failure/);
    h.run("staging", "test.yml", { status: "in_progress", conclusion: null });
    h.writes.length = 0;
    await h.tick();
    assert.deepEqual(h.writes.filter(w => w.path.endsWith("/dispatches")).map(w => w.path), ["actions/workflows/build.yml/dispatches"]);
    assert.equal(h.heads.main, "old-main");
});

test("promoted workflows support dispatch and credentialed promotion only runs from main", () => {
    for (const name of ["test", "build", "publish"])
        assert.match(readFileSync(`.github/workflows/${name}.yml`, "utf8"), /    workflow_dispatch:/);
    const workflow = readFileSync(".github/workflows/promote.yml", "utf8");
    assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /cancel-in-progress: false/);
});
