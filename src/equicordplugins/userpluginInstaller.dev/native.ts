/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NativeSettings } from "@main/settings";
import { exec, spawn } from "child_process";
import { BrowserWindow, dialog, shell } from "electron";
import { readdirSync, readFileSync } from "fs";
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "fs/promises";
import { basename, join, resolve } from "path";
import yaml from "yaml-js";

// @ts-ignore fuck off
import pluginValidateContent from "./misc/pluginValidate.txt"; // i would use HTML but esbuild is being whiny
// @ts-ignore fuck off
import setGitPathContent from "./misc/setGitPath.txt";
import { assertSafeExistingUserpluginDirectory, parseUserpluginRepositoryUrl, resolveUserpluginDirectory } from "./repositorySafety";
import {
    createUpdateReviewModel,
    createUpdateReviewPlan,
    isUpdateReviewPlanCurrent,
    MAX_DISPLAYED_UPDATE_COMMITS,
    MAX_UPDATE_LOG_BYTES,
    parseUpdateCommits,
    runUpdateReview,
    type UpdateCommit,
    type UpdateReviewPlan
} from "./updateReview";

const PLUGIN_META_REGEX = /export default definePlugin\((?:\s|\/(?:\/|\*).*)*{\s*(?:\s|\/(?:\/|\*).*)*name:\s*(?:"|'|`)(.*)(?:"|'|`)(?:\s|\/(?:\/|\*).*)*,(?:\s|\/(?:\/|\*).*)*.+(?:\s|\/(?:\/|\*).*)*description:\s*(?:"|'|`)(.*)(?:"|'|`)(?:\s|\/(?:\/|\*).*)*/;
const vencordPath = ["desktop", "equibop"].includes(basename(__dirname)) ? join(__dirname, "../") : __dirname;
const userpluginsRoot = resolve(vencordPath, "../src/userplugins");

function gitExecutable() {
    return NativeSettings.store.plugins.UserpluginInstaller?.gitPath?.trim() || "git";
}

function getUserpluginPath(name: string): string {
    return resolveUserpluginDirectory(userpluginsRoot, name);
}

async function removeUserpluginDirectory(destination: string): Promise<void> {
    await assertSafeUserpluginDirectory(destination);
    await rm(destination, { recursive: true });
}

async function assertSafeUserpluginDirectory(destination: string): Promise<string> {
    return assertSafeExistingUserpluginDirectory(userpluginsRoot, destination);
}

export async function ensurePluginsDirectory(_: any) {
    if (!IS_DEV) return;
    try {
        await mkdir(userpluginsRoot, { recursive: true });
    } catch(e) { }
}

export async function rmPlugin(_, name: string): Promise<string> {
    const ups = await getUserplugins();
    const pl = ups.find(p => p.directory! === name);
    if (!pl) throw new Error("Plugin is not installed");

    const deleteReqDialog = await dialog.showMessageBox({
        title: "Uninstall plugin",
        message: `Uninstall ${pl.name}`,
        type: "error",
        detail: `The uninstall of the userplugin ${pl.name} has been requested. Would you like to do so?\n\nIf you did not initiate this, press No.`,
        buttons: ["No", "Yes"]
    });

    if (deleteReqDialog.response !== 1) throw new Error("User rejected");
    await removeUserpluginDirectory(getUserpluginPath(name));

    await build();
    return "Done";
}

export async function isUpdateAvailableForPlugin(_, name: string): Promise<boolean> {
    try {
        const pluginDir = await assertSafeUserpluginDirectory(getUserpluginPath(name));
        await new Promise<void>((resolveFetch, rejectFetch) => {
            const proc = spawn(gitExecutable(), ["fetch"], { cwd: pluginDir, timeout: 120_000, stdio: "ignore", windowsHide: true });
            proc.once("error", rejectFetch);
            proc.once("close", code => code === 0 ? resolveFetch() : rejectFetch(new Error("Git fetch failed")));
        });
        const plan = await getUpdateReviewPlan(pluginDir);
        return plan.localRevision !== plan.targetRevision;
    } catch {
        return false;
    }
}

export async function initPluginInstall(_, link: string): Promise<string> {
    const repository = parseUserpluginRepositoryUrl(link);
    if (!repository) throw new Error("Invalid link");
    const { href: repositoryUrl, owner, repo, source } = repository;
    const pluginPath = getUserpluginPath(repo);

    // Ask for clone
    const cloneDialog = await dialog.showMessageBox({
        title: "Clone userplugin",
        message: `You are about to clone a userplugin from ${source}.`,
        type: "question",
        detail: `The repository name is "${repo}" and it is owned by "${owner}".\nThe repository URL is ${link}\n\n(If you did not request this intentionally, choose Cancel)`,
        buttons: ["Cancel", "Clone repository and continue install", "Open repository in browser"]
    });
    switch (cloneDialog.response) {
        case 0: {
            throw new Error("Rejected by user");
        }
        case 1: {
            await cloneRepo(repositoryUrl, repo);
            break;
        }
        case 2: {
            await shell.openExternal(repositoryUrl);
            throw new Error("silentStop");
        }
        default: throw new Error("Rejected by user");
    }

    // Get plugin meta
    const meta = await getPluginMeta(pluginPath).catch(async error => {
        await removeUserpluginDirectory(pluginPath);
        throw error;
    });

    // Review plugin
    const win = new BrowserWindow({
        maximizable: false,
        minimizable: false,
        width: 560,
        height: meta.usesNative || meta.usesPreSend ? 650 : 360,
        resizable: false,
        webPreferences: {
            devTools: true, nodeIntegration: false, contextIsolation: true, sandbox: true
        },
        title: "Review userplugin",
        modal: true,
        parent: BrowserWindow.getAllWindows()[0],
        show: false,
        autoHideMenuBar: true
    });
    return new Promise<string>((resolveInstall, rejectInstall) => {
        let actionStarted = false;
        win.once("closed", () => {
            if (actionStarted) return;
            actionStarted = true;
            removeUserpluginDirectory(pluginPath).then(
                () => rejectInstall(new Error("Rejected by user")), rejectInstall
            );
        });
        win.on("page-title-updated", () => {
            if (actionStarted) return;
            const title = win.webContents.getTitle();
            if (title !== "abortInstall" && title !== "install") return;
            actionStarted = true;
            void (async () => {
                switch (title) {
                    case "abortInstall": {
                        win.close();
                        await removeUserpluginDirectory(pluginPath);
                        throw new Error("Rejected by user");
                    }
                    case "install": {
                        win.close();
                        await build();
                        resolveInstall(JSON.stringify({
                            name: meta.name,
                            native: meta.usesNative
                        }));
                        break;
                    }
                }
            })().catch(rejectInstall);
        });
        win.loadURL(generateReviewPluginContent(meta)).then(() => { if (!win.isDestroyed()) win.show(); }).catch(async error => {
            actionStarted = true;
            win.close();
            await removeUserpluginDirectory(pluginPath).catch(() => undefined);
            rejectInstall(error);
        });
    });
}

async function build(): Promise<any> {
    return new Promise((resolve, reject) => {
        const proc = exec("pnpm build --dev", {
            cwd: join(vencordPath, ".."),
            shell: process.env.SHELL || process.env.ComSpec || "/bin/sh"
        });
        proc.once("error", reject);
        proc.once("close", () => {
            if (proc.exitCode !== 0) {
                reject("Failed to build Vencord, try building from console");
            }
            resolve("Success");
        });
    });
}

async function getPluginMeta(path: string, extra: object = {}): Promise<{
    name: string;
    description: string;
    usesPreSend: boolean;
    usesNative: boolean;
    directory?: string;
    remote: string;
    supportChannelID?: string;
}> {
    return new Promise((resolve, reject) => {
        const files = readdirSync(path);
        let fileToRead: "index.ts" | "index.tsx" | "index.js" | "index.jsx" | undefined;
        files.forEach(f => {
            if (f === "index.ts") fileToRead = "index.ts";
            if (f === "index.tsx") fileToRead = "index.tsx";
            if (f === "index.js") fileToRead = "index.js";
            if (f === "index.jsx") fileToRead = "index.jsx";
        });
        if (!fileToRead) return reject("Invalid plugin");

        const file = readFileSync(`${path}/${fileToRead}`, "utf8");
        let remoteURL;
        try {
            const remoteC = readFileSync(join(path, ".git/config"), "utf8");
            remoteURL = remoteC.match(/\[remote "origin"]\s+url = (https:\/\/(?:(?:git(?:hub|lab)\.com|git\.(?:[a-zA-Z0-9]|\.)+|codeberg\.org)\/(?!user-attachments)(?:[a-zA-Z0-9]|-)+\/(?:[a-zA-Z0-9]|-|\.)+(?:\.git)?|(plugins\.(nin0)\.dev)\/((?:[a-zA-Z0-9]|-|\.)+))(?:\/)?)\n/);
        } catch {
            remoteURL = null;
        }

        let supportChannelID;
        try {
            const meta = readFileSync(join(path, "meta.yml"), "utf8");
            const parsed = yaml.load(meta);
            if (parsed.thread && typeof parsed.thread === "string" && /^\d+$/.test(parsed.thread)) {
                supportChannelID = parsed.thread;
            }
        } catch {
            supportChannelID = null;
        }

        const rawMeta = file.match(PLUGIN_META_REGEX);
        if (!rawMeta) return reject("Invalid plugin metadata");
        resolve({
            name: rawMeta![1],
            description: rawMeta![2],
            usesPreSend: file.includes("PreSendListener") || file.includes("onBeforeMessage"),
            usesNative: files.includes("native.ts") || files.includes("native.js"),
            remote: remoteURL ? remoteURL[1] : "",
            supportChannelID,
            ...extra
        });

    });
}

async function cloneRepo(link: string, repo: string): Promise<void> {
    const destination = getUserpluginPath(repo);
    try {
        await assertSafeUserpluginDirectory(destination);
        const deleteReqDialog = await dialog.showMessageBox({
            title: "Error",
            message: "Plugin already exists",
            type: "error",
            detail: `The plugin that you tried to clone already exists at ${destination}.\nWould you like to delete this exact directory and reclone it?`,
            buttons: ["No", "Yes"]
        });
        if (deleteReqDialog.response !== 1) throw new Error("User rejected");
        await removeUserpluginDirectory(destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // Clone into a directory that this operation created. An existing junction
    // can therefore never redirect git outside the userplugins root.
    const stagingDirectory = await mkdtemp(join(userpluginsRoot, ".clone-"));
    try {
        await new Promise<void>((resolveClone, rejectClone) => {
            const proc = spawn(gitExecutable(), ["clone", "--", link, stagingDirectory], { cwd: userpluginsRoot, timeout: 120_000, stdio: "ignore", windowsHide: true });
            proc.once("error", rejectClone);
            proc.once("close", exitCode => exitCode === 0 ? resolveClone() : rejectClone(new Error("Failed to clone")));
        });
        await assertSafeUserpluginDirectory(stagingDirectory);

        try {
            await lstat(destination);
            throw new Error("The plugin destination appeared while cloning; refusing to replace it");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        await rename(stagingDirectory, destination);
    } catch (error) {
        await removeUserpluginDirectory(stagingDirectory).catch(() => undefined);
        throw error;
    }
}

function generateReviewPluginContent(meta: {
    name: string;
    description: string;
    usesPreSend: boolean;
    usesNative: boolean;
}): string {
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const template = pluginValidateContent.replace("%PLUGINNAME%", () => escape(meta.name)).replace("%PLUGINDESC%", () => escape(meta.description)).replace("%WARNINGHIDER%", !meta.usesNative && !meta.usesPreSend ? "[data-useless=\"warning\"] { display: none !important; }" : "").replace("%NATIVETSHIDER%", meta.usesNative ? "" : "#native-ts-warning { display: none !important; }").replace("%PRESENDHIDER%", meta.usesPreSend ? "" : "#pre-send-warning { display: none !important; }");
    const buf = Buffer.from(template).toString("base64");
    return `data:text/html;base64,${buf}`;
}

function getGitRevision(pluginDir: string, revision: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const revisionProc = spawn(gitExecutable(), ["rev-parse", "--verify", `${revision}^{commit}`], { cwd: pluginDir, timeout: 15_000, windowsHide: true });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            callback();
        };

        revisionProc.stdout?.setEncoding("utf8");
        revisionProc.stdout?.on("data", data => {
            if (stdout.length < 256) stdout += String(data).slice(0, 256 - stdout.length);
        });
        revisionProc.stderr?.on("data", data => {
            if (stderr.length < 8_192) stderr += String(data).slice(0, 8_192 - stderr.length);
        });
        revisionProc.once("error", error => settle(() => reject(error)));
        revisionProc.once("close", exitCode => {
            if (exitCode !== 0) return settle(() => reject(`Failed to resolve ${revision}. Git errors:\n\n${stderr.trim()}`));
            settle(() => resolve(stdout.trim()));
        });
    });
}

async function getUpdateReviewPlan(pluginDir: string): Promise<UpdateReviewPlan> {
    const localRevision = await getGitRevision(pluginDir, "HEAD");
    const targetRevision = await getGitRevision(pluginDir, "origin/HEAD");
    return createUpdateReviewPlan(localRevision, targetRevision);
}

function getUpdateCommits(pluginDir: string, logRange: string): Promise<UpdateCommit[]> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            callback();
        };
        const commitProc = spawn(gitExecutable(), [
            "log",
            "-z",
            `--max-count=${MAX_DISPLAYED_UPDATE_COMMITS + 1}`,
            "--format=%an%x00%h%x00%H%x00%s",
            logRange
        ], { cwd: pluginDir, timeout: 15_000, windowsHide: true });
        let rawOutput = "";
        let outputBytes = 0;
        let outputTooLarge = false;
        let stderr = "";

        commitProc.stdout?.setEncoding("utf8");
        commitProc.stdout?.on("data", data => {
            outputBytes += Buffer.byteLength(data);
            if (outputBytes > MAX_UPDATE_LOG_BYTES) {
                outputTooLarge = true;
                commitProc.kill();
                return;
            }
            rawOutput += String(data);
        });
        commitProc.stderr?.on("data", data => {
            if (stderr.length < 8_192) stderr += String(data).slice(0, 8_192 - stderr.length);
        });
        commitProc.once("error", error => settle(() => reject(error)));
        commitProc.once("close", exitCode => {
            if (outputTooLarge) return settle(() => reject("Git returned too much update metadata"));
            if (exitCode !== 0) return settle(() => reject(`Failed to inspect the update. Git errors:\n\n${stderr.trim()}`));
            try {
                const commits = parseUpdateCommits(rawOutput);
                settle(() => resolve(commits));
            } catch (error) {
                settle(() => reject((error as Error).message));
            }
        });
    });
}

