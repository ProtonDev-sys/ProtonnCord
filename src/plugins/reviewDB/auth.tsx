/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { OAuth2AuthorizeModal, openModal, showToast, Toasts, UserStore } from "@webpack/common";

import { ReviewDBAuth } from "./entities";

const DATA_STORE_KEY = "rdb-auth";

export let Auth: ReviewDBAuth = {};
let generation = 0;

export function clearAuth() {
    generation++;
    Auth = {};
}

export async function initAuth() {
    clearAuth();
    const currentGeneration = generation;
    try {
        const auth = await getAuth();
        if (generation === currentGeneration) Auth = auth ?? {};
    } catch (error) {
        new Logger("ReviewDB").error("Failed to load authorization", error);
    }
}

export async function getAuth(): Promise<ReviewDBAuth | undefined> {
    const accountId = UserStore.getCurrentUser()?.id;
    if (!accountId) return;
    const auth = await DataStore.get(DATA_STORE_KEY);
    if (accountId === UserStore.getCurrentUser()?.id) return auth?.[accountId];
}

export async function getToken() {
    const auth = await getAuth();
    return auth?.token;
}

export async function updateAuth(newAuth: ReviewDBAuth, accountId = UserStore.getCurrentUser()?.id) {
    if (!accountId || accountId !== UserStore.getCurrentUser()?.id) return;
    const currentGeneration = generation;
    let saved: ReviewDBAuth | undefined;
    await DataStore.update(DATA_STORE_KEY, auth => {
        saved = { ...auth?.[accountId], ...newAuth };
        return { ...auth, [accountId]: saved };
    });
    if (generation === currentGeneration && accountId === UserStore.getCurrentUser()?.id && saved) Auth = saved;
}

export function authorize(callback?: () => void) {
    const accountId = UserStore.getCurrentUser()?.id;
    const currentGeneration = generation;
    if (!accountId) return;
    openModal(props =>
        <OAuth2AuthorizeModal
            {...props}
            scopes={["identify"]}
            responseType="code"
            redirectUri="https://manti.vendicated.dev/api/reviewdb/auth"
            permissions={0n}
            clientId="915703782174752809"
            cancelCompletesFlow={false}
            callback={async (response: { location: string }) => {
                try {
                    if (currentGeneration !== generation || accountId !== UserStore.getCurrentUser()?.id) return;
                    const url = new URL(response.location);
                    if (url.origin !== "https://manti.vendicated.dev" || url.pathname !== "/api/reviewdb/auth" || url.username || url.password)
                        throw new Error("Unexpected authorization redirect");
                    url.searchParams.append("clientMod", "vencord");
                    const res = await fetch(url, {
                        headers: { Accept: "application/json" },
                        signal: AbortSignal.timeout(10_000)
                    });
                    if (currentGeneration !== generation || accountId !== UserStore.getCurrentUser()?.id) return;

                    if (!res.ok) {
                        const { message } = await res.json();
                        showToast(message ?? "An error occured while authorizing", Toasts.Type.FAILURE);
                        return;
                    }

                    const { token } = await res.json();
                    if (typeof token !== "string" || !token) throw new Error("Missing authorization token");
                    if (currentGeneration !== generation || accountId !== UserStore.getCurrentUser()?.id) return;
                    await updateAuth({ token }, accountId);
                    if (currentGeneration !== generation || accountId !== UserStore.getCurrentUser()?.id) return;
                    showToast("Successfully logged in!", Toasts.Type.SUCCESS);
                    callback?.();
                } catch (e) {
                    new Logger("ReviewDB").error("Failed to authorize", e);
                }
            }}
        />
    );
}
