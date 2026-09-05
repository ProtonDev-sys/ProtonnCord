/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createDecoration, Decoration, deleteDecoration, getUserDecoration, getUserDecorations, NewDecoration, setUserDecoration } from "@plugins/decor/lib/api";
import { decorationToAsset } from "@plugins/decor/lib/utils/decoration";
import { proxyLazy } from "@utils/lazy";
import { zustandCreate } from "@webpack/common";

import { Authorization, useAuthorizationStore } from "./AuthorizationStore";
import { useUsersDecorationsStore } from "./UsersDecorationsStore";

interface UserDecorationsState {
    decorations: Decoration[];
    selectedDecoration: Decoration | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    fetch(authorization: Authorization): Promise<void>;
    delete(hash: string, authorization: Authorization): Promise<void>;
    create(decoration: NewDecoration, authorization: Authorization): Promise<void>;
    select(decoration: Decoration | null, authorization: Authorization): Promise<void>;
    clear(): void;
}

interface UserDecorationsStore {
    (): UserDecorationsState;
    getState(): UserDecorationsState;
}

interface Operation {
    authorization: Authorization;
    controller: AbortController;
}

export const useCurrentUserDecorationsStore: UserDecorationsStore = proxyLazy(() => zustandCreate((set: (state: Partial<UserDecorationsState>) => void, get: () => UserDecorationsState) => {
    let read: { operation: Operation; promise: Promise<void>; } | undefined;
    let write: Operation | undefined;

    function isCurrent(operation: Operation) {
        return !operation.controller.signal.aborted && useAuthorizationStore.getState().isAuthorized()
            && useAuthorizationStore.getState().authorization === operation.authorization;
    }

    async function mutate(authorization: Authorization, update: (signal: AbortSignal) => Promise<Partial<UserDecorationsState>>) {
        useAuthorizationStore.getState().requireAuthorization(authorization);
        if (write) throw new Error("Wait for the current decoration change to finish.");
        read?.operation.controller.abort();
        read = undefined;
        const operation = { authorization, controller: new AbortController() };
        write = operation;
        set({ busy: true, loading: false, error: null });
        try {
            const next = await update(operation.controller.signal);
            if (!isCurrent(operation)) throw new Error("The Decor account or service changed. Please try again.");
            set(next);
            if ("selectedDecoration" in next) {
                const decoration = next.selectedDecoration;
                useUsersDecorationsStore.getState().set(authorization.userId, decoration ? decorationToAsset(decoration) : null);
            }
        } catch (error) {
            const failure = error instanceof Error ? error : new Error("Could not change the decoration.");
            if (isCurrent(operation)) set({ error: failure.message });
            throw failure;
        } finally {
            if (write === operation) {
                write = undefined;
                set({ busy: false });
            }
        }
    }

    return {
        decorations: [],
        selectedDecoration: null,
        loading: false,
        busy: false,
        error: null,
        async fetch(authorization) {
            useAuthorizationStore.getState().requireAuthorization(authorization);
            if (write) throw new Error("Wait for the current decoration change to finish.");
            if (read && read.operation.authorization === authorization) return read.promise;
            read?.operation.controller.abort();
            const operation = { authorization, controller: new AbortController() };
            set({ loading: true, error: null });
            const promise = (async () => {
                try {
                    const [decorations, selectedDecoration] = await Promise.all([
                        getUserDecorations(authorization, operation.controller.signal),
                        getUserDecoration(authorization, operation.controller.signal)
                    ]);
                    if (isCurrent(operation)) {
                        set({ decorations, selectedDecoration });
                        useUsersDecorationsStore.getState().set(authorization.userId, selectedDecoration ? decorationToAsset(selectedDecoration) : null);
                    }
                } catch (error) {
                    if (isCurrent(operation)) set({ error: error instanceof Error ? error.message : "Could not load decorations." });
                } finally {
                    operation.controller.abort();
                    if (read?.operation === operation) {
                        read = undefined;
                        set({ loading: false });
                    }
                }
            })();
            read = { operation, promise };
            await promise;
        },
        create(newDecoration, authorization) {
            return mutate(authorization, async signal => {
                const decoration = await createDecoration(newDecoration, authorization, signal);
                return { decorations: [...get().decorations.filter(item => item.hash !== decoration.hash), decoration] };
            });
        },
        delete(hash, authorization) {
            return mutate(authorization, async signal => {
                await deleteDecoration(hash, authorization, signal);
                const { selectedDecoration, decorations } = get();
                return {
                    decorations: decorations.filter(decoration => decoration.hash !== hash),
                    selectedDecoration: selectedDecoration?.hash === hash ? null : selectedDecoration
                };
            });
        },
        select(decoration, authorization) {
            return mutate(authorization, async signal => {
                await setUserDecoration(decoration?.hash ?? null, authorization, signal);
                return { selectedDecoration: decoration };
            });
        },
        clear() {
            read?.operation.controller.abort();
            write?.controller.abort();
            read = undefined;
            write = undefined;
            set({ decorations: [], selectedDecoration: null, loading: false, busy: false, error: null });
        }
    } satisfies UserDecorationsState;
}));
