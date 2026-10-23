import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { requireCleanTree } from "../src/main/updater/gitOperations";
import { createOperationQueue, serializeErrors } from "../src/main/updater/ipc";
import { IpcEvents } from "../src/shared/IpcEvents";
import { parseUpdaterBranch } from "../src/shared/Updater";
import { loadTestModule } from "./utils/loadTestModule";

const originalHead = "a".repeat(40);
const updateHead = "b".repeat(40);

function fixture(platform = "linux", flatpak = false, environment: Record<string, string> = {}) {
    const state = { head: originalHead, branch: "nightly", root: path.resolve("/fixture/source"), dirty: "", published: 0 };
    const commands: { command: string; args: string[]; options: Record<string, any>; }[] = [];
    const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
    let install = async () => {};
    let build = async () => {};
    let pull = async () => { state.head = updateHead; return true; };
    loadTestModule("src/main/updater/git.ts", {
        "@shared/IpcEvents": { IpcEvents: {
            GET_REPO: IpcEvents.GET_REPO,
            GET_UPDATES: IpcEvents.GET_UPDATES,
            UPDATE: IpcEvents.UPDATE,
            BUILD: IpcEvents.BUILD,
            GET_UPDATER_DIAGNOSTICS: IpcEvents.GET_UPDATER_DIAGNOSTICS,
        } },
        "@shared/Updater": { parseUpdaterBranch },
        "~git-hash": { __esModule: true, default: originalHead, buildChannel: "nightly" },
        "~git-remote": { __esModule: true, default: "ProtonDev-sys/ProtonnCord" },
        "child_process": { async execFile(command: string, args: string[], options: Record<string, any>) {
            commands.push({ command, args, options });
            const executable = command === "flatpak-spawn" ? args[1] : command;
            const arguments_ = command === "flatpak-spawn" ? args.slice(2) : args;
            if (executable === "git") {
                assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
                assert.ok(options.timeout > 0);
                const request = arguments_.join(" ");
                const responses = {
                    "rev-parse HEAD": state.head,
                    "rev-parse --show-toplevel": state.root,
                    "branch --show-current": state.branch,
                    "status --porcelain=v1 --untracked-files=all": state.dirty,
                };
                assert.ok(Object.hasOwn(responses, request), request);
                return { stdout: responses[request], stderr: "" };
            }
            assert.ok(options.timeout > 0, "dependency installation and builds are bounded");
            if (executable === "pnpm" || executable === "cmd.exe") {
                assert.equal(options.env.CI, "true", "dependency installation never waits for terminal input");
                await install();
            } else {
                assert.equal(executable, "node");
                await build();
            }
            return { stdout: "", stderr: "" };
        } },
        "@main/ipc": { ipcMain: { handle: (event: string, handler: (...args: unknown[]) => Promise<any>) => handlers.set(event, handler) } },
        path,
        "original-fs": { realpathSync: path.resolve },
        util: { promisify: (operation: unknown) => operation },
        "./ipc": { createOperationQueue, serializeErrors },
        "./gitOperations": {
            requireCleanTree,
            async inspectGitUpdates(_git: unknown, repository: string, builtHead: string) {
                assert.equal(repository, "https://github.com/ProtonDev-sys/ProtonnCord.git");
                return { targetHead: state.head, changes: state.head === builtHead ? [] : [{ hash: state.head, author: "Fixture", message: "Update" }] };
            },
            async pullGitUpdates() {
                return pull();
            },
        },
        "./buildOperations": { async buildAndInstall(options: { build(directory: string): Promise<void>; verifySource(): Promise<void>; }) {
            await options.build("/fixture/source/dist/.updater-stage");
            await options.verifySource();
            state.published++;
        } },
    }, {
        __dirname: "/fixture/source/dist/desktop", IS_DEV: false, Error,
        process: { platform, env: { ...environment, ...(flatpak ? { FLATPAK_ID: "fixture" } : {}) } },
    });
    return {
        state,
        commands,
        invoke: (event: IpcEvents, branch = "nightly") => handlers.get(event)!({}, branch),
        setInstall(operation: typeof install) { install = operation; },
        setBuild(operation: typeof build) { build = operation; },
        setPull(operation: typeof pull) { pull = operation; },
    };
}

