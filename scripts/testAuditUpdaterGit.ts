/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { createOperationQueue, serializeErrors } from "../src/main/updater/ipc";
import { IpcEvents } from "../src/shared/IpcEvents";
import { parseUpdaterBranch } from "../src/shared/Updater";
import { loadTestModule } from "./utils/loadTestModule";

const originalHead = "a".repeat(40);
const updateHead = "b".repeat(40);

function fixture(platform = "linux", flatpak = false) {
    const state = { head: originalHead, branch: "nightly", published: 0 };
    const commands: { command: string; args: string[]; options: Record<string, any>; }[] = [];
    const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
    let install = async () => {};
    let build = async () => {};
    loadTestModule("src/main/updater/git.ts", {
        "@shared/IpcEvents": { IpcEvents: {
            GET_REPO: IpcEvents.GET_REPO,
            GET_UPDATES: IpcEvents.GET_UPDATES,
            UPDATE: IpcEvents.UPDATE,
            BUILD: IpcEvents.BUILD,
            GET_UPDATER_DIAGNOSTICS: IpcEvents.GET_UPDATER_DIAGNOSTICS,
        } },
        "@shared/Updater": { parseUpdaterBranch },
        "~git-hash": { __esModule: true, default: originalHead },
        "~git-remote": { __esModule: true, default: "ProtonDev-sys/ProtonnCord" },
        "child_process": { async execFile(command: string, args: string[], options: Record<string, any>) {
            commands.push({ command, args, options });
            const executable = command === "flatpak-spawn" ? args[1] : command;
            const arguments_ = command === "flatpak-spawn" ? args.slice(2) : args;
            if (executable === "git") {
                assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
                assert.ok(options.timeout > 0);
                const request = arguments_.join(" ");
                assert.ok(["rev-parse HEAD", "branch --show-current"].includes(request), request);
                return { stdout: request === "rev-parse HEAD" ? state.head : state.branch, stderr: "" };
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
        "electron": { ipcMain: { handle: (event: string, handler: (...args: unknown[]) => Promise<any>) => handlers.set(event, handler) } },
        path,
        "original-fs": { promises: {} },
        util: { promisify: (operation: unknown) => operation },
        "./ipc": { createOperationQueue, serializeErrors },
        "./gitOperations": {
            async inspectGitUpdates(_git: unknown, repository: string, builtHead: string) {
                assert.equal(repository, "https://github.com/ProtonDev-sys/ProtonnCord.git");
                return { changes: state.head === builtHead ? [] : [{ hash: state.head, author: "Fixture", message: "Update" }] };
            },
            async pullGitUpdates() {
                state.head = updateHead;
                return true;
            },
        },
        "./buildOperations": { async buildAndInstall(options: { build(directory: string): Promise<void>; verifySource(): Promise<void>; }) {
            await options.build("/fixture/source/dist/.updater-stage");
            await options.verifySource();
            state.published++;
        } },
    }, {
        __dirname: "/fixture/source/dist/desktop", IS_DEV: false, Error,
        process: { platform, env: flatpak ? { FLATPAK_ID: "fixture" } : {} },
    });
    return {
        state,
        commands,
        invoke: (event: IpcEvents, branch = "nightly") => handlers.get(event)!({}, branch),
        setInstall(operation: typeof install) { install = operation; },
        setBuild(operation: typeof build) { build = operation; },
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
