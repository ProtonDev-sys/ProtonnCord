/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { API_URL, AUTHORIZE_URL, CLIENT_ID } from "@plugins/decor/lib/constants";
import { proxyLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { isObject, parseUrl } from "@utils/misc";
import { closeModal, OAuth2AuthorizeModal, openModal, UserStore, zustandCreate } from "@webpack/common";

interface AuthorizationScope {
    userId: string;
    apiUrl: string;
    authorizeUrl: string;
    clientId: string;
}

export interface Authorization extends AuthorizationScope {
    token: string;
}

interface AuthorizationState {
    authorization: Authorization | null;
    ready: boolean;
    busy: boolean;
    error: string | null;
    init(): Promise<void>;
    clear(error?: string): void;
    authorize(): Promise<void>;
    remove(expected: Authorization): Promise<void>;
    requireAuthorization(): Authorization;
    isAuthorized(): boolean;
}

interface AuthorizationStore {
    (): AuthorizationState;
    getState(): AuthorizationState;
}

const TOKEN_KEY = "decor-auth-v2";
const logger = new Logger("Decor");

function scopeMatches(scope: AuthorizationScope) {
    return scope.userId === UserStore.getCurrentUser()?.id && scope.apiUrl === API_URL
        && scope.authorizeUrl === AUTHORIZE_URL && scope.clientId === CLIENT_ID;
}

function captureScope(): AuthorizationScope {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) throw new Error("Sign in to Discord before using Decor.");
    return { userId, apiUrl: API_URL, authorizeUrl: AUTHORIZE_URL, clientId: CLIENT_ID };
}

function tokenKey(scope: AuthorizationScope) {
    return JSON.stringify([scope.apiUrl, scope.authorizeUrl, scope.clientId, scope.userId]);
}

function isToken(value: unknown): value is string {
    return typeof value === "string" && /^[\x21-\x7e]+$/.test(value);
}

function readTokens(value: unknown): Record<string, string> {
    if (value === undefined) return {};
    if (!isObject(value)) throw new Error("Could not read saved Decor authorization.");
    const entries = Object.entries(value);
    if (entries.some(([, token]) => !isToken(token))) throw new Error("Could not read saved Decor authorization.");
    return Object.fromEntries(entries);
}