test("a failed source build remains pending and a successful retry records the installed commit", async () => {
    const f = fixture();
    await f.invoke(IpcEvents.UPDATE);
    f.setBuild(async () => { throw new Error("Fixture build failure"); });
    assert.equal((await f.invoke(IpcEvents.BUILD)).ok, false);
    assert.equal(f.state.published, 0);
    assert.equal((await f.invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS)).value.builtHead, originalHead);
    assert.equal((await f.invoke(IpcEvents.GET_UPDATES)).value.length, 1);
    f.setBuild(async () => {});
    assert.equal((await f.invoke(IpcEvents.BUILD)).value, true);
    assert.equal(f.state.published, 1);
    assert.equal((await f.invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS)).value.builtHead, updateHead);
    assert.equal((await f.invoke(IpcEvents.GET_UPDATES)).value.length, 0);
});

test("switching channels at the installed commit remains pending until that channel is built", async () => {
    const f = fixture();
    // The source was already switched by a previous pull, but compilation failed.
    f.state.branch = "main";
    f.setPull(async () => false);
    const changes = (await f.invoke(IpcEvents.GET_UPDATES, "main")).value;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].hash, originalHead);
    assert.match(changes[0].message, /Switch update branch to main/u);
    assert.equal((await f.invoke(IpcEvents.UPDATE, "main")).value, true);
    f.setBuild(async () => { throw new Error("channel compile failed"); });
    assert.equal((await f.invoke(IpcEvents.BUILD, "main")).ok, false);
    assert.equal((await f.invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS, "main")).value.installedBranch, "nightly");
    assert.equal((await f.invoke(IpcEvents.GET_UPDATES, "main")).value.length, 1);
    f.setBuild(async () => {});
    assert.equal((await f.invoke(IpcEvents.BUILD, "main")).value, true);
    const diagnostics = (await f.invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS, "main")).value;
    assert.equal(diagnostics.builtHead, originalHead);
    assert.equal(diagnostics.installedBranch, "main");
    assert.equal((await f.invoke(IpcEvents.GET_UPDATES, "main")).value.length, 0);
    assert.equal((await f.invoke(IpcEvents.UPDATE, "main")).value, false);
    assert.equal((await f.invoke(IpcEvents.GET_UPDATES, "nightly")).value.length, 1,
        "the running renderer can select its previous channel after a deferred restart");
    assert.ok(f.commands.filter(call => call.command === "node").every(call => call.options.env.PROTONN_CORD_BUILD_CHANNEL === "main"));
});

test("dependency installation is frozen, noninteractive, and runs before the build on every supported launcher", async () => {
    for (const [platform, flatpak] of [["linux", false], ["win32", false], ["linux", true]] as const) {
        const f = fixture(platform, flatpak);
        const phases: string[] = [];
        f.setInstall(async () => { phases.push("dependencies"); });
        f.setBuild(async () => { phases.push("build"); });
        assert.equal((await f.invoke(IpcEvents.BUILD)).value, true);
        assert.deepEqual(phases, ["dependencies", "build"]);
        assert.ok(f.commands.some(call => call.args.includes("--outdir=/fixture/source/dist/.updater-stage")),
            "build output must go to the staged directory supplied by the transaction helper");
        const install = f.commands.find(call => call.command === "cmd.exe" || call.command === "pnpm" || call.args[1] === "pnpm");
        assert.ok(install);
        assert.deepEqual(Array.from(install.args), flatpak ? ["--host", "pnpm", "install", "--frozen-lockfile"]
            : platform === "win32" ? ["/d", "/s", "/c", "pnpm install --frozen-lockfile"]
                : ["install", "--frozen-lockfile"]);
    }
});

test("source operations reject a parent repository before fetching, installing, or building", async () => {
    for (const operation of [IpcEvents.GET_UPDATES, IpcEvents.UPDATE, IpcEvents.BUILD]) {
        const f = fixture();
        f.state.root = path.resolve("/fixture");
        const result = await f.invoke(operation);
        assert.equal(result.ok, false);
        assert.match(result.error.message, /not the root of its Git checkout/u);
        assert.equal(f.state.head, originalHead);
        assert.equal(f.state.published, 0);
        assert.ok(f.commands.every(call => call.command === "git"));
    }
});

