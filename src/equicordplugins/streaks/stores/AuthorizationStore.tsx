/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { proxyLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { OAuth2AuthorizeModal, openModal, showToast, Toasts, UserStore, zustandCreate, zustandPersist } from "@webpack/common";

import { AUTHORIZE_URL, CLIENT_ID } from "../constants";
import { useStreaksStore } from "./StreaksStore";

interface AuthorizationState {
    token: string | null;
    tokens: Record<string, string>;
    init: () => void;
    authorize: () => Promise<void>;
    setToken: (token: string, id?: string) => void;
    remove: (id: string) => void;
    isAuthorized: () => boolean;
}
const indexedDBStorage = {
    async getItem(name: string): Promise<string | null> {
        return DataStore.get(name).then(v => v ?? null);
    },
    async setItem(name: string, value: string): Promise<void> {
        await DataStore.set(name, value);
    },
    async removeItem(name: string): Promise<void> {
        await DataStore.del(name);
    },
};
export const useAuthorizationStore = proxyLazy(() => zustandCreate(
    zustandPersist(
        (set: any, get: any) => ({
            token: null,
            tokens: {},
            init: () => {
                useStreaksStore.getState().clear();
                set({ token: get().tokens?.[UserStore.getCurrentUser()?.id] ?? null });
            },
            setToken: (token: string, id = UserStore.getCurrentUser()?.id) => {
                if (!id) return;
                set({ token: UserStore.getCurrentUser()?.id === id ? token : get().token, tokens: { ...get().tokens, [id]: token } });
            },
            remove: (id: string) => {
                const { tokens, init } = get();
                const newTokens = { ...tokens };
                delete newTokens[id];
                set({ tokens: newTokens });
                init();
            },
            async authorize() {
                const userId = UserStore.getCurrentUser()?.id;
                if (!userId) throw new Error("No current account");
                return new Promise((resolve, reject) => {
                    let hasCallbackStarted = false;
                    openModal(props =>
                        <OAuth2AuthorizeModal
                            {...props}
                            scopes={["identify"]}
                            responseType="code"
                            redirectUri={AUTHORIZE_URL}
                            permissions={0n}
                            clientId={CLIENT_ID}
                            cancelCompletesFlow={false}
                            callback={async (response: any) => {
                                hasCallbackStarted = true;
                                try {
                                    const url = new URL(response.location);
                                    const expected = new URL(AUTHORIZE_URL);
                                    if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new Error("Unexpected authorization callback");
                                    if (UserStore.getCurrentUser()?.id !== userId) throw new Error("The account changed during authorization");
                                    const code = url.searchParams.get("code");
                                    if (!code) throw new Error("No code in redirect");
                                    const req = await fetch(`${AUTHORIZE_URL}?code=${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
                                    if (req?.ok) {
                                        const { access_token: token } = await req.json();
                                        if (typeof token !== "string" || !token) throw new Error("No access token returned");
                                        if (UserStore.getCurrentUser()?.id !== userId) throw new Error("The account changed during authorization");
                                        get().setToken(token, userId);
                                    } else {
                                        throw new Error(`Request not OK: ${req.status}`);
                                    }
                                    resolve(void 0);
                                } catch (e) {
                                    if (e instanceof Error) {
                                        showToast(`Failed to authorize: ${e.message}`, Toasts.Type.FAILURE);
                                        new Logger("Streaks").error("Failed to authorize", e);
                                    }
                                    reject(e);
                                }
                            }}
                        />, {
                        onCloseCallback() {
                            if (!hasCallbackStarted) {
                                reject(new Error("Authorization cancelled"));
                            }
                        },
                    });
                });
            },
            isAuthorized: () => typeof get().tokens?.[UserStore.getCurrentUser()?.id] === "string" && !!get().tokens[UserStore.getCurrentUser()?.id],
        } as AuthorizationState),
        {
            name: "vc-streaks-auth",
            storage: indexedDBStorage,
            partialize: state => ({ tokens: state.tokens }),
            onRehydrateStorage: () => async state => {
                if (!state) return;
                state.init();
                if (state.isAuthorized()) {
                    useStreaksStore.getState().clear();
                    await useStreaksStore.getState().migrate();
                    await useStreaksStore.getState().fetch();
                }
            }
        }
    )
));
