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

import { PlainSettings, Settings, SettingsStore } from "@api/Settings";
import { traceFunction } from "@debug/Tracer";
import { getLoadedPluginDefinition, getLoadedPluginNames, getPluginDependencies, setPluginDefinitionInitializer } from "@shared/pluginDefinition";
import { Logger } from "@utils/Logger";
import { onlyOnce } from "@utils/onlyOnce";
import { canonicalizeFind, canonicalizeReplacement } from "@utils/patches";
import { DefinedSettings, Patch, Plugin, PluginDef, PluginSettingDef, ReporterTestable, StartAt } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";
import { patches } from "@webpack/patcher";

import Plugins, { PluginManifest } from "~plugins";
export { Plugins as plugins };

import { registerPluginContributions } from "./pluginManager/registrations";
import { PluginResources } from "./pluginManager/resources";

const logger = new Logger("PluginManager", "#a6d189");

export const PMLogger = logger;

/** Whether we have subscribed to flux events of all the enabled plugins when FluxDispatcher was ready */
let enabledPluginsSubscribedFlux = false;
type FluxHandler = (event: unknown) => void | Promise<void>;
const subscribedFluxEventsPlugins = new Map<string, PluginResources>();

interface PluginRun {
    resources: PluginResources;
    stopping: boolean;
}

const pluginRuns = new WeakMap<Plugin, PluginRun>();
const startedPluginNames = new Set<string>();
const failedPluginNames = new Set<string>();

export function getPluginRuntimeStatus() {
    return {
        started: [...startedPluginNames].sort(), failed: [...failedPluginNames].sort(),
        loaded: getLoadedPluginNames().sort(), catalogCount: Object.keys(PluginManifest).length
    };
}

const pluginKeysToBind = [
    "onBeforeMessageEdit", "onBeforeMessageSend", "onMessageClick",
    "renderMemberListDecorator", "renderMessageAccessory", "renderMessageDecoration",
    // Custom
    "renderNicknameIcon"
] as const satisfies ReadonlyArray<keyof PluginDef & `${"on" | "render"}${string}`>;

export function isPluginEnabled(p: string) {
    const loaded = getLoadedPluginDefinition(p);
    const metadata = PluginManifest[p];
    const settings = PlainSettings.plugins[p];
    return (loaded?.required ?? metadata?.required)
        || loaded?.isDependency
        || (settings ? settings.enabled : IS_REPORTER || metadata?.enabledByDefault || false)
        || false;
}
export function isPluginRequired(p: string) {
    return getLoadedPluginDefinition(p)?.required ?? PluginManifest[p]?.required ?? false;
}

export function isSettingHidden(settings: DefinedSettings, setting: PluginSettingDef) {
    if (!("hidden" in setting)) return false;

    return typeof setting.hidden === "function"
        ? setting.hidden.call(settings)
        : Boolean(setting.hidden);
}

export function isSettingDisabled(settings: DefinedSettings, setting: PluginSettingDef) {
    if (!("disabled" in setting)) return false;

    return typeof setting.disabled === "function"
        ? setting.disabled.call(settings)
        : Boolean(setting.disabled);
}

export function hasAnyVisibleSettings({ settings }: Plugin) {
    return !!settings && Object.values(settings.def).some(s => !isSettingHidden(settings, s));
}

export function addPatch(newPatch: Omit<Patch, "plugin">, pluginName: string, pluginPath = `Vencord.Plugins.plugins[${JSON.stringify(pluginName)}]`) {
    // TODO: this causes crashes
    if (pluginName === "Vesktop" && newPatch.find === ".STREAMING_AUTO_STREAMER_MODE,") return;
    if (pluginName === "Equibop" && newPatch.find === ".STREAMING_AUTO_STREAMER_MODE,") return;

    const patch = newPatch as Patch;
    patch.plugin = pluginName;

    if (IS_REPORTER) {
        delete patch.predicate;
        delete patch.group;
    }

    if (patch.predicate && !patch.predicate()) return;

    canonicalizeFind(patch);
    if (!Array.isArray(patch.replacement)) {
        patch.replacement = [patch.replacement];
    }

    for (const replacement of patch.replacement) {
        canonicalizeReplacement(replacement, pluginPath);

        if (IS_REPORTER) {
            delete replacement.predicate;
        }
    }

    patch.replacement = patch.replacement.filter(({ predicate }) => !predicate || predicate());

    patches.push(patch);
}

