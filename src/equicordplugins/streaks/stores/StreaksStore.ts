/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { proxyLazy } from "@utils/lazy";
import { UserStore, zustandCreate } from "@webpack/common";

import { API_URL } from "../constants";
import { useAuthorizationStore } from "./AuthorizationStore";

export interface RemoteStreak {
    id: string;
    user_a_id: string;
    user_b_id: string;
    count: number;
    last_streak_date: string | null;
    user_a_today: boolean;
    user_b_today: boolean;
    today_date: string | null;
}

export interface StreaksState {
    streaks: Record<string, RemoteStreak>;
    fetch: () => Promise<void>;
    update: (recipientId: string) => Promise<void>;
    refresh: (recipientId: string) => Promise<void>;
    migrate: () => Promise<void>;
    clear: () => void;
}

let active = false;
let generation = 0;
const migrations = new Map<string, Promise<void>>();

export function setStreaksActive(value: boolean) {
    active = value;
    useStreaksStore.getState().clear();
}

function captureAccount() {
    const userId = UserStore.getCurrentUser()?.id;
    const token = useAuthorizationStore.getState().tokens?.[userId];
    return active && userId && typeof token === "string" && token ? { userId, token, generation } : null;
}

function accountIsCurrent(account: NonNullable<ReturnType<typeof captureAccount>>) {
    return active && account.generation === generation && UserStore.getCurrentUser()?.id === account.userId &&
        useAuthorizationStore.getState().tokens?.[account.userId] === account.token;
}

function validStreak(value: any, userId: string): value is RemoteStreak {
    return value && typeof value.user_a_id === "string" && typeof value.user_b_id === "string" &&
        (value.user_a_id === userId || value.user_b_id === userId) &&
        Number.isSafeInteger(value.count) && value.count >= 0;
}

export const useStreaksStore = proxyLazy(() => zustandCreate((set: any, get: any) => ({
    streaks: {},
    clear: () => { generation++; set({ streaks: {} }); },
    async fetch() {
        const account = captureAccount();
        if (!account) return;

        try {
            const res = await fetch(`${API_URL}/streaks`, {
                headers: { Authorization: `Bearer ${account.token}` },
                signal: AbortSignal.timeout(15_000), redirect: "error"
            });
            if (res.ok) {
                const data: RemoteStreak[] = await res.json();
                if (!Array.isArray(data) || !accountIsCurrent(account)) return;
                const myId = account.userId;
                const streaksMap: Record<string, RemoteStreak> = {};
                for (const s of data) {
                    if (!validStreak(s, myId)) continue;
                    const otherId = s.user_a_id === myId ? s.user_b_id : s.user_a_id;
                    streaksMap[otherId] = s;
                }
                set({ streaks: streaksMap });
            }
        } catch (e) {
            console.error("Failed to fetch streaks", e);
        }
    },
    async update(recipientId: string) {
        const account = captureAccount();
        if (!account || !/^\d{17,20}$/u.test(recipientId)) return;

        try {
            const res = await fetch(`${API_URL}/streaks/${recipientId}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${account.token}` },
                signal: AbortSignal.timeout(15_000), redirect: "error"
            });
            if (res.ok) {
                const streak: RemoteStreak = await res.json();
                if (!accountIsCurrent(account) || !validStreak(streak, account.userId) ||
                    ![streak.user_a_id, streak.user_b_id].includes(recipientId)) return;
                set({ streaks: { ...get().streaks, [recipientId]: streak } });
            }
        } catch (e) {
            console.error("Failed to update streak", e);
        }
    },
    async refresh(recipientId: string) {
        const account = captureAccount();
        if (!account || !/^\d{17,20}$/u.test(recipientId)) return;

        try {
            const res = await fetch(`${API_URL}/streaks/${recipientId}`, {
                headers: { Authorization: `Bearer ${account.token}` },
                signal: AbortSignal.timeout(15_000), redirect: "error"
            });
            if (res.ok) {
                const streak: RemoteStreak = await res.json();
                if (!accountIsCurrent(account) || !validStreak(streak, account.userId) ||
                    ![streak.user_a_id, streak.user_b_id].includes(recipientId)) return;
                set({ streaks: { ...get().streaks, [recipientId]: streak } });
            }
        } catch (e) {
            console.error("Failed to refresh streak", e);
        }
    },
    async migrate() {
        const account = captureAccount();
        if (!account) return;
        const key = `${account.userId}\0${account.token}`;
        const existing = migrations.get(key);
        if (existing) return existing;
        const pending = (async () => {
            try {
                const legacyData = await DataStore.get("vc-streaks-data");
                if (!legacyData || Object.keys(legacyData).length === 0 || !accountIsCurrent(account)) return;
                const serialized = JSON.stringify(legacyData);
                const res = await fetch(`${API_URL}/streaks/migrate`, {
                    method: "POST",
                    signal: AbortSignal.timeout(15_000), redirect: "error",
                    headers: {
                        Authorization: `Bearer ${account.token}`,
                        "Content-Type": "application/json"
                    },
                    body: serialized
                });

                if (res.ok && accountIsCurrent(account)) {
                    const currentData = await DataStore.get("vc-streaks-data");
                    if (accountIsCurrent(account) && JSON.stringify(currentData) === serialized) {
                        await DataStore.del("vc-streaks-data");
                        console.log("Successfully migrated local streaks to API");
                    }
                }
            } catch (e) {
                console.error("Failed to migrate streaks", e);
            }
        })().finally(() => { if (migrations.get(key) === pending) migrations.delete(key); });
        migrations.set(key, pending);
        return pending;
    }
} as StreaksState)));
