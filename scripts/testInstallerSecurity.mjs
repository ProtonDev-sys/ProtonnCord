/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ensureCachedArtifact,
    EQUILOTL_ARTIFACTS,
    EQUILOTL_RELEASE,
    getArtifact,
    getInstallerArgs,
    prepareInstaller,
    runInstaller,
} from "./runInstaller.mjs";

function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function fixtureArtifact(bytes, overrides = {}) {
    return {
        assetId: 123456789,
        executable: false,
        filename: "installer-fixture.bin",
        sha256: digest(bytes),
        size: bytes.byteLength,
        ...overrides,
    };
}

function byteResponse(bytes, headers = {}) {
    return new Response(new Uint8Array(bytes), { headers });
}

async function assertNoTemporaryFiles(directory) {
    const names = await readdir(directory);
    assert.equal(names.some(name => name.endsWith(".tmp")), false, "installer temporary files must be cleaned");
}

function testReleasePin() {
    assert.deepEqual(EQUILOTL_RELEASE, {
        commit: "c6bfed9c941883fb0aa48cc1ab6031ed69334c2a",
        tag: "v2.2.6",
    });
    assert.equal(getArtifact("win32", "x64"), EQUILOTL_ARTIFACTS.win32);
    assert.equal(getArtifact("linux", "x64"), EQUILOTL_ARTIFACTS.linux);
    assert.equal(getArtifact("darwin", "x64"), EQUILOTL_ARTIFACTS.darwinX64);
    assert.equal(getArtifact("darwin", "arm64"), EQUILOTL_ARTIFACTS.darwinArm64);
    assert.throws(() => getArtifact("darwin", "riscv64"), /Unsupported macOS architecture/u);
    assert.throws(() => getArtifact("freebsd", "x64"), /Unsupported platform/u);

    const assetIds = new Set();
    for (const artifact of Object.values(EQUILOTL_ARTIFACTS)) {
        assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
        assert.ok(Number.isSafeInteger(artifact.assetId) && artifact.assetId > 0);
        assert.ok(Number.isSafeInteger(artifact.size) && artifact.size > 0);
        assetIds.add(artifact.assetId);
    }
    assert.equal(assetIds.size, Object.keys(EQUILOTL_ARTIFACTS).length);
    assert.deepEqual(getInstallerArgs(["node", "runInstaller.mjs", "--", "--repair"]), ["--repair"]);
    assert.deepEqual(getInstallerArgs(["node", "runInstaller.mjs"]), []);
}

async function testVerifiedCache(root) {
    const cacheDirectory = join(root, "verified-cache");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, reviewed);

    let fetchCalls = 0;
    const result = await ensureCachedArtifact(artifact, {
        cacheDirectory,
        fetcher: async () => {
            fetchCalls++;
            throw new Error("A verified cache must not perform a download.");
        },
    });
    assert.equal(result, outputPath);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(await readFile(outputPath), reviewed);
}

