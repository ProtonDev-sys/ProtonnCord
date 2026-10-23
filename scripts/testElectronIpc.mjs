/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// ELECTRON_BIN=/path/to/electron xvfb-run -a node scripts/testElectronIpc.mjs [build-directory]
// Uses actual compiled preloads and IPC registration with local pages and fake
// privileged operations. No Discord account, server, credentials or traffic.
const repository = fileURLToPath(new URL("../", import.meta.url));
const buildDirectory = resolve(repository, process.argv[2] ?? "dist");
const electron = process.env.ELECTRON_BIN;
assert.ok(electron, "Set ELECTRON_BIN to an installed Electron executable");
for (const host of ["desktop", "equibop"]) await access(join(buildDirectory, host, "preload.js"));
const directory = await mkdtemp(join(tmpdir(), "protonncord-electron-ipc-"));

try {
    await build({
        stdin: { contents: 'export { ipcMain, registerQuickCssEditor } from "./ipc"; export { IpcEvents } from "@shared/IpcEvents"; import "./ipcPlugins";',
            resolveDir: join(repository, "src/main"), loader: "ts" },
        absWorkingDir: repository, tsconfig: join(repository, "tsconfig.json"),
        bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: join(directory, "boundary.cjs"),
        plugins: [{ name: "native-fixture", setup(builder) {
            builder.onResolve({ filter: /^~pluginNatives$/ }, () => ({ path: "natives", namespace: "fixture" }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
                export default { NativeFixture: { eager: false, methods: ["ping"], load() {
                    globalThis.fixtureNativeLoads++;
                    return { ping(event, value) { globalThis.fixtureNativeCalls++; return { origin: event.senderFrame.origin, value }; } };
                } } };
            ` }));
        } }],
    });
    const patcher = await readFile(join(repository, "src/main/patcher.ts"), "utf8");
    const permissionStart = patcher.indexOf("function isDiscordOrigin(");
    const permissionEnd = patcher.indexOf("if (!IS_VANILLA)");
    assert.ok(permissionStart >= 0 && permissionEnd > permissionStart);
    await build({
        stdin: { contents: `import * as electron from "electron";\n${patcher.slice(permissionStart, permissionEnd)}\nexport { installDiscordMediaPermissionBypass };`, loader: "ts" },
        bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: join(directory, "permissions.cjs"),
    });
    await writeFile(join(directory, "host-preload.cjs"), 'require("electron").contextBridge.exposeInMainWorld("testHostPreload", true);\n');
    await writeFile(join(directory, "raw-preload.cjs"), `
        const { ipcRenderer, contextBridge } = require("electron");
        contextBridge.exposeInMainWorld("probe", {
            invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
            sync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
        });
    `);
    await writeFile(join(directory, "equibop-loader.cjs"), `
        const { ipcRenderer } = require("electron/renderer");
        Function("require", "Buffer", "process", "clearImmediate", "setImmediate",
            ipcRenderer.sendSync("fixture:get-equibop-preload"))
            (require, Buffer, process, clearImmediate, setImmediate);
    `);
    await writeFile(join(directory, "main.cjs"), `(${runElectronChecks.toString()})(${JSON.stringify(buildDirectory)});\n`);
    const args = ["--disable-gpu"];
    if (process.getuid?.() === 0) args.push("--no-sandbox");
    if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless");
    const electronEnvironment = { ...process.env };
    delete electronEnvironment.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
        const child = spawn(electron, [...args, join(directory, "main.cjs")], {
            cwd: repository, stdio: "inherit", timeout: 60_000, killSignal: "SIGKILL",
            env: electronEnvironment,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Electron IPC smoke failed (${signal ?? `exit ${code}`})`)));
    });
    const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
    assert.equal(result.assertions, "all passed", "Electron must finish every smoke check before reporting success");
} finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("protonncord-electron-ipc-"));
    await rm(directory, { recursive: true, force: true });
}

