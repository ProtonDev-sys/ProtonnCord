/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { initPluginManager, PMLogger, startAllPlugins } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { coreStyleRootNode, initStyles, vencordRootNode } from "@api/Styles";
import { IS_WINDOWS } from "@utils/constants";
import { createAndAppendStyle } from "@utils/css";
import { StartAt } from "@utils/types";
import { onceReady } from "@webpack";
import { patches } from "@webpack/patcher";

import { createRendererRuntime, type RendererService, type RuntimeStatus, scheduleIdleTask } from "./bootstrap";

let runtime: ReturnType<typeof createRendererRuntime> | undefined;

function developmentChecks(): RendererService {
    return {
        dispose() {},
        runInitial() {
            const pendingPatches = patches.filter(patch => !patch.all && patch.predicate?.() !== false);
            if (pendingPatches.length) PMLogger.warn(
                "Webpack has finished initialising, but some patches haven't been applied yet.",
                "This might be expected since some Modules are lazy loaded, but please verify",
                "that all plugins are working as intended.",
                "You are seeing this warning because this is a development build of Protonn Cord.",
                "\nThe following patches have not been applied:",
                "\n\n" + pendingPatches.map(patch => `${patch.plugin}: ${patch.find}`).join("\n")
            );
        },
    };
}

/** Called by the public entry only, after its circular plugin initialization and reporter setup. */
export function startRenderer() {
    runtime ??= createRendererRuntime({
        host: {
            now: () => performance.now(),
            isDomReady: () => document.readyState !== "loading",
            onDomReady(callback) {
                document.addEventListener("DOMContentLoaded", callback, { once: true });
                return () => document.removeEventListener("DOMContentLoaded", callback);
            },
            onPageHide(callback) {
                window.addEventListener("pagehide", callback, { once: true });
                return () => window.removeEventListener("pagehide", callback);
            },
            defer: callback => scheduleIdleTask(callback, window),
        },
        ready: onceReady,
        initializePlugins: initPluginManager,
        initializeStyles: initStyles,
        startPlugins: stage => startAllPlugins(stage as StartAt),
        onDomReady() {
            // Styles.ts also observes DOM readiness; this covers loading the entry after that event.
            if (!vencordRootNode.isConnected) document.documentElement.append(vencordRootNode);
            if (IS_DISCORD_DESKTOP && Settings.winNativeTitleBar && IS_WINDOWS)
                createAndAppendStyle("vencord-native-titlebar-style", coreStyleRootNode).textContent = "[class*=titleBar]{display: none!important}";
        },
        services: [
            { name: "cloudSettings", start: () => (require("./cloudSettings") as typeof import("./cloudSettings")).createCloudSettingsService() },
            { name: "updates", start: () => (require("./updates") as typeof import("./updates")).createUpdateService() },
            ...(IS_DEV ? [{ name: "developmentChecks", start: developmentChecks }] : []),
        ],
        onError: (stage, error) => PMLogger.error(`Renderer startup failed at ${stage}`, error),
    });
    runtime.start();
}

/** A detached, frozen diagnostic snapshot; no plugin hydration or user data reads. */
export function getRuntimeStatus(): RuntimeStatus {
    return runtime?.getStatus() ?? Object.freeze({ started: false, disposed: false, elapsedMs: 0, stages: Object.freeze([]) });
}
