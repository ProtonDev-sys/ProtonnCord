/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createPackage } from "@electron/asar";
import assert from "node:assert/strict";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    applyPendingHttpUpdate,
    type AtomicFileOperations,
    type HttpFetcher,
    inspectHttpUpdates,
    type PendingHttpUpdate,
    replaceAsarAtomically,
    requestBytes,
    requestJson,
    validateAsar,
} from "../src/main/updater/httpOperations";

const CURRENT_HASH = "a".repeat(40);
const RELEASE_HASH = "b".repeat(40);
const COMMIT_HASH = "c".repeat(40);
const ASAR_FILE = "desktop.asar";
const DOWNLOAD_URL = "https://github.com/ProtonDev-sys/ProtonnCord/releases/download/test/desktop.asar";

function release(hash: string, withAsset = true): unknown {
    return {
        assets: withAsset ? [{ browser_download_url: DOWNLOAD_URL, name: ASAR_FILE }] : [],
        name: `Protonn Cord ${hash}`,
    };
}

async function createValidAsar(root: string): Promise<Buffer> {
    const source = join(root, "source");
    const archive = join(root, "valid.asar");
    await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ main: "main.js", name: "updater-test" }));
    await writeFile(join(source, "main.js"), "module.exports = true;\n");
    await createPackage(source, archive);
    return readFile(archive);
}

function fileOperations(): AtomicFileOperations {
    return {
        remove(path) {
            rmSync(path, { force: true });
        },
        rename: renameSync,
        write(path, data) {
            writeFileSync(path, data, { flag: "wx", flush: true });
        },
    };
}