async function reviewPluginUpdate(metadata: { name: string; description: string; remote: string; }, commits: UpdateCommit[]): Promise<boolean> {
    const review = createUpdateReviewModel(metadata, commits);
    const options = {
        type: "warning" as const,
        title: review.title,
        message: review.message,
        detail: review.detail,
        buttons: review.buttons,
        defaultId: 0,
        cancelId: 0,
        noLink: true
    };

    return runUpdateReview(review, {
        async showReview() {
            const parent = BrowserWindow.getAllWindows()[0];
            const result = parent
                ? await dialog.showMessageBox(parent, options)
                : await dialog.showMessageBox(options);
            return result.response;
        },
        openSource: sourceUrl => shell.openExternal(sourceUrl),
        async showOpenSourceError(error) {
            await dialog.showMessageBox({
                type: "error",
                title: "Unable to open source code",
                message: "The repository could not be opened.",
                detail: String(error),
                buttons: ["OK"],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            });
        }
    });
}

export async function getUserplugins() {
    const folderContents = await readdir(userpluginsRoot, {
        withFileTypes: true
    });
    const plugins = await Promise.allSettled(
        folderContents
            .filter(item => item.isDirectory())
            .map(async item => {
                try {
                    return {
                        path: await assertSafeUserpluginDirectory(getUserpluginPath(item.name)),
                        directory: item.name
                    };
                } catch {
                    return null;
                }
            })
            .map(async item => {
                const plugin = await item;
                return plugin == null ? null : getPluginMeta(plugin.path, { directory: plugin.directory });
            })
    );

    return plugins
        .flatMap(p => p.status === "fulfilled" && p.value != null ? [p.value] : []);
}