// Serialized into an isolated Electron entry point; keep its dependencies local.
function runElectronChecks(buildDirectory) {
    const assert = require("node:assert/strict");
    const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { app, BrowserWindow, session, ipcMain: fixtureIpc } = require("electron");
    const profile = join(__dirname, "profile");
    mkdirSync(profile, { recursive: true });
    app.setPath("userData", profile);
    app.disableHardwareAcceleration();
    app.on("window-all-closed", () => {});
    process.env.DISCORD_PRELOAD = join(__dirname, "host-preload.cjs");
    globalThis.fixtureNativeLoads = 0;
    globalThis.fixtureNativeCalls = 0;
    const { ipcMain, registerQuickCssEditor, IpcEvents: events } = require("./boundary.cjs");
    let css = "fixture css";
    let builds = 0;
    let watcherStarts = 0;
    ipcMain.on(events.GET_SETTINGS, event => { event.returnValue = { fixture: true }; });
    ipcMain.on(events.GET_MONACO_THEME, event => { event.returnValue = "vs-dark"; });
    ipcMain.on(events.PRELOAD_GET_RENDERER_JS, event => { event.returnValue = "globalThis.testRendererInjected = true;"; });
    ipcMain.handle(events.INIT_FILE_WATCHERS, () => { watcherStarts++; });
    ipcMain.handle(events.BUILD, () => { builds++; return true; });
    ipcMain.handle(events.GET_QUICK_CSS, () => css);
    ipcMain.handle(events.SET_QUICK_CSS, (_, value) => { css = value; });
    // Equibop loads the compiled mod through Function inside a sandboxed
    // preload. Its fixture transport supplies only this fixed public script.
    const equibopPreload = readFileSync(join(buildDirectory, "equibop/preload.js"), "utf8");
    fixtureIpc.on("fixture:get-equibop-preload", event => { event.returnValue = equibopPreload; });

    function window(preload, subframes = false, sandbox = false) {
        return new BrowserWindow({ show: false, webPreferences: {
            preload, contextIsolation: true, nodeIntegration: false, sandbox,
            nodeIntegrationInSubFrames: subframes,
        } });
    }
    const evaluate = (win, code) => win.webContents.executeJavaScript(code);
    const invoke = (channel, ...args) => `probe.invoke(${[channel, ...args].map(value => JSON.stringify(value)).join(",")})`;
    const sync = channel => `probe.sync(${JSON.stringify(channel)})`;
    async function rejected(win, expression) {
        const value = await evaluate(win, `(async () => { try { await (${expression}); return "accepted"; } catch (error) { return error.message; } })()`);
        assert.match(value, /Untrusted Protonn Cord IPC request/);
    }

    const deadline = setTimeout(() => { console.error("Electron IPC smoke deadline exceeded"); app.exit(1); }, 45_000);
    app.whenReady().then(async () => {
        // Override both network schemes before creating any renderer. These
        // fixtures never reach Discord or any other network service.
        const respond = request => {
            const path = new URL(request.url).pathname;
            const html = path === "/parent" ? '<iframe src="https://discord.com/child"></iframe>'
                : path === "/media-parent" ? '<iframe src="https://attacker.invalid/media-child" allow="camera; microphone"></iframe>'
                    : "<title>IPC fixture</title>";
            return new Response(`<!doctype html>${html}`, { headers: {
                "content-type": "text/html",
                ...(path === "/opaque" ? { "content-security-policy": "sandbox allow-scripts" } : {}),
                ...(path === "/media-parent" ? { "permissions-policy": 'camera=(self "https://attacker.invalid"), microphone=(self "https://attacker.invalid")' } : {}),
            } });
        };
        session.defaultSession.protocol.handle("https", respond);
        session.defaultSession.protocol.handle("http", respond);

        for (const url of ["https://attacker.invalid/", "http://discord.com/", "https://discord.com:444/"]) {
            const win = window(join(__dirname, "raw-preload.cjs"));
            await win.loadURL(url);
            assert.equal(await evaluate(win, sync(events.GET_SETTINGS)), null);
            assert.equal(await evaluate(win, sync(events.GET_PLUGIN_IPC_METHOD_MAP)), null);
            await rejected(win, invoke(events.BUILD));
            await rejected(win, invoke("VencordPluginNative_NativeFixture_ping", "value"));
            win.destroy();
        }
        const opaque = window(join(__dirname, "raw-preload.cjs"));
        await opaque.loadURL("https://discord.com/opaque");
        assert.equal(opaque.webContents.mainFrame.origin, "null");
        if (await evaluate(opaque, "typeof probe") === "object") {
            assert.equal(await evaluate(opaque, sync(events.GET_SETTINGS)), null);
            await rejected(opaque, invoke(events.BUILD));
            console.log("PASS opaque main-frame IPC rejected using the security origin.");
        } else console.log("PASS opaque document has no preload bridge.");
        opaque.destroy();

        const parent = window(join(__dirname, "raw-preload.cjs"), true);
        await parent.loadURL("https://discord.com/parent");
        const child = parent.webContents.mainFrame.frames.find(frame => frame.url === "https://discord.com/child");
        assert.ok(child);
        assert.equal(child.origin, "https://discord.com");
        assert.equal(await child.executeJavaScript(sync(events.GET_SETTINGS)), null);
        assert.match(await child.executeJavaScript(`${invoke(events.BUILD)}.then(() => "accepted", error => error.message)`), /Untrusted/);
        parent.destroy();
        assert.equal(builds, 0);
        assert.equal(globalThis.fixtureNativeLoads, 0);
        console.log("PASS foreign, insecure, opaque and child-frame callers cannot reach privileged IPC.");

        for (const host of ["desktop", "equibop"]) {
            const directPreload = join(buildDirectory, host, "preload.js");
            const sandbox = host === "equibop";
            const preload = sandbox ? join(__dirname, "equibop-loader.cjs") : directPreload;
            for (const origin of ["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com", "https://discordapp.com"]) {
                const win = window(preload, false, sandbox);
                await win.loadURL(`${origin}/channels/@me`);
                const result = await evaluate(win, `(async () => ({
                    bridge: typeof VencordNative,
                    ping: await VencordNative.pluginHelpers.NativeFixture.ping("value"),
                    settings: VencordNative.settings.get(), css: await VencordNative.quickCss.get(),
                    injected: globalThis.testRendererInjected === true, host: globalThis.testHostPreload === true,
                }))()`);
                assert.deepEqual(result, { bridge: "object", ping: { origin, value: "value" }, settings: { fixture: true }, css, injected: host === "desktop", host: host === "desktop" });
                win.destroy();
            }
            const foreign = window(preload, false, sandbox);
            await foreign.loadURL("https://attacker.invalid/");
            assert.equal(await evaluate(foreign, "typeof VencordNative"), "undefined");
            assert.equal(await evaluate(foreign, "globalThis.testRendererInjected === true"), false);
            assert.equal(await evaluate(foreign, "globalThis.testHostPreload === true"), host === "desktop");
            foreign.destroy();

            const framed = window(preload, true, sandbox);
            await framed.loadURL("https://discord.com/parent");
            const frame = framed.webContents.mainFrame.frames.find(frame => frame.url === "https://discord.com/child");
            assert.ok(frame);
            assert.equal(await frame.executeJavaScript("typeof VencordNative"), "undefined");
            framed.destroy();

            const editorUrl = "data:text/html;base64,PCFkb2N0eXBlIGh0bWw+PHRpdGxlPkVkaXRvcjwvdGl0bGU+";
            const editor = window(directPreload);
            registerQuickCssEditor(editor.webContents, editorUrl);
            await editor.loadURL(editorUrl);
            assert.equal(await evaluate(editor, "typeof VencordNative"), "undefined");
            assert.equal(await evaluate(editor, "getTheme()"), "vs-dark");
            assert.equal(await evaluate(editor, "getCurrentCss()"), css);
            await evaluate(editor, `setCss("edited ${host}")`);
            await new Promise(resolve => setTimeout(resolve, 500));
            assert.equal(css, `edited ${host}`);
            await editor.loadURL("data:text/html,other-document");
            await rejected(editor, "getCurrentCss()");
            editor.destroy();
            console.log(`PASS ${host}: actual compiled preload startup, navigation, injection, editor save and restricted access.`);
        }
        assert.equal(globalThis.fixtureNativeLoads, 1);
        assert.equal(globalThis.fixtureNativeCalls, 8);
        assert.equal(watcherStarts, 10);
        require("./permissions.cjs").installDiscordMediaPermissionBypass();
        let delegatedMediaChecks = 0;
        session.defaultSession.setPermissionCheckHandler(() => { delegatedMediaChecks++; return false; });
        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        const media = window(join(__dirname, "raw-preload.cjs"));
        await media.loadURL("https://discord.com/media-parent");
        const mediaChild = media.webContents.mainFrame.frames.find(frame => frame.url === "https://attacker.invalid/media-child");
        assert.ok(mediaChild);
        for (const permission of ["camera", "microphone"]) {
            const query = `navigator.permissions.query({ name: ${JSON.stringify(permission)} }).then(permission => permission.state)`;
            assert.equal(await evaluate(media, query), "granted");
            assert.notEqual(await mediaChild.executeJavaScript(query), "granted");
        }
        assert.ok(delegatedMediaChecks > 0, "untrusted media checks must reach the host's permission policy");
        media.destroy();
        console.log("PASS camera and microphone permission checks trust the requester, with foreign frames delegated to the host policy.");
        const result = JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, assertions: "all passed" });
        writeFileSync(join(__dirname, "result.json"), result);
        console.log(result);
        clearTimeout(deadline);
        app.exit(0);
    }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
