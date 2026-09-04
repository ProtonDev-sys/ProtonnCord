/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import {
    type GitRunner,
    inspectGitUpdates,
    pullGitUpdates,
} from "../src/main/updater/gitOperations";
import {
    findHttpUpdate,
    inspectHttpUpdates,
} from "../src/main/updater/httpOperations";
import { serializeErrors } from "../src/main/updater/ipc";
import {
    parseUpdaterBranch,
    UPDATER_BRANCHES,
    updaterReleaseEndpoint,
} from "../src/shared/Updater";

const execFile = promisify(execFileCallback);

async function testUpdaterControls(): Promise<void> {
    interface Element {
        type: unknown;
        props: Record<string, unknown>;
        children: unknown[];
    }
    const settings = { updateBranch: "main" };
    const calls: string[] = [];
    const openedRoutes: string[] = [];
    let states: unknown[] = [];
    let cursor = 0;
    let remoteChanges = [{ hash: "b".repeat(40), author: "Fixture", message: "Update" }];
    let finishCheck: (() => void) | undefined;
    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
    const common = {
        React: { createElement, useEffect: () => undefined, Fragment: "Fragment" },
        useState(initial: unknown) {
            const index = cursor++;
            if (!(index in states)) states[index] = initial;
            return [states[index], (value: unknown) => { states[index] = value; }];
        },
        Select: "Select", ConfirmModal: "ConfirmModal",
        SettingsRouter: { openUserSettings: (route: string) => { openedRoutes.push(route); } },
        Toasts: { show: () => undefined, genId: () => "fixture", Type: {}, Position: {} },
        openModal(factory: (props: object) => Element) {
            const modal = factory({});
            assert.equal(typeof modal.props.onCancel, "function");
            (modal.props.onCancel as () => void)();
        },
    };
    const mocks: Record<string, object> = {
        "@api/Settings": { Settings: settings, useSettings: () => settings },
        "@shared/Updater": { UPDATER_BRANCHES },
        "@utils/margins": { Margins: {} },
        "@utils/misc": { classes: () => "" },
        "@utils/Logger": { Logger: class { debug() {} } },
        "@utils/native": { relaunch: () => assert.fail("The test must not restart Discord") },
        "@webpack/common": common,
        "~git-hash": { default: "a".repeat(40) },
        "./Logger": { Logger: class { error() {} } },
        "./native": { relaunch: () => assert.fail("The test must not restart Discord") },
        "./updateClassification": { classifyUpdateChanges: () => ({ isNewer: false, isOutdated: true }) },
        "./runWithDispatch": {
            runWithDispatch: (dispatch: (value: boolean) => void, action: () => Promise<void>) => async () => {
                dispatch(true);
                try { await action(); } finally { dispatch(false); }
            },
        },
    };
    async function load(relative: string): Promise<Record<string, unknown>> {
        const filename = new URL(`../${relative}`, import.meta.url);
        const { outputText } = transpileModule(await readFile(filename, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: 2 }, fileName: relative,
        });
        const module = { exports: {} };
        runInNewContext(outputText, {
            exports: module.exports, module, IS_STANDALONE: true, IS_WEB: false, IS_UPDATER_DISABLED: false,
            require(name: string) {
                if (mocks[name]) {
                    if (!("__esModule" in mocks[name])) Object.defineProperty(mocks[name], "__esModule", { value: true });
                    return mocks[name];
                }
                if (name.startsWith("@components/")) {
                    const component = name.split("/").at(-1);
                    assert.ok(component);
                    return { [component]: component };
                }
                throw new Error(`Unexpected test import: ${name}`);
            },
            VencordNative: { updater: {
                async getUpdates(branch: string) {
                    calls.push(`check:${branch}`);
                    await new Promise<void>(resolve => { finishCheck = resolve; });
                    return { ok: true, value: remoteChanges };
                },
                async update(branch: string) { calls.push(`update:${branch}`); return { ok: true, value: true }; },
                async rebuild() { calls.push("build"); return { ok: true, value: true }; },
            } },
        }, { filename: relative });
        return module.exports;
    }
    const updater = await load("src/utils/updater.ts");
    mocks["@utils/updater"] = updater;
    const components = await load("src/components/settings/tabs/updater/Components.tsx");
    const routes = await load("src/equicordplugins/commandPalette/commands/openSettings.ts");
    for (const route of ["equicord_updater", "equicord_changelog", "equicord_changelog_panel"])
        await (routes.openSettingsPage as (route: string) => Promise<boolean>)(route);
    assert.deepEqual(openedRoutes, Array(3).fill("equicord_updater_panel"),
        "old changelog and updater commands open the same Updates page");
    const render = (disabled = false) => {
        cursor = 0;
        return (components.Updatable as (props: object) => Element)({ repo: "https://example.invalid", repoPending: false, disabled });
    };
    const elements = (node: unknown): Element[] => {
        if (!node || typeof node !== "object" || !("children" in node)) return [];
        const element = node as Element;
        return [element, ...element.children.flatMap(elements)];
    };
    const find = (tree: Element, type: string, label?: string) => elements(tree).find(node => node.type === type && (!label || node.children.includes(label)));
    const invoke = (element: Element | undefined, action: string, ...args: unknown[]) => {
        assert.ok(element);
        const callback = element.props[action];
        assert.equal(typeof callback, "function");
        return (callback as (...args: unknown[]) => Promise<void>)(...args);
    };
    for (const branch of ["nightly", "staging"]) {
        invoke(find(render(), "Select"), "select", branch);
        assert.equal(settings.updateBranch, branch);
        states = [];
        assert.equal(find(render(), "Button", "Update Now"), undefined, "branch changes discard stale update results");
        const checking = invoke(find(render(), "Button", "Check for Updates"), "onClick");
        assert.equal(find(render(), "Select")?.props.isDisabled, true);
        invoke(find(render(), "Select"), "select", "main");
        assert.equal(settings.updateBranch, branch, "a pending update check locks the branch selection");
        assert.ok(finishCheck);
        finishCheck();
        await checking;
        await invoke(find(render(), "Button", "Update Now"), "onClick");
        assert.equal(find(render(), "Button", "Update Now"), undefined);
    }
    assert.deepEqual(calls, ["check:nightly", "update:nightly", "build", "check:staging", "update:staging", "build"]);
    invoke(find(render(true), "Select"), "select", "main");
    assert.equal(settings.updateBranch, "staging", "changelog loading also locks the controls");
    remoteChanges = [];
    const checking = invoke(find(render(), "Button", "Check for Updates"), "onClick");
    assert.ok(finishCheck);
    finishCheck();
    await checking;
    assert.equal(find(render(), "Button", "Update Now"), undefined, "a current branch has no install action");
}

