/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { upgradeBootstrapInjector, writeBootstrapFiles } from "./bootstrapFiles";

// Install before loading the mod or Discord internals. Unpacked/development
// builds retain their existing profile and updater behavior.
if (IS_DISCORD_DESKTOP && !IS_DEV && !IS_UPDATER_DISABLED && process.platform === "win32") {
    const files = require("original-fs") as typeof import("node:fs");
    if (files.statSync(__dirname).isFile()) {
        try {
            const injector = require.main?.filename;
            if (!injector) throw new Error("Could not locate the Discord injector");
            writeBootstrapFiles(__dirname, readFileSync(join(__dirname, "bootstrap.js")), files);
            upgradeBootstrapInjector(injector, __dirname, files);
            require("./asarBootstrap").installHostRecovery(__dirname);
        } catch (error) {
            console.error("[Protonn Cord] Failed to install update recovery", error);
        }
    }
}