function isReporterTestable(p: Plugin, part: ReporterTestable) {
    return p.reporterTestable == null
        ? true
        : (p.reporterTestable & part) === part;
}

export function pluginRequiresRestart(p: Plugin) {
    return p.requiresRestart !== false && (p.requiresRestart || !!p.patches?.length);
}

export const startAllPlugins = traceFunction("startAllPlugins", function startAllPlugins(target: StartAt) {
    logger.info(`Starting plugins (stage ${target})`);
    for (const name in PluginManifest) {
        if (isPluginEnabled(name) && (!IS_REPORTER || isReporterTestable(Plugins[name], ReporterTestable.Start))) {
            const p = Plugins[name];

            const startAt = p.startAt ?? StartAt.WebpackReady;
            if (startAt !== target) continue;

            startPlugin(Plugins[name]);
        }
    }
});

export function startDependenciesRecursive(p: Plugin, visiting = new Set<string>()): { restartNeeded: boolean; failures: string[]; } {
    const settings = Settings.plugins;
    let restartNeeded = false;
    const failures: string[] = [];

    if (visiting.has(p.name)) return { restartNeeded, failures: [p.name] };
    visiting.add(p.name);

    p.dependencies?.forEach(d => {
        const dep = Plugins[d];
        if (!dep) {
            failures.push(d);
            return;
        }
        if (!dep.started) {
            const nested = startDependenciesRecursive(dep, visiting);
            restartNeeded ||= nested.restartNeeded;
            failures.push(...nested.failures);
            if (nested.failures.length) return;

            // If the plugin has patches, don't start the plugin, just enable it.
            if (nested.restartNeeded || pluginRequiresRestart(dep)) {
                logger.warn(`Enabling dependency ${d} requires restart.`);
                restartNeeded = true;
            } else if (!startPlugin(dep)) {
                failures.push(d);
                return;
            }
        }
        settings[d].enabled = true;
        dep.isDependency = true;
    });

    visiting.delete(p.name);
    return { restartNeeded, failures };
}

export function subscribePluginFluxEvents(p: Plugin, fluxDispatcher: typeof FluxDispatcher) {
    if (!p.flux || subscribedFluxEventsPlugins.has(p.name) || (IS_REPORTER && !isReporterTestable(p, ReporterTestable.FluxEvents))) return;

    const resources = new PluginResources();
    subscribedFluxEventsPlugins.set(p.name, resources);

    logger.debug("Subscribing to flux events of plugin", p.name);
    try {
        for (const [event, handler] of Object.entries(p.flux)) {
            if (!handler) continue;
            const wrappedHandler: FluxHandler = eventData => {
                if (p.name === "Encryptcord" && event === "MESSAGE_CREATE") return;
                try {
                    const res = handler.call(p, eventData);
                    return res != null && typeof res.then === "function"
                        ? Promise.resolve(res).catch(e => logger.error(`${p.name}: Error while handling ${event}\n`, e))
                        : res;
                } catch (e) {
                    logger.error(`${p.name}: Error while handling ${event}\n`, e);
                }
            };

            resources.register(
                () => fluxDispatcher.subscribe(event, wrappedHandler),
                () => fluxDispatcher.unsubscribe(event, wrappedHandler)
            );
        }
    } catch (error) {
        unsubscribePluginFluxEvents(p, fluxDispatcher);
        throw error;
    }
}

export function unsubscribePluginFluxEvents(p: Plugin, _fluxDispatcher: typeof FluxDispatcher) {
    const resources = subscribedFluxEventsPlugins.get(p.name);
    if (!resources) return true;

    subscribedFluxEventsPlugins.delete(p.name);
    logger.debug("Unsubscribing from flux events of plugin", p.name);
    // Each disposer retains its original dispatcher and handler, even if p.flux changes.
    return resources.dispose(error => logger.error(`Failed to unsubscribe flux events of ${p.name}\n`, error));
}

export function subscribeAllPluginsFluxEvents(fluxDispatcher: typeof FluxDispatcher) {
    enabledPluginsSubscribedFlux = true;

    for (const name in PluginManifest) {
        if (!isPluginEnabled(name) || failedPluginNames.has(name)) continue;
        try {
            subscribePluginFluxEvents(Plugins[name], fluxDispatcher);
        } catch (error) {
            logger.error(`Failed to subscribe flux events of ${name}\n`, error);
        }
    }
}

function observeAsyncHook(result: unknown, onError: (error: unknown) => void) {
    if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
        Promise.resolve(result).catch(onError);
    }
}

