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

import { app } from "electron";
import { constants as FsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const suffix = IS_DEV ? "dev" : "";

export const DATA_DIR = process.env.PROTONN_CORD_USER_DATA_DIR ?? process.env.EQUICORD_USER_DATA_DIR ?? (
    process.env.DISCORD_USER_DATA_DIR
        ? join(process.env.DISCORD_USER_DATA_DIR, "..", "ProtonnCordData", suffix)
        : join(app.getPath("userData"), "..", "ProtonnCord", suffix)
);

export const SETTINGS_DIR = join(DATA_DIR, "settings");
export const THEMES_DIR = join(DATA_DIR, "themes");
export const QUICK_CSS_PATH = join(SETTINGS_DIR, "quickCss.css");
export const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
export const NATIVE_SETTINGS_FILE = join(SETTINGS_DIR, "native-settings.json");
export const DEV_MIGRATED = join(SETTINGS_DIR, "migration");
export const ALLOWED_PROTOCOLS = [
    "https:",
    "http:",
    "steam:",
    "spotify:",
    "com.epicgames.launcher:",
    "tidal:",
    "itunes:",
    "vrcx:",
    "tg:",
];

export const IS_VANILLA = /* @__PURE__ */ process.argv.includes("--vanilla");

if (IS_DEV && !process.env.PROTONN_CORD_USER_DATA_DIR && !process.env.EQUICORD_USER_DATA_DIR) {
    const prodDir = join(DATA_DIR, "..");
    const settings = join(prodDir, "settings", "settings.json");
    const quickCss = join(prodDir, "settings", "quickCss.css");

    try {
        const migrated = existsSync(DEV_MIGRATED) && readFileSync(DEV_MIGRATED, "utf-8").includes("migrated");
        if (!migrated) {
            // Constants load before the settings stores. Seed missing files now so
            // development startup never overwrites edits or needs a forced restart.
            mkdirSync(SETTINGS_DIR, { recursive: true });
            for (const [source, destination] of [[settings, SETTINGS_FILE], [quickCss, QUICK_CSS_PATH]]) {
                if (existsSync(source) && !existsSync(destination))
                    copyFileSync(source, destination, FsConstants.COPYFILE_EXCL);
            }
            writeFileSync(DEV_MIGRATED, "migrated");
        }
    } catch (err) {
        console.error("[Protonn Cord] Failed to copy prod data:", err);
    }
}
