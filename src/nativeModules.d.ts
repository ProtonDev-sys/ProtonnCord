/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/// <reference types="standalone-electron-types"/>

declare module "~pluginNatives" {
    const pluginNatives: Record<string, import("./main/pluginNativeRegistry").NativePluginDefinition>;
    export default pluginNatives;
}
