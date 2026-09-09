/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationIntegrationType } from "@vencord/discord-types/enums";
import { OAuth2AuthorizeModal, openModal,showToast, Toasts, UserStore } from "@webpack/common";

import { apiConstants, authFetch, getData } from "./api";
import { useAuthorizationStore } from "./stores/AuthorizationStore";
import { logger } from "./utils";

export function presentOAuth2Modal() {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;
    openModal(props => (
        <OAuth2AuthorizeModal
            {...props}
            clientId={apiConstants.oauth2.clientId}
            scopes={["applications.commands", "identify"]}
            integrationType={ApplicationIntegrationType.USER_INSTALL}
            permissions={0n}
            responseType="code"
            redirectUri={apiConstants.oauth2.redirectURL}
            cancelCompletesFlow={false}
            callback={async ({ location }) => {
                if (!location || UserStore.getCurrentUser()?.id !== userId) return;

                try {
                    const url = new URL(location);
                    const redirect = new URL(apiConstants.oauth2.redirectURL);
                    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) throw "Unexpected authorization callback";
                    url.searchParams.append("whois", "equicord");

                    const res = await authFetch(url);
                    if (!res) throw "Response wasn't ok";

                    const access = await res.text();
                    if (UserStore.getCurrentUser()?.id !== userId) return;
                    if (!access) throw "Access token is missing";

                    const refresh = res.headers.get("X-Refresh-Token");
                    if (!refresh) throw "Refresh token is missing";

                    useAuthorizationStore.getState().setToken(access, refresh, userId);
                    await getData();

                    showToast("Successfully authorized!", Toasts.Type.SUCCESS);
                } catch (error) {
                    logger.error("Got an error during OAuth2", error);
                    if (typeof error === "string") showToast(error, Toasts.Type.FAILURE);
                }
            }}
        />
    ));
}
