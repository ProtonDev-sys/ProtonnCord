/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";
import { loadLazyChunks } from "@debug/loadLazyChunks";
import { reporterData } from "@debug/reporterData";
import { getIntlMessageFromHash } from "@utils/discord";
import { canonicalizeMatch } from "@utils/patches";
import { filters, findAll, search, wreq } from "@webpack";
import { Toasts } from "@webpack/common";

import { CLIENT_VERSION, logger, PORT, settings } from ".";
import { CompanionAuthenticator, createCompanionAuthenticator, isValidAuthSecret } from "./auth";
import { Recieve } from "./types";
import { FullOutgoingMessage, OutgoingMessage } from "./types/send";
import { extractModule, extractOrThrow, findAllModuleIds, findModuleId, getModulePatchedBy, mkRegexFind, parseNode, toggleEnabled, } from "./util";

export const MAX_COMPANION_MESSAGE_LENGTH = 256 * 1024;
export const MAX_AUTHENTICATED_COMMANDS_PER_WINDOW = 30;

const AUTHENTICATION_TIMEOUT_MS = 5000;
const AUTHENTICATED_COMMAND_WINDOW_MS = 10_000;
const POLICY_VIOLATION = 1008;

function areStrings(values: Array<string | RegExp>): values is string[] {
    return values.every((value): value is string => typeof value === "string");
}

export function stopWs() {
    const close = disconnect;
    disconnect = undefined;
    close?.();
}

let disconnect: (() => void) | undefined;

