// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, TestContext } from "node:test";
import { publishAndroidInstaller, validateAndroidInstaller } from "./publishAndroidInstaller.mjs";

async function fixture(t: TestContext) {
    const directory = await mkdtemp(join(tmpdir(), "android-release-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await Promise.all([mkdir(join(directory, "standalone")), mkdir(join(directory, "reports/android-client"), { recursive: true })]);
    const env = { GITHUB_REPOSITORY: "ProtonDev-sys/ProtonnCord", GITHUB_REF_NAME: "nightly", GITHUB_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "42", GITHUB_RUN_NUMBER: "174", GITHUB_RUN_ATTEMPT: "2", ANDROID_SIGNER_SHA256: "b".repeat(64) };
    const data = Buffer.from("PK\x03\x04disposable already-verified APK fixture");
    const receipt = { format: 1, abi: "universal", packageName: "com.discord", sourceCommit: env.GITHUB_SHA,
        signerSha256: env.ANDROID_SIGNER_SHA256, outputs: { "ProtonnCord.apk": createHash("sha256").update(data).digest("hex") },
        release: { repository: env.GITHUB_REPOSITORY, runId: "42", runNumber: "174", attempt: "1" } };
    const smoke = { status: "passed", firstLaunch: { status: "passed", verifiedBeforeTestWrites: true },
        restart: { status: "passed", cacheRemovedBeforeLaunch: true, cacheRestored: true, statePreserved: true },
        javaScriptStarted: true, loginScreen: true, smoke: { signedOut: true }, apkReceipt: receipt };
    const save = () => Promise.all([
        writeFile(join(directory, "standalone/build-receipt.json"), JSON.stringify(receipt)),
        writeFile(join(directory, "reports/android-client/result.json"), JSON.stringify(smoke)),
    ]);
    await Promise.all([writeFile(join(directory, "standalone/ProtonnCord.apk"), data), save()]);
    const stopped = new Error("Reached immutable release lookup"), calls: string[] = [];
    const api = async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (method === "GET" && path === "/git/ref/heads/nightly") return { ref: "refs/heads/nightly", object: { type: "commit", sha: env.GITHUB_SHA } };
        throw stopped;
    };
    return { directory, env, data, receipt, smoke, save, stopped, calls, api };
}

test("local APK validation needs neither publishing credentials nor a GitHub request", async t => {
    const build = await fixture(t);
    const installer = await validateAndroidInstaller(build);
    assert.equal(installer.tag, "android-42-1");
    assert.deepEqual(installer.data, build.data);
    assert.deepEqual(build.calls, []);
});

test("APK publish-only retry selects the tested build's immutable tag before any mutation", async t => {
    const build = await fixture(t);
    await assert.rejects(publishAndroidInstaller(build), error => error === build.stopped);
    assert.deepEqual(build.calls, ["GET /git/ref/heads/nightly", "GET /releases/tags/android-42-1"]);
});

test("APK signing, source, build and actual smoke mismatches refuse every release request", async t => {
    const mutations: Array<(build: Awaited<ReturnType<typeof fixture>>) => void | Promise<void>> = [
        build => { build.env.ANDROID_SIGNER_SHA256 = ""; },
        build => { build.receipt.signerSha256 = "c".repeat(64); },
        build => { build.receipt.sourceCommit = "c".repeat(40); },
        build => { build.receipt.release.runId = "43"; },
        build => { build.receipt.release.attempt = "3"; },
        build => { build.smoke.firstLaunch.verifiedBeforeTestWrites = false; },
        build => { build.smoke.restart.cacheRestored = false; },
        build => { build.smoke.restart.statePreserved = false; },
        build => { build.smoke.apkReceipt = { ...build.receipt, sourceCommit: "c".repeat(40) }; },
        build => writeFile(join(build.directory, "standalone/ProtonnCord.apk"), Buffer.concat([build.data, Buffer.from("changed")])),
    ];
    for (const mutate of mutations) {
        const build = await fixture(t);
        await mutate(build);
        await build.save();
        await assert.rejects(publishAndroidInstaller(build));
        assert.deepEqual(build.calls, []);
    }
});
