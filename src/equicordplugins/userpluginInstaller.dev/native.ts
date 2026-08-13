/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NativeSettings } from "@main/settings";
import { exec, spawn } from "child_process";
import { BrowserWindow, dialog, shell, WebContentsView } from "electron";
import { existsSync, readdirSync, readFileSync } from "fs";
import { lstat, mkdir, readdir, readFile, rm } from "fs/promises";
import { basename, join, resolve } from "path";
import yaml from "yaml-js";

// @ts-ignore fuck off
import pluginValidateContent from "./misc/pluginValidate.txt"; // i would use HTML but esbuild is being whiny
// @ts-ignore fuck off
import setGitPathContent from "./misc/setGitPath.txt";
import { parseUserpluginRepositoryUrl, resolveUserpluginDirectory } from "./repositorySafety";
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

function getUserpluginPath(name: string): string {
    return resolveUserpluginDirectory(userpluginsRoot, name);
}

async function removeUserpluginDirectory(destination: string): Promise<void> {
    // Never follow or recursively operate through a user-controlled reparse point.
    if ((await lstat(destination)).isSymbolicLink()) throw new Error("Refusing to remove a linked plugin directory");
    await rm(destination, { recursive: true });
}

export async function ensurePluginsDirectory(_: any) {
    if (!IS_DEV) return;
    try {
        await mkdir(userpluginsRoot, { recursive: true });
    } catch(e) { }
}

export async function rmPlugin(_, name: string): Promise<string> {
    // eslint-disable-next-line
    return new Promise(async (resolve, reject) => {
        const ups = await getUserplugins();
        const pl = ups.find(p => p.directory! === name);
        if (!pl) return;

        const deleteReqDialog = await dialog.showMessageBox({
            title: "Uninstall plugin",
            message: `Uninstall ${pl.name}`,
            type: "error",
            detail: `The uninstall of the userplugin ${pl.name} has been requested. Would you like to do so?\n\nIf you did not initiate this, press No.`,
            buttons: ["No", "Yes"]
        });

        if (deleteReqDialog.response !== 1) return reject("User rejected");
        await removeUserpluginDirectory(getUserpluginPath(name));

        await build();
        resolve("Done");
    });
}

export async function isUpdateAvailableForPlugin(_, name: string): Promise<boolean> {
    return new Promise(resolve => {
        const pluginDir = getUserpluginPath(name);
        const otherProc = exec("git fetch", {
            cwd: pluginDir
        });
        otherProc.once("close", () => {
            async function doStuff() {
                try {
                    const head = (await readFile(join(pluginDir, ".git/HEAD"), "utf8")).match(/^ref: (.+)/)![1];
                    const remoteHead = (await readFile(join(pluginDir, ".git/refs/remotes/origin/HEAD"), "utf8")).match(/^ref: (.+)/)![1];
                    const localCommit = await readFile(join(pluginDir, ".git", head), "utf8");
                    const remoteCommit = await readFile(join(pluginDir, ".git", remoteHead), "utf8");

                    resolve(localCommit !== remoteCommit);
                }
                catch (e) {
                    resolve(false);
                }
            }
            doStuff();
        });
    });
}

export function initPluginInstall(_, link: string): Promise<string> {
    // eslint-disable-next-line
    return new Promise(async (resolve, reject) => {
        const repository = parseUserpluginRepositoryUrl(link);
        if (!repository) return reject("Invalid link");
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
                return reject("Rejected by user");
            }
            case 1: {
                await cloneRepo(repositoryUrl, repo);
                break;
            }
            case 2: {
                await shell.openExternal(repositoryUrl);
                return reject("silentStop");
            }
        }

        // Get plugin meta
        const meta = await getPluginMeta(pluginPath);

        // Review plugin
        const win = new BrowserWindow({
            maximizable: false,
            minimizable: false,
            width: 560,
            height: meta.usesNative || meta.usesPreSend ? 650 : 360,
            resizable: false,
            webPreferences: {
                devTools: true
            },
            title: "Review userplugin",
            modal: true,
            parent: BrowserWindow.getAllWindows()[0],
            show: false,
            autoHideMenuBar: true
        });
        const reView /* haha got it */ = new WebContentsView({
            webPreferences: {
                devTools: true,
                nodeIntegration: true
            }
        });
        win.contentView.addChildView(reView);
        win.loadURL(generateReviewPluginContent(meta));
        win.on("page-title-updated", async e => {
            switch (win.webContents.getTitle() as "abortInstall" | "reviewCode" | "install") {
                case "abortInstall": {
                    win.close();
                    await removeUserpluginDirectory(pluginPath);
                    return reject("Rejected by user");
                }
                case "install": {
                    win.close();
                    try {
                        await build();
                    }
                    catch (e) {
                        reject((e as Error).toString());
                    }
                    resolve(JSON.stringify({
                        name: meta.name,
                        native: meta.usesNative
                    }));
                    break;
                }
            }
        });
        win.show();
    });
}