export async function updatePlugin(_, directory: string) {
    return new Promise((resolve, reject) => {
        let pluginDir: string;
        try {
            pluginDir = getUserpluginPath(directory);
        } catch {
            return reject("Invalid plugin directory");
        }

        async function doStuff() {
            try {
                pluginDir = await assertSafeUserpluginDirectory(pluginDir);
                const pluginMeta = await getPluginMeta(pluginDir);
                const reviewPlan = await getUpdateReviewPlan(pluginDir);
                const commits = await getUpdateCommits(pluginDir, reviewPlan.logRange);
                if (!await reviewPluginUpdate(pluginMeta, commits)) return reject("Rejected by user");

                const currentRevision = await getGitRevision(pluginDir, "HEAD");
                if (!isUpdateReviewPlanCurrent(reviewPlan, currentRevision)) {
                    return reject("The plugin repository changed while the update was being reviewed. Review the update again.");
                }

                await new Promise<void>((resolveRebase, rejectRebase) => {
                    const rebaseProc = spawn(gitExecutable(), ["rebase", reviewPlan.targetRevision], { cwd: pluginDir, timeout: 120_000, windowsHide: true });
                    let stderr = "";
                    let settled = false;
                    const settle = (callback: () => void) => {
                        if (settled) return;
                        settled = true;
                        callback();
                    };
                    rebaseProc.stderr?.on("data", data => {
                        if (stderr.length < 8_192) stderr += String(data).slice(0, 8_192 - stderr.length);
                    });
                    rebaseProc.once("error", error => settle(() => rejectRebase(error)));
                    rebaseProc.once("close", exitCode => {
                        if (exitCode !== 0) {
                            const detail = stderr.trim() || `Git exited with code ${exitCode}`;
                            return settle(() => rejectRebase(`Failed to apply the reviewed update. Git errors:\n\n${detail}`));
                        }
                        settle(resolveRebase);
                    });
                });
                await build();
                resolve(JSON.stringify({
                    name: pluginMeta.name,
                    native: pluginMeta.usesNative
                }));
            } catch (error) {
                reject(error instanceof Error ? error.toString() : error);
            }
        }
        void doStuff();
    });
}

