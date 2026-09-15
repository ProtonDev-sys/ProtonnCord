/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Card } from "@components/Card";
import { HeadphonesIcon } from "@components/Icons";
import { Button, useEffect, useState } from "@webpack/common";

import pl, { Native, settings, SongLinkResult } from ".";
import { Providers } from "./Providers";

interface SongLinkerProps {
    url: string;
    onResolved?: (url: string, result: SongLinkResult) => void;
}

export default function SongLinker({ url, onResolved }: SongLinkerProps) {
    const [songData, setSongData] = useState<SongLinkResult>();
    const [failed, setFailed] = useState(false);
    const { servicesSettings, userCountry } = settings.use(["servicesSettings", "userCountry"]);

    useEffect(() => {
        let cancelled = false;

        async function loadSongData() {
            setFailed(false);
            const cached = pl.getFromCache(url, userCountry);
            if (cached) {
                setSongData(cached);
                onResolved?.(url, cached);
                return;
            }

            setSongData(undefined);

            try {
                const sd = await Native.getTrackData(url, userCountry);
                if (cancelled) return;

                pl.addToCache(url, sd, userCountry);
                setSongData(sd);
                onResolved?.(url, sd);
            } catch (error) {
                if (!cancelled) {
                    setFailed(true);
                    console.error("Failed to fetch song link", error);
                }
            }
        }

        void loadSongData();

        return () => {
            cancelled = true;
        };
    }, [url, userCountry]);

    return <BaseText>
        {
            songData ? <Card style={{
                padding: "10px 15px"
            }}>
                <div>
                    <BaseText style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 600, fontSize: "1.05rem" }}>
                        <HeadphonesIcon /> {songData.info?.title} - {songData.info?.artist}
                    </BaseText>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px", marginTop: "10px" }}>
                        {
                            Object.keys(songData.links).map(service => servicesSettings[service]?.enabled && Providers[service] && <Button key={`${service}-${url}`} style={{
                                width: "20px !important"
                                // @ts-ignore
                            }} variant="secondary" onClick={() => {
                                VencordNative.native.openExternal(servicesSettings[service].openInNative && Providers[service].native && songData.links[service].nativeUri ? songData.links[service].nativeUri : songData.links[service].url);
                            }}>
                                <img
                                    src={Providers[service].logo}
                                    alt={`${Providers[service].name} logo`}
                                    style={{ width: 16, height: 16, objectFit: "contain", display: "block" }}
                                />
                            </Button>)
                        }
                    </div>
                </div>
            </Card> : <BaseText>{failed ? "Could not load this song link." : "Loading song link..."}</BaseText>
        }
    </BaseText >;
}
