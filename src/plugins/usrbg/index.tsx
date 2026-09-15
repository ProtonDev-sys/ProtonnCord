/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";

const cl = classNameFactory("vc-usrbg-");
const API_URL = "https://usrbg.is-hardly.online/users";
let generation = 0;
let requestController: AbortController | undefined;

interface UsrbgApiReturn {
    endpoint: string;
    bucket: string;
    prefix: string;
    users: Record<string, string>;
}

const settings = definePluginSettings({
    nitroFirst: {
        description: "Banner to use if both Nitro and USRBG banners are present",
        type: OptionType.SELECT,
        options: [
            { label: "Nitro banner", value: true, default: true },
            { label: "USRBG banner", value: false },
        ]
    },
    voiceBackground: {
        description: "Use USRBG banners as voice chat backgrounds",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    }
});

export default definePlugin({
    name: "USRBG",
    description: "Displays user banners from USRBG, allowing anyone to get a banner without Nitro",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.AutumnVN, Devs.katlyn, Devs.pylix, Devs.TheKodeToad],
    settings,
    patches: [
        {
            find: ':"SHOULD_LOAD");',
            replacement: {
                match: /\i(?:\?)?.getPreviewBanner\(\i,\i,\i\)(?=.{0,100}"COMPLETE")/,
                replace: "$self.patchBannerUrl(arguments[0])||$&"

            }
        },
        {
            find: "\"data-selenium-video-tile\":",
            replacement: [
                {
                    match: /(?<=function\((\i),\i\)\{)(?=let.{20,40},style:)/,
                    replace: "Object.assign($1.style=$1.style||{},$self.getVoiceBackgroundStyles($1));"
                }
            ]
        },
        {
            find: '"VideoBackground-web"',
            predicate: () => settings.store.voiceBackground,
            replacement: {
                match: /backgroundColor:.{0,25},\{style:(?=\i\?)/,
                replace: "$&$self.userHasBackground(arguments[0]?.userId)?null:",
            }
        }
    ],

    data: null as UsrbgApiReturn | null,

    settingsAboutComponent: () => (
        <Button
            variant="link"
            className={cl("settings-button")}
            onClick={() => VencordNative.native.openExternal("https://github.com/AutumnVN/usrbg#how-to-request-your-own-usrbg-banner")}
        >
            Get your own USRBG banner
        </Button>
    ),

    getVoiceBackgroundStyles({ className, participantUserId }: any) {
        if (settings.store.voiceBackground && typeof className === "string" && className.includes("tile")) {
            if (this.userHasBackground(participantUserId)) {
                return {
                    backgroundImage: `url(${JSON.stringify(this.getImageUrl(participantUserId))})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    backgroundRepeat: "no-repeat"
                };
            }
        }
    },

    patchBannerUrl({ displayProfile }: any) {
        if (displayProfile?.banner && settings.store.nitroFirst) return;
        if (this.userHasBackground(displayProfile?.userId)) return this.getImageUrl(displayProfile?.userId);
    },

    userHasBackground(userId: string) {
        return !!this.data && Object.hasOwn(this.data.users, userId) && !!this.data.users[userId];
    },

    getImageUrl(userId: string): string | null {
        if (!this.userHasBackground(userId)) return null;

        // We can assert that data exists because userHasBackground returned true
        const { endpoint, bucket, prefix, users: { [userId]: etag } } = this.data!;
        return `${endpoint}/${bucket}/${prefix}${userId}?${etag}`;
    },

    async start() {
        const currentGeneration = ++generation;
        requestController?.abort();
        const controller = requestController = new AbortController();
        this.data = null;
        try {
            const res = await fetch(API_URL, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
            if (!res.ok) return;
            const data = await res.json() as UsrbgApiReturn;
            if (currentGeneration !== generation || controller.signal.aborted) return;
            if (!data || typeof data.endpoint !== "string" || typeof data.bucket !== "string" || typeof data.prefix !== "string"
                || !data.users || typeof data.users !== "object" || Array.isArray(data.users)
                || Object.entries(data.users).some(([id, etag]) => !/^\d+$/.test(id) || typeof etag !== "string")) return;
            const endpoint = new URL(data.endpoint);
            if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return;
            this.data = data;
        } catch {
            // Keep Discord's existing banner when the optional catalog is unavailable.
        } finally {
            if (requestController === controller) requestController = undefined;
        }
    },

    stop() {
        generation++;
        requestController?.abort();
        requestController = undefined;
        this.data = null;
    }
});