export async function openGitPathModal(_: any) {
    const gitPathSet: string | undefined = NativeSettings.store.plugins.UserpluginInstaller?.gitPath;
    const win = new BrowserWindow({
        maximizable: false,
        minimizable: false,
        width: 560,
        height: 400,
        resizable: false,
        webPreferences: {
            devTools: true, nodeIntegration: false, contextIsolation: true, sandbox: true
        },
        title: "Set Git path",
        modal: true,
        parent: BrowserWindow.getAllWindows()[0],
        show: false,
        autoHideMenuBar: true
    });
    win.on("page-title-updated", async _ => {
        const t = win.webContents.getTitle();
        if (t === "abort") win.close();
        if (t.startsWith("ok")) {
            if (!NativeSettings.store.plugins.UserpluginInstaller) {
                NativeSettings.store.plugins.UserpluginInstaller = {
                    gitPath: undefined
                };
            }
            if (t === "ok-") {
                NativeSettings.store.plugins.UserpluginInstaller.gitPath = undefined;
            } else {
                const gitPath2 = t.split("-").toSpliced(0, 1).join("-");
                NativeSettings.store.plugins.UserpluginInstaller.gitPath = gitPath2;
            }
            win.close();
        }
        if (t.startsWith("check")) {
            try {
                const gitProc = spawn(t === "check-" ? "git" : t.split("-").toSpliced(0, 1).join("-"), ["--version"], { timeout: 15_000, windowsHide: true });
                let rawOutput = "";
                gitProc.stdout?.on("data", d => {
                    rawOutput += String(d).slice(0, Math.max(0, 8192 - rawOutput.length));
                });
                gitProc.on("error", e => {
                    dialog.showMessageBox({
                        title: "Error",
                        message: "Git error",
                        type: "error",
                        detail: `${e}\n\nDouble-check the path you entered.`,
                        buttons: ["OK"]
                    });
                });
                gitProc.once("close", () => {
                    if (gitProc.exitCode === 0) {
                        dialog.showMessageBox({
                            title: "Success",
                            message: "Git works!",
                            type: "info",
                            detail: `Successfully called ${rawOutput.trim()}`,
                            buttons: ["OK"]
                        });
                    }
                });
            } catch (e) {
                dialog.showMessageBox({
                    title: "Error",
                    message: "Git error",
                    type: "error",
                    detail: `${e}\n\nDouble-check the path you entered.`,
                    buttons: ["OK"]
                });
            }
        }
    });
    await win.loadURL(`data:text/html;base64,${Buffer.from(setGitPathContent).toString("base64")}`);
    win.show();
    if (gitPathSet) {
        win.webContents.executeJavaScript(`document.querySelector("input").value = ${JSON.stringify(gitPathSet)};`);
    }
}
