/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

type NativeMethod = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type NativeMethods = Record<string, NativeMethod>;

export interface NativePluginDefinition {
    methods: readonly string[];
    eager: boolean;
    load(): NativeMethods;
}

export type PluginIpcMappings = Record<string, Record<string, string>>;

/** Register the complete IPC surface while initializing each native only when it is used. */
export function registerPluginNatives(
    plugins: Record<string, NativePluginDefinition>,
    register: (channel: string, method: NativeMethod) => void,
): PluginIpcMappings {
    const mappings: PluginIpcMappings = {};

    for (const [plugin, definition] of Object.entries(plugins)) {
        let implementation: NativeMethods | undefined;
        const load = () => implementation ??= definition.load();
        if (definition.eager) load();
        if (!definition.methods.length) continue;

        const methods = mappings[plugin] = {};
        for (const name of definition.methods) {
            const channel = `VencordPluginNative_${plugin}_${name}`;
            register(channel, (event, ...args) => {
                const method = load()[name];
                if (typeof method !== "function")
                    throw new Error(`Native method ${plugin}.${name} is unavailable. Rebuild Protonn Cord.`);
                return method(event, ...args);
            });
            methods[name] = channel;
        }
    }

    return mappings;
}
