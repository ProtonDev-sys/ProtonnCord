/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { isObject, parseUrl } from "@utils/misc";

export let BASE_URL = "https://decor.fieryflames.dev";
export let API_URL = BASE_URL + "/api";
export let AUTHORIZE_URL = API_URL + "/authorize";
export let CDN_URL = "https://ugc.decor.fieryflames.dev";
export let CLIENT_ID = "1096966363416899624";
export const SKU_ID = "100101099111114"; // decor in ascii numbers
export const RAW_SKU_ID = "11497119"; // raw in ascii numbers
export const GUILD_ID = "1096357702931841148";
export const INVITE_KEY = "dXp2SdxDcP";
export const DECORATION_FETCH_COOLDOWN = 1000 * 60 * 60 * 4; // 4 hours

const logger = new Logger("Decor");
let configurationRequest: AbortController | undefined;

function parseBaseUrl(value: unknown) {
    if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value)) throw new Error("Decor requires an HTTPS service URL.");
    const url = parseUrl(value);
    if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw new Error("Decor requires an HTTPS service URL without credentials, query parameters or fragments.");
    return url.href.replace(/\/+$/, "");
}

export function cancelConfiguration() {
    configurationRequest?.abort();
    configurationRequest = undefined;
}

export async function setBaseUrl(value: string): Promise<boolean> {
    cancelConfiguration();
    const controller = new AbortController();
    configurationRequest = controller;
    let baseUrl: string | undefined;
    try {
        baseUrl = parseBaseUrl(value);
        const response = await fetch(`${baseUrl}/api/config`, { signal: controller.signal, redirect: "error" });
        if (!response.ok) throw new Error("Could not load Decor configuration.");
        const config: unknown = await response.json();
        if (!isObject(config) || !("CDN_URL" in config) || !("CLIENT_ID" in config)
            || typeof config.CLIENT_ID !== "string" || !/^\d{16,21}$/.test(config.CLIENT_ID))
            throw new Error("Invalid Decor configuration.");
        const cdnUrl = parseBaseUrl(config.CDN_URL);
        if (controller.signal.aborted) return false;
        BASE_URL = baseUrl;
        API_URL = BASE_URL + "/api";
        AUTHORIZE_URL = API_URL + "/authorize";
        CDN_URL = cdnUrl;
        CLIENT_ID = config.CLIENT_ID;
        return true;
    } catch (error) {
        if (controller.signal.aborted) return false;
        logger.error("Failed to load Decor configuration", error);
        return baseUrl === BASE_URL;
    } finally {
        if (configurationRequest === controller) configurationRequest = undefined;
    }
}
