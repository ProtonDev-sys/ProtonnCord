import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { buildAndInstall, recoverBuildInstallations } from "../src/main/updater/buildOperations";

function write(path: string, data: string) {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, data);
}

function writeBuild(output: string, contents: string) {
    for (const host of ["desktop", "equibop"]) {
        const main = host === "desktop" ? "patcher.js" : "main.js";
        for (const name of [main, "preload.js", "renderer.js", "renderer.css", "renderer.js.map"])
            write(join(output, host, name), `${contents}:${host}/${name}`);
        write(join(output, host, "package.json"), JSON.stringify({ name: "protonn-cord", main }));
        write(join(output, `${host}.asar`), `${contents}:${host}.asar`);
    }
}

function snapshot(directory: string): Record<string, string> {
    const result: Record<string, string> = {};
    function visit(path: string) {
        for (const entry of fs.readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const item = join(path, entry.name);
            if (entry.isDirectory()) {
                result[`${relative(directory, item)}${sep}`] = "directory";
                visit(item);
            } else {
                result[relative(directory, item)] = entry.isSymbolicLink() ? `symlink:${fs.readlinkSync(item)}` : fs.readFileSync(item, "utf8");
            }
        }
    }
    visit(directory);
    return result;
}

function fixture() {
    const root = fs.mkdtempSync(join(tmpdir(), "protonn-build-transaction-"));
    const dist = join(root, "dist with spaces");
    writeBuild(dist, "old");
    write(join(dist, "browser", "browser.js"), "unrelated browser build");
    write(join(dist, "desktop", "monacoWin-OLD.html"), "still needed by the running client");
    write(join(dist, "desktop", "custom-native.js"), "unrelated native file");
    return { root, dist, before: snapshot(dist) };
}

function verify() { return Promise.resolve(); }
function build(output: string) { writeBuild(output, "new"); return Promise.resolve(); }
const busy = () => Object.assign(new Error("fixture Windows file is busy"), { code: "EBUSY" });