async function build(): Promise<any> {
    return new Promise((resolve, reject) => {
        const proc = exec("pnpm build --dev", {
            cwd: join(vencordPath, ".."),
            shell: process.env.SHELL || process.env.ComSpec || "/bin/sh"
        });
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
        if (!fileToRead) reject("Invalid plugin");

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
    return new Promise((resolve, reject) => {
        const proc = spawn("git", ["clone", "--", link, destination], {
            cwd: userpluginsRoot
        });
        proc.once("close", async () => {
            if (proc.exitCode !== 0) {
                if (!existsSync(destination))
                    return reject("Failed to clone");
                const deleteReqDialog = await dialog.showMessageBox({
                    title: "Error",
                    message: "Plugin already exists",
                    type: "error",
                    detail: `The plugin that you tried to clone already exists at ${destination}.\nWould you like to delete this exact directory and reclone it?`,
                    buttons: ["No", "Yes"]
                });
                if (deleteReqDialog.response !== 1) return reject("User rejected");
                await removeUserpluginDirectory(destination);
                await cloneRepo(link, repo);
            }
            resolve();
        });
    });
}

function generateReviewPluginContent(meta: {
    name: string;
    description: string;
    usesPreSend: boolean;
    usesNative: boolean;
}): string {
    const template = pluginValidateContent.replace("%PLUGINNAME%", meta.name.replaceAll("<", "&lt;")).replace("%PLUGINDESC%", meta.description.replaceAll("<", "&lt;")).replace("%WARNINGHIDER%", !meta.usesNative && !meta.usesPreSend ? "[data-useless=\"warning\"] { display: none !important; }" : "").replace("%NATIVETSHIDER%", meta.usesNative ? "" : "#native-ts-warning { display: none !important; }").replace("%PRESENDHIDER%", meta.usesPreSend ? "" : "#pre-send-warning { display: none !important; }");
    const buf = Buffer.from(template).toString("base64");
    return `data:text/html;base64,${buf}`;
}

function getGitRevision(pluginDir: string, revision: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const revisionProc = spawn("git", ["rev-parse", "--verify", `${revision}^{commit}`], { cwd: pluginDir });
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
        const commitProc = spawn("git", [
            "log",
            "-z",
            `--max-count=${MAX_DISPLAYED_UPDATE_COMMITS + 1}`,
            "--format=%an%x00%h%x00%H%x00%s",
            logRange
        ], { cwd: pluginDir });
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
            .map(item => {
                try {
                    return { path: getUserpluginPath(item.name), directory: item.name };
                } catch {
                    return null;
                }
            })
            .filter(item => item != null)
            .map(({ path, directory }) => getPluginMeta(path, { directory }))
    );

    return plugins
        .filter(p => p.status === "fulfilled")
        .map(p => p.value);
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
                const pluginMeta = await getPluginMeta(pluginDir);
                const reviewPlan = await getUpdateReviewPlan(pluginDir);
                const commits = await getUpdateCommits(pluginDir, reviewPlan.logRange);
                if (!await reviewPluginUpdate(pluginMeta, commits)) return reject("Rejected by user");

                const currentRevision = await getGitRevision(pluginDir, "HEAD");
                if (!isUpdateReviewPlanCurrent(reviewPlan, currentRevision)) {
                    return reject("The plugin repository changed while the update was being reviewed. Review the update again.");
                }

                await new Promise<void>((resolveRebase, rejectRebase) => {
                    const rebaseProc = spawn("git", ["rebase", reviewPlan.targetRevision], { cwd: pluginDir });
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
            devTools: true
        },
        title: "Set Git path",
        modal: true,
        parent: BrowserWindow.getAllWindows()[0],
        show: false,
        autoHideMenuBar: true
    });
    const reView = new WebContentsView({
        webPreferences: {
            devTools: true,
            nodeIntegration: true
        }
    });
    win.contentView.addChildView(reView);
    win.loadURL(`data:text/html;base64,${Buffer.from(setGitPathContent).toString("base64")}`);
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
                const gitProc = spawn(t === "check-" ? "git" : t.split("-").toSpliced(0, 1).join("-"), ["--version"]);
                let rawOutput = "";
                gitProc.stdout?.on("data", d => {
                    rawOutput += String(d);
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
    win.show();
    if (gitPathSet) {
        win.webContents.executeJavaScript(`document.querySelector("input").value = ${JSON.stringify(gitPathSet)};`);
    }
}
