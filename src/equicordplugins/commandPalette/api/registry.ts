/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import type { PaletteCommand } from "./types";

const owners = new Map<string, PaletteCommand[]>();
const listeners = new Set<() => void>();
const logger = new Logger("CommandPalette");

export function notifyPaletteChange() {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            logger.error("Palette listener failed", error);
        }
    }
}

export function subscribePalette(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

export function registerCommands(ownerId: string, commands: PaletteCommand[]) {
    owners.set(ownerId, commands);
    notifyPaletteChange();
}

export function unregisterOwner(ownerId: string) {
    owners.delete(ownerId);
    notifyPaletteChange();
}

export function clearRegistry() {
    owners.clear();
    listeners.clear();
}

export function getVisibleCommands(): PaletteCommand[] {
    const result: PaletteCommand[] = [];
    for (const commands of owners.values()) {
        for (const command of commands) {
            try {
                if (command.predicate && !command.predicate()) continue;
            } catch (error) {
                logger.error(`Command ${command.id} predicate failed`, error);
                continue;
            }
            result.push(command);
        }
    }
    return result;
}

export function getCommandById(id: string): PaletteCommand | undefined {
    for (const commands of owners.values()) {
        const match = commands.find(c => c.id === id);
        if (match) return match;
    }
    return undefined;
}
