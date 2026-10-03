/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import "./updater";
import "./ipcPlugins";
import "./settings";

import { debounce } from "@shared/debounce";
import { IpcEvents } from "@shared/IpcEvents";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, systemPreferences, type WebContents } from "electron";
import monacoHtml from "file://monacoWin.html?minify&base64";
import { closeSync, FSWatcher, fsyncSync, mkdirSync, openSync, readFileSync, watch, writeFileSync } from "fs";
import { open, readdir, readFile, unlink } from "fs/promises";
import { release } from "os";
import { join } from "path";

import { registerCspIpcHandlers } from "./csp/manager";
import { getThemeInfo, stripBOM, UserThemeHeader } from "./themes";
import { ALLOWED_PROTOCOLS, QUICK_CSS_PATH, SETTINGS_DIR, THEMES_DIR } from "./utils/constants";
import { ensureSafePath } from "./utils/ensureSafePath";
import { makeLinksOpenExternally } from "./utils/externalLinks";

const RENDERER_CSS_PATH = join(__dirname, "renderer.css");

mkdirSync(THEMES_DIR, { recursive: true });

registerCspIpcHandlers();

function readCss() {
    return readFile(QUICK_CSS_PATH, "utf-8").catch(() => "");
}

async function listThemes(): Promise<UserThemeHeader[]> {
    const files = await readdir(THEMES_DIR).catch(() => []);

    const themeInfo: UserThemeHeader[] = [];

    for (const fileName of files) {
        if (!fileName.endsWith(".css")) continue;

        const data = await getThemeData(fileName).then(stripBOM).catch(() => null);
        if (data == null) continue;

        themeInfo.push(getThemeInfo(data, fileName));
    }

    return themeInfo;
}

function getThemeData(fileName: string) {
    fileName = fileName.replace(/\?v=\d+$/, "");
    const safePath = ensureSafePath(THEMES_DIR, fileName);
    if (!safePath) return Promise.reject(`Unsafe path ${fileName}`);
    return readFile(safePath, "utf-8");
}

ipcMain.handle(IpcEvents.OPEN_QUICKCSS, () => shell.openPath(QUICK_CSS_PATH));

ipcMain.handle(IpcEvents.OPEN_EXTERNAL, (_, url) => {
    try {
        var { protocol } = new URL(url);
    } catch {
        throw "Malformed URL";
    }
    if (!ALLOWED_PROTOCOLS.includes(protocol))
        throw "Disallowed protocol.";

    shell.openExternal(url)
        .catch(err => console.error("[Vencord] Failed to open external link", url, err));
});

ipcMain.handle(IpcEvents.GET_QUICK_CSS, () => readCss());
ipcMain.handle(IpcEvents.SET_QUICK_CSS, (_, css) => {
    if (typeof css !== "string") throw new Error("Invalid QuickCSS value");
    return writeFileSync(QUICK_CSS_PATH, css);
});

ipcMain.handle(IpcEvents.GET_THEMES_LIST, () => listThemes());
ipcMain.handle(IpcEvents.GET_THEME_DATA, (_, fileName) => getThemeData(fileName));
ipcMain.handle(IpcEvents.DELETE_THEME, (_, fileName) => {
    const safePath = ensureSafePath(THEMES_DIR, fileName);
    if (!safePath) return Promise.reject(`Unsafe path ${fileName}`);
    return unlink(safePath);
});
ipcMain.handle(IpcEvents.GET_THEME_SYSTEM_VALUES, () => {
    let accentColor = systemPreferences.getAccentColor?.() ?? "";

    if (accentColor.length && accentColor[0] !== "#") {
        accentColor = `#${accentColor}`;
    }

    return {
        "os-accent-color": accentColor
    };
});

ipcMain.handle(IpcEvents.OPEN_THEMES_FOLDER, () => shell.openPath(THEMES_DIR));
ipcMain.handle(IpcEvents.OPEN_SETTINGS_FOLDER, () => shell.openPath(SETTINGS_DIR));

let stopWatching: WeakMap<WebContents, () => void> | undefined;

ipcMain.handle(IpcEvents.INIT_FILE_WATCHERS, async ({ sender }) => {
    const watchersBySender = stopWatching ??= new WeakMap();
    watchersBySender.get(sender)?.();
    if (sender.isDestroyed?.()) return;

    const watchers: FSWatcher[] = [];
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        watchers.forEach(watcher => watcher.close());
        sender.removeListener("destroyed", stop);
        if (watchersBySender.get(sender) === stop) watchersBySender.delete(sender);
    };
    const addWatcher = (watcher: FSWatcher) => {
        watchers.push(watcher);
        watcher.on?.("error", stop);
    };
    watchersBySender.set(sender, stop);
    sender.once("destroyed", stop);

    await open(QUICK_CSS_PATH, "a+").then(fd => fd.close()).catch(() => { });
    if (stopped) return;

    try {
        addWatcher(watch(QUICK_CSS_PATH, { persistent: false }, debounce(async () => {
            const css = await readCss();
            if (!stopped) sender.postMessage(IpcEvents.QUICK_CSS_UPDATE, css);
        }, 50)));
    } catch { }

    try {
        addWatcher(watch(THEMES_DIR, { persistent: false }, debounce(() => {
            if (!stopped) sender.postMessage(IpcEvents.THEME_UPDATE, void 0);
        })));

        if (IS_DEV) {
            addWatcher(watch(RENDERER_CSS_PATH, { persistent: false }, async () => {
                const css = await readFile(RENDERER_CSS_PATH, "utf-8").catch(() => null);
                if (!stopped && css !== null) sender.postMessage(IpcEvents.RENDERER_CSS_UPDATE, css);
            }));
        }
    } catch (error) {
        stop();
        throw error;
    }
});

