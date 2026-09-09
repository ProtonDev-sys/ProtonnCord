/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { SettingsRouter, useEffect, useRef, useState } from "@webpack/common";

import { registerAction } from "./commands";
import { closeCommandPalette, openCommandPalette } from "./components/CommandPalette";

const cl = classNameFactory("vc-keyboard-navigation-");
let isRecordingGlobal: boolean = false;
let cancelRecording: (() => void) | null = null;
let removeDevAction: (() => void) | null = null;

const modifiers = {
    control: "ctrlKey",
    shift: "shiftKey",
    alt: "altKey",
    meta: "metaKey"
} as const;

function isModifierKey(key: string): key is keyof typeof modifiers {
    return Object.hasOwn(modifiers, key);
}

function formatHotkeyLabel(hotkey: readonly string[]): string {
    let label = "";
    for (const word of hotkey) {
        if (label) label += " + ";
        label += word.charAt(0).toUpperCase() + word.slice(1);
    }

    return label;
}

function HotkeyRecorder() {
    const { hotkey } = settings.use(["hotkey"]);
    const [isRecording, setIsRecording] = useState(false);
    const mounted = useRef(true);
    const cancelOwnRecording = useRef<(() => void) | null>(null);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            cancelOwnRecording.current?.();
        };
    }, []);

    const recordKeybind = () => {
        if (isRecordingGlobal) return;
        const keys = new Set<string>();
        let longestKeys: string[] = [];
        setIsRecording(true);
        isRecordingGlobal = true;

        const finish = (save: boolean) => {
            document.removeEventListener("keydown", keydown, true);
            document.removeEventListener("keyup", keyup, true);
            window.removeEventListener("blur", cancel);
            if (save && longestKeys.length) settings.store.hotkey = longestKeys;
            if (mounted.current) setIsRecording(false);
            isRecordingGlobal = false;
            cancelOwnRecording.current = null;
            if (cancelRecording === cancel) cancelRecording = null;
        };
        const cancel = () => finish(false);
        const keydown = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();
            keys.add(event.key.toLowerCase());
            if (keys.size > longestKeys.length) longestKeys = [...keys];
        };
        const keyup = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();
            keys.delete(event.key.toLowerCase());
            if (!keys.size) finish(true);
        };
        cancelRecording = cancelOwnRecording.current = cancel;
        document.addEventListener("keydown", keydown, true);
        document.addEventListener("keyup", keyup, true);
        window.addEventListener("blur", cancel);
    };

    return <div className={cl("key-recorder-container")} onClick={recordKeybind}>
        <div className={`${cl("key-recorder")} ${isRecording ? cl("recording") : ""}`}>
            {formatHotkeyLabel(hotkey)}
            <button className={`${cl("key-recorder-button")} ${isRecording ? cl("recording-button") : ""}`} disabled={isRecording}>
                {isRecording ? "Recording..." : "Record keybind"}
            </button>
        </div>
    </div>;
}

export const settings = definePluginSettings({
    hotkey: {
        description: "The hotkey to open the command palette.",
        type: OptionType.COMPONENT,
        default: ["Control", "Shift", "P"],
        component: HotkeyRecorder
    },
    allowMouseControl: {
        description: "Allow the mouse to control the command palette.",
        type: OptionType.BOOLEAN,
        default: true
    }
});

export default definePlugin({
    name: "KeyboardNavigation",
    description: "Allows you to navigate the UI with a keyboard.",
    tags: ["Accessibility", "Shortcuts"],
    authors: [Devs.Ethan],
    settings,

    start() {
        document.addEventListener("keydown", this.event);

        if (IS_DEV) {
            removeDevAction?.();
            removeDevAction = registerAction({
                id: "openDevSettings",
                label: "Open Dev tab",
                callback: () => SettingsRouter.openUserSettings("equicord_patch_helper_panel"),
                registrar: "Protonn Cord"
            });
        }
    },

    stop() {
        document.removeEventListener("keydown", this.event);
        cancelRecording?.();
        removeDevAction?.();
        removeDevAction = null;
        closeCommandPalette();
    },

    event(e: KeyboardEvent) {
        if (isRecordingGlobal || e.repeat || e.isComposing) return;

        const { hotkey } = settings.store;
        const pressedKey = e.key.toLowerCase();
        if (!hotkey.length) return;
        for (const [name, flag] of Object.entries(modifiers)) {
            if (Boolean(e[flag]) !== hotkey.some(key => key.toLowerCase() === name)) return;
        }

        for (let i = 0; i < hotkey.length; i++) {
            const lowercasedRequiredKey = hotkey[i].toLowerCase();

            if (isModifierKey(lowercasedRequiredKey) && !e[modifiers[lowercasedRequiredKey]]) {
                return;
            }

            if (!isModifierKey(lowercasedRequiredKey) && pressedKey !== lowercasedRequiredKey) {
                return;
            }
        }

        e.preventDefault();
        e.stopPropagation();

        if (document.querySelector(`.${cl("root")}`)) return;

        openCommandPalette();
    }
});
