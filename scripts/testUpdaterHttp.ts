import { createPackage } from "@electron/asar";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

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

async function testWindowsBootstrap(root: string, validAsar: Buffer) {
    const bundle = await build({
        entryPoints: ["src/main/updater/asarBootstrap.ts"], bundle: true, write: false,
        platform: "node", format: "cjs", external: ["original-fs", "electron"],
    });
    const nativeFs = await import("node:fs");
    const nativeRequire = createRequire(import.meta.url);
    const target = join(root, "windows.asar");
    const pending = `${target}.pending`;
    const hostRoot = join(root, "Discord");
    await mkdir(join(hostRoot, "app-1.0.1"), { recursive: true });
    const temporary = () => `${target}.${process.pid}.${randomUUID()}.tmp`;
    let failure: string | undefined = "EPERM";
    let releaseOnWait = true;
    let waits = 0;
    let loads = 0;
    let incompatiblePatcher = false;
    const errors: unknown[] = [];
    function bootModule() {
        const app = new EventEmitter();
        const childProcess = Object.assign(new EventEmitter(), { platform: "win32", execPath: join(hostRoot, "app-1.0.1", "Discord.exe") });
        let tick: (() => void) | undefined;
        const fs = { ...nativeFs, renameSync(source: string, destination: string) {
            if (destination === target && failure)
                throw Object.assign(new Error("simulated archive lock"), { code: failure });
            renameSync(source, destination);
        } };
        const module = { exports: {} as typeof import("../src/main/updater/asarBootstrap") };
        runInNewContext(bundle.outputFiles[0].text, {
            module, exports: module.exports, Buffer, Error, Int32Array, SharedArrayBuffer, TextDecoder,
            process: childProcess, console: { error: (...args: unknown[]) => errors.push(args) },
            setInterval(callback: () => void) { tick = callback; return { unref() {} }; },
            clearInterval() { tick = undefined; },
            Atomics: { wait() { waits++; if (releaseOnWait) failure = undefined; } },
            require(name: string) {
                if (name === "original-fs") return fs;
                if (name === "electron") return { app };
                if (name === `${target}/patcher.js`) {
                    if (incompatiblePatcher) throw new Error("incompatible mod startup");
                    loads++; return {};
                }
                return nativeRequire(name);
            },
        });
        return { fs, app, tick: () => tick?.(), ...module.exports };
    }

    await writeFile(target, "working client");
    const first = bootModule();
    first.installAsarUpdateShim(target);
    const download = temporary();
    await writeFile(download, validAsar);
    first.fs.renameSync(download, target);
    assert.equal(await readFile(target, "utf8"), "working client", "the running archive must never be overwritten");
    assert.deepEqual(await readFile(pending), validAsar);
    assert.equal(existsSync(download), false);

    const invalid = temporary();
    await writeFile(invalid, "broken download");
    assert.throws(() => first.fs.renameSync(invalid, target), /invalid header/iu);
    assert.deepEqual(await readFile(pending), validAsar, "invalid updates cannot replace an already staged update");
    assert.throws(() => first.fs.renameSync(join(root, "unrelated.tmp"), target), /simulated archive lock/iu);
    failure = "EIO";
    assert.throws(() => first.fs.renameSync(download, target), /simulated archive lock/iu);
    failure = "EPERM";

    await writeFile(join(root, "source", "main.js"), "module.exports = 'another channel';\n");
    const nextArchive = join(root, "next.asar");
    await createPackage(join(root, "source"), nextArchive);
    const nextBytes = await readFile(nextArchive);
    const secondDownload = temporary();
    await writeFile(secondDownload, nextBytes);
    first.fs.renameSync(secondDownload, target);
    assert.deepEqual(await readFile(pending), nextBytes, "the last selected channel replaces the pending update");

    bootModule().load(target);
    assert.equal(waits, 1, "startup must wait for old renderer handles to close");
    assert.deepEqual(await readFile(target), nextBytes);
    assert.equal(existsSync(pending), false);
    assert.equal(loads, 1);
    assert.equal(errors.length, 0);

    failure = "EPERM";
    releaseOnWait = false;
    await writeFile(pending, validAsar);
    bootModule().load(target);
    assert.equal(waits, 50, "lock retries must be bounded");
    assert.deepEqual(await readFile(target), nextBytes);
    assert.deepEqual(await readFile(pending), validAsar, "a failed startup install remains available for retry");
    assert.equal(loads, 2, "an install failure must still load the working client");
    await writeFile(pending, "invalid staged archive");
    bootModule().load(target);
    assert.deepEqual(await readFile(target), nextBytes);
    assert.equal(errors.length, 2);

    // Host recovery is installed before the archived mod. It must survive a
    // broken mod and must not require private Discord updater APIs to work.
    await rm(pending);
    failure = undefined;
    incompatiblePatcher = true;
    const host = bootModule();
    assert.throws(() => host.load(target), /incompatible mod startup/iu);
    const dispose = host.installHostRecovery(target);
    assert.equal(host.app.listenerCount("will-quit"), 1, "recovery installation is idempotent");
    const nextHost = join(hostRoot, "app-1.0.2", "resources");
    await mkdir(nextHost, { recursive: true });
    host.tick();
    assert.equal(existsSync(join(nextHost, "_app.asar")), false, "an incomplete install remains untouched");
    await writeFile(join(nextHost, "app.asar"), "original Discord");
    host.tick();
    assert.equal(await readFile(join(nextHost, "_app.asar"), "utf8"), "original Discord");
    const expectedStub = `require(${JSON.stringify(`${target}.loader.cjs`)});`;
    assert.equal(await readFile(join(nextHost, "app.asar", "index.js"), "utf8"), expectedStub);
    await writeFile(join(nextHost, "app.asar", "index.js"), `require(${JSON.stringify(join(target, "patcher.js"))});`);
    host.app.emit("will-quit");
    assert.equal((await readFile(join(nextHost, "app.asar", "index.js"), "utf8")).trim(), expectedStub,
        "a raw-archive stub written by an older main build is upgraded before relaunch");
    dispose?.();
    assert.equal(host.app.listenerCount("will-quit"), 0);
}