async function run(cwd: string, ...args: string[]): Promise<{ stderr: string; stdout: string; }> {
    const result = await execFile("git", args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 30_000,
    });
    return { stderr: String(result.stderr), stdout: String(result.stdout) };
}

function runner(cwd: string): GitRunner {
    return (...args) => run(cwd, ...args);
}

async function configureRepository(repository: string): Promise<void> {
    await run(repository, "config", "user.name", "Updater Branch Test");
    await run(repository, "config", "user.email", "updater-branch-test@example.invalid");
}

async function commitFile(repository: string, filename: string, content: string, message: string): Promise<string> {
    await writeFile(join(repository, filename), content);
    await run(repository, "add", "--", filename);
    await run(repository, "commit", "-m", message);
    return (await run(repository, "rev-parse", "HEAD")).stdout.trim();
}

async function testIpcBranchArguments(): Promise<void> {
    const received: unknown[] = [];
    const handler = serializeErrors((branch: unknown) => {
        received.push(branch);
        return parseUpdaterBranch(branch);
    });
    const fakeElectronEvent = { sender: { id: 1 } };

    assert.throws(
        () => parseUpdaterBranch(fakeElectronEvent),
        /Unsupported Protonn Cord update branch/u,
        "the Electron event object must never be interpreted as the selected branch",
    );
    assert.deepEqual(await handler(fakeElectronEvent, "main"), { ok: true, value: "main" });
    assert.deepEqual(await handler(fakeElectronEvent, "staging"), { ok: true, value: "staging" });

    const invalid = await handler(fakeElectronEvent, "beta");
    assert.equal(invalid.ok, false);
    const invalidError = "error" in invalid ? invalid.error : null;
    assert.ok(invalidError && typeof invalidError === "object" && "message" in invalidError);
    assert.match(String(invalidError.message), /Unsupported Protonn Cord update branch/u);
    assert.deepEqual(received, ["main", "staging", "beta"],
        "IPC handlers must receive only renderer arguments, without Electron's event metadata");
}

