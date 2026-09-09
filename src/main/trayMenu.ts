/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcEvents } from "@shared/IpcEvents";
import { gitHashShort } from "@shared/vencordUserAgent";
import { BrowserWindow, ipcMain, Menu, MenuItemConstructorOptions, shell } from "electron";
import iconBase64 from "file://../../browser/icon.png?base64";
import aboutHtml from "file://about.html?minify";

import { SETTINGS_DIR, THEMES_DIR } from "./utils/constants";

let cachedUpdateAvailable = false;
let trayPatched = false;

ipcMain.on(IpcEvents.SET_TRAY_UPDATE_STATE, (_, available: boolean) => {
    cachedUpdateAvailable = available;
});

function getMainWindow(): BrowserWindow | undefined {
    const isDiscordWindow = (window: BrowserWindow | null): window is BrowserWindow => {
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
        try {
            const url = new URL(window.webContents.getURL());
            return url.protocol === "https:" && /^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname);
        } catch {
            return false;
        }
    };
    const focused = BrowserWindow.getFocusedWindow();
    return isDiscordWindow(focused) ? focused : BrowserWindow.getAllWindows().find(isDiscordWindow);
}

function sendToRenderer(event: IpcEvents): void {
    getMainWindow()?.webContents.send(event);
}

function findInsertIndex(template: MenuItemConstructorOptions[]): number {
    const openIndex = template.findIndex(item => {
        const label = item.label?.toLowerCase() ?? "";
        return label.includes("open") || label.includes("show");
    });
    return openIndex !== -1 ? openIndex + 1 : 0;
}

function isTrayMenu(template: MenuItemConstructorOptions[]): boolean {
    if (!template.length) return false;

    const hasOpenOrShow = template.some(item => {
        const label = item.label?.toLowerCase() ?? "";
        return label.includes("open") || label.includes("show");
    });

    const hasQuit = template.some(item =>
        item.label?.toLowerCase().includes("quit") || item.role === "quit"
    );

    const isNotAppMenu = !template.some(item =>
        item.label === "&File" || item.label === "File" ||
        item.label === "&Edit" || item.label === "Edit"
    );

    return hasOpenOrShow && hasQuit && isNotAppMenu;
}

let aboutWindow: BrowserWindow | null = null;

function openAboutWindow() {
    if (aboutWindow) {
        aboutWindow.focus();
        return;
    }

    const height = 750;
    const width = height * (4 / 3);

    aboutWindow = new BrowserWindow({
        center: true,
        autoHideMenuBar: true,
        height,
        width
    });

    aboutWindow.webContents.setWindowOpenHandler(({ url }) => {
        void openAboutLink(url);
        return { action: "deny" };
    });

    aboutWindow.webContents.on("will-navigate", (e, url) => {
        e.preventDefault();
        void openAboutLink(url);
    });

    const aboutParams = aboutHtml
        .replaceAll("{{VERSION}}", VERSION)
        .replaceAll("{{GIT_HASH}}", gitHashShort)
        .replaceAll("{{ICON}}", `data:image/png;base64,${iconBase64}`);
    const base64Html = Buffer.from(aboutParams).toString("base64");
    aboutWindow.loadURL(`data:text/html;base64,${base64Html}`)
        .catch(error => console.error("[Protonn Cord] Failed to open About window", error));
    aboutWindow.on("closed", () => {
        aboutWindow = null;
    });
}

async function openAboutLink(url: string) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
        await shell.openExternal(parsed.href);
    } catch (error) {
        console.error("[Protonn Cord] Failed to open About link", error);
    }
}

function createProtonnCordMenuItems(): MenuItemConstructorOptions[] {
    return [
        {
            label: "Protonn Cord",
            submenu: [
                {
                    label: "About Protonn Cord",
                    click: () => openAboutWindow()
                },
                {
                    label: cachedUpdateAvailable ? "Update Protonn Cord" : "Check for Updates",
                    click: () => sendToRenderer(IpcEvents.TRAY_CHECK_UPDATES)
                },
                {
                    label: "Repair Protonn Cord",
                    click: () => sendToRenderer(IpcEvents.TRAY_REPAIR)
                },
                { type: "separator" },
                {
                    label: "Open Settings Folder",
                    click: () => shell.openPath(SETTINGS_DIR)
                },
                {
                    label: "Open Themes Folder",
                    click: () => shell.openPath(THEMES_DIR)
                }
            ]
        },
        { type: "separator" }
    ];
}

export function patchTrayMenu(): void {
    if (trayPatched) return;
    trayPatched = true;
    const originalBuildFromTemplate = Menu.buildFromTemplate;

    Menu.buildFromTemplate = function (template: MenuItemConstructorOptions[]) {
        const alreadyPatched = template.some(item => item.label === "Protonn Cord");
        if (isTrayMenu(template) && !alreadyPatched) {
            template = template.slice();
            const insertIndex = findInsertIndex(template);
            const protonnCordItems = createProtonnCordMenuItems();
            template.splice(insertIndex, 0, ...protonnCordItems);
        }

        return originalBuildFromTemplate.call(this, template);
    };
}
