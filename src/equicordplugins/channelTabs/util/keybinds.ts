/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type KeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

function normalizeKey(key: string) {
    const upper = key.toUpperCase();
    return upper === " " ? "SPACE" : upper === "ESCAPE" ? "ESC" : upper;
}

export function getKeybindString(event: KeyEvent, isMac: boolean) {
    const keys: string[] = [];
    if (event.ctrlKey) keys.push(isMac ? "CONTROL" : "CTRL");
    if (event.metaKey) keys.push(isMac ? "CTRL" : "META");
    if (event.shiftKey) keys.push("SHIFT");
    if (event.altKey) keys.push("ALT");
    keys.push(normalizeKey(event.key));
    return keys.join("+");
}

export function matchesKeybind(event: KeyEvent, keybind: string) {
    if (!keybind) return false;
    const parts = keybind.toUpperCase().split("+");
    const mainKey = parts.pop() || "+";
    const hasCtrl = parts.includes("CTRL");
    const hasControl = parts.includes("CONTROL");
    const hasMeta = parts.includes("META");

    // CTRL retains the existing Control-or-Command alias. CONTROL and META
    // distinguish physical modifiers recorded explicitly on either platform.
    const modifiersMatch = hasControl
        ? event.ctrlKey && (hasCtrl || hasMeta) === event.metaKey
        : hasMeta
            ? event.metaKey && hasCtrl === event.ctrlKey
            : hasCtrl === (event.ctrlKey || event.metaKey);

    return modifiersMatch
        && parts.includes("SHIFT") === event.shiftKey
        && parts.includes("ALT") === event.altKey
        && normalizeKey(mainKey) === normalizeKey(event.key);
}
