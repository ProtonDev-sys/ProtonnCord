import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import { load } from "yaml-js";

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; };
type Job = { steps: Step[]; if: string; };
type Triggers = { workflow_dispatch: { inputs: Record<string, { default: unknown; options?: string[]; }>; }; };
const workflow = load(readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8")) as {
    jobs: Record<string, Job>;
    on?: Triggers;
    true?: Triggers;
};
const prepare = workflow.jobs.prepare;
const bash = process.env.AUDIT_BASH ?? (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const archives = ["extension-chrome.zip", "extension-firefox.zip", "extension-sources.zip"];

function script(job: Job, name: string) {
    const step = job.steps.find(candidate => candidate.name === name);
    assert.ok(step?.run, `Missing runnable step: ${name}`);
    return step.run;
}

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "publish-retry-audit-"));
    const dist = join(root, "dist");
    mkdirSync(dist);
    for (const archive of archives) writeFileSync(join(dist, archive), `inert fixture: ${archive}`);
    return { root, dist };
}

function run(root: string, source: string, overrides: Record<string, string | undefined> = {}) {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", source], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            GITHUB_SHA: sha,
            GITHUB_REPOSITORY: "offline/fixture",
            GITHUB_OUTPUT: "outputs.txt",
            PACKAGE_VERSION: "v1.2.3",
            LATEST_VERSION: "v1.2.3",
            RETRY: "true",
            TAG_EXISTS: "true",
            TAG_SHA: sha,
            DURABLE_ID: "42",
            HEAD_SHA: sha,
            DURABLE_SHA: sha,
            ARTIFACT_TAG: "browser-extension-v1.2.3",
            API_FAIL: "false",
            ...overrides
        }
    });
    assert.ifError(result.error);
    return result;
}

const mocks = `
git() {
  case "$1" in
    show-ref) test "$TAG_EXISTS" = true ;;
    rev-parse) printf '%s\\n' "$TAG_SHA" ;;
    *) echo 'Unexpected git call' >&2; return 99 ;;
  esac
}
gh() {
  printf '%s\\n' "$*" >> calls.txt
  test "$API_FAIL" != true || return 23
  case "$1 $2" in
    'api --paginate') printf '%s' "$DURABLE_ID" ;;
    'api repos/'*) printf '%s\\n' "$HEAD_SHA" ;;
    'release view') printf '%s\\n' "$DURABLE_SHA" ;;
    'release download') cp durable/* dist/ ;;
    'release create') mkdir durable; cp dist/extension-*.zip dist/archives.sha256 dist/release-sha.txt durable/ ;;
    'api --method') printf '%s\\n' '${otherSha}' ;;
    *) echo 'Unexpected gh call' >&2; return 99 ;;
  esac
}
`;

function outputs(root: string) {
    return existsSync(join(root, "outputs.txt")) ? readFileSync(join(root, "outputs.txt"), "utf8") : "";
}

