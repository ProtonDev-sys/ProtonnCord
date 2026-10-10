/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createPackage } from "@electron/asar";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
    applyPendingHttpUpdate,
    type AtomicFileOperations,
    findHttpUpdate,
    type HttpFetcher,
    HttpRequestError,
    inspectHttpUpdates,
    type PendingHttpUpdate,
    replaceAsarAtomically,
    requestBytes,
    requestJson,
    validateAsar,
} from "../src/main/updater/httpOperations";
import { createOperationQueue, serializeErrors } from "../src/main/updater/ipc";
import { IpcEvents } from "../src/shared/IpcEvents";
import { parseUpdaterBranch } from "../src/shared/Updater";
import { loadTestModule } from "./utils/loadTestModule";

const CURRENT_HASH = "a".repeat(40);
const RELEASE_HASH = "b".repeat(40);
const COMMIT_HASH = "c".repeat(40);
const RELEASE_SHA256 = "d".repeat(64);
const RELEASE_SIZE = 128;
const ASAR_FILE = "desktop.asar";
const DOWNLOAD_URL = "https://github.com/ProtonDev-sys/ProtonnCord/releases/download/test/desktop.asar";

function release(hash: string, withAsset = true) {
    return {
        assets: withAsset ? [{ browser_download_url: DOWNLOAD_URL, name: ASAR_FILE,
            digest: `sha256:${RELEASE_SHA256}`, size: RELEASE_SIZE, state: "uploaded" }] : [],
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

async function testInstalledReleaseState(): Promise<void> {
    const handlers = new Map<IpcEvents, (...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; }>>();
    const requests: string[] = [];
    const installed: string[] = [];
    let failInstall = true;
    let finishDownload: (() => void) | undefined;
    let signalDownload: (() => void) | undefined;
    let downloadGate: Promise<void> | undefined;
    const archives = { main: Buffer.from("main archive"), nightly: Buffer.from("nightly archive") };
    loadTestModule("src/main/updater/http.ts", {
        "node:crypto": { randomUUID: () => "fixture" },
        "@shared/IpcEvents": { IpcEvents: {
            GET_REPO: IpcEvents.GET_REPO, GET_UPDATES: IpcEvents.GET_UPDATES, UPDATE: IpcEvents.UPDATE,
            BUILD: IpcEvents.BUILD, GET_UPDATER_DIAGNOSTICS: IpcEvents.GET_UPDATER_DIAGNOSTICS,
        } },
        "@shared/Updater": { parseUpdaterBranch },
        "@shared/vencordUserAgent": { VENCORD_USER_AGENT: "Fixture" },
        electron: { ipcMain: { handle: (event: IpcEvents, handler: (...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; }>) => handlers.set(event, handler) } },
        "original-fs": {}, "~git-hash": { __esModule: true, default: CURRENT_HASH }, "~git-remote": { __esModule: true, default: "Fixture/Fixture" },
        "./common": { ASAR_FILE }, "./ipc": { createOperationQueue, serializeErrors },
        "./httpOperations": {
            applyPendingHttpUpdate, findHttpUpdate, inspectHttpUpdates,
            async requestJson(_fetch: unknown, url: string) {
                const endpoint = url.slice("https://api.github.com/repos/Fixture/Fixture".length);
                requests.push(endpoint);
                if (endpoint.startsWith("/compare/")) return { commits: [] };
                const branch = endpoint === "/releases/latest" ? "main" : "nightly";
                const data = archives[branch];
                return {
                    name: `Protonn Cord ${branch === "main" ? CURRENT_HASH : RELEASE_HASH}`,
                    assets: [{ name: ASAR_FILE, browser_download_url: DOWNLOAD_URL.replace("/test/", `/${branch}/`),
                        digest: `sha256:${createHash("sha256").update(data).digest("hex")}`, size: data.length, state: "uploaded" }],
                };
            },
            async requestBytes(_fetch: unknown, url: string) {
                signalDownload?.();
                await downloadGate;
                return archives[url.includes("/nightly/") ? "nightly" : "main"];
            },
            replaceAsarAtomically(_target: string, _temporary: string, data: Buffer) {
                if (failInstall) throw new Error("Fixture install failure");
                installed.push(data.toString());
            },
        },
    }, { __dirname: "fixture.asar", process: { pid: 1 }, fetch: () => assert.fail("No live network") });
    const invoke = (event: IpcEvents, ...args: unknown[]) => handlers.get(event)!({}, ...args);
    const installedHash = async () => (await invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS, "main")).value as { builtHead: string; };

    assert.deepEqual(await invoke(IpcEvents.UPDATE, "nightly"), { ok: true, value: true });
    assert.equal((await invoke(IpcEvents.BUILD, "nightly")).ok, false);
    assert.equal((await installedHash()).builtHead, CURRENT_HASH, "a failed replacement cannot advance the installed hash");

    failInstall = false;
    downloadGate = new Promise(resolve => { finishDownload = resolve; });
    const downloadStarted = new Promise<void>(resolve => { signalDownload = resolve; });
    const installing = invoke(IpcEvents.BUILD, "nightly");
    await downloadStarted;
    const requestCount = requests.length;
    const mainCheck = invoke(IpcEvents.GET_UPDATES, "main");
    assert.equal(requests.length, requestCount, "checks wait for an in-flight archive replacement");
    finishDownload!();
    assert.equal((await installing).value, true);
    const check = await mainCheck;
    assert.ok(Array.isArray(check.value) && check.value.length > 0, "returning to the running build still restores the archive on disk");
    assert.ok(requests.includes(`/compare/${RELEASE_HASH}...${CURRENT_HASH}`));
    assert.equal((await installedHash()).builtHead, RELEASE_HASH);

    assert.deepEqual((await invoke(IpcEvents.GET_UPDATES, "nightly")).value, []);
    assert.equal((await invoke(IpcEvents.UPDATE, "nightly")).value, false, "an installed release is not repeatedly downloaded before restart");
    assert.equal((await invoke(IpcEvents.UPDATE, "main")).value, true);
    assert.equal((await invoke(IpcEvents.BUILD, "main")).value, true);
    assert.equal((await installedHash()).builtHead, CURRENT_HASH);
    assert.deepEqual(installed, ["nightly archive", "main archive"]);
}

async function main(): Promise<void> {
    await testInstalledReleaseState();
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
        pending: { hash: RELEASE_HASH, sha256: RELEASE_SHA256, size: RELEASE_SIZE, url: DOWNLOAD_URL },
    });

    const rewritten = await inspectHttpUpdates(async endpoint => {
        if (endpoint === "/releases/tags/nightly") return release(RELEASE_HASH);
        assert.equal(endpoint, `/compare/${CURRENT_HASH}...${RELEASE_HASH}`);
        return requestJson(async () => new Response("missing comparison", { status: 404, statusText: "Not Found" }),
            `https://api.github.com/repos/ProtonDev-sys/ProtonnCord${endpoint}`, {}, 1_000, 100);
    }, CURRENT_HASH, ASAR_FILE, "nightly");
    assert.deepEqual(rewritten, {
        changes: [{ author: "ProtonnCord", hash: RELEASE_HASH, message: "Update to the latest nightly release (previous build cannot be compared)" }],
        pending: { hash: RELEASE_HASH, sha256: RELEASE_SHA256, size: RELEASE_SIZE, url: DOWNLOAD_URL },
    });

    for (const failure of [new HttpRequestError("comparison", 403, "Forbidden"), new HttpRequestError("comparison", 429, "Too Many Requests"),
        new HttpRequestError("comparison", 500, "Internal Server Error"), new Error("network failure"), new Error("GET comparison: 404 Not Found")]) {
        await assert.rejects(inspectHttpUpdates(async endpoint => {
            if (endpoint === "/releases/latest") return release(RELEASE_HASH);
            throw failure;
        }, CURRENT_HASH, ASAR_FILE), error => error === failure, "only a structured comparison 404 allows recovery");
    }
    const missingRelease = new HttpRequestError("release", 404, "Not Found");
    await assert.rejects(inspectHttpUpdates(async () => { throw missingRelease; }, CURRENT_HASH, ASAR_FILE), error => error === missingRelease);
    await assert.rejects(inspectHttpUpdates(async endpoint => endpoint === "/releases/latest" ? release(RELEASE_HASH) : {}, CURRENT_HASH, ASAR_FILE), /invalid Protonn Cord changelog/iu);

    await assert.rejects(
        inspectHttpUpdates(async () => release("not-a-commit"), CURRENT_HASH, ASAR_FILE),
        /does not identify its source commit/iu,
    );
    await assert.rejects(
        inspectHttpUpdates(async () => release(RELEASE_HASH, false), CURRENT_HASH, ASAR_FILE),
        /missing desktop\.asar/iu,
    );

    for (const browser_download_url of [
        DOWNLOAD_URL.replace("https:", "http:"),
        DOWNLOAD_URL.replace("github.com", "github.com.example.invalid"),
        DOWNLOAD_URL.replace("github.com", "github.com:8443"),
        DOWNLOAD_URL.replace("github.com", "user:password@github.com"),
        `${DOWNLOAD_URL}?asset=other`,
        `${DOWNLOAD_URL}#asset`,
        DOWNLOAD_URL.replace("desktop.asar", "equibop.asar"),
        "https://github.com/ProtonDev-sys/ProtonnCord",
    ]) {
        await assert.rejects(findHttpUpdate(async () => ({
            ...release(RELEASE_HASH), assets: [{ ...release(RELEASE_HASH).assets[0], browser_download_url }],
        }), CURRENT_HASH, ASAR_FILE), /invalid desktop\.asar download URL/iu);
    }
    for (const invalidMetadata of [
        { digest: undefined }, { digest: null }, { digest: "sha1:" + "d".repeat(40) }, { digest: "sha256:invalid" },
        { size: undefined }, { size: 0 }, { size: -1 }, { size: 1.5 }, { size: Number.MAX_SAFE_INTEGER + 1 },
        { state: "starter" }, { state: undefined },
    ]) {
        await assert.rejects(findHttpUpdate(async () => ({
            ...release(RELEASE_HASH), assets: [{ ...release(RELEASE_HASH).assets[0], ...invalidMetadata }],
        }), CURRENT_HASH, ASAR_FILE), /integrity metadata/iu);
    }

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

    const fragmented = new ReadableStream<Uint8Array>({ start(controller) {
        for (const fragment of [new Uint8Array([0, 1, 2, 0]).subarray(1, 3), new Uint8Array([3])]) controller.enqueue(fragment);
        controller.close();
    } });
    assert.deepEqual(await requestBytes(async () => new Response(fragmented), "https://example.invalid/fragments", {}, 1_000, 3), Buffer.from([1, 2, 3]));

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
    const timeoutFixture = setTimeout(() => assert.fail("The request timeout did not settle"), 1_000);
    try {
        await assert.rejects(
            requestBytes(timeoutFetcher, "https://example.invalid/timeout", {}, 1, 100),
            /timed out/iu,
        );
    } finally {
        clearTimeout(timeoutFixture);
    }

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

        const expectedPending: PendingHttpUpdate = {
            hash: RELEASE_HASH, sha256: createHash("sha256").update(validAsar).digest("hex"), size: validAsar.length, url: DOWNLOAD_URL,
        };
        let pending: PendingHttpUpdate | null = expectedPending;
        await assert.rejects(async () => {
            pending = await applyPendingHttpUpdate(pending, async () => validAsar, () => {
                throw new Error("simulated install failure");
            });
        }, /simulated install failure/iu);
        assert.equal(pending, expectedPending, "a failed install must remain pending for retry");

        for (const wrongArchive of [validAsar.subarray(0, -1), Buffer.concat([validAsar, Buffer.from([0])]), corruptedAsar]) {
            await assert.rejects(async () => {
                pending = await applyPendingHttpUpdate(pending, async () => wrongArchive, () => assert.fail("Mismatched releases must never reach installation"));
            }, /does not match the selected release/iu);
            assert.equal(pending, expectedPending, "failed digest or size checks retain the pending release");
        }

        const advancedSource = join(root, "source", "main.js");
        await writeFile(advancedSource, "module.exports = null;\n");
        const advancedPath = join(root, "advanced.asar");
        await createPackage(dirname(advancedSource), advancedPath);
        const advancedAsar = await readFile(advancedPath);
        validateAsar(advancedAsar);
        assert.equal(advancedAsar.byteLength, validAsar.byteLength, "the next valid release has the same size as the selected release");
        await assert.rejects(applyPendingHttpUpdate(pending, async () => advancedAsar,
            () => assert.fail("A moved channel URL must not install another release")), /does not match the selected release/iu);

        pending = await applyPendingHttpUpdate(pending, async () => validAsar, () => undefined);
        assert.equal(pending, null);
    } finally {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(basename(root).startsWith("protonn-cord-http-updater-"));
        await rm(root, { force: true, recursive: true });
    }

    console.log("HTTP updater safety matrix passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
