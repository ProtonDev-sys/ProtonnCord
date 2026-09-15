/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { logger, themeRequest } from "@equicordplugins/themeLibrary/components/ThemeTab";
import { OAuth2AuthorizeModal, openModal,Toasts, UserStore } from "@webpack/common";

const TOKEN_KEY = "ThemeLibrary_uniqueToken";

let tokenCache: string | null | undefined;
let tokenLoadPromise: Promise<string | null> | null = null;
let tokenGeneration = 0;
let tokenMutation = Promise.resolve();

export async function getThemeLibraryToken(): Promise<string | null> {
    const mutation = tokenMutation;
    await mutation.catch(() => undefined);
    if (mutation !== tokenMutation) return getThemeLibraryToken();
    if (tokenCache !== undefined) return tokenCache;

    const generation = tokenGeneration;
    const pending = tokenLoadPromise ??= DataStore.get<string>(TOKEN_KEY)
        .then(token => {
            if (generation !== tokenGeneration) return getThemeLibraryToken();
            return tokenCache = typeof token === "string" && token ? token : null;
        })
        .finally(() => {
            if (tokenLoadPromise === pending) tokenLoadPromise = null;
        });

    return pending;
}

async function setThemeLibraryToken(token: string) {
    tokenGeneration++;
    tokenLoadPromise = null;
    tokenMutation = tokenMutation.catch(() => undefined).then(async () => {
        await DataStore.set(TOKEN_KEY, token);
        tokenCache = token;
    });
    await tokenMutation;
}

async function deleteThemeLibraryToken(expectedToken?: string) {
    tokenGeneration++;
    tokenLoadPromise = null;
    tokenMutation = tokenMutation.catch(() => undefined).then(async () => {
        if (expectedToken && tokenCache !== expectedToken) return;
        await DataStore.del(TOKEN_KEY);
        tokenCache = null;
    });
    await tokenMutation;
}

export async function authorizeUser(triggerModal: boolean = true) {
    const userId = UserStore.getCurrentUser()?.id;
    const isAuthorized = await getAuthorization();

    if (isAuthorized === false) {
        if (!triggerModal || !userId || UserStore.getCurrentUser()?.id !== userId) return false;
        openModal((props: any) => <OAuth2AuthorizeModal
            {...props}
            scopes={["identify", "connections"]}
            responseType="code"
            redirectUri="https://themes.equicord.org/api/user/auth"
            permissions={0n}
            clientId="1464006702125940736"
            cancelCompletesFlow={false}
            callback={async ({ location }: any) => {
                if (!location) return logger.error("No redirect location returned");

                try {
                    const callbackUrl = new URL(location);
                    if (callbackUrl.origin !== "https://themes.equicord.org" || callbackUrl.pathname !== "/api/user/auth")
                        throw new Error("Unexpected authorization callback");
                    if (UserStore.getCurrentUser()?.id !== userId) return;
                    const response = await fetch(location, {
                        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "error"
                    });
                    if (!response.ok) throw new Error(`Authorization failed (${response.status})`);

                    const { token } = await response.json();
                    if (UserStore.getCurrentUser()?.id !== userId) return;

                    if (typeof token === "string" && token) {
                        await setThemeLibraryToken(token);
                        showNotification({
                            title: "ThemeLibrary",
                            body: "Successfully authorized with ThemeLibrary!"
                        });
                    } else {
                        showNotification({
                            title: "ThemeLibrary",
                            body: "Failed to authorize, check console"
                        });
                    }
                } catch (e: any) {
                    logger.error("Failed to authorize", e);
                    showNotification({
                        title: "ThemeLibrary",
                        body: "Failed to authorize, check console"
                    });
                }
            }
            }
        />);
    } else {
        return isAuthorized;
    }
}

export async function deauthorizeUser() {
    const uniqueToken = await getThemeLibraryToken();

    if (!uniqueToken) return Toasts.show({
        message: "No uniqueToken present, try authorizing first!",
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        options: {
            duration: 2e3,
            position: Toasts.Position.BOTTOM
        }
    });

    const currentUser = UserStore.getCurrentUser();
    if (!currentUser) return Toasts.show({
        message: "Unable to deauthorize while logged out.",
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        options: {
            duration: 2e3,
            position: Toasts.Position.BOTTOM
        }
    });

    const res = await themeRequest("/user/revoke", {
        method: "DELETE",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${uniqueToken}`
        },
        body: JSON.stringify({ userId: currentUser.id })
    });

    if (res.ok) {
        await deleteThemeLibraryToken(uniqueToken);
        showNotification({
            title: "ThemeLibrary",
            body: "Successfully deauthorized from ThemeLibrary!"
        });
    } else {
        // try to delete anyway
        try {
            await deleteThemeLibraryToken(uniqueToken);
        } catch (e) {
            logger.error("Failed to delete token", e);
            showNotification({
                title: "ThemeLibrary",
                body: "Failed to deauthorize, check console"
            });
        }
    }
}

export async function getAuthorization() {
    const uniqueToken = await getThemeLibraryToken();

    if (!uniqueToken) {
        return false;
    } else {
        // check if valid
        const res = await themeRequest("/user/findUserByToken", {
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${uniqueToken}`
            },
        });

        if (!res.ok) {
            return false;
        } else {
            return uniqueToken;
        }
    }

}

export async function isAuthorized(triggerModal: boolean = true) {
    const authorization = await getAuthorization();

    if (authorization === false) {
        await authorizeUser(triggerModal);
        return false;
    }

    return true;
}
