/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserData, UserDataSchema } from "@song-spotlight/api/structs";
import { showToast, Toasts, UserStore } from "@webpack/common";

import { Token, useAuthorizationStore } from "./stores/AuthorizationStore";
import { useSongStore } from "./stores/SongStore";

const api = "https://dc.songspotlight.nexpid.xyz/";
export const apiConstants = {
    api,
    oauth2: {
        clientId: "1157745434140344321",
        redirectURL: `${api}api/auth/authorize`,
    },
    songLimit: 6,
};

const tokenRefreshes = new Map<string, { token: Token; promise: Promise<boolean>; }>();

function accountIsCurrent(userId: string | undefined) {
    return UserStore.getCurrentUser()?.id === userId;
}

function requireCurrentAccount(userId: string | undefined) {
    if (!accountIsCurrent(userId)) throw new Error("Song Spotlight cancelled a request after the account changed");
}

async function refreshAccessToken(userId: string | undefined, token: Token | undefined) {
    if (!userId || !token || !accountIsCurrent(userId)) return false;
    const existing = tokenRefreshes.get(userId);
    if (existing?.token.access === token.access && existing.token.refresh === token.refresh) return existing.promise;

    const promise = fetch(new URL("api/auth/refresh", apiConstants.api), {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
        headers: {
            "X-Refresh-Token": token.refresh,
        },
        body: token.access,
    }).then(async res => {
        if (!res.ok) return false;

        const access = await res.text();
        const current = useAuthorizationStore.getState().getToken(userId);
        if (!access || !accountIsCurrent(userId) || current?.access !== token.access || current.refresh !== token.refresh) return false;
        useAuthorizationStore.getState().setToken(access, token.refresh, userId);
        return true;
    }).finally(() => {
        if (tokenRefreshes.get(userId)?.promise === promise) tokenRefreshes.delete(userId);
    });
    tokenRefreshes.set(userId, { token, promise });
    return promise;
}

export async function authFetch(url: string | URL, options?: RequestInit, retried = false, userId = UserStore.getCurrentUser()?.id): Promise<Response | null> {
    url = new URL(url);
    if (url.origin !== new URL(apiConstants.api).origin)
        throw new Error("Song Spotlight refused to send credentials outside its API");
    try {
        requireCurrentAccount(userId);
        const token = useAuthorizationStore.getState().getToken(userId);
        const headers = new Headers(options?.headers);
        if (token?.access) headers.set("Authorization", token.access);
        else headers.delete("Authorization");
        const res = await fetch(url, {
            ...options,
            headers,
            redirect: "error",
            signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        });
        requireCurrentAccount(userId);

        if (res.ok) return res;

        // not modified
        if (res.status === 304) return null;

        const text = await res.text();
        requireCurrentAccount(userId);

        // unauthorized
        if (res.status === 401) {
            const retry = !retried && await refreshAccessToken(userId, token);
            requireCurrentAccount(userId);
            if (retry) return await authFetch(url, options, true, userId);
            else {
                if (userId && useAuthorizationStore.getState().getToken(userId)?.access === token?.access) {
                    useAuthorizationStore.getState().deleteTokens(userId);
                    showToast("You have been signed out from Song Spotlight. Please sign in again.", Toasts.Type.FAILURE);
                }
            }
        } else {
            showToast(
                !text.includes("<body>") && res.status >= 400 && res.status <= 599
                    ? `Song Spotlight: ${text}`
                    : `Song Spotlight fetch error at ${url.pathname}`,
                Toasts.Type.FAILURE,
            );
        }

        throw new Error(text);
    } catch (error) {
        showToast(`Song Spotlight: ${error}`, Toasts.Type.FAILURE);

        throw error;
    }
}

export async function getData(): Promise<UserData | undefined> {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;
    return await authFetch(new URL("api/data", apiConstants.api), {
        headers: {
            "If-Modified-Since": useSongStore.getState().users[userId]?.at,
        } as HeadersInit,
    }).then(async res => {
        if (!res) return useSongStore.getState().users[userId]?.data;

        const data = UserDataSchema.max(apiConstants.songLimit).parse(await res.json());
        requireCurrentAccount(userId);
        useSongStore.getState().update({
            userId,
            data,
            at: res.headers.get("Last-Modified") || undefined,
        });
        return data;
    });
}
export async function listData(userId: string): Promise<UserData | undefined> {
    if (userId === UserStore.getCurrentUser()?.id) return await getData();

    return await authFetch(new URL(`api/data/${userId}`, apiConstants.api), {
        headers: {
            "If-Modified-Since": useSongStore.getState().users[userId]?.at,
        } as HeadersInit,
    }).then(async res => {
        if (!res) return useSongStore.getState().users[userId]?.data;

        const data = UserDataSchema.max(apiConstants.songLimit).parse(await res.json());
        useSongStore.getState().update({
            userId,
            data,
            at: res.headers.get("Last-Modified") || undefined,
        });
        return data;
    });
}
export async function saveData(data: UserData): Promise<true> {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) throw new Error("Song Spotlight could not identify the current account");
    data = UserDataSchema.max(apiConstants.songLimit).parse(structuredClone(data));
    return await authFetch(new URL("api/data", apiConstants.api), {
        method: "PUT",
        body: JSON.stringify(data),
        headers: {
            "Content-Type": "application/json",
        },
    })
        .then(res => res?.json())
        .then(json => {
            requireCurrentAccount(userId);
            useSongStore
                .getState().update({
                    userId,
                    data,
                    at: new Date().toUTCString(),
                });
            return json;
        });
}
export async function deleteData(): Promise<true> {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) throw new Error("Song Spotlight could not identify the current account");
    return await authFetch(new URL("api/data", apiConstants.api), {
        method: "DELETE",
    })
        .then(res => res?.json())
        .then(json => {
            requireCurrentAccount(userId);
            useSongStore.getState().delete(userId);
            return json;
        });
}