ipcMain.on(IpcEvents.GET_MONACO_THEME, e => {
    e.returnValue = nativeTheme.shouldUseDarkColors ? "vs-dark" : "vs-light";
});

let monacoWin: BrowserWindow | null = null;
let closeRequestId = 0;
let pendingEditorClose: { window: BrowserWindow; requestId: number; timer: ReturnType<typeof setTimeout>; } | undefined;
let editorCloseAllowed = false;
let quitAfterEditorClose = false;

function cancelEditorClose(error: string) {
    if (!pendingEditorClose) return;
    const { window, timer } = pendingEditorClose;
    clearTimeout(timer);
    pendingEditorClose = undefined;
    quitAfterEditorClose = false;
    try {
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
            window.webContents.send(IpcEvents.MONACO_CLOSE, null);
    } catch (sendError) {
        console.error("[Protonn Cord] Failed to reset QuickCSS close state", sendError);
    }
    try {
        if (!window.isDestroyed()) window.show();
    } catch (showError) {
        console.error("[Protonn Cord] Failed to show the QuickCSS editor", showError);
    }
    console.error("[Protonn Cord] QuickCSS close cancelled", error);
}

ipcMain.handle(IpcEvents.MONACO_CLOSE_ACK, ({ sender }, requestId, error) => {
    if (!pendingEditorClose || sender !== pendingEditorClose.window.webContents
        || requestId !== pendingEditorClose.requestId) throw new Error("Unexpected QuickCSS close acknowledgement");
    if (error !== undefined) {
        cancelEditorClose(String(error));
        return;
    }
    const { window, timer } = pendingEditorClose;
    try {
        const descriptor = openSync(QUICK_CSS_PATH, "a");
        try {
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }
    } catch (saveError) {
        cancelEditorClose(String(saveError));
        return;
    }
    clearTimeout(timer);
    pendingEditorClose = undefined;
    editorCloseAllowed = true;
    window.close();
});

ipcMain.handle(IpcEvents.OPEN_MONACO_EDITOR, async () => {
    if (monacoWin && !monacoWin.isDestroyed()) {
        monacoWin.show();
        monacoWin.focus();
        return;
    }

    monacoWin = new BrowserWindow({
        title: "Protonn Cord QuickCSS Editor",
        autoHideMenuBar: true,
        darkTheme: true,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "white",
        webPreferences: {
            preload: join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    editorCloseAllowed = false;
    const window = monacoWin;
    window.on("close", event => {
        if (editorCloseAllowed) return;
        event.preventDefault();
        if (pendingEditorClose) return;
        const requestId = ++closeRequestId;
        const timer = setTimeout(() => cancelEditorClose("Save acknowledgement timed out"), 10000);
        pendingEditorClose = { window, requestId, timer };
        try {
            window.webContents.send(IpcEvents.MONACO_CLOSE, requestId);
        } catch (error) {
            cancelEditorClose(String(error));
        }
    });
    window.once("closed", () => {
        if (pendingEditorClose?.window === window) {
            clearTimeout(pendingEditorClose.timer);
            pendingEditorClose = undefined;
        }
        monacoWin = null;
        if (quitAfterEditorClose) {
            quitAfterEditorClose = false;
            app.quit();
        }
    });

    makeLinksOpenExternally(monacoWin);

    await monacoWin.loadURL(`data:text/html;base64,${monacoHtml}`);
});

let quitPromptPending = false;

app.on("before-quit", async event => {
    if (monacoWin && !monacoWin.isDestroyed()) {
        event.preventDefault();
        if (pendingEditorClose) {
            quitAfterEditorClose = true;
            return;
        }
        if (monacoWin.isVisible()) {
            quitAfterEditorClose = true;
            monacoWin.close();
            return;
        }
        if (quitPromptPending) return;
        quitPromptPending = true;
        try {
            const result = await dialog.showMessageBox({
                type: "question",
                buttons: ["Cancel", "Close Anyway"],
                defaultId: 0,
                cancelId: 0,
                title: "QuickCSS Editor Open",
                message: "QuickCSS editor is still open in the background.",
                detail: "Do you want to close Discord anyway? This will also close the QuickCSS editor."
            });

            if (result.response === 1 && monacoWin && !monacoWin.isDestroyed()) {
                quitAfterEditorClose = true;
                monacoWin.close();
            }
        } catch (error) {
            console.error("[Protonn Cord] Failed to confirm closing the QuickCSS editor", error);
        } finally {
            quitPromptPending = false;
        }
    }
});

ipcMain.handle(IpcEvents.GET_RENDERER_CSS, () => readFile(RENDERER_CSS_PATH, "utf-8"));

if (IS_DISCORD_DESKTOP) {
    ipcMain.on(IpcEvents.PRELOAD_GET_RENDERER_JS, e => {
        e.returnValue = readFileSync(join(__dirname, "renderer.js"), "utf-8");
    });
}

ipcMain.on(IpcEvents.SUPPORTS_WINDOWS_MATERIAL, e => {
    e.returnValue = process.platform === "win32" && Number(release().split(".")[2]) >= 22621;
});
