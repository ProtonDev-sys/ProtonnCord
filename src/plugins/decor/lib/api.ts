/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isObject } from "@utils/misc";

import { API_URL } from "./constants";
import { Authorization, useAuthorizationStore } from "./stores/AuthorizationStore";

export interface Preset {
    id: string;
    name: string;
    description: string | null;
    decorations: Decoration[];
    authorIds: string[];
}

export interface Decoration {
    hash: string;
    animated: boolean;
    alt: string | null;
    authorId: string | null;
    reviewed: boolean | null;
    presetId: string | null;
}

export interface NewDecoration {
    file: File;
    alt: string | null;
}

async function fetchApi(path: string, authorization: Authorization, options?: RequestInit) {
    useAuthorizationStore.getState().requireAuthorization(authorization);
    const headers = new Headers(options?.headers);
    headers.set("Authorization", `Bearer ${authorization.token}`);
    const res = await fetch(authorization.apiUrl + path, {
        ...options,
        headers,
        redirect: "error"
    });

    if (res.ok) return res;
    const message = (await res.text()).trim();
    throw new Error(message || `Decor request failed (HTTP ${res.status}).`);
}

function readDecoration(value: unknown): Decoration {
    if (!isObject(value)) throw new Error("Invalid decoration response.");
    const { hash, animated, alt, authorId, reviewed, presetId } = value as Record<string, unknown>;
    if (typeof hash !== "string" || !hash || typeof animated !== "boolean"
        || (alt !== null && typeof alt !== "string") || (authorId !== null && typeof authorId !== "string")
        || (reviewed !== null && typeof reviewed !== "boolean") || (presetId !== null && typeof presetId !== "string"))
        throw new Error("Invalid decoration response.");
    return { hash, animated, alt, authorId, reviewed, presetId };
}

function readDecorations(value: unknown): Decoration[] {
    if (!Array.isArray(value)) throw new Error("Invalid decoration response.");
    const decorations = value.map(readDecoration);
    if (new Set(decorations.map(decoration => decoration.hash)).size !== decorations.length)
        throw new Error("Invalid duplicate decoration response.");
    return decorations;
}

export const getUsersDecorations = async (ids: string[], signal?: AbortSignal): Promise<Record<string, string | null>> => {
    if (ids.length === 0) return {};

    const url = new URL(API_URL + "/users");
    url.searchParams.set("ids", JSON.stringify(ids));

    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Could not load decorations.");
    const data: unknown = await response.json();
    if (!isObject(data)) throw new Error("Invalid decoration response.");
    const decorations: Record<string, string | null> = {};
    for (const id of ids) {
        const asset = Object.hasOwn(data, id) ? data[id] : null;
        if (asset !== null && typeof asset !== "string") throw new Error("Invalid decoration response.");
        Object.defineProperty(decorations, id, { value: asset, enumerable: true });
    }
    return decorations;
};

export const getUserDecorations = async (authorization: Authorization, signal?: AbortSignal): Promise<Decoration[]> =>
    fetchApi("/users/@me/decorations", authorization, { signal }).then(c => c.json()).then(readDecorations);

export const getUserDecoration = async (authorization: Authorization, signal?: AbortSignal): Promise<Decoration | null> => {
    const value: unknown = await fetchApi("/users/@me/decoration", authorization, { signal }).then(c => c.json());
    return value === null ? null : readDecoration(value);
};

export const setUserDecoration = async (hash: string | null, authorization: Authorization, signal?: AbortSignal): Promise<void> => {
    const formData = new FormData();
    formData.append("hash", hash ?? "null");
    await fetchApi("/users/@me/decoration", authorization, { method: "PUT", body: formData, signal });
};

export const createDecoration = async (decoration: NewDecoration, authorization: Authorization, signal?: AbortSignal): Promise<Decoration> => {
    const formData = new FormData();
    formData.append("image", decoration.file);
    formData.append("alt", decoration.alt ?? "null");
    return fetchApi("/users/@me/decoration", authorization, { method: "PUT", body: formData, signal }).then(c => c.json()).then(readDecoration);
};

export const deleteDecoration = async (hash: string, authorization: Authorization, signal?: AbortSignal): Promise<void> => {
    await fetchApi(`/decorations/${encodeURIComponent(hash)}`, authorization, { method: "DELETE", signal });
};

export const getPresets = async (signal?: AbortSignal): Promise<Preset[]> => {
    const response = await fetch(API_URL + "/decorations/presets", { signal });
    if (!response.ok) throw new Error("Could not load decoration presets.");
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new Error("Invalid decoration presets.");
    const presets = value.map((preset: unknown): Preset => {
        if (!isObject(preset)) throw new Error("Invalid decoration presets.");
        const { id, name, description, decorations, authorIds } = preset as Record<string, unknown>;
        if (typeof id !== "string" || !id || typeof name !== "string"
            || (description !== null && typeof description !== "string")
            || !Array.isArray(authorIds) || !authorIds.every((id: unknown) => typeof id === "string" && id.length > 0))
            throw new Error("Invalid decoration presets.");
        return { id, name, description, decorations: readDecorations(decorations), authorIds };
    });
    if (new Set(presets.map(preset => preset.id)).size !== presets.length) throw new Error("Invalid duplicate decoration presets.");
    return presets;
};
