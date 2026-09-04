/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { OAuth2AuthorizeModal, openModal, UserStore } from "@webpack/common";

import { parseCloudBackendUrl } from "./cloudPolicy";

export const logger = new Logger("SettingsSync:CloudSetup", "#39b7e0");
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
let authorizationGeneration = 0;
const authorizationCommitQueues = new Map<string, Promise<void>>();

export function cancelCloudAuthorization() {
    authorizationGeneration++;
}

function isCurrentAuthorizationFlow(origin: string, userId: string, generation: number) {
    if (generation !== authorizationGeneration) return false;
    try {
        return getCloudUrlOrigin() === origin && getUserId() === userId;
    } catch {
        return false;
    }
}

export const getCloudUrl = () => parseCloudBackendUrl(Settings.cloud.url);
const getCloudUrlOrigin = () => getCloudUrl().origin;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

const getUserId = () => {
    const id = UserStore.getCurrentUser()?.id;
    if (!id) throw new Error("User not yet logged in");
    return id;
};

export const getCloudUserId = getUserId;

export const getCloudSyncScope = () => `${getCloudUrlOrigin()}:${getUserId()}`;

export interface CloudRequestContext {
    authorization: string;
    origin: string;
    scope: string;
    url: URL;
    userId: string;
}

function encodeCloudAuthorization(secret: string, userId: string) {
    return window.btoa(`${secret}:${userId}`);
}

function isValidCloudSecret(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !/^[\x20-\x39\x3b-\x7e]+$/u.test(value))
        return false;
    try {
        encodeCloudAuthorization(value, "0");
        return true;
    } catch {
        return false;
    }
}

async function readBoundedOAuthJson(response: Response): Promise<Record<string, unknown>> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_OAUTH_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => { });
        throw new Error("OAuth response exceeded the allowed size");
    }
    if (!response.body) throw new Error("OAuth response had no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_OAUTH_RESPONSE_BYTES) throw new Error("OAuth response exceeded the allowed size");
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => { });
        throw error;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        throw new Error("OAuth response was invalid");
    }
    if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("OAuth response was invalid");
    return value as Record<string, unknown>;
}

export async function getAuthorization() {
    return await getAuthorizationForOrigin(getCloudUrlOrigin(), getUserId());
}

async function getAuthorizationForOrigin(origin: string, userId: string) {
    const stored = await DataStore.get<Record<string, string>>("Vencord_cloudSecret");
    const secrets = isPlainRecord(stored) ? stored : {};
    const scopedKey = `${origin}:${userId}`;
    const scopedSecret = isValidCloudSecret(secrets[scopedKey]) ? secrets[scopedKey] : undefined;

    // we need to migrate from the old format here
    if (secrets[origin] !== undefined || secrets[scopedKey] !== undefined && !scopedSecret) {
        await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
            if (!isPlainRecord(secrets)) secrets = {};
            const currentScoped = isValidCloudSecret(secrets[scopedKey]) ? secrets[scopedKey] : undefined;
            const currentLegacy = isValidCloudSecret(secrets[origin]) ? secrets[origin] : undefined;
            // Preserve a concurrently written account-scoped credential over legacy state.
            if (currentScoped) secrets[scopedKey] = currentScoped;
            else if (currentLegacy) secrets[scopedKey] = currentLegacy;
            else delete secrets[scopedKey];
            delete secrets[origin];
            return secrets;
        });
        return await getAuthorizationForOrigin(origin, userId);
    }

    return scopedSecret;
}

export async function getCloudRequestContext(): Promise<CloudRequestContext> {
    const url = getCloudUrl();
    const userId = getUserId();
    const secret = await getAuthorizationForOrigin(url.origin, userId);
    if (!secret) throw new Error("Cloud account is not authorized");

    return {
        authorization: encodeCloudAuthorization(secret, userId),
        origin: url.origin,
        scope: `${url.origin}:${userId}`,
        url,
        userId,
    };
}

async function setAuthorizationForContext(secret: string, origin: string, userId: string) {
    await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
        if (!isPlainRecord(secrets)) secrets = {};
        secrets[`${origin}:${userId}`] = secret;
        return secrets;
    });
}

export async function deauthorizeCloud(origin = getCloudUrlOrigin(), userId = getUserId()) {
    await deauthorizeCloudForContext(origin, userId);
}

async function deauthorizeCloudForContext(origin: string, userId: string) {
    await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
        if (!isPlainRecord(secrets)) secrets = {};
        delete secrets[`${origin}:${userId}`];
        delete secrets[origin];
        return secrets;
    });
}

async function removeAuthorizationIfUnchanged(secret: string, origin: string, userId: string) {
    await DataStore.update<Record<string, string>>("Vencord_cloudSecret", secrets => {
        if (!isPlainRecord(secrets)) secrets = {};
        const scopedKey = `${origin}:${userId}`;
        if (secrets[scopedKey] === secret) delete secrets[scopedKey];
        return secrets;
    });
}

