/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { upgradeBootstrapInjector, writeBootstrapFiles } from "./bootstrapFiles";

if (!IS_DEV && !IS_UPDATER_DISABLED) {
    const files = require("original-fs") as typeof import("node:fs");
    if (files.statSync(__dirname).isDirectory()
        && require("./buildOperations").recoverBuildInstallations(join(__dirname, ".."), files)) {
        const { app } = require("electron") as typeof import("electron");
        app.relaunch();
        app.exit(0);
    }
}

// Install before loading the mod or Discord internals.
if (IS_DISCORD_DESKTOP && !IS_DEV && !IS_UPDATER_DISABLED && process.platform === "win32") {
    const files = require("original-fs") as typeof import("node:fs");
    try {
        if (files.statSync(__dirname).isFile()) {
            const injector = require.main?.filename;
            if (!injector) throw new Error("Could not locate the Discord injector");
            writeBootstrapFiles(__dirname, readFileSync(join(__dirname, "bootstrap.js")), files);
            require("./asarBootstrap").installHostRecovery(__dirname);
            upgradeBootstrapInjector(injector, __dirname, files);
            require("./asarBootstrap").installAsarUpdateShim(__dirname);
        }
    } catch (error) {
        console.error("[Protonn Cord] Failed to install update recovery", error);
    }
}