export const useAuthorizationStore: AuthorizationStore = proxyLazy(() => zustandCreate((set: (state: Partial<AuthorizationState>) => void, get: () => AuthorizationState) => {
    let generation = 0;
    let attempt: { scope: AuthorizationScope; promise: Promise<void>; cancel(): void; } | undefined;
    const isCurrent = (scope: AuthorizationScope, version: number) => version === generation && scopeMatches(scope);

    return {
        authorization: null,
        ready: false,
        busy: false,
        error: null,
        clear(error) {
            generation++;
            attempt?.cancel();
            set({ authorization: null, ready: false, busy: false, error: error ?? null });
        },
        async init() {
            get().clear();
            if (!UserStore.getCurrentUser()) return;
            const version = generation;
            const scope = captureScope();
            set({ busy: true });
            try {
                const tokens = readTokens(await DataStore.get<unknown>(TOKEN_KEY));
                if (!isCurrent(scope, version)) return;
                const token = tokens[tokenKey(scope)];
                set({ authorization: token ? { ...scope, token } : null, ready: true, busy: false });
            } catch (error) {
                if (!isCurrent(scope, version)) return;
                logger.error("Could not load Decor authorization", error);
                set({ ready: true, busy: false, error: "Could not read saved Decor authorization. Your saved data has been kept." });
            }
        },
        authorize() {
            let scope: AuthorizationScope;
            try {
                if (!get().ready) throw new Error("Decor is not ready to authorize. Check its configuration and restart the plugin.");
                scope = captureScope();
            } catch (error) {
                const failure = error instanceof Error ? error : new Error("Could not start Decor authorization.");
                set({ error: failure.message });
                return Promise.reject(failure);
            }
            if (attempt && scopeMatches(attempt.scope)) return attempt.promise;
            attempt?.cancel();
            const version = ++generation;
            set({ busy: true, error: null });
            let cancel: () => void = () => undefined;
            const promise = new Promise<void>((resolve, reject) => {
                const controller = new AbortController();
                let modalKey: string | undefined;
                let exchanging = false;
                let settled = false;
                const closeOwnedModal = () => {
                    if (modalKey === undefined) return;
                    const key = modalKey;
                    modalKey = undefined;
                    try { closeModal(key); } catch (error) { logger.error("Could not close Decor authorization", error); }
                };
                const finish = (error?: Error, cancelled = false) => {
                    if (settled) return;
                    settled = true;
                    controller.abort();
                    if (isCurrent(scope, version)) set({ busy: false, error: cancelled ? null : error?.message ?? null });
                    closeOwnedModal();
                    if (error) reject(error);
                    else resolve();
                };
                cancel = () => finish(new Error("Authorization cancelled."), true);
                const assertCurrent = () => {
                    if (controller.signal.aborted || !isCurrent(scope, version)) throw new Error("The Decor account or service changed. Please try again.");
                };
                try {
                    modalKey = openModal(props =>
                        <OAuth2AuthorizeModal
                            {...props}
                            scopes={["identify"]}
                            responseType="code"
                            redirectUri={scope.authorizeUrl}
                            permissions={0n}
                            clientId={scope.clientId}
                            cancelCompletesFlow={false}
                            callback={async (response: unknown) => {
                                if (settled || exchanging) return;
                                exchanging = true;
                                try {
                                    assertCurrent();
                                    const url = isObject(response) && "location" in response && typeof response.location === "string"
                                        ? parseUrl(response.location) : null;
                                    const expected = new URL(scope.authorizeUrl);
                                    if (!url || url.origin !== expected.origin || url.pathname !== expected.pathname
                                        || url.username || url.password || url.hash || !url.searchParams.get("code") || url.searchParams.has("error"))
                                        throw new Error("Invalid Decor authorization response.");
                                    url.searchParams.set("client", "vencord");
                                    const responseToken = await fetch(url, { signal: controller.signal, redirect: "error" });
                                    if (!responseToken.ok) throw new Error("Decor authorization failed.");
                                    const token = (await responseToken.text()).trim();
                                    if (!isToken(token)) throw new Error("Decor returned an invalid authorization token.");
                                    assertCurrent();
                                    await DataStore.update<unknown>(TOKEN_KEY, previous => {
                                        assertCurrent();
                                        return { ...readTokens(previous), [tokenKey(scope)]: token };
                                    });
                                    assertCurrent();
                                    set({ authorization: { ...scope, token } });
                                    finish();
                                } catch (error) {
                                    if (settled) return;
                                    const failure = error instanceof Error ? error : new Error("Decor authorization failed.");
                                    logger.error("Failed to authorize Decor", failure);
                                    finish(failure);
                                }
                            }}
                        />, {
                        onCloseCallback() {
                            modalKey = undefined;
                            if (!exchanging) cancel();
                        }
                    });
                    if (settled) closeOwnedModal();
                    else if (!isCurrent(scope, version)) cancel();
                } catch (error) {
                    finish(error instanceof Error ? error : new Error("Could not open Decor authorization."));
                }
            });
            const current = { scope, promise, cancel };
            attempt = current;
            const cleanup = () => { if (attempt === current) attempt = undefined; };
            void promise.then(cleanup, cleanup);
            return promise;
        },
        async remove(expected) {
            if (get().authorization !== expected || !scopeMatches(expected)) throw new Error("The Decor account changed. Please try again.");
            if (get().busy) throw new Error("Wait for the current Decor authorization to finish.");
            const version = ++generation;
            set({ busy: true, error: null });
            try {
                await DataStore.update<unknown>(TOKEN_KEY, previous => {
                    if (!isCurrent(expected, version)) throw new Error("The Decor account changed. Please try again.");
                    const tokens = readTokens(previous);
                    const key = tokenKey(expected);
                    if (tokens[key] !== undefined && tokens[key] !== expected.token) throw new Error("Saved Decor authorization changed. Please sign in again.");
                    delete tokens[key];
                    return tokens;
                });
                if (isCurrent(expected, version)) set({ authorization: null, busy: false });
            } catch (error) {
                const failure = error instanceof Error ? error : new Error("Could not remove Decor authorization.");
                if (isCurrent(expected, version)) set({ busy: false, error: failure.message });
                throw failure;
            }
        },
        requireAuthorization() {
            const { authorization, ready } = get();
            if (!ready || !authorization || !scopeMatches(authorization)) throw new Error("Sign in to Decor before changing decorations.");
            return authorization;
        },
        isAuthorized() {
            const { authorization, ready } = get();
            return ready && authorization !== null && scopeMatches(authorization);
        }
    } satisfies AuthorizationState;
}));