test("actual release decision covers first build, explicit retry and fail-closed cases", () => {
    const cases = [
        { env: { TAG_EXISTS: "false", RETRY: "false", DURABLE_ID: "", LATEST_VERSION: "v0.0.0" }, expected: "build=true\nrelease=true\n" },
        { env: {}, expected: "build=false\nrelease=true\n" },
        { env: { RETRY: "false" }, expected: "release=false\n" },
        { env: { TAG_SHA: otherSha }, failure: true },
        { env: { TAG_EXISTS: "false" }, expected: "build=false\nrelease=true\n" },
        { env: { TAG_EXISTS: "false", DURABLE_ID: "" }, failure: true },
        { env: { DURABLE_ID: "" }, failure: true },
        { env: { DURABLE_ID: "42\n43" }, failure: true },
        { env: { API_FAIL: "true" }, failure: true },
        { env: { LATEST_VERSION: "v1.2.4" }, expected: "release=false\n" },
        { env: { TAG_EXISTS: "false", RETRY: "false" }, expected: "build=false\nrelease=true\n" }
    ];
    for (const scenario of cases) {
        const { root } = fixture();
        try {
            const result = run(root, mocks + script(prepare, "Check if package.json version is newer"), scenario.env);
            if (scenario.failure) {
                assert.notEqual(result.status, 0, JSON.stringify(scenario));
                assert.doesNotMatch(outputs(root), /release=true/);
            } else {
                assert.equal(result.status, 0, result.stderr);
                assert.equal(outputs(root), scenario.expected);
            }
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
});

test("actual checksum gates reject changed, missing, misbound and malformed inert artifacts", () => {
    for (const job of Object.values(workflow.jobs)) {
        const mutations = [
            () => {},
            (dist: string) => writeFileSync(join(dist, archives[0]), "changed bytes"),
            (dist: string) => rmSync(join(dist, archives[1])),
            (dist: string) => writeFileSync(join(dist, "release-sha.txt"), otherSha),
            (dist: string) => writeFileSync(join(dist, "archives.sha256"), `${"0".repeat(64)}  ../outside.zip\n`),
            (dist: string) => writeFileSync(join(dist, "archives.sha256"), ""),
            (dist: string) => writeFileSync(join(dist, "archives.sha256"), readFileSync(join(dist, "archives.sha256"), "utf8").split("\n").slice(0, 2).join("\n")),
            (dist: string) => writeFileSync(join(dist, "archives.sha256"), readFileSync(join(dist, "archives.sha256"), "utf8") + "extra\n")
        ];
        for (const [index, mutate] of mutations.entries()) {
            const { root, dist } = fixture();
            try {
                assert.equal(run(root, script(prepare, "Record archive identity")).status, 0);
                const hash = createHash("sha256").update(readFileSync(join(dist, archives[0]))).digest("hex");
                assert.ok(readFileSync(join(dist, "archives.sha256"), "utf8").includes(hash));
                mutate(dist);
                const result = run(root, script(job, "Verify release archives"));
                assert.equal(result.status === 0, index === 0, `mutation ${index}: ${result.stderr}`);
            } finally { rmSync(root, { recursive: true, force: true }); }
        }
    }
});

test("durable archives survive loss of run artifacts and restore byte-identically without rebuilding", () => {
    const { root, dist } = fixture();
    try {
        assert.equal(run(root, script(prepare, "Record archive identity")).status, 0);
        const original = archives.map(archive => readFileSync(join(dist, archive)).toString("hex"));
        assert.equal(run(root, mocks + script(prepare, "Persist durable release archives")).status, 0);
        for (const archive of [...archives, "archives.sha256", "release-sha.txt"]) rmSync(join(dist, archive));
        const restored = run(root, mocks + script(prepare, "Restore durable release archives"));
        assert.equal(restored.status, 0, restored.stderr);
        assert.equal(run(root, script(prepare, "Verify release archives")).status, 0);
        assert.deepEqual(archives.map(archive => readFileSync(join(dist, archive)).toString("hex")), original);
        assert.notEqual(run(root, mocks + script(prepare, "Restore durable release archives"), { DURABLE_SHA: otherSha }).status, 0);
        assert.notEqual(run(root, mocks + script(prepare, "Restore durable release archives"), { API_FAIL: "true" }).status, 0);
        assert.notEqual(run(root, mocks + script(prepare, "Persist durable release archives"), { HEAD_SHA: otherSha }).status, 0);
        assert.notEqual(run(root, mocks + script(prepare, "Persist durable release archives")).status, 0);
        rmSync(join(root, "durable", archives[1]));
        for (const archive of [...archives, "archives.sha256", "release-sha.txt"]) rmSync(join(dist, archive));
        assert.equal(run(root, mocks + script(prepare, "Restore durable release archives")).status, 0);
        assert.notEqual(run(root, script(prepare, "Verify release archives")).status, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tag finalization is idempotent, never moves an existing version, and rejects stale builds", () => {
    for (const scenario of [
        { env: {}, expected: "release=true\n", writes: false },
        { env: { TAG_SHA: otherSha }, failure: true, writes: false },
        { env: { TAG_EXISTS: "false", HEAD_SHA: otherSha }, expected: "release=false\n", writes: false },
        { env: { TAG_EXISTS: "false" }, expected: "release=true\n", writes: true }
    ]) {
        const { root } = fixture();
        try {
            const result = run(root, mocks + script(prepare, "Create Tag"), scenario.env);
            assert.equal(result.status === 0, !scenario.failure, result.stderr);
            if (!scenario.failure) assert.equal(outputs(root), scenario.expected);
            const calls = existsSync(join(root, "calls.txt")) ? readFileSync(join(root, "calls.txt"), "utf8") : "";
            assert.equal(calls.includes("api --method POST"), scenario.writes);
            assert.doesNotMatch(calls, /PATCH|DELETE|force|clobber/);
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
});

test("partial-store retry selects only the failed store and preserves build/secret isolation", () => {
    const triggers = workflow.on ?? workflow.true;
    assert.ok(triggers);
    assert.equal(triggers.workflow_dispatch.inputs.retry.default, false);
    assert.deepEqual(triggers.workflow_dispatch.inputs.store.options, ["all", "chrome", "firefox", "edge"]);
    for (const selected of ["all", "chrome", "firefox", "edge"]) {
        for (const store of ["chrome", "firefox", "edge"]) {
            const job = workflow.jobs[`publish-${store}`];
            const expression = job.if.replaceAll("needs.prepare.outputs.release", '"true"')
                .replaceAll("vars.ACT", '"false"').replaceAll("github.event_name", '"workflow_dispatch"')
                .replaceAll("inputs.store", JSON.stringify(selected));
            assert.equal(runInNewContext(expression, Object.create(null), { timeout: 100 }), selected === "all" || selected === store);
            assert.ok(job.steps.findIndex(step => step.name === "Verify release archives") < job.steps.findIndex(step => step.name === `Publish ${store[0].toUpperCase()}${store.slice(1)} extension`));
            assert.equal(job.steps.filter(step => step.env && Object.values(step.env).some(value => value.includes("secrets."))).length, 1);
        }
    }
    for (const name of ["Setup PNPM", "Use Node.js 24", "Install dependencies", "Build web", "Create sources zip", "Record archive identity", "Persist durable release archives"])
        assert.equal(prepare.steps.find(step => step.name === name)?.if, "steps.check.outputs.build == 'true'");
    assert.equal(prepare.steps.find(step => step.name === "Store release archives")?.with?.["retention-days"], 90);
    assert.ok(prepare.steps.findIndex(step => step.name === "Persist durable release archives") < prepare.steps.findIndex(step => step.name === "Create Tag"));
    for (const step of prepare.steps) assert.doesNotMatch(JSON.stringify(step.env ?? {}), /secrets\.(CHROME|FIREFOX|EDGE)_/);
    for (const job of Object.values(workflow.jobs)) {
        const checkout = job.steps.filter(step => step.uses?.startsWith("actions/checkout@"));
        assert.equal(checkout.length, 1);
        assert.equal(checkout[0].with?.ref, "${{ github.sha }}");
        assert.equal(checkout[0].with?.["persist-credentials"], false);
    }
});

test("a partially created durable draft cannot consume the version or rebuild different bytes", () => {
    const { root, dist } = fixture();
    try {
        assert.equal(run(root, script(prepare, "Record archive identity")).status, 0);
        const interrupted = mocks.replace(
            "mkdir durable; cp dist/extension-*.zip dist/archives.sha256 dist/release-sha.txt durable/",
            "mkdir durable; cp dist/extension-chrome.zip dist/archives.sha256 dist/release-sha.txt durable/; return 23"
        );
        assert.notEqual(run(root, interrupted + script(prepare, "Persist durable release archives")).status, 0);
        assert.equal(outputs(root), "");
        for (const archive of [...archives, "archives.sha256", "release-sha.txt"]) rmSync(join(dist, archive));
        const decision = run(root, mocks + script(prepare, "Check if package.json version is newer"), { TAG_EXISTS: "false" });
        assert.equal(decision.status, 0, decision.stderr);
        assert.equal(outputs(root), "build=false\nrelease=true\n");
        const result = run(root, mocks + script(prepare, "Restore durable release archives") + "\n" + script(prepare, "Verify release archives") + "\n" + script(prepare, "Create Tag"), { TAG_EXISTS: "false" });
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(readFileSync(join(root, "calls.txt"), "utf8"), /api --method POST/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real Git peels lightweight and annotated tags and rejects a different commit", () => {
    const { root } = fixture();
    const git = (args: string[], input?: string) => {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input, timeout: 10000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    try {
        git(["init", "--quiet"]);
        const tree = git(["hash-object", "-w", "-t", "tree", "--stdin"], "");
        const commit = git(["hash-object", "-w", "-t", "commit", "--stdin"], `tree ${tree}\nauthor Offline Test <offline@example.invalid> 0 +0000\ncommitter Offline Test <offline@example.invalid> 0 +0000\n\nfixture\n`);
        const annotated = git(["hash-object", "-w", "-t", "tag", "--stdin"], `object ${commit}\ntype commit\ntag v1.2.3\ntagger Offline Test <offline@example.invalid> 0 +0000\n\nfixture\n`);
        const ghOnly = mocks.slice(mocks.indexOf("gh()"));
        for (const tagObject of [commit, annotated]) {
            git(["update-ref", "refs/tags/v1.2.3", tagObject]);
            for (const expectedSha of [commit, otherSha]) {
                writeFileSync(join(root, "outputs.txt"), "");
                const result = run(root, ghOnly + script(prepare, "Check if package.json version is newer"), { GITHUB_SHA: expectedSha });
                assert.equal(result.status === 0, expectedSha === commit, result.stderr);
                assert.equal(outputs(root), expectedSha === commit ? "build=false\nrelease=true\n" : "");
                writeFileSync(join(root, "outputs.txt"), "");
                const finalized = run(root, ghOnly + script(prepare, "Create Tag"), { GITHUB_SHA: expectedSha });
                assert.equal(finalized.status === 0, expectedSha === commit, finalized.stderr);
                assert.equal(git(["rev-parse", "refs/tags/v1.2.3"]), tagObject);
            }
        }
        assert.doesNotMatch(readFileSync(join(root, "calls.txt"), "utf8"), /api --method POST/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