async function testGitBranches(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "protonn-cord-updater-branches-"));
    try {
        const remote = join(root, "remote.git");
        const seed = join(root, "seed");
        await run(root, "init", "--bare", remote);
        await run(root, "init", seed);
        await configureRepository(seed);
        const mainHead = await commitFile(seed, "state.txt", "main\n", "main");
        await run(seed, "branch", "-M", "main");
        await run(seed, "remote", "add", "origin", remote);
        await run(seed, "push", "-u", "origin", "main");
        await run(remote, "symbolic-ref", "HEAD", "refs/heads/main");

        await run(seed, "switch", "-c", "staging");
        const stagingHead = await commitFile(seed, "staging.txt", "staging\n", "staging update");
        await run(seed, "push", "-u", "origin", "staging");
        await run(seed, "switch", "main");
        await run(seed, "branch", "nightly", "staging");
        await run(seed, "push", "origin", "nightly");

        const clone = join(root, "clone");
        await run(root, "clone", remote, clone);
        await configureRepository(clone);

        const stagingInspection = await inspectGitUpdates(runner(clone), remote, mainHead, "staging");
        assert.equal(stagingInspection.branch, "staging");
        assert.equal(stagingInspection.targetHead, stagingHead);
        assert.deepEqual(stagingInspection.changes.map(change => change.hash), [stagingHead]);
        assert.equal(await pullGitUpdates(runner(clone), remote, mainHead, "staging"), true);
        assert.equal((await run(clone, "branch", "--show-current")).stdout.trim(), "staging");
        assert.equal((await run(clone, "rev-parse", "HEAD")).stdout.trim(), stagingHead);

        const mainInspection = await inspectGitUpdates(runner(clone), remote, stagingHead, "main");
        assert.equal(mainInspection.changes.length, 1);
        assert.match(mainInspection.changes[0].message, /Switch update branch to main/u);
        assert.equal(await pullGitUpdates(runner(clone), remote, stagingHead, "main"), true);
        assert.equal((await run(clone, "branch", "--show-current")).stdout.trim(), "main");
        assert.equal((await run(clone, "rev-parse", "HEAD")).stdout.trim(), mainHead);

        await writeFile(join(clone, "state.txt"), "dirty\n");
        await assert.rejects(
            pullGitUpdates(runner(clone), remote, mainHead, "staging"),
            /uncommitted changes/iu,
        );
        assert.equal(await readFile(join(clone, "state.txt"), "utf8"), "dirty\n");
        await assert.rejects(
            inspectGitUpdates(runner(clone), remote, mainHead, "beta" as never),
            /Unsupported Protonn Cord update branch/u,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
}

async function testHttpBranches(): Promise<void> {
    const currentHash = "a".repeat(40);
    const targetHash = "b".repeat(40);
    const endpoints: string[] = [];
    const release = {
        name: `Protonn Cord staging ${targetHash}`,
        assets: [{
            name: "desktop.asar",
            browser_download_url: "https://github.com/ProtonDev-sys/ProtonnCord/releases/download/staging/desktop.asar",
        }],
    };
    const inspection = await inspectHttpUpdates(async endpoint => {
        endpoints.push(endpoint);
        if (endpoint === "/releases/tags/staging") return release;
        if (endpoint === `/compare/${currentHash}...${targetHash}`) return { commits: [] };
        throw new Error(`Unexpected endpoint ${endpoint}`);
    }, currentHash, "desktop.asar", "staging");
    assert.deepEqual(endpoints, [
        "/releases/tags/staging",
        `/compare/${currentHash}...${targetHash}`,
    ]);
    assert.equal(inspection.pending?.hash, targetHash);
    assert.match(inspection.changes[0].message, /Switch update branch to staging/u);

    let nightlyEndpoint = "";
    const nightly = await findHttpUpdate(async endpoint => {
        nightlyEndpoint = endpoint;
        return {
            ...release,
            name: `Protonn Cord nightly ${targetHash}`,
            assets: [{
                name: "desktop.asar",
                browser_download_url: "https://github.com/ProtonDev-sys/ProtonnCord/releases/download/nightly/desktop.asar",
            }],
        };
    }, currentHash, "desktop.asar", "nightly");
    assert.equal(nightlyEndpoint, "/releases/tags/nightly");
    assert.equal(nightly?.hash, targetHash);
}

async function main(): Promise<void> {
    assert.equal(parseUpdaterBranch(undefined), "main");
    assert.equal(parseUpdaterBranch("staging"), "staging");
    assert.throws(() => parseUpdaterBranch("dev"), /Unsupported Protonn Cord update branch/u);
    assert.equal(updaterReleaseEndpoint("main"), "/releases/latest");
    assert.equal(updaterReleaseEndpoint("nightly"), "/releases/tags/nightly");

    await testIpcBranchArguments();
    await testGitBranches();
    await testHttpBranches();
    await testUpdaterControls();

    const workflow = await readFile(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
    assert.match(workflow, /- main[\s\S]*- staging[\s\S]*- nightly/u);
    assert.match(workflow, /tag="latest"/u);
    assert.match(workflow, /--prerelease/u);

    const changelogSettings = await readFile(new URL(
        "../src/components/settings/tabs/changelog/index.tsx",
        import.meta.url,
    ), "utf8");
    assert.match(changelogSettings, /<Updatable/u, "Changelog must expose install controls, not only fetch commits");
    assert.doesNotMatch(changelogSettings, /updater\.getUpdates\(\)/u,
        "Changelog checks must not silently default to main");
    const updaterSettings = await readFile(new URL(
        "../src/components/settings/tabs/updater/Components.tsx",
        import.meta.url,
    ), "utf8");
    assert.match(updaterSettings, /<Select[\s\S]*options=\{UPDATE_BRANCH_OPTIONS\}/u,
        "ProtonnCord settings must expose the update branch dropdown");
    assert.match(updaterSettings, /settings\.updateBranch = branch/u,
        "the branch dropdown must persist the locally selected channel");
    assert.match(updaterSettings, /Main \(stable\)/u);
    assert.match(updaterSettings, /Staging \(tested previews\)/u);
    assert.match(updaterSettings, /Nightly \(latest previews\)/u);

    const settingsNavigation = await readFile(new URL("../src/plugins/_core/settings.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(settingsNavigation, /key: "equicord_changelog"/u,
        "updates and changelog must share one sidebar entry");
    assert.match(settingsNavigation, /key: "equicord_updater",\s*title: "Updates"/u);
    assert.match(changelogSettings, /<UpdatePreferences\s*\/>/u,
        "the combined page retains automatic-update preferences");

    console.log("updater branch-channel checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
