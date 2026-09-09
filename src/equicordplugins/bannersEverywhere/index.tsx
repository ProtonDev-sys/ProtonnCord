/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import usrbg from "@plugins/usrbg";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { UserProfileStore } from "@webpack/common";

import style from "./style.css?managed";

interface Nameplate {
    imgAlt: string;
    palette: {
        darkBackground: string;
        lightBackground: string;
        name: string;
    };
    src: string;
}

const settings = definePluginSettings({
    animate: {
        description: "Animate banners",
        type: OptionType.BOOLEAN,
        default: false
    },
    preferNameplate: {
        description: "prefer nameplate over banner",
        type: OptionType.BOOLEAN,
        default: false
    },
});

const DATASTORE_KEY = "bannersEverywhere";
const MAX_PNG_CACHE_SIZE = 100;

export default definePlugin({
    name: "BannersEverywhere",
    description: "Displays banners in the member list ",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.ImLvna, Devs.AutumnVN],
    settings,
    patches: [
        {
            find: "#{intl::GUILD_OWNER}),",
            replacement: [
                {
                    // We add the banner as a property while we can still access the user id
                    match: /user:(\i).{0,150}nameplate:(\i).*?name:null.*?(?=avatar:)/,
                    replace: "$&banner:$self.memberListBannerHook($1, $2),",
                },
                {
                    match: /(?<=\),nameplate:)(\i)/,
                    replace: "$self.nameplate($1)"
                }
            ]
        },
        {
            find: "role:\"listitem\",innerRef",
            replacement: {
                // We cant access the user id here, so we take the banner property we set earlier
                match: /children:\[(?=.{0,100}\.MEMBER_LIST)/,
                replace: "$&arguments[0].banner,"
            }
        }
    ],

    data: {},
    generation: 0,
    loaded: false,
    managedStyle: style,
    pngCache: new Map<string, Promise<string>>(),
    persistTimeout: undefined as ReturnType<typeof setTimeout> | undefined,

    async start() {
        const generation = ++this.generation;
        this.loaded = false;
        const saved = await DataStore.get(DATASTORE_KEY) || {};
        if (generation !== this.generation) return;
        this.data = { ...saved, ...this.data };
        this.loaded = true;
        this.queuePersist();
    },

    stop() {
        this.generation++;
        if (this.persistTimeout) {
            clearTimeout(this.persistTimeout);
            this.persistTimeout = undefined;
        }
        this.pngCache.clear();
        if (this.loaded) void DataStore.set(DATASTORE_KEY, this.data).catch(console.error);
        this.loaded = false;
    },

    queuePersist() {
        if (!this.loaded || this.persistTimeout) return;

        this.persistTimeout = setTimeout(() => {
            this.persistTimeout = undefined;
            void DataStore.set(DATASTORE_KEY, this.data).catch(console.error);
        }, 2_000);
    },

    nameplate(nameplate: Nameplate | undefined) {
        if (settings.store.preferNameplate) return nameplate;
    },

    memberListBannerHook(user: User, nameplate: Nameplate | undefined) {
        let url = this.getBanner(user.id);
        if (!url) return;
        if (settings.store.preferNameplate && nameplate) return;
        if (!settings.store.animate) {
            // Discord Banners
            url = url.replace(".gif", ".png");
            // Usrbg Banners
            const { generation } = this;
            this.gifToPng(url)
                .then(pngUrl => {
                    const imgElement = document.getElementById(`vc-banners-everywhere-${user.id}`) as HTMLImageElement;
                    if (generation === this.generation && !settings.store.animate && imgElement?.getAttribute("src") === url) {
                        imgElement.src = pngUrl;
                    }
                })
                .catch(console.error);
        }

        return (
            <img alt="" id={`vc-banners-everywhere-${user.id}`} src={url} className="vc-banners-everywhere-memberlist"></img>
        );
    },

    async gifToPng(url: string): Promise<string> {
        const cached = this.pngCache.get(url);
        if (cached) return cached;

        const promise = new Promise<string>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext("2d");
                    if (!ctx) throw new Error("Failed to get canvas context.");
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas.toDataURL("image/png"));
                } catch (error) {
                    reject(error);
                }
            };
            img.onerror = () => reject(new Error("Failed to load banner image."));
            img.src = url;
        });
        this.pngCache.set(url, promise);

        if (this.pngCache.size > MAX_PNG_CACHE_SIZE) {
            const oldestKey = this.pngCache.keys().next().value;
            if (oldestKey) this.pngCache.delete(oldestKey);
        }

        return promise;
    },

    getBanner(userId: string): string | undefined {
        if (isPluginEnabled(usrbg.name) && usrbg.userHasBackground(userId)) {
            let banner = usrbg.getImageUrl(userId);
            if (banner === null) banner = "";
            return banner;
        }
        const userProfile = UserProfileStore.getUserProfile(userId);
        if (userProfile?.banner) {
            const banner = `https://cdn.discordapp.com/banners/${userId}/${userProfile.banner}.${userProfile.banner.startsWith("a_") ? "gif" : "png"}`;
            if (this.data[userId] !== banner) {
                this.data[userId] = banner;
                this.queuePersist();
            }
        }
        return this.data[userId];
    },
});