async function testVerifiedReplacement(root) {
    const cacheDirectory = join(root, "verified-replacement");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, Buffer.from("tampered"));

    let fetchCalls = 0;
    await ensureCachedArtifact(artifact, {
        cacheDirectory,
        fetcher: async (url, init) => {
            fetchCalls++;
            assert.equal(url, `https://api.github.com/repos/Equicord/Equilotl/releases/assets/${artifact.assetId}`);
            assert.doesNotMatch(url, /latest/iu);
            assert.equal(init.credentials, "omit");
            assert.equal(init.redirect, "follow");
            assert.ok(init.signal instanceof AbortSignal);
            assert.equal(new Headers(init.headers).get("Accept"), "application/octet-stream");
            return byteResponse(reviewed, { "Content-Length": String(reviewed.byteLength) });
        },
    });

    assert.equal(fetchCalls, 1);
    assert.deepEqual(await readFile(outputPath), reviewed);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testDigestFailurePreservesCache(root) {
    const cacheDirectory = join(root, "digest-failure");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);

    await assert.rejects(
        ensureCachedArtifact(artifact, {
            cacheDirectory,
            fetcher: async () => byteResponse(Buffer.from("attacker")),
        }),
        /failed SHA-256 verification/iu,
    );
    assert.deepEqual(await readFile(outputPath), previous, "an unverified download must not replace the cache");
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testStreamingLimitPreservesCache(root) {
    const cacheDirectory = join(root, "streaming-limit");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);
    let cancelled = false;

    await assert.rejects(
        ensureCachedArtifact(artifact, {
            cacheDirectory,
            fetcher: async () => new Response(new ReadableStream({
                cancel() {
                    cancelled = true;
                },
                pull(controller) {
                    controller.enqueue(new Uint8Array(reviewed.byteLength + 1));
                },
            })),
        }),
        /exceeded the 8 byte limit/iu,
    );
    assert.equal(cancelled, true, "an oversized response stream must be cancelled");
    assert.deepEqual(await readFile(outputPath), previous);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testTimeoutPreservesCache(root) {
    const cacheDirectory = join(root, "timeout");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);

    const fetcher = (_url, init) => new Promise((_resolve, reject) => {
        const rejectOnAbort = () => reject(init.signal.reason);
        if (init.signal.aborted) rejectOnAbort();
        else init.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    await assert.rejects(
        ensureCachedArtifact(artifact, { cacheDirectory, fetcher, timeoutMs: 5 }),
        /download timed out/iu,
    );
    assert.deepEqual(await readFile(outputPath), previous);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testBodyTimeoutPreservesCache(root) {
    const cacheDirectory = join(root, "body-timeout");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);
    let cancelled = false;

    await assert.rejects(
        ensureCachedArtifact(artifact, {
            cacheDirectory,
            fetcher: async () => new Response(new ReadableStream({
                cancel() {
                    cancelled = true;
                },
            })),
            timeoutMs: 5,
        }),
        /download timed out/iu,
    );
    assert.equal(cancelled, true, "a stalled response body must be cancelled at the deadline");
    assert.deepEqual(await readFile(outputPath), previous);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testActivationFailurePreservesCache(root) {
    const cacheDirectory = join(root, "activation-failure");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);

    await assert.rejects(
        ensureCachedArtifact(artifact, {
            cacheDirectory,
            fetcher: async () => byteResponse(reviewed),
            renameFile: async () => {
                throw new Error("simulated atomic rename failure");
            },
        }),
        /Could not activate the verified installer download/iu,
    );
    assert.deepEqual(await readFile(outputPath), previous);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testVerificationPrecedesExtraction(root) {
    const cacheDirectory = join(root, "darwin");
    await mkdir(cacheDirectory);
    const archivePath = join(cacheDirectory, "reviewed.zip");
    await writeFile(archivePath, "reviewed archive fixture");
    const order = [];

    const prepared = await prepareInstaller({
        arch: "arm64",
        cacheDirectory,
        clearQuarantine: async appPath => {
            order.push("quarantine");
            assert.equal(appPath.endsWith("Equilotl.app"), true);
        },
        ensureArtifact: async artifact => {
            order.push("verify");
            assert.equal(artifact, EQUILOTL_ARTIFACTS.darwinArm64);
            return archivePath;
        },
        extractArchive: async (_archive, destination) => {
            order.push("extract");
            const executableDirectory = join(destination, "Equilotl.app", "Contents", "MacOS");
            await mkdir(executableDirectory, { recursive: true });
            await writeFile(join(executableDirectory, "Equilotl"), "verified executable fixture");
        },
        platform: "darwin",
    });
    assert.deepEqual(order, ["verify", "extract", "quarantine"]);
    assert.equal(existsSync(prepared.binaryPath), true);
    await prepared.cleanup();
    assert.equal(existsSync(prepared.binaryPath), false, "the extracted app must be temporary");

    let extractionCalls = 0;
    await assert.rejects(
        prepareInstaller({
            arch: "x64",
            cacheDirectory,
            ensureArtifact: async () => {
                throw new Error("simulated verification failure");
            },
            extractArchive: async () => {
                extractionCalls++;
            },
            platform: "darwin",
        }),
        /simulated verification failure/iu,
    );
    assert.equal(extractionCalls, 0, "an unverified archive must never be extracted");
}

async function testExecutionGateAndCleanup() {
    let executeCalls = 0;
    await assert.rejects(
        runInstaller({
            execute: () => {
                executeCalls++;
            },
            prepare: async () => {
                throw new Error("simulated verification failure");
            },
        }),
        /simulated verification failure/iu,
    );
    assert.equal(executeCalls, 0, "verification failures must prevent execution");

    let cleaned = false;
    await assert.rejects(
        runInstaller({
            execute: () => {
                throw new Error("simulated installer failure");
            },
            prepare: async () => ({
                binaryPath: "verified-fixture",
                cleanup: async () => {
                    cleaned = true;
                },
            }),
        }),
        /simulated installer failure/iu,
    );
    assert.equal(cleaned, true, "temporary extraction must be cleaned after execution failures");
}

async function main() {
    testReleasePin();
    const root = await mkdtemp(join(tmpdir(), "protonn-cord-installer-security-"));
    try {
        await testVerifiedCache(root);
        await testVerifiedReplacement(root);
        await testDigestFailurePreservesCache(root);
        await testStreamingLimitPreservesCache(root);
        await testTimeoutPreservesCache(root);
        await testBodyTimeoutPreservesCache(root);
        await testActivationFailurePreservesCache(root);
        await testVerificationPrecedesExtraction(root);
        await testExecutionGateAndCleanup();
    } finally {
        await rm(root, { force: true, recursive: true });
    }
    console.log("Installer authenticity and recovery checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