async function testInstalledReleaseState(): Promise<void> {
    const handlers = new Map<IpcEvents, (...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; }>>();
    const requests: string[] = [];
    const installed: string[] = [];
    let failInstall = true;
    let nightlyReleaseHash = RELEASE_HASH;
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
        "@main/ipc": { ipcMain: { handle: (event: IpcEvents, handler: (...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; }>) => handlers.set(event, handler) } },
        "original-fs": {}, "~git-hash": { __esModule: true, default: CURRENT_HASH, buildChannel: "main" }, "~git-remote": { __esModule: true, default: "Fixture/Fixture" },
        "./common": { ASAR_FILE }, "./ipc": { createOperationQueue, serializeErrors },
        "./httpOperations": {
            applyPendingHttpUpdate, findHttpUpdate, inspectHttpUpdates,
            async requestJson(_fetch: unknown, url: string) {
                const endpoint = url.slice("https://api.github.com/repos/Fixture/Fixture".length);
                requests.push(endpoint);
                if (endpoint.startsWith("/compare/")) return { status: "behind", commits: [] };
                const branch = endpoint === "/releases/latest" ? "main" : "nightly";
                const data = archives[branch];
                return {
                    name: `Protonn Cord ${branch === "main" ? CURRENT_HASH : nightlyReleaseHash}`,
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
    const retryCheck = await invoke(IpcEvents.GET_UPDATES, "nightly");
    assert.ok(Array.isArray(retryCheck.value) && retryCheck.value.length > 0, "a failed replacement cannot advance the installed branch either");

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

    nightlyReleaseHash = CURRENT_HASH;
    assert.deepEqual((await invoke(IpcEvents.GET_UPDATES, "nightly")).value, [], "an older release on the installed channel is not an automatic update");
    assert.equal((await invoke(IpcEvents.UPDATE, "nightly")).value, false, "a direct update request cannot queue a same-channel downgrade");
    assert.equal((await invoke(IpcEvents.BUILD, "nightly")).value, false, "a blocked downgrade cannot download or install an archive");
    assert.equal((await installedHash()).builtHead, RELEASE_HASH);
    assert.deepEqual(installed, ["nightly archive"]);
    nightlyReleaseHash = RELEASE_HASH;

    assert.deepEqual((await invoke(IpcEvents.GET_UPDATES, "nightly")).value, []);
    assert.equal((await invoke(IpcEvents.UPDATE, "nightly")).value, false, "an installed release is not repeatedly downloaded before restart");
    assert.equal((await invoke(IpcEvents.UPDATE, "main")).value, true);
    assert.equal((await invoke(IpcEvents.BUILD, "main")).value, true);
    assert.equal((await installedHash()).builtHead, CURRENT_HASH);
    assert.deepEqual(installed, ["nightly archive", "main archive"]);
    assert.equal((await invoke(IpcEvents.UPDATE, "main", true)).value, true, "forced repair can reinstall the current release");
    assert.equal((await invoke(IpcEvents.BUILD, "main")).value, true);
    assert.deepEqual(installed, ["nightly archive", "main archive", "main archive"]);

    nightlyReleaseHash = CURRENT_HASH;
    const sameHashSwitch = await invoke(IpcEvents.GET_UPDATES, "nightly");
    assert.ok(Array.isArray(sameHashSwitch.value) && sameHashSwitch.value.length > 0, "channel-specific bundles can differ at the same commit");
    assert.equal((await invoke(IpcEvents.UPDATE, "nightly")).value, true);
    assert.equal((await invoke(IpcEvents.BUILD, "nightly")).value, true);
    assert.equal((await installedHash()).builtHead, CURRENT_HASH);
    const switchBack = await invoke(IpcEvents.GET_UPDATES, "main");
    assert.ok(Array.isArray(switchBack.value) && switchBack.value.length > 0, "successful replacement advances the channel even when the source hash stays the same");
    assert.deepEqual(installed, ["nightly archive", "main archive", "main archive", "nightly archive"]);
}

async function testSameChannelDowngradeProtection(): Promise<void> {
    const requests: string[] = [];
    const behind = async (endpoint: string) => {
        requests.push(endpoint);
        if (endpoint === "/releases/tags/nightly") return release(RELEASE_HASH);
        assert.equal(endpoint, `/compare/${CURRENT_HASH}...${RELEASE_HASH}`);
        return { status: "behind", commits: [] };
    };
    assert.deepEqual(await inspectHttpUpdates(behind, CURRENT_HASH, ASAR_FILE, "nightly", "nightly"),
        { changes: [], pending: null }, "a locally newer build does not offer its channel's older release");
    assert.equal(await findHttpUpdate(behind, CURRENT_HASH, ASAR_FILE, "nightly", false, "nightly"), null,
        "direct acquisition applies the same rollback check");
    assert.deepEqual(requests, [
        "/releases/tags/nightly", `/compare/${CURRENT_HASH}...${RELEASE_HASH}`,
        "/releases/tags/nightly", `/compare/${CURRENT_HASH}...${RELEASE_HASH}`,
    ]);

    const expectedPending = { hash: RELEASE_HASH, sha256: RELEASE_SHA256, size: RELEASE_SIZE, url: DOWNLOAD_URL };
    const switched = await inspectHttpUpdates(behind, CURRENT_HASH, ASAR_FILE, "nightly", "main");
    assert.deepEqual(switched, {
        changes: [{ author: "ProtonnCord", hash: RELEASE_HASH, message: "Switch update branch to nightly" }],
        pending: expectedPending,
    }, "an explicit channel switch can select an ancestor release");
    assert.deepEqual(await findHttpUpdate(behind, CURRENT_HASH, ASAR_FILE, "nightly", false, "main"), expectedPending);
    assert.deepEqual(await findHttpUpdate(behind, CURRENT_HASH, ASAR_FILE, "nightly"), expectedPending,
        "unknown build channels retain the previous branch-switch behavior");

    const sameHash = async (endpoint: string) => endpoint.startsWith("/compare/")
        ? { status: "identical", commits: [] } : release(CURRENT_HASH);
    assert.deepEqual(await inspectHttpUpdates(sameHash, CURRENT_HASH, ASAR_FILE, "nightly", "nightly"),
        { changes: [], pending: null }, "the installed channel at its published hash remains current");
    assert.deepEqual(await inspectHttpUpdates(sameHash, CURRENT_HASH, ASAR_FILE, "nightly", "main"), {
        changes: [{ author: "ProtonnCord", hash: CURRENT_HASH, message: "Switch update branch to nightly" }],
        pending: { ...expectedPending, hash: CURRENT_HASH },
    }, "switching channels installs the selected bundle even at an identical source commit");
    assert.deepEqual(await findHttpUpdate(sameHash, CURRENT_HASH, ASAR_FILE, "nightly", false, "main"),
        { ...expectedPending, hash: CURRENT_HASH });

    requests.length = 0;
    assert.deepEqual(await findHttpUpdate(behind, CURRENT_HASH, ASAR_FILE, "nightly", true, "nightly"), expectedPending,
        "forced repair can intentionally restore the published channel release");
    assert.deepEqual(requests, ["/releases/tags/nightly"], "repair does not require a comparison");

    const ahead = async (endpoint: string) => endpoint === "/releases/tags/nightly" ? release(RELEASE_HASH) : {
        status: "ahead",
        commits: [{ sha: RELEASE_HASH, commit: { message: "New nightly release" } }],
    };
    const newer = await inspectHttpUpdates(ahead, CURRENT_HASH, ASAR_FILE, "nightly", "nightly");
    assert.equal(newer.changes[0].message, "New nightly release");
    assert.deepEqual(newer.pending, expectedPending);
    assert.deepEqual(await findHttpUpdate(ahead, CURRENT_HASH, ASAR_FILE, "nightly", false, "nightly"), expectedPending);

    for (const comparison of [
        { status: "behind" },
        { status: "behind", commits: "invalid" },
        { status: "behind", commits: [{ sha: "invalid", commit: { message: "Malformed" } }] },
    ]) {
        const malformed = async (endpoint: string) => endpoint === "/releases/tags/nightly" ? release(RELEASE_HASH) : comparison;
        await assert.rejects(inspectHttpUpdates(malformed, CURRENT_HASH, ASAR_FILE, "nightly", "nightly"), /invalid Protonn Cord changelog/iu);
        await assert.rejects(findHttpUpdate(malformed, CURRENT_HASH, ASAR_FILE, "nightly", false, "nightly"), /invalid Protonn Cord changelog/iu);
    }
}

async function main(): Promise<void> {
    await testInstalledReleaseState();
    await testSameChannelDowngradeProtection();
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
    }, CURRENT_HASH, ASAR_FILE, "nightly", "nightly");
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

        await testWindowsBootstrap(root, validAsar);

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