/** Shared by normal stops and failed starts; one failure must not strand other resources. */
function releasePlugin(p: Plugin, run: PluginRun): boolean {
    run.stopping = true;
    let success = true;
    try {
        observeAsyncHook(p.stop?.(), error => logger.error(`Failed to stop ${p.name}\n`, error));
    } catch (error) {
        success = false;
        logger.error(`Failed to stop ${p.name}\n`, error);
    }

    p.started = false;
    startedPluginNames.delete(p.name);
    if (!run.resources.dispose(error => logger.error(`Failed to clean up ${p.name}\n`, error))) success = false;
    if (!unsubscribePluginFluxEvents(p, FluxDispatcher)) success = false;
    pluginRuns.delete(p);
    return success;
}

export const startPlugin = traceFunction("startPlugin", function startPlugin(p: Plugin) {
    if (p.started || pluginRuns.has(p)) {
        logger.warn(`${p.name} already started or changing state`);
        return false;
    }

    const run: PluginRun = { resources: new PluginResources(), stopping: false };
    pluginRuns.set(p, run);
    logger.info("Starting plugin", p.name);

    try {
        observeAsyncHook(p.start?.(), error => {
            logger.error(`Failed to start ${p.name}\n`, error);
            // A late rejection from an earlier run must not stop a newer one.
            if (pluginRuns.get(p) === run && !run.stopping) {
                failedPluginNames.add(p.name);
                releasePlugin(p, run);
            }
        });

        p.started = true;
        registerPluginContributions(p, run.resources, () => {
            if (enabledPluginsSubscribedFlux) subscribePluginFluxEvents(p, FluxDispatcher);
        });
        startedPluginNames.add(p.name);
        failedPluginNames.delete(p.name);
        return true;
    } catch (error) {
        logger.error(`Failed to start ${p.name}\n`, error);
        failedPluginNames.add(p.name);
        releasePlugin(p, run);
        return false;
    }
}, p => `startPlugin ${p.name}`);

export const stopPlugin = traceFunction("stopPlugin", function stopPlugin(p: Plugin) {
    const run = pluginRuns.get(p);
    if (!p.started || run?.stopping) {
        logger.warn(`${p.name} already stopped or stopping`);
        return false;
    }

    logger.info("Stopping plugin", p.name);
    const currentRun = run ?? { resources: new PluginResources(), stopping: false };
    pluginRuns.set(p, currentRun);
    return releasePlugin(p, currentRun);
}, p => `stopPlugin ${p.name}`);

function bindPluginSettings(p: Plugin) {
    if (!p.settings) return;

    p.settings.pluginName = p.name;

    for (const [key, def] of Object.entries(p.settings.def)) {
        if (!def.onChange) continue;

        SettingsStore.addChangeListener(`plugins.${p.name}.${key}`, def.onChange);
    }
}

function bindPluginMethods(p: Plugin) {
    for (const key of pluginKeysToBind) {
        p[key] &&= p[key].bind(p) as any;
    }
}

export const initPluginManager = onlyOnce(function init() {
    const settings = Settings.plugins;
    const pendingSettings = new Set<Plugin>();
    let settingsReady = false;

    setPluginDefinitionInitializer(p => {
        const dependencies = getPluginDependencies(p);
        if (dependencies.length) p.dependencies = dependencies;
        bindPluginMethods(p);
        if (settingsReady) bindPluginSettings(p);
        else pendingSettings.add(p);
    });

    const enabledPlugins = new Set(Object.keys(PluginManifest).filter(isPluginEnabled));
    for (const pluginName of enabledPlugins) {
        const p = Plugins[pluginName];
        for (const name of p.dependencies ?? []) {
            const dependency = Plugins[name];
            if (!dependency) {
                const error = new Error(`Plugin ${p.name} has unresolved dependency ${name}`);
                if (IS_DEV) throw error;
                logger.warn(error);
                continue;
            }
            settings[name].enabled = true;
            dependency.isDependency = true;
            enabledPlugins.add(name);
        }
    }

    settingsReady = true;
    for (const plugin of pendingSettings) bindPluginSettings(plugin);
    pendingSettings.clear();

    // Catalog order keeps patch ordering compatible, independent of dependency traversal.
    for (const name in PluginManifest) {
        if (!isPluginEnabled(name)) continue;
        const p = Plugins[name];
        if (p.patches) {
            if (!IS_REPORTER || isReporterTestable(p, ReporterTestable.Patches)) {
                for (const patch of p.patches) {
                    addPatch(patch, p.name);
                }
            }
        }
    }

});
