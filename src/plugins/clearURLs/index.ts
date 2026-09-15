/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { MessageObject } from "@api/MessageEvents";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import definePlugin from "@utils/types";

const CLEAR_URLS_JSON_URL = "https://raw.githubusercontent.com/ClearURLs/Rules/master/data.min.json";
const MESSAGE_URL_REGEX = /(https?:\/\/[^\s<]+[^<.,:;"'>)|\]\s])/gi;
const logger = new Logger("ClearURLs");
let activeRequest: AbortController | undefined;

interface RuleSet {
    urlPattern: RegExp;
    rules: RegExp[];
    rawRules: RegExp[];
    exceptions: RegExp[];
}

function compilePatterns(value: unknown = [], flags = "i", fullMatch = false): RegExp[] {
    if (!Array.isArray(value)) throw new Error("Invalid rule list");
    return value.map(pattern => {
        if (typeof pattern !== "string") throw new Error("Invalid rule pattern");
        return new RegExp(fullMatch ? `^(?:${pattern})$` : pattern, flags);
    });
}

export default definePlugin({
    name: "ClearURLs",
    description: "Automatically removes tracking elements from URLs you send",
    dependencies: ["MessageEventsAPI"],
    tags: ["Privacy", "Utility"],
    authors: [Devs.adryd, Devs.thororen],

    rules: [] as RuleSet[],

    start() {
        void this.createRules();
    },

    stop() {
        activeRequest?.abort();
        activeRequest = undefined;
        this.rules = [];
    },

    onBeforeMessageSend(_, msg) {
        return this.cleanMessage(msg);
    },

    onBeforeMessageEdit(_cid, _mid, msg) {
        return this.cleanMessage(msg);
    },

    async createRules() {
        activeRequest?.abort();
        const request = activeRequest = new AbortController();
        try {
            const response = await fetch(CLEAR_URLS_JSON_URL, { signal: request.signal });
            if (!response.ok) throw new Error(`Rule request failed with status ${response.status}`);
            const data: unknown = await response.json();
            if (request.signal.aborted) return;
            if (!isObject(data)) throw new Error("Invalid rule catalog");
            const { providers } = data as Record<string, unknown>;
            if (!isObject(providers)) throw new Error("Invalid provider list");

            const rules = Object.values(providers).map(provider => {
                if (!isObject(provider)) throw new Error("Invalid provider");
                const { urlPattern, rules, rawRules, exceptions } = provider as Record<string, unknown>;
                if (typeof urlPattern !== "string") throw new Error("Invalid provider URL pattern");
                return {
                    urlPattern: new RegExp(urlPattern, "i"),
                    rules: compilePatterns(rules, "i", true),
                    rawRules: compilePatterns(rawRules, "gi"),
                    exceptions: compilePatterns(exceptions)
                };
            });
            this.rules = rules;
        } catch (error) {
            if (!request.signal.aborted) logger.error("Failed to load URL cleaning rules", error);
        }
    },

    replacer(match: string) {
        let url: URL;
        // Parse URL without throwing errors
        try {
            url = new URL(match);
        } catch (error) {
            // Don't modify anything if we can't parse the URL
            return match;
        }

        const originalUrl = url.href;

        for (const { urlPattern, exceptions, rawRules, rules } of this.rules) {
            if (!urlPattern.test(url.href) || exceptions.some(ex => ex.test(url.href))) continue;

            // Match and remove any raw rules
            let cleanedUrl = url.href;
            for (const rawRule of rawRules) {
                cleanedUrl = cleanedUrl.replace(rawRule, "");
            }
            if (cleanedUrl !== url.href) {
                try {
                    url = new URL(cleanedUrl);
                    if (url.protocol !== "https:" && url.protocol !== "http:") return match;
                } catch {
                    return match;
                }
            }

            // Delete matched params from list
            for (const param of [...url.searchParams.keys()]) {
                if (rules.some(rule => rule.test(param))) url.searchParams.delete(param);
            }
        }

        return url.href === originalUrl ? match : url.href;
    },

    cleanMessage(msg: MessageObject) {
        msg.content = msg.content.replace(MESSAGE_URL_REGEX, match => this.replacer(match));
    },
});