export function initWs(isManual = false) {
    stopWs();
    const secret = settings.store.authSecret;
    if (!isValidAuthSecret(secret)) {
        logger.warn("Dev Companion is disabled until a valid authentication secret is configured");
        if (isManual) {
            Toasts.show({
                message: "Configure a valid Dev Companion authentication secret first",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                options: { position: Toasts.Position.TOP }
            });
        }
        return;
    }

    let hasErrored = false;
    let authenticated = false;
    let authenticationFailed = false;
    let authenticator: CompanionAuthenticator | undefined;
    let authenticationTimeout: number | undefined;
    const authenticatedCommandTimes: number[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    disconnect = closeConnection;

    function closeConnection() {
        clearAuthenticationTimeout();
        ws.close(1000, "Connection replaced or stopped");
    }

    function isCurrentConnection() {
        return disconnect === closeConnection && ws.readyState === WebSocket.OPEN;
    }

    function sendData(data: object) {
        if (isCurrentConnection()) ws.send(JSON.stringify(data));
    }

    function clearAuthenticationTimeout() {
        if (authenticationTimeout === undefined) return;
        window.clearTimeout(authenticationTimeout);
        authenticationTimeout = undefined;
    }

    function failAuthentication() {
        if (!isCurrentConnection() || authenticationFailed || authenticated) return;
        authenticationFailed = true;
        clearAuthenticationTimeout();
        logger.warn("Rejected unauthenticated Dev Companion connection");
        if (isManual) {
            Toasts.show({
                message: "Dev Companion authentication failed",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                options: { position: Toasts.Position.TOP }
            });
        }
        ws.close(POLICY_VIOLATION, "Authentication failed");
    }

    function finishAuthentication() {
        authenticated = true;
        clearAuthenticationTimeout();

        logger.info("Authenticated Dev Companion connection");

        sendData({
            type: "moduleList",
            data: {
                modules: Object.keys(wreq.m)
            },
            ok: true
        });

        if (IS_COMPANION_TEST) {
            const toSend = JSON.stringify(reporterData, (_k, v) => {
                if (v instanceof RegExp)
                    return String(v);
                return v;
            });

            ws.send(JSON.stringify({
                type: "report",
                data: JSON.parse(toSend),
                ok: true
            }));
        }

        try {
            if (settings.store.notifyOnAutoConnect || isManual) {
                Toasts.show({
                    message: "Authenticated with Dev Companion",
                    id: Toasts.genId(),
                    type: Toasts.Type.SUCCESS,
                    options: {
                        position: Toasts.Position.TOP
                    }
                });
            }
        }
        catch (error) {
            logger.error("Failed to show Dev Companion connection status", error);
        }
    }

    function acceptAuthenticatedCommand(): boolean {
        const now = Date.now();
        while (authenticatedCommandTimes.length > 0
            && authenticatedCommandTimes[0] <= now - AUTHENTICATED_COMMAND_WINDOW_MS)
            authenticatedCommandTimes.shift();

        if (authenticatedCommandTimes.length >= MAX_AUTHENTICATED_COMMANDS_PER_WINDOW) return false;
        authenticatedCommandTimes.push(now);
        return true;
    }

    ws.addEventListener("open", () => {
        if (!isCurrentConnection()) return;
        authenticationTimeout = window.setTimeout(failAuthentication, AUTHENTICATION_TIMEOUT_MS);
        void createCompanionAuthenticator(secret).then(createdAuthenticator => {
            if (authenticationFailed || !isCurrentConnection()) return;
            authenticator = createdAuthenticator;
            ws.send(JSON.stringify(authenticator.hello));
        }).catch(failAuthentication);
    });

    ws.addEventListener("error", () => {
        if (!isCurrentConnection() || !authenticated) return;

        hasErrored = true;

        logger.error("Dev Companion connection error");

        Toasts.show({
            message: "Dev Companion Error",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE,
            options: {
                position: Toasts.Position.TOP
            }
        });
    });

    ws.addEventListener("close", e => {
        clearAuthenticationTimeout();
        if (disconnect !== closeConnection) return;
        disconnect = undefined;
        if (!authenticated || hasErrored) return;

        logger.info("Dev Companion disconnected with code", e.code);

        Toasts.show({
            message: "Dev Companion Disconnected",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE,
            options: {
                position: Toasts.Position.TOP
            }
        });
    });

    ws.addEventListener("message", event => {
        if (!isCurrentConnection()) return;
        if (typeof event.data !== "string" || event.data.length > MAX_COMPANION_MESSAGE_LENGTH) {
            failAuthentication();
            if (authenticated) ws.close(POLICY_VIOLATION, "Invalid message");
            return;
        }

        if (!authenticated) {
            if (!authenticator) return failAuthentication();

            let message: unknown;
            try {
                message = JSON.parse(event.data);
            } catch {
                return failAuthentication();
            }

            void authenticator.receive(message).then(result => {
                if (authenticationFailed || !isCurrentConnection()) return;
                if (!result.authenticated) ws.send(JSON.stringify(result.response));
                else finishAuthentication();
            }).catch(failAuthentication);
            return;
        }

        if (!acceptAuthenticatedCommand()) {
            logger.warn("Dev Companion command rate limit exceeded");
            ws.close(POLICY_VIOLATION, "Rate limit exceeded");
            return;
        }

        try {
            handleAuthenticatedMessage(event.data);
        } catch {
            logger.warn("Rejected invalid authenticated Dev Companion message");
        }
    });

    function handleAuthenticatedMessage(rawMessage: string) {
        let parsedMessage: unknown;
        try {
            parsedMessage = JSON.parse(rawMessage);
        } catch {
            logger.warn("Dev Companion sent invalid JSON");
            ws.close(POLICY_VIOLATION, "Invalid message");
            return;
        }
        const d = Recieve.parseIncomingMessage(parsedMessage);
        if (!d) {
            logger.warn("Dev Companion sent an invalid command schema");
            ws.close(POLICY_VIOLATION, "Invalid message");
            return;
        }
        const requestNonce = d.nonce;
        /**
         * @param error the error to reply with. if there is no error, the reply is a sucess
         */
        function reply(error?: string) {
            const toSend = { nonce: requestNonce, ok: !error } as Record<string, unknown>;
            if (error) toSend.error = error;
            logger.debug("Replying to authenticated Dev Companion request");
            sendData(toSend);
        }
        function replyData(data: OutgoingMessage) {
            const toSend: FullOutgoingMessage = {
                ...data,
                nonce: requestNonce
            };
            logger.debug("Replying with data to authenticated Dev Companion request");
            sendData(toSend);
        }

        switch (d.type) {
            case "disable": {
                const m = d.data;
                const settings = Settings.plugins[m.pluginName];
                if (!settings) throw new Error("Plugin not found: " + m.pluginName);
                if (m.enabled !== settings.enabled)
                    toggleEnabled(m.pluginName, reply);
                break;
            }
            case "rawId": {
                const m = d.data;
                logger.warn("Deprecated rawId message received, use extract instead");
                replyData({
                    type: "rawId",
                    ok: true,
                    data: extractModule(m.id),
                });
                break;
            }
            case "diff": {
                try {
                    const m = d.data;
                    switch (m.extractType) {
                        case "id": {
                            if (typeof m.idOrSearch !== "number")
                                throw new Error("Id is not a number, got :" + typeof m.idOrSearch);
                            replyData({
                                type: "diff",
                                ok: true,
                                data: {
                                    patched: extractOrThrow(m.idOrSearch),
                                    source: extractModule(m.idOrSearch, false),
                                    moduleNumber: m.idOrSearch,
                                    patchedBy: getModulePatchedBy(m.idOrSearch, true)
                                },
                            });
                            break;
                        }
                        case "search": {
                            let moduleId: number;
                            if (m.findType === "string")
                                moduleId = +findModuleId([canonicalizeMatch(m.idOrSearch.toString())]);
                            else
                                moduleId = +findModuleId(mkRegexFind(m.idOrSearch));
                            const p = extractOrThrow(moduleId);
                            const p2 = extractModule(moduleId, false);

                            replyData({
                                type: "diff",
                                ok: true,
                                data: {
                                    patched: p,
                                    source: p2,
                                    moduleNumber: moduleId,
                                    patchedBy: getModulePatchedBy(moduleId, true)
                                },
                            });
                            break;
                        }
                    }
                } catch (error) {
                    reply(String(error));
                }
                break;
            }
            case "reload": {
                reply();
                window.location.reload();
                break;
            }
            case "extract": {
                try {
                    const m = d.data;
                    switch (m.extractType) {
                        case "id": {
                            if (typeof m.idOrSearch !== "number")
                                throw new Error("Id is not a number, got :" + typeof m.idOrSearch);

                            else
                                replyData({
                                    type: "extract",
                                    ok: true,
                                    data: {
                                        module: extractModule(m.idOrSearch, m.usePatched ?? undefined),
                                        moduleNumber: m.idOrSearch,
                                        patchedBy: getModulePatchedBy(m.idOrSearch, m.usePatched ?? undefined)
                                    },
                                });

                            break;
                        }
                        case "search": {
                            let moduleId;
                            if (m.findType === "string")
                                moduleId = +findModuleId([canonicalizeMatch(m.idOrSearch.toString())]);

                            else
                                moduleId = +findModuleId(mkRegexFind(m.idOrSearch));
                            replyData({
                                type: "extract",
                                ok: true,
                                data: {
                                    module: extractModule(moduleId, m.usePatched ?? undefined),
                                    moduleNumber: moduleId,
                                    patchedBy: getModulePatchedBy(moduleId, m.usePatched ?? undefined)
                                },
                            });
                            break;
                        }
                        case "find": {
                            try {
                                var parsedArgs = m.findArgs.map(parseNode);
                            } catch (err) {
                                return reply("Failed to parse args: " + err);
                            }

                            try {
                                let moduleIds: string[];
                                switch (m.findType.replace("find", "").replace("Lazy", "")) {
                                    case "":
                                    case "Component":
                                        return reply("Function-based finds are disabled for security");
                                    case "CssClasses":
                                        if (!areStrings(parsedArgs)) return reply("CSS class finds accept only string arguments");
                                        moduleIds = findAllModuleIds(filters.byClassNames(...parsedArgs), { topLevelOnly: true });
                                        break;
                                    case "ByProps":
                                        if (!areStrings(parsedArgs)) return reply("Property finds accept only string arguments");
                                        moduleIds = findAllModuleIds(filters.byProps(...parsedArgs));
                                        break;
                                    case "Store":
                                        if (!areStrings(parsedArgs)) return reply("Store finds accept only string arguments");
                                        moduleIds = findAllModuleIds(filters.byStoreName(parsedArgs[0]));
                                        break;
                                    case "ByCode":
                                        moduleIds = findAllModuleIds(filters.byCode(...parsedArgs));
                                        break;
                                    case "ModuleId":
                                        moduleIds = Object.keys(search(parsedArgs[0]));
                                        break;
                                    case "ComponentByCode":
                                        moduleIds = findAllModuleIds(filters.componentByCode(...parsedArgs));
                                        break;
                                    default:
                                        return reply("Unknown Find Type " + m.findType);
                                }

                                const uniqueModuleIds = new Set(moduleIds).size;
                                if (uniqueModuleIds === 0) throw "No results";
                                if (uniqueModuleIds > 1) throw "Found more than one result! Make this filter more specific";
                                // best name ever
                                const [foundId] = moduleIds;
                                replyData({
                                    type: "extract",
                                    ok: true,
                                    data: {
                                        module: extractModule(foundId),
                                        find: true,
                                        moduleNumber: +foundId,
                                        patchedBy: getModulePatchedBy(foundId)
                                    },
                                });
                            } catch (err) {
                                return reply("Failed to find: " + err);
                            }
                            break;
                        }
                        default:
                            reply(`Unknown Extract type. Got: ${d.data.extractType}`);
                            break;
                    }
                } catch (error) {
                    reply(String(error));
                }
                break;
            }
            case "testPatch": {
                reply("Remote patch compilation is disabled for security");
                break;
            }
            case "testFind": {
                const m = d.data;
                try {
                    var parsedArgs = m.args.map(parseNode);
                } catch (err) {
                    return reply("Failed to parse args: " + err);
                }

                try {
                    let results: unknown[];
                    switch (m.type.replace("find", "").replace("Lazy", "")) {
                        case "":
                        case "Component":
                            return reply("Function-based finds are disabled for security");
                        case "ByProps":
                            if (!areStrings(parsedArgs)) return reply("Property finds accept only string arguments");
                            results = findAll(filters.byProps(...parsedArgs));
                            break;
                        case "CssClasses":
                            if (!areStrings(parsedArgs)) return reply("CSS class finds accept only string arguments");
                            results = findAll(filters.byClassNames(...parsedArgs), { topLevelOnly: true });
                            break;
                        case "Store":
                            if (!areStrings(parsedArgs)) return reply("Store finds accept only string arguments");
                            results = findAll(filters.byStoreName(parsedArgs[0]));
                            break;
                        case "ByCode":
                            results = findAll(filters.byCode(...parsedArgs));
                            break;
                        case "ModuleId":
                            results = Object.keys(search(parsedArgs[0]));
                            break;
                        case "ComponentByCode":
                            results = findAll(filters.componentByCode(...parsedArgs));
                            break;
                        default:
                            return reply("Unknown Find Type " + m.type);
                    }

                    const uniqueResultsCount = new Set(results).size;
                    if (uniqueResultsCount === 0) throw "No results";
                    if (uniqueResultsCount > 1) throw "Found more than one result! Make this filter more specific";
                } catch (err) {
                    return reply("Failed to find: " + err);
                }

                reply();
                break;
            }
            case "allModules": {
                loadLazyChunks()
                    .then(() => {
                        replyData({
                            type: "moduleList",
                            data: {
                                modules: Object.keys(wreq.m)
                            },
                            ok: true
                        });
                    })
                    .catch(e => {
                        logger.error("Failed to load modules", e);
                        replyData({
                            type: "moduleList",
                            ok: false,
                            error: String(e),
                            data: null
                        });
                    });
                break;
            }
            case "i18n": {
                const { hashedKey } = d.data;
                replyData({
                    type: "i18n",
                    ok: true,
                    data: {
                        value: getIntlMessageFromHash(hashedKey)
                    }
                });
                break;
            }
            case "version": {
                replyData({
                    type: "version",
                    ok: true,
                    data: {
                        clientVersion: CLIENT_VERSION
                    }
                });
                break;
            }
            default:
                reply("Unknown message type");
                break;
        }
    }
}
