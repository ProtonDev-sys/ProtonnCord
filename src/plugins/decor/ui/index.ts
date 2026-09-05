/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { extractAndLoadChunksLazy, findCssClassesLazy } from "@webpack";
import { useEffect, useRef } from "@webpack/common";

import { Authorization, useAuthorizationStore } from "../lib/stores/AuthorizationStore";

export const cl = classNameFactory("vc-decor-");
export const DecorationModalClasses = findCssClassesLazy("modalPreview", "modalCloseButton", "spinner", "modal");

export const requireAvatarDecorationModal = extractAndLoadChunksLazy(["initialSelectedDecoration:", /initialSelectedDecoration:\i,.{0,300}\i\.e\(/]);
export const requireCreateStickerModal = extractAndLoadChunksLazy([".CREATE_STICKER_MODAL,", "isDisplayingIndividualStickers"]);

export function useDialogActions(onClose?: () => void) {
    const state = useRef<{ active: boolean; controller?: AbortController; }>({ active: false });
    useEffect(() => {
        state.current.active = true;
        return () => {
            state.current.active = false;
            state.current.controller?.abort();
        };
    }, []);
    return {
        begin() {
            state.current.controller?.abort();
            const controller = new AbortController();
            state.current.controller = controller;
            if (!state.current.active) controller.abort();
            return controller.signal;
        },
        close() {
            state.current.active = false;
            state.current.controller?.abort();
            onClose?.();
        }
    };
}

export function requireDialogOwner(owner: Authorization, signal: AbortSignal) {
    if (signal.aborted) throw new Error("This decoration view is closed.");
    useAuthorizationStore.getState().requireAuthorization(owner);
}
