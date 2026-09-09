/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";

import { clearRegistry, getCommandById } from "./api/registry";
import type { PaletteContext } from "./api/types";
import { registerBuiltinCommands } from "./commands";
import { loadCustomCommands } from "./commands/custom";
import { DEFAULT_HOTKEY, settings } from "./settings";
import { loadAliases } from "./state/aliases";
import { loadFrecency, recordUse } from "./state/frecency";
import { getAllHotkeys, loadHotkeys } from "./state/hotkeys";
import { loadPins } from "./state/pins";
import { comboEquals, comboFromEvent, installKeyboardListeners, isEditableTarget, removeKeyboardListeners, setGlobalKeyHandler } from "./ui/keyboard";
import { closePalette, openPalette, togglePalette } from "./ui/openPalette";

const headlessCtx: PaletteContext = {
    close() { },
    pop() { },
    push: entry => openPalette(entry),
    setQuery() { }
};

const MODIFIER_KEYS = ["meta", "ctrl", "shift", "alt"];
const logger = new Logger("CommandPalette");
let lifecycleGeneration = 0;

function hasModifier(combo: string[]) {
    return combo.some(key => MODIFIER_KEYS.includes(key) && key !== "shift");
}

function handleGlobalKey(e: KeyboardEvent): boolean {
    const combo = comboFromEvent(e);
    if (!combo) return false;
    if (!hasModifier(combo) && isEditableTarget(e.target)) return false;

    const openHotkey = Array.isArray(settings.store.hotkey) && settings.store.hotkey.length > 0
        ? settings.store.hotkey
        : DEFAULT_HOTKEY;

    if (comboEquals(combo, openHotkey)) {
        togglePalette();
        return true;
    }

    for (const [commandId, hotkey] of Object.entries(getAllHotkeys())) {
        if (!comboEquals(combo, hotkey)) continue;

        const command = getCommandById(commandId);
        if (!command) continue;
        if (command.predicate && !command.predicate()) continue;

        if (command.page) {
            recordUse(commandId);
            openPalette(command.page());
        } else if (command.actions?.[0]) {
            recordUse(commandId);
            const action = command.actions[0];
            Promise.resolve()
                .then(() => action.run(headlessCtx))
                .catch(error => logger.error(`Command ${commandId} failed`, error));
        } else {
            continue;
        }
        return true;
    }

    return false;
}

export default definePlugin({
    name: "CommandPalette",
    description: "Raycast style command palette for running actions anywhere in Discord",
    authors: [EquicordDevs.justjxke],
    tags: ["Customisation", "Commands", "Shortcuts"],
    dependencies: ["UserSettingsAPI"],
    settings,

    async start() {
        const generation = ++lifecycleGeneration;
        await Promise.all([loadFrecency(), loadPins(), loadAliases(), loadHotkeys(), loadCustomCommands()]);
        if (generation !== lifecycleGeneration) return;

        registerBuiltinCommands();
        installKeyboardListeners();
        setGlobalKeyHandler(handleGlobalKey);
    },

    stop() {
        lifecycleGeneration++;
        closePalette();
        removeKeyboardListeners();
        clearRegistry();
    }
});