test("Git environment overrides cannot redirect the checkout or mislabel a source build", async () => {
    const f = fixture("linux", false, {
        GIT_DIR: "/other/repo", git_work_tree: "/other/tree", GIT_INDEX_FILE: "/other/index",
        PROTONN_CORD_HASH: "old-ci-hash", EQUICORD_HASH: "legacy-ci-hash", PROTONN_CORD_BUILD_CHANNEL: "main",
        PROTONN_CORD_REMOTE: "Other/Repository", CI: "true",
    });
    await f.invoke(IpcEvents.UPDATE);
    assert.equal((await f.invoke(IpcEvents.BUILD)).value, true);
    for (const call of f.commands) {
        assert.equal(path.resolve(call.options.cwd), path.resolve("/fixture/source"));
        assert.ok(Object.keys(call.options.env).every(name => !/^GIT_/iu.test(name) || name === "GIT_TERMINAL_PROMPT"));
    }
    const compile = f.commands.find(call => call.command === "node")!;
    assert.equal(compile.options.env.PROTONN_CORD_HASH, updateHead);
    assert.equal(compile.options.env.PROTONN_CORD_BUILD_CHANNEL, "nightly");
    assert.equal(compile.options.env.PROTONN_CORD_REMOTE, "ProtonDev-sys/ProtonnCord");
    assert.equal(compile.options.env.EQUICORD_HASH, undefined);
});

test("dirty source before or during dependency installation and compilation never publishes outputs", async () => {
    for (const phase of ["initial", "dependencies", "build"]) {
        const f = fixture();
        const mutate = async () => { f.state.dirty = " M src/Vencord.ts"; };
        if (phase === "initial") await mutate();
        else if (phase === "dependencies") f.setInstall(mutate);
        else f.setBuild(mutate);
        const result = await f.invoke(IpcEvents.BUILD);
        assert.equal(result.ok, false);
        assert.match(result.error.message, /uncommitted changes/u);
        assert.equal(f.state.published, 0);
        assert.equal((await f.invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS)).value.builtHead, originalHead);
        if (phase === "initial") assert.ok(f.commands.every(call => call.command === "git"));
        if (phase !== "build") assert.ok(f.commands.every(call => call.command !== "node"));
    }
});

test("source updates wait for an in-flight build and failed builds release the operation queue", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setInstall(async () => { entered.resolve(); await release.promise; });
    f.setBuild(async () => { throw new Error("queued build failure"); });
    const building = f.invoke(IpcEvents.BUILD);
    await entered.promise;
    const updating = f.invoke(IpcEvents.UPDATE);
    await Promise.resolve();
    assert.equal(f.state.head, originalHead, "the queued update cannot change the source being built");
    release.resolve();
    assert.equal((await building).ok, false);
    assert.equal((await updating).value, true);
    assert.equal(f.state.head, updateHead);
    assert.equal((await f.invoke(IpcEvents.GET_UPDATES)).value.length, 1);
});

test("dependency failures preserve installed state and provide a retry instruction", async () => {
    const f = fixture();
    await f.invoke(IpcEvents.UPDATE);
    f.setInstall(async () => { throw new Error("pnpm ENOENT"); });
    f.setBuild(async () => assert.fail("a dependency failure must not start the build"));
    const failed = await f.invoke(IpcEvents.BUILD);
    assert.equal(failed.ok, false);
    assert.match(failed.error.message, /pnpm install --frozen-lockfile/u);
    assert.match(failed.error.message, /pnpm ENOENT/u);
    assert.equal(f.state.published, 0);
    assert.equal((await f.invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS)).value.builtHead, originalHead);
});

test("changes to source HEAD or branch during dependency installation and builds never advance built state", async () => {
    for (const phase of ["dependencies", "build"]) {
        for (const change of ["head", "branch"] as const) {
            const f = fixture();
            await f.invoke(IpcEvents.UPDATE);
            const mutate = async () => { f.state[change] = change === "head" ? "c".repeat(40) : "main"; };
            if (phase === "dependencies") {
                f.setInstall(mutate);
                f.setBuild(async () => assert.fail("source drift during installation must be caught before building"));
            } else {
                f.setBuild(mutate);
            }
            const failed = await f.invoke(IpcEvents.BUILD);
            assert.equal(failed.ok, false);
            assert.match(failed.error.message, /source checkout changed/u);
            assert.equal(f.state.published, 0);
            assert.equal((await f.invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS)).value.builtHead, originalHead);
        }
    }
});
