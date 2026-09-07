/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Settings } from "@api/Settings";
import { IpcEvents } from "@shared/IpcEvents";
import { SettingsStore } from "@shared/SettingsStore";
import { mergeDefaults } from "@utils/mergeDefaults";
import { randomUUID } from "crypto";
import { ipcMain } from "electron";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";

import { NATIVE_SETTINGS_FILE, SETTINGS_DIR, SETTINGS_FILE } from "./utils/constants";

mkdirSync(SETTINGS_DIR, { recursive: true });

function readSettings<T = object>(name: string, file: string): Partial<T> {
    try {
        const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
        if (data === null || typeof data !== "object" || Array.isArray(data))
            throw new Error("Settings must contain a JSON object");
        return data as Partial<T>;
    } catch (err: any) {
        if (err?.code !== "ENOENT")
            console.error(`Failed to read ${name} settings`, err);

        return {};
    }
}

function writeSettings(file: string, data: object) {
    const contents = JSON.stringify(data, null, 4);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
        try {
            writeFileSync(descriptor, contents);
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }
        renameSync(temporary, file);
    } finally {
        try {
            rmSync(temporary, { force: true });
        } catch (error) {
            console.error("Failed to remove temporary settings file", error);
        }
    }
}

export const RendererSettings = new SettingsStore(readSettings<Settings>("renderer", SETTINGS_FILE));

ipcMain.handle(IpcEvents.GET_SETTINGS_DIR, () => SETTINGS_DIR);
ipcMain.on(IpcEvents.GET_SETTINGS, e => e.returnValue = RendererSettings.plain);

ipcMain.handle(IpcEvents.SET_SETTINGS, (_, data: Settings, pathToNotify?: string) => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("Settings must contain an object.");
    writeSettings(SETTINGS_FILE, data);
    RendererSettings.setData(data, pathToNotify);
});

export interface NativeSettings {
    plugins: {
        [plugin: string]: {
            [setting: string]: any;
        };
    };
    customCspRules: Record<string, string[]>;
}

const DefaultNativeSettings: NativeSettings = {
    plugins: {},
    customCspRules: {}
};

const nativeSettings = readSettings<NativeSettings>("native", NATIVE_SETTINGS_FILE);
mergeDefaults(nativeSettings, DefaultNativeSettings);

export const NativeSettings = new SettingsStore(nativeSettings as NativeSettings);

NativeSettings.addGlobalChangeListener(() => {
    try {
        writeSettings(NATIVE_SETTINGS_FILE, NativeSettings.plain);
    } catch (e) {
        console.error("Failed to write native settings", e);
    }
});