async function commitAuthorization(
    secret: string,
    origin: string,
    userId: string,
    generation: number
): Promise<boolean> {
    const scope = `${origin}:${userId}`;
    const previous = authorizationCommitQueues.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    authorizationCommitQueues.set(scope, current);
    await previous;

    try {
        if (!isCurrentAuthorizationFlow(origin, userId, generation))
            return false;
        await setAuthorizationForContext(secret, origin, userId);
        if (!isCurrentAuthorizationFlow(origin, userId, generation)) {
            await removeAuthorizationIfUnchanged(secret, origin, userId);
            return false;
        }
        return true;
    } finally {
        release();
        if (authorizationCommitQueues.get(scope) === current) authorizationCommitQueues.delete(scope);
    }
}

export async function authorizeCloud(signal?: AbortSignal) {
    const generation = ++authorizationGeneration;
    const url = getCloudUrl();
    const { origin } = url;
    const userId = getUserId();
    const scope = `${origin}:${userId}`;
    const pendingCommit = authorizationCommitQueues.get(scope);
    if (pendingCommit) await pendingCommit;
    if (!isCurrentAuthorizationFlow(origin, userId, generation)) return;
    if (await getAuthorizationForOrigin(origin, userId) !== undefined) {
        if (isCurrentAuthorizationFlow(origin, userId, generation)) {
            Settings.cloud.authenticated = true;
        }
        return;
    }

    try {
        const oauthConfiguration = await fetch(new URL("/v1/oauth/settings", url), {
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal,
        });
        if (!oauthConfiguration.ok) {
            void oauthConfiguration.body?.cancel().catch(() => { });
            throw new Error(`OAuth configuration returned ${oauthConfiguration.status}`);
        }
        var { clientId, redirectUri } = await readBoundedOAuthJson(oauthConfiguration);
        if (typeof clientId !== "string" || !/^\d{17,20}$/u.test(clientId) || typeof redirectUri !== "string" || redirectUri.length > 4096)
            throw new Error("OAuth configuration was invalid");
        const redirect = new URL(redirectUri);
        if (redirect.protocol !== "https:" || redirect.origin !== origin || redirect.username || redirect.password || redirect.hash)
            throw new Error("OAuth redirect left the configured cloud origin");
        redirectUri = redirect.href;
    } catch {
        if (isCurrentAuthorizationFlow(origin, userId, generation)) {
            showNotification({
                title: "Cloud Integration",
                body: "Setup failed (couldn't retrieve OAuth configuration)."
            });
            Settings.cloud.authenticated = false;
        }
        return;
    }

    if (!isCurrentAuthorizationFlow(origin, userId, generation)) return;

    openModal((props: any) => <OAuth2AuthorizeModal
        {...props}
        scopes={["identify"]}
        responseType="code"
        redirectUri={redirectUri}
        permissions={0n}
        clientId={clientId}
        cancelCompletesFlow={false}
        callback={async ({ location }: any) => {
            if (!location) {
                if (isCurrentAuthorizationFlow(origin, userId, generation))
                    Settings.cloud.authenticated = false;
                return;
            }

            try {
                if (!isCurrentAuthorizationFlow(origin, userId, generation))
                    throw new Error("Cloud authorization context changed");
                const callbackUrl = new URL(location);
                if (callbackUrl.protocol !== "https:" || callbackUrl.origin !== origin || callbackUrl.username || callbackUrl.password)
                    throw new Error("OAuth callback left the configured cloud origin");

                const callbackController = new AbortController();
                const callbackTimeout = setTimeout(() => callbackController.abort(), 30_000);
                try {
                    const res = await fetch(callbackUrl, {
                        headers: { Accept: "application/json" },
                        redirect: "error",
                        credentials: "omit",
                        cache: "no-store",
                        signal: callbackController.signal,
                    });
                    if (!res.ok) {
                        void res.body?.cancel().catch(() => { });
                        throw new Error(`OAuth callback returned ${res.status}`);
                    }
                    var data = await readBoundedOAuthJson(res);
                } finally {
                    clearTimeout(callbackTimeout);
                }
                if (isValidCloudSecret(data.secret)) {
                    if (!isCurrentAuthorizationFlow(origin, userId, generation))
                        throw new Error("Cloud authorization context changed");
                    logger.info("Authorized with cloud");
                    if (!await commitAuthorization(data.secret, origin, userId, generation)) return;
                    if (!isCurrentAuthorizationFlow(origin, userId, generation)) return;
                    Settings.cloud.authenticated = true;
                    showNotification({
                        title: "Cloud Integration",
                        body: "Cloud integrations enabled!"
                    });
                } else {
                    logger.error("OAuth callback returned an invalid secret");
                    if (isCurrentAuthorizationFlow(origin, userId, generation)) {
                        showNotification({
                            title: "Cloud Integration",
                            body: "Setup failed because the backend returned an invalid credential."
                        });
                        Settings.cloud.authenticated = false;
                    }
                }
            } catch {
                logger.error("Failed to authorize");
                if (isCurrentAuthorizationFlow(origin, userId, generation)) {
                    showNotification({
                        title: "Cloud Integration",
                        body: "Setup failed. The authorization response was rejected."
                    });
                    Settings.cloud.authenticated = false;
                }
            }
        }
        }
    />);
}

export async function getCloudAuth() {
    return (await getCloudRequestContext()).authorization;
}
