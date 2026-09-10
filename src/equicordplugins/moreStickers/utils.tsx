/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { waitFor } from "@webpack";
import { React } from "@webpack/common";

import { FFmpegState } from "./types";

export const cl = classNameFactory("vc-more-stickers-");
export const clPicker = (className: string, ...args: any[]) => cl("picker-" + className, ...args);

const CORS_PROXY = "https://cors.keiran0.workers.dev?url=";

function corsUrl(url: string | URL) {
    return CORS_PROXY + encodeURIComponent(url.toString());
}

export function corsFetch(url: string | URL, init?: RequestInit | undefined) {
    // Custom authorization headers must stay with the configured origin.
    const hasHeaders = new Headers(init?.headers).keys().next().done === false;
    return fetch(hasHeaders ? url : corsUrl(url), {
        ...init,
        credentials: "omit",
        redirect: "error",
        signal: init?.signal ?? AbortSignal.timeout(60_000)
    });
}

export let FFmpegStateContext: React.Context<FFmpegState | undefined> | undefined;
waitFor("createContext", () => {
    FFmpegStateContext = React.createContext<FFmpegState | undefined>(undefined);
});