async function main(): Promise<void> {
    const currentRequests: string[] = [];
    const current = await inspectHttpUpdates(async endpoint => {
        currentRequests.push(endpoint);
        return release(CURRENT_HASH, false);
    }, CURRENT_HASH, ASAR_FILE);
    assert.deepEqual(current, { changes: [], pending: null });
    assert.deepEqual(currentRequests, ["/releases/latest"]);

    const outdatedRequests: string[] = [];
    const outdated = await inspectHttpUpdates(async endpoint => {
        outdatedRequests.push(endpoint);
        if (endpoint === "/releases/latest") return release(RELEASE_HASH);
        return {
            commits: [{
                author: { login: "ProtonDev-sys" },
                commit: { message: "Exact release commit\nbody" },
                sha: COMMIT_HASH,
            }],
        };
    }, CURRENT_HASH, ASAR_FILE);
    assert.deepEqual(outdatedRequests, [
        "/releases/latest",
        `/compare/${CURRENT_HASH}...${RELEASE_HASH}`,
    ]);
    assert.ok(outdatedRequests.every(endpoint => !endpoint.includes("HEAD")));
    assert.deepEqual(outdated, {
        changes: [{ author: "ProtonDev-sys", hash: COMMIT_HASH, message: "Exact release commit" }],
        pending: { hash: RELEASE_HASH, url: DOWNLOAD_URL },
    });

    await assert.rejects(
        inspectHttpUpdates(async () => release("not-a-commit"), CURRENT_HASH, ASAR_FILE),
        /does not identify its source commit/iu,
    );
    await assert.rejects(
        inspectHttpUpdates(async () => release(RELEASE_HASH, false), CURRENT_HASH, ASAR_FILE),
        /missing desktop\.asar/iu,
    );

    const bytes = Buffer.from("bounded response");
    const fetched = await requestBytes(
        async () => new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength) } }),
        "https://example.invalid/data",
        {},
        1_000,
        bytes.byteLength,
    );
    assert.deepEqual(fetched, bytes);

    let earlyResponseCancelled = false;
    await assert.rejects(
        requestBytes(
            async () => new Response(new ReadableStream<Uint8Array>({
                cancel() { earlyResponseCancelled = true; },
            }), { headers: { "Content-Length": "100" } }),
            "https://example.invalid/oversize",
            {},
            1_000,
            99,
        ),
        /exceeded the 99 byte limit/iu,
    );
    assert.equal(earlyResponseCancelled, true, "an early response rejection cancels its unread body");

    const streamingOversize: HttpFetcher = async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(60));
            controller.enqueue(new Uint8Array(60));
            controller.close();
        },
    }));
    await assert.rejects(
        requestBytes(streamingOversize, "https://example.invalid/stream", {}, 1_000, 100),
        /exceeded the 100 byte limit/iu,
    );

    const timeoutFetcher: HttpFetcher = (_url, init) => new Promise((_resolve, reject) => {
        const signal = init.signal;
        assert.ok(signal);
        const rejectOnAbort = () => reject(signal.reason);
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    await assert.rejects(
        requestBytes(timeoutFetcher, "https://example.invalid/timeout", {}, 1, 100),
        /timed out/iu,
    );

    await assert.rejects(
        requestJson(
            async () => new Response("not json"),
            "https://example.invalid/json",
            {},
            1_000,
            100,
        ),
        /invalid JSON/iu,
    );

    const root = await mkdtemp(join(tmpdir(), "protonn-cord-http-updater-"));
    try {
        const validAsar = await createValidAsar(root);
        validateAsar(validAsar);

        const corruptedAsar = Buffer.from(validAsar);
        corruptedAsar[corruptedAsar.byteLength - 1] ^= 0xff;
        assert.throws(() => validateAsar(corruptedAsar), /integrity check/iu);
        assert.throws(() => validateAsar(Buffer.from("not an asar")), /invalid header/iu);

        const target = join(root, "active.asar");
        const temporary = join(root, "active.asar.test.tmp");
        const original = Buffer.from("active archive remains intact");
        await writeFile(target, original);

        const writeFailure: AtomicFileOperations = {
            ...fileOperations(),
            write(path, data) {
                writeFileSync(path, data.subarray(0, 32), { flag: "wx", flush: true });
                throw new Error("simulated write failure");
            },
        };
        assert.throws(
            () => replaceAsarAtomically(target, temporary, validAsar, writeFailure),
            /simulated write failure/iu,
        );
        assert.deepEqual(await readFile(target), original);
        assert.equal(existsSync(temporary), false);

        const cleanupFailure: AtomicFileOperations = {
            ...fileOperations(),
            write() {
                throw new Error("primary write failure");
            },
            remove() {
                throw new Error("secondary cleanup failure");
            },
        };
        assert.throws(
            () => replaceAsarAtomically(target, temporary, validAsar, cleanupFailure),
            /primary write failure/iu,
            "temporary-file cleanup cannot hide the original install failure",
        );

        const renameFailure: AtomicFileOperations = {
            ...fileOperations(),
            rename() {
                throw new Error("simulated rename failure");
            },
        };
        assert.throws(
            () => replaceAsarAtomically(target, temporary, validAsar, renameFailure),
            /simulated rename failure/iu,
        );
        assert.deepEqual(await readFile(target), original);
        assert.equal(existsSync(temporary), false);

        replaceAsarAtomically(target, temporary, validAsar, fileOperations());
        assert.deepEqual(await readFile(target), validAsar);
        assert.equal(existsSync(temporary), false);

        const expectedPending: PendingHttpUpdate = { hash: RELEASE_HASH, url: DOWNLOAD_URL };
        let pending: PendingHttpUpdate | null = expectedPending;
        await assert.rejects(async () => {
            pending = await applyPendingHttpUpdate(pending, async () => validAsar, () => {
                throw new Error("simulated install failure");
            });
        }, /simulated install failure/iu);
        assert.equal(pending, expectedPending, "a failed install must remain pending for retry");

        pending = await applyPendingHttpUpdate(pending, async () => validAsar, () => undefined);
        assert.equal(pending, null);
    } finally {
        await rm(root, { force: true, recursive: true });
    }

    console.log("HTTP updater safety matrix passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