test("successful source build publishes staged outputs and preserves unrelated and previous hashed files", async () => {
    const { root, dist } = fixture();
    try {
        const initialMode = fs.statSync(join(dist, "desktop")).mode;
        let verified = false;
        await buildAndInstall({
            distDirectory: dist,
            files: fs,
            async build(output) {
                assert.ok(output.startsWith(`${dist}${sep}.protonn-build-`));
                assert.notEqual(output, dist);
                await build(output);
                write(join(output, "desktop", "assets", "monacoWin-NEW.html"), "new asset");
                write(join(output, "desktop", "assets", "preview image-É.html"), "named userplugin asset");
                assert.equal(fs.readFileSync(join(dist, "desktop", "renderer.js"), "utf8"), "old:desktop/renderer.js");
            },
            async verifySource() {
                verified = true;
                assert.equal(fs.readFileSync(join(dist, "desktop.asar"), "utf8"), "old:desktop.asar");
            }
        });
        assert.ok(verified);
        assert.equal(fs.readFileSync(join(dist, "desktop", "renderer.js"), "utf8"), "new:desktop/renderer.js");
        assert.equal(fs.readFileSync(join(dist, "equibop.asar"), "utf8"), "new:equibop.asar");
        assert.equal(fs.readFileSync(join(dist, "browser", "browser.js"), "utf8"), "unrelated browser build");
        assert.equal(fs.readFileSync(join(dist, "desktop", "monacoWin-OLD.html"), "utf8"), "still needed by the running client");
        assert.equal(fs.readFileSync(join(dist, "desktop", "custom-native.js"), "utf8"), "unrelated native file");
        assert.equal(fs.readFileSync(join(dist, "desktop", "assets", "monacoWin-NEW.html"), "utf8"), "new asset");
        assert.equal(fs.readFileSync(join(dist, "desktop", "assets", "preview image-É.html"), "utf8"), "named userplugin asset");
        assert.equal(fs.statSync(join(dist, "desktop")).mode, initialMode);
        assert.ok(fs.readdirSync(dist).every(name => !name.startsWith(".protonn-build-")));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("compile failures and source changes cannot overwrite the running source build", async () => {
    for (const changedSource of [false, true]) {
        const { root, dist, before } = fixture();
        try {
            await assert.rejects(buildAndInstall({
                distDirectory: dist,
                files: fs,
                async build(output) {
                    await build(output);
                    if (!changedSource) throw new Error("fixture compile failed after producing partial outputs");
                },
                async verifySource() { throw new Error("fixture checkout changed during compilation"); }
            }), changedSource ? /checkout changed/u : /compile failed/u);
            assert.deepEqual(snapshot(dist), before);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("missing, empty, malformed and cross-platform conflicting outputs fail before installation", async () => {
    const corruptions = [
        (output: string) => fs.rmSync(join(output, "desktop", "preload.js")),
        (output: string) => fs.writeFileSync(join(output, "desktop.asar"), ""),
        (output: string) => fs.writeFileSync(join(output, "desktop", "package.json"), '{"main":"missing.js"}'),
        (output: string) => write(join(output, "unexpected.txt"), "wrong root output"),
        (output: string) => write(join(output, "desktop", "CON.js"), "unsafe Windows filename"),
        (output: string) => {
            write(join(output, "desktop", "renderer.JS"), "case collision");
            if (!fs.readdirSync(join(output, "desktop")).includes("renderer.JS"))
                throw new Error("The fixture filesystem cannot create case-distinct filenames");
        },
    ];
    for (const corrupt of corruptions) {
        const { root, dist, before } = fixture();
        try {
            let verified = false;
            await assert.rejects(buildAndInstall({
                distDirectory: dist, files: fs,
                async build(output) { await build(output); corrupt(output); },
                async verifySource() { verified = true; }
            }));
            assert.equal(verified, false, "invalid outputs must fail before source verification and publication");
            assert.deepEqual(snapshot(dist), before);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("backup copy failures leave every installed output intact and remove staging", async () => {
    const { root, dist, before } = fixture();
    try {
        let copied = 0;
        await assert.rejects(buildAndInstall({
            distDirectory: dist, build, verifySource: verify,
            files: {
                ...fs,
                copyFileSync(...args) {
                    if (++copied === 3) throw Object.assign(new Error("fixture disk full while backing up"), { code: "ENOSPC" });
                    return fs.copyFileSync(...args);
                }
            }
        }), /disk full/u);
        assert.equal(copied, 3);
        assert.deepEqual(snapshot(dist), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("case-conflicting staged directories fail even when their files have different names", { skip: process.platform === "win32" }, async () => {
    const { root, dist, before } = fixture();
    try {
        await assert.rejects(buildAndInstall({
            distDirectory: dist, files: fs, verifySource: verify,
            async build(output) {
                await build(output);
                write(join(output, "desktop", "ASSETS", "first.js"), "first");
                write(join(output, "desktop", "assets", "second.js"), "second");
            }
        }), /conflict on Windows/u);
        assert.deepEqual(snapshot(dist), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a replaced staging root cannot redirect build installation", async () => {
    const { root, dist, before } = fixture();
    try {
        const redirected = join(root, "redirected-build");
        writeBuild(redirected, "redirected");
        const outsideBefore = snapshot(redirected);
        await assert.rejects(buildAndInstall({
            distDirectory: dist, files: fs, verifySource: verify,
            async build(output) {
                fs.rmdirSync(output);
                fs.symlinkSync(redirected, output, process.platform === "win32" ? "junction" : "dir");
            }
        }), /regular directory/u);
        assert.deepEqual(snapshot(dist), before);
        assert.deepEqual(snapshot(redirected), outsideBefore);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Windows busy-file failures restore earlier replacements and remove newly generated files", async () => {
    for (const failedInstall of [1, 5, 15]) {
        const { root, dist, before } = fixture();
        try {
            let installs = 0;
            await assert.rejects(buildAndInstall({
                distDirectory: dist, verifySource: verify,
                async build(output) { await build(output); write(join(output, "desktop", "assets", "NEW.html"), "new asset"); },
                files: {
                    ...fs,
                    renameSync(source, destination) {
                        if (String(source).includes(`${sep}output${sep}`) && ++installs === failedInstall) throw busy();
                        return fs.renameSync(source, destination);
                    }
                }
            }), /file is busy/u);
            assert.equal(installs, failedInstall);
            assert.deepEqual(snapshot(dist), before);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("failed rollback preserves identifiable originals and gives an actionable recovery path", async () => {
    const { root, dist, before } = fixture();
    try {
        let installs = 0;
        let restored = 0;
        await assert.rejects(buildAndInstall({
            distDirectory: dist, build, verifySource: verify,
            files: {
                ...fs,
                copyFileSync(source, destination) {
                    if (String(source).includes(`${sep}backup${sep}`) && ++restored === 2) throw busy();
                    return fs.copyFileSync(source, destination);
                },
                renameSync(source, destination) {
                    if (String(source).includes(`${sep}output${sep}`) && ++installs === 3) throw busy();
                    return fs.renameSync(source, destination);
                }
            }
        }), /could not be fully restored.*Close Discord.*recovery files are in/u);
        const staging = fs.readdirSync(dist).find(name => name.startsWith(".protonn-build-"));
        assert.ok(staging);
        const backup = join(dist, staging, "backup");
        assert.equal(restored, 2);
        assert.equal(fs.readFileSync(join(dist, "desktop", "patcher.js"), "utf8"), "old:desktop/patcher.js");
        assert.equal(fs.readFileSync(join(backup, "desktop", "patcher.js"), "utf8"), "old:desktop/patcher.js");
        const manifest = JSON.parse(fs.readFileSync(join(backup, "manifest.json"), "utf8")) as { path: string; existed: boolean; }[];
        assert.ok(manifest.some(entry => entry.path === join("desktop", "patcher.js") && entry.existed));
        for (const entry of manifest.filter(entry => entry.existed))
            assert.ok(fs.existsSync(join(backup, entry.path)), "successful rollback copies must also remain available for recovery");
        assert.equal(fs.readFileSync(join(dist, "browser", "browser.js"), "utf8"), "unrelated browser build");
        recoverBuildInstallations(dist, fs);
        assert.deepEqual(snapshot(dist), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function interruptBuild(root: string, dist: string, phase: "before" | "mid" | "published" | "completed" | "cleanup") {
    const staged = join(root, "new-build");
    writeBuild(staged, "new");
    write(join(staged, "desktop", "assets", "NEW.html"), "new asset");
    const count = Object.values(snapshot(staged)).filter(value => value !== "directory").length;
    const script = `
        import * as fs from "node:fs";
        import { sep } from "node:path";
        import { buildAndInstall } from ${JSON.stringify(new URL("../src/main/updater/buildOperations.ts", import.meta.url).href)};
        let installed = 0;
        const phase = ${JSON.stringify(phase)};
        await buildAndInstall({
            distDirectory: ${JSON.stringify(dist)},
            async build(output) { fs.cpSync(${JSON.stringify(staged)}, output, { recursive: true }); },
            async verifySource() {},
            files: {
                ...fs,
                renameSync(source, destination) {
                    const publishing = String(source).includes(sep + "output" + sep);
                    if (publishing && phase === "before") process.exit(73);
                    fs.renameSync(source, destination);
                    if (publishing) {
                        installed++;
                        if (phase === "mid" && installed === 4 || phase === "published" && installed === ${count}) process.exit(73);
                    }
                    if (String(destination).endsWith(sep + "completed") && phase === "completed") process.exit(73);
                },
                rmSync(path, options) {
                    if (String(path).endsWith(sep + "backup") && phase === "cleanup") {
                        fs.rmSync(String(path) + sep + "desktop" + sep + "patcher.js");
                        process.exit(73);
                    }
                    fs.rmSync(path, options);
                }
            }
        });
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 73, child.stderr || String(child.error));
    const owner = JSON.parse(fs.readFileSync(join(dist, ".protonn-source-build.lock", "owner.json"), "utf8"));
    assert.equal(owner.pid, child.pid, "a process exit must leave the global lock owned by the dead child");
    const transaction = fs.readdirSync(dist).find(name => name.startsWith(".protonn-build-"));
    assert.ok(transaction, "process exit must leave the actual build transaction on disk");
    return join(dist, transaction);
}

test("process exits before, during and after publication restore journaled files while preserving unrelated outputs", () => {
    for (const phase of ["before", "mid", "published"] as const) {
        const { root, dist, before } = fixture();
        try {
            interruptBuild(root, dist, phase);
            write(join(dist, "desktop", "assets", "user.js"), "unrelated later file");
            assert.equal(recoverBuildInstallations(dist, fs), true);
            assert.deepEqual(snapshot(dist), {
                ...before,
                [join("desktop", "assets") + sep]: "directory",
                [join("desktop", "assets", "user.js")]: "unrelated later file"
            });
            assert.equal(recoverBuildInstallations(dist, fs), false);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("completed builds survive process exits before or during backup cleanup", () => {
    for (const phase of ["completed", "cleanup"] as const) {
        const { root, dist } = fixture();
        try {
            const transaction = interruptBuild(root, dist, phase);
            assert.equal(fs.readFileSync(join(transaction, "completed"), "utf8"), "complete\n");
            recoverBuildInstallations(dist, fs);
            assert.equal(fs.readFileSync(join(dist, "desktop", "renderer.js"), "utf8"), "new:desktop/renderer.js");
            assert.equal(fs.readFileSync(join(dist, "equibop.asar"), "utf8"), "new:equibop.asar");
            assert.equal(fs.readFileSync(join(dist, "desktop", "assets", "NEW.html"), "utf8"), "new asset");
            assert.equal(fs.readFileSync(join(dist, "desktop", "custom-native.js"), "utf8"), "unrelated native file");
            assert.equal(fs.existsSync(transaction), false);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("recovery and another updater leave an active source installation alone", async () => {
    const { root, dist } = fixture();
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const installing = buildAndInstall({ distDirectory: dist, files: fs, verifySource: verify, async build(output) {
        writeBuild(output, "new");
        started.resolve();
        await pending.promise;
    } });
    try {
        await started.promise;
        const during = snapshot(dist);
        assert.throws(() => recoverBuildInstallations(dist, fs), error => error instanceof Error
            && error.cause instanceof Error && /Another Discord process/u.test(error.cause.message));
        await assert.rejects(buildAndInstall({ distDirectory: dist, files: fs, verifySource: verify,
            build: async () => assert.fail("a second updater must not start compiling") }));
        assert.deepEqual(snapshot(dist), during);
    } finally {
        pending.resolve();
        await installing;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("two source updater processes starting before the recovery scan cannot both compile", { timeout: 30_000 }, async () => {
    const { root, dist } = fixture();
    const staged = join(root, "new-build");
    writeBuild(staged, "new");
    const scanGate = join(root, "release-scan");
    const buildGate = join(root, "release-build");
    const messages: { type: string; ok?: boolean; error?: string; }[] = [];
    const script = `
        import * as fs from "node:fs";
        import { once } from "node:events";
        import { setTimeout as delay } from "node:timers/promises";
        import { buildAndInstall } from ${JSON.stringify(new URL("../src/main/updater/buildOperations.ts", import.meta.url).href)};
        const start = once(process, "message");
        process.send({ type: "ready" });
        await start;
        let scanned = false;
        try {
            await buildAndInstall({
                distDirectory: ${JSON.stringify(dist)},
                async verifySource() {},
                async build(output) {
                    process.send({ type: "build" });
                    const deadline = Date.now() + 15000;
                    while (!fs.existsSync(${JSON.stringify(buildGate)})) {
                        if (Date.now() > deadline) throw new Error("build gate timed out");
                        await delay(10);
                    }
                    fs.cpSync(${JSON.stringify(staged)}, output, { recursive: true });
                },
                files: {
                    ...fs,
                    readdirSync(path, options) {
                        const entries = fs.readdirSync(path, options);
                        if (path === ${JSON.stringify(dist)} && !scanned) {
                            scanned = true;
                            // Cache the actual scan before releasing either process. Without the
                            // global lock both processes observe an empty transaction list.
                            process.send({ type: "scan" });
                            const deadline = Date.now() + 15000;
                            while (!fs.existsSync(${JSON.stringify(scanGate)})) {
                                if (Date.now() > deadline) throw new Error("scan gate timed out");
                                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                            }
                        }
                        return entries;
                    }
                }
            });
            process.send({ type: "result", ok: true });
        } catch (error) {
            const details = [];
            for (let current = error; current; current = current.cause) details.push(String(current));
            process.send({ type: "result", ok: false, error: details.join("; ") });
        } finally { process.disconnect(); }
    `;
    const children = Array.from({ length: 2 }, () => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
        let stderr = "";
        child.stderr?.on("data", data => { stderr += data; });
        child.on("message", message => messages.push(message as typeof messages[number]));
        return { child, exited: once(child, "exit"), stderr: () => stderr };
    });
    const count = (type: string) => messages.filter(message => message.type === type).length;
    async function until(condition: () => boolean) {
        const deadline = Date.now() + 20_000;
        while (!condition()) {
            assert.ok(Date.now() < deadline, `child process barrier timed out: ${JSON.stringify(messages)}; ${children.map(child => child.stderr()).join("; ")}`);
            await delay(10);
        }
    }
    try {
        await until(() => count("ready") === 2);
        for (const { child } of children) child.send("start");
        await until(() => count("scan") + count("result") >= 2);
        write(scanGate, "go");
        await until(() => count("build") + count("result") >= 2);
        assert.equal(fs.readFileSync(join(dist, "desktop", "renderer.js"), "utf8"), "old:desktop/renderer.js");
        write(buildGate, "go");
        for (const child of children) assert.equal((await child.exited)[0], 0, child.stderr());
        assert.equal(count("scan"), 1, "the losing process must never scan or recover the active transaction");
        assert.equal(count("build"), 1, "only the lock owner may compile");
        const results = messages.filter(message => message.type === "result");
        assert.equal(results.filter(result => result.ok).length, 1);
        assert.match(results.find(result => !result.ok)?.error ?? "", /Another Discord process/u);
        assert.equal(fs.readFileSync(join(dist, "desktop", "renderer.js"), "utf8"), "new:desktop/renderer.js");
        assert.equal(recoverBuildInstallations(dist, fs), false);
    } finally {
        for (const { child } of children) if (child.exitCode === null) child.kill();
        await Promise.all(children.map(child => child.exited));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("the source lock remains held during publication and transaction cleanup", async () => {
    const { root, dist } = fixture();
    let publishing = false;
    let cleaning = false;
    function checkActive() {
        const before = snapshot(dist);
        assert.throws(() => recoverBuildInstallations(dist, fs), /Could not acquire the source-build lock/u);
        assert.deepEqual(snapshot(dist), before, "recovery must not restore the live owner's journal");
    }
    try {
        await buildAndInstall({ distDirectory: dist, build, verifySource: verify, files: {
            ...fs,
            renameSync(source, destination) {
                fs.renameSync(source, destination);
                if (!publishing && String(source).includes(`${sep}output${sep}`)) {
                    publishing = true;
                    checkActive();
                }
            },
            rmSync(path, options) {
                if (String(path).endsWith(`${sep}backup`)) {
                    cleaning = true;
                    checkActive();
                }
                fs.rmSync(path, options);
            }
        } });
        assert.ok(publishing && cleaning);
        assert.equal(recoverBuildInstallations(dist, fs), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a stale reclaimer re-reads the owner under its guard and cannot steal a replacement live lock", () => {
    const { root, dist } = fixture();
    try {
        interruptBuild(root, dist, "mid");
        const lock = join(dist, ".protonn-source-build.lock");
        const owner = join(lock, "owner.json");
        const interrupted = snapshot(dist);
        const replacement = JSON.stringify({ pid: process.pid, token: ".protonn-source-lock-replacement" });
        let guarded = false;
        assert.throws(() => recoverBuildInstallations(dist, { ...fs, mkdirSync(path, options) {
            const result = fs.mkdirSync(path, options);
            if (path === join(dist, ".protonn-source-build.reclaim")) {
                guarded = true;
                fs.writeFileSync(owner, replacement);
            }
            return result;
        } }), /Could not acquire the source-build lock/u);
        assert.ok(guarded);
        assert.equal(fs.readFileSync(owner, "utf8"), replacement);
        assert.equal(fs.existsSync(join(dist, ".protonn-source-build.reclaim")), false);
        assert.deepEqual(snapshot(dist), { ...interrupted, [relative(dist, owner)]: replacement }, "the live replacement's journal and outputs must be untouched");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("incomplete, corrupt and redirected source locks fail closed with their paths", () => {
    for (const invalid of ["empty", "json", "pid", "token", "owner-directory", "owner-link", "lock-file", "lock-link", "guard", "guard-link"]) {
        const { root, dist } = fixture();
        try {
            const lock = join(dist, ".protonn-source-build.lock");
            const guard = join(dist, ".protonn-source-build.reclaim");
            const owner = join(lock, "owner.json");
            const outside = join(root, "outside");
            fs.mkdirSync(outside);
            if (invalid === "lock-file") write(lock, "invalid lock");
            else if (invalid === "lock-link") fs.symlinkSync(outside, lock, process.platform === "win32" ? "junction" : "dir");
            else if (invalid === "guard-link") fs.symlinkSync(outside, guard, process.platform === "win32" ? "junction" : "dir");
            else if (invalid === "guard") fs.mkdirSync(guard);
            else {
                fs.mkdirSync(lock);
                if (invalid === "json") write(owner, "{unfinished");
                if (invalid === "pid") write(owner, JSON.stringify({ pid: "bad", token: ".protonn-source-lock-invalid" }));
                if (invalid === "token") write(owner, JSON.stringify({ pid: process.pid, token: "../outside" }));
                if (invalid === "owner-directory") fs.mkdirSync(owner);
                if (invalid === "owner-link") fs.symlinkSync(outside, owner, process.platform === "win32" ? "junction" : "dir");
            }
            const before = snapshot(dist);
            assert.throws(() => recoverBuildInstallations(dist, fs), error => {
                assert.ok(error instanceof Error);
                assert.ok(error.message.includes(lock));
                assert.ok(error.message.includes(guard));
                return true;
            });
            assert.deepEqual(snapshot(dist), before, invalid);
            assert.deepEqual(snapshot(outside), {});
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("failed recovery retains every backup and can retry even after a partial restore", () => {
    const { root, dist, before } = fixture();
    try {
        const transaction = interruptBuild(root, dist, "published");
        const backup = join(transaction, "backup");
        const originals = snapshot(backup);
        let restored = 0;
        assert.throws(() => recoverBuildInstallations(dist, {
            ...fs,
            copyFileSync(source, destination) {
                if (++restored === 3) {
                    fs.writeFileSync(destination, "partial failed copy");
                    throw busy();
                }
                return fs.copyFileSync(source, destination);
            }
        }), error => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(transaction));
            assert.match(String(error.cause), /file is busy/u);
            return true;
        });
        assert.equal(restored, 3);
        assert.deepEqual(snapshot(backup), originals);
        assert.equal(fs.existsSync(join(transaction, "completed")), false);
        assert.throws(() => recoverBuildInstallations(dist, {
            ...fs,
            rmSync(path, options) {
                if (path === backup) {
                    fs.rmSync(join(backup, "desktop", "patcher.js"));
                    throw busy();
                }
                return fs.rmSync(path, options);
            }
        }), /recovery files are in/u);
        assert.equal(fs.readFileSync(join(transaction, "completed"), "utf8"), "complete\n");
        assert.equal(fs.readFileSync(join(dist, "desktop", "renderer.js"), "utf8"), "old:desktop/renderer.js");
        write(join(dist, "desktop", "renderer.js"), "edited after recovery");
        recoverBuildInstallations(dist, fs);
        before[join("desktop", "renderer.js")] = "edited after recovery";
        assert.deepEqual(snapshot(dist), { ...before, [join("desktop", "assets") + sep]: "directory" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a new build recovers old publication before compiling and blocks if recovery fails", async () => {
    const { root, dist } = fixture();
    try {
        const transaction = interruptBuild(root, dist, "mid");
        let built = false;
        await assert.rejects(buildAndInstall({
            distDirectory: dist, async build() { built = true; throw new Error("must not build during failed recovery"); }, verifySource: verify,
            files: { ...fs, copyFileSync() { throw busy(); } }
        }), /could not be recovered/u);
        assert.equal(built, false);
        await assert.rejects(buildAndInstall({
            distDirectory: dist, files: fs, verifySource: verify,
            async build() {
                built = true;
                assert.equal(fs.existsSync(transaction), false);
                assert.equal(fs.readFileSync(join(dist, "desktop", "renderer.js"), "utf8"), "old:desktop/renderer.js");
                assert.equal(fs.readFileSync(join(dist, "equibop.asar"), "utf8"), "old:equibop.asar");
                assert.equal(fs.existsSync(join(dist, "desktop", "assets", "NEW.html")), false);
                throw new Error("fixture stop after checking recovered outputs");
            }
        }), /stop after checking/u);
        assert.equal(built, true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recovery validates all journal paths and backups before changing any output", () => {
    const { root, dist } = fixture();
    try {
        const transaction = fs.mkdtempSync(join(dist, ".protonn-build-"));
        const backup = join(transaction, "backup");
        const original = { path: join("desktop", "renderer.js"), existed: true };
        write(join(backup, original.path), "original backup");
        const invalid = [
            "../outside", "desktop/../../outside", "desktop\\..\\outside", "/desktop/file", "C:\\desktop\\file",
            "browser/browser.js", "desktop", "desktop.asar/file", "desktop//file", "desktop/./file", "desktop/CON.js", "desktop/file:stream", "desktop/file.",
            "desktop/renderer.JS", "desktop/renderer.js/child"
        ].map(path => ({ path, existed: false }));
        invalid.push({ path: join("equibop", "missing-backup.js"), existed: true });
        invalid.push({ ...original });
        for (const entry of invalid) {
            write(join(backup, "manifest.json"), JSON.stringify([original, entry]));
            const before = snapshot(dist);
            assert.throws(() => recoverBuildInstallations(dist, fs), /recovery files are in/u);
            assert.deepEqual(snapshot(dist), before, `invalid entry must not allow a partial recovery: ${entry.path}`);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recovery rejects redirected transaction, backup and destination directories", () => {
    for (const redirected of ["transaction", "backup", "backup-parent", "destination-parent"]) {
        const { root, dist } = fixture();
        try {
            const transaction = fs.mkdtempSync(join(dist, ".protonn-build-"));
            const backup = join(transaction, "backup");
            write(join(backup, "manifest.json"), JSON.stringify([{ path: join("desktop", "renderer.js"), existed: true }]));
            write(join(backup, "desktop", "renderer.js"), "original backup");
            const target = redirected === "transaction" ? transaction : redirected === "backup" ? backup
                : redirected === "backup-parent" ? join(backup, "desktop") : join(dist, "desktop");
            const outside = join(root, "outside");
            fs.renameSync(target, outside);
            fs.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
            const before = snapshot(dist);
            const outsideBefore = snapshot(outside);
            assert.throws(() => recoverBuildInstallations(dist, fs), /recovery files are in/u);
            assert.deepEqual(snapshot(dist), before);
            assert.deepEqual(snapshot(outside), outsideBefore);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("incomplete staging without a published manifest is left alone", () => {
    const { root, dist } = fixture();
    try {
        const transaction = fs.mkdtempSync(join(dist, ".protonn-build-"));
        write(join(transaction, "output", "desktop", "renderer.js"), "unfinished build");
        write(join(transaction, "backup", "manifest.tmp"), "unfinished manifest");
        const before = snapshot(dist);
        recoverBuildInstallations(dist, fs);
        assert.deepEqual(snapshot(dist), before);
        recoverBuildInstallations(join(root, "missing-dist"), fs);
        assert.equal(fs.existsSync(join(root, "missing-dist")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("startup recovery without pending transactions or locks never attempts a write", () => {
    const { root, dist, before } = fixture();
    try {
        const readOnly = { ...fs };
        for (const method of ["copyFileSync", "mkdirSync", "mkdtempSync", "renameSync", "rmSync", "rmdirSync", "writeFileSync"] as const)
            readOnly[method] = () => assert.fail(`ordinary source startup must not call ${method}`);
        assert.equal(recoverBuildInstallations(dist, readOnly), false);
        assert.deepEqual(snapshot(dist), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("startup recovery honors an active global lock before its transaction is created", () => {
    const { root, dist } = fixture();
    try {
        write(join(dist, ".protonn-source-build.lock", "owner.json"), JSON.stringify({ pid: process.pid, token: ".protonn-source-lock-active" }));
        const before = snapshot(dist);
        assert.throws(() => recoverBuildInstallations(dist, fs), error => error instanceof Error
            && error.cause instanceof Error && /Another Discord process/u.test(error.cause.message));
        assert.deepEqual(snapshot(dist), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("symlinked output files and destination directories cannot redirect installation", { skip: process.platform === "win32" }, async () => {
    for (const symlinkDestination of [false, true]) {
        const { root, dist } = fixture();
        try {
            const outside = join(root, "outside");
            write(join(outside, "renderer.js"), "outside content");
            if (symlinkDestination) {
                fs.rmSync(join(dist, "equibop"), { recursive: true });
                fs.symlinkSync(outside, join(dist, "equibop"), "dir");
            }
            const before = snapshot(dist);
            await assert.rejects(buildAndInstall({
                distDirectory: dist, files: fs, verifySource: verify,
                async build(output) {
                    await build(output);
                    if (!symlinkDestination) {
                        fs.rmSync(join(output, "desktop", "renderer.js"));
                        fs.symlinkSync(join(outside, "renderer.js"), join(output, "desktop", "renderer.js"));
                    }
                }
            }), /symbolic link|regular directory/u);
            assert.deepEqual(snapshot(dist), before);
            assert.equal(fs.readFileSync(join(outside, "renderer.js"), "utf8"), "outside content");
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});
