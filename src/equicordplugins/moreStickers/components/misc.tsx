/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { BaseText } from "@components/BaseText";
import { CheckedTextInput } from "@components/CheckedTextInput";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { convert as convertLineEP, getIdFromUrl as getLineEmojiPackIdFromUrl, getStickerPackById as getLineEmojiPackById, isLineEmojiPackHtml, parseHtml as getLineEPFromHtml } from "@equicordplugins/moreStickers/lineEmojis";
import { convert as convertLineSP, getIdFromUrl as getLineStickerPackIdFromUrl, getStickerPackById as getLineStickerPackById, isLineStickerPackHtml, parseHtml as getLineSPFromHtml } from "@equicordplugins/moreStickers/lineStickers";
import { isV1, migrate } from "@equicordplugins/moreStickers/migrate-v1";
import { deleteStickerPack, getStickerPack, getStickerPackMetas, saveStickerPack, saveStickerPacks } from "@equicordplugins/moreStickers/stickers";
import { SettingsTabsKey, Sticker, StickerPack, StickerPackMeta } from "@equicordplugins/moreStickers/types";
import { cl, clPicker } from "@equicordplugins/moreStickers/utils";
import { saveFile } from "@utils/web";
import { Button, React, TabBar, TextArea, Toasts } from "@webpack/common";
import { JSX } from "react";

// The ID of recent sticker and recent sticker pack
export const RECENT_STICKERS_ID = "recent";
export const RECENT_STICKERS_TITLE = "Recently Used";

const KEY = "MoreStickers:RecentStickers";
const showFailure = () => Toasts.show({ message: "Could not update sticker packs", type: Toasts.Type.FAILURE, id: Toasts.genId() });

const noDrag = {
    onMouseDown: e => { e.preventDefault(); return false; },
    onDragStart: e => { e.preventDefault(); return false; }
};

const StickerPackMetadata = ({ meta, hoveredStickerPackId, setHoveredStickerPackId, refreshStickerPackMetas }:
    { meta: StickerPackMeta, [key: string]: any; }
) => {
    return (
        <div className="sticker-pack"
            onMouseEnter={() => setHoveredStickerPackId(meta.id)}
            onMouseLeave={() => setHoveredStickerPackId(null)}
        >
            <div className={
                [
                    clPicker("content-row-grid-inspected-indicator"),
                    hoveredStickerPackId === meta.id ? "inspected" : ""
                ].join(" ")
            } style={{
                top: "unset",
                left: "unset",
                height: "96px",
                width: "96px",
            }}></div>
            {meta.logo?.image ? <img src={meta.logo.image} width="96" {...noDrag} /> : null}
            <button
                className={hoveredStickerPackId === meta.id ? "show" : ""}
                onClick={async () => {
                    try {
                        await deleteStickerPack(meta.id);
                        Toasts.show({
                            message: "Sticker Pack deleted",
                            type: Toasts.Type.SUCCESS,
                            id: Toasts.genId(),
                            options: {
                                duration: 1000
                            }
                        });
                        await refreshStickerPackMetas();
                    } catch (e: any) {
                        Toasts.show({
                            message: e.message,
                            type: Toasts.Type.FAILURE,
                            id: Toasts.genId(),
                            options: {
                                duration: 1000
                            }
                        });
                    }
                }}
            >
                <svg width="24" height="24" viewBox="0 0 24 24" style={{ fill: "var(--status-danger)" }}>
                    <title>Delete</title>
                    <path d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z" />
                    <path d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z" />
                </svg>
            </button>
            <BaseText className={cl("pack-title")} tag="span">{meta.title}</BaseText>
        </div>
    );
};

export const Packs = () => {
    const [stickerPackMetas, setstickerPackMetas] = React.useState<StickerPackMeta[]>([]);
    const [addStickerUrl, setAddStickerUrl] = React.useState<string>("");
    const [addStickerHtml, setAddStickerHtml] = React.useState<string>("");
    const [tab, setTab] = React.useState<SettingsTabsKey>(SettingsTabsKey.ADD_STICKER_PACK_URL);
    const [hoveredStickerPackId, setHoveredStickerPackId] = React.useState<string | null>(null);
    const [_isV1, setV1] = React.useState<boolean>(false);
    const mounted = React.useRef(true);

    async function refreshStickerPackMetas() {
        const metas = await getStickerPackMetas();
        if (mounted.current) setstickerPackMetas(metas);
    }
    React.useEffect(() => {
        mounted.current = true;
        refreshStickerPackMetas().catch(showFailure);
        isV1().then(value => { if (mounted.current) setV1(value); }).catch(showFailure);
        return () => { mounted.current = false; };
    }, []);

    return (
        <div className={cl("settings")}>
            <TabBar
                type="top"
                look="brand"
                selectedItem={tab}
                onItemSelect={setTab}
                className="tab-bar"
            >
                {
                    Object.values(SettingsTabsKey).map(k => (
                        <TabBar.Item key={k} id={k} className="tab-bar-item">
                            {k}
                        </TabBar.Item>
                    ))
                }
            </TabBar>

            {tab === SettingsTabsKey.ADD_STICKER_PACK_URL &&
                <div className="section">
                    <Heading>Add Sticker Pack from URL</Heading>
                    <Paragraph>
                        <p>
                            Currently LINE stickers/emojis supported only. <br />

                            Get Telegram stickers with <a href="https://github.com/lekoOwO/MoreStickersConverter" target="_blank" rel="noreferrer"> MoreStickersConverter</a>.
                        </p>
                    </Paragraph>
                    <Flex flexDirection="row" style={{
                        alignItems: "center",
                        justifyContent: "center"
                    }} >
                        <span style={{
                            flexGrow: 1
                        }}>
                            <CheckedTextInput
                                initialValue={addStickerUrl}
                                onChange={setAddStickerUrl}
                                validate={(v: string) => {
                                    try {
                                        getLineStickerPackIdFromUrl(v);
                                        return true;
                                    } catch (e: any) { }
                                    try {
                                        getLineEmojiPackIdFromUrl(v);
                                        return true;
                                    } catch (e: any) { }

                                    return "Invalid URL";
                                }}
                                placeholder="Sticker Pack URL"
                            />
                        </span>
                        <Button
                            size={Button.Sizes.SMALL}
                            onClick={async e => {
                                e.preventDefault();

                                let type: string = "";
                                try {
                                    getLineStickerPackIdFromUrl(addStickerUrl);
                                    type = "LineStickerPack";
                                } catch (e: any) { }

                                try {
                                    getLineEmojiPackIdFromUrl(addStickerUrl);
                                    type = "LineEmojiPack";
                                } catch (e: any) { }

                                let errorMessage = type ? "" : "Invalid URL";
                                switch (type) {
                                    case "LineStickerPack": {
                                        try {
                                            const id = getLineStickerPackIdFromUrl(addStickerUrl);
                                            const lineSP = await getLineStickerPackById(id);
                                            const stickerPack = convertLineSP(lineSP);
                                            await saveStickerPack(stickerPack);
                                        } catch (e: any) {
                                            console.error(e);
                                            errorMessage = e.message;
                                        }
                                        break;
                                    }
                                    case "LineEmojiPack": {
                                        try {
                                            const id = getLineEmojiPackIdFromUrl(addStickerUrl);
                                            const lineEP = await getLineEmojiPackById(id);
                                            const stickerPack = convertLineEP(lineEP);
                                            await saveStickerPack(stickerPack);

                                        } catch (e: any) {
                                            console.error(e);
                                            errorMessage = e.message;
                                        }
                                        break;
                                    }
                                }

                                if (!errorMessage) {
                                    setAddStickerUrl("");
                                    await refreshStickerPackMetas().catch(showFailure);
                                }

                                if (errorMessage) {
                                    Toasts.show({
                                        message: errorMessage,
                                        type: Toasts.Type.FAILURE,
                                        id: Toasts.genId(),
                                        options: {
                                            duration: 1000
                                        }
                                    });
                                } else {
                                    Toasts.show({
                                        message: "Sticker Pack added",
                                        type: Toasts.Type.SUCCESS,
                                        id: Toasts.genId(),
                                        options: {
                                            duration: 1000
                                        }
                                    });
                                }

                            }}
                        >Insert</Button>
                    </Flex>
                </div>
            }
            {tab === SettingsTabsKey.ADD_STICKER_PACK_HTML &&
                <div className="section">
                    <Heading>Add Sticker Pack from HTML</Heading>
                    <Paragraph>
                        <p>
                            When encountering errors while adding a sticker pack, you can try to add it using the HTML source code of the sticker pack page.<br />
                            This applies to stickers which are region locked / OS locked / etc.<br />
                            The region LINE recognized may vary from the region you are in due to the CORS proxy we're using.
                        </p>
                    </Paragraph>
                    <Flex flexDirection="row" style={{
                        alignItems: "center",
                        justifyContent: "center"
                    }} >
                        <span style={{
                            flexGrow: 1
                        }}>
                            <TextArea
                                value={addStickerHtml}
                                onChange={setAddStickerHtml}
                                placeholder="Paste HTML here"
                                rows={1}
                            />
                        </span>
                        <Button
                            size={Button.Sizes.SMALL}
                            onClick={async e => {
                                e.preventDefault();

                                let errorMessage = "";
                                if (isLineEmojiPackHtml(addStickerHtml)) {
                                    try {
                                        const lineEP = getLineEPFromHtml(addStickerHtml);
                                        const stickerPack = convertLineEP(lineEP);
                                        await saveStickerPack(stickerPack);
                                    } catch (e: any) {
                                        console.error(e);
                                        errorMessage = e.message;
                                    }
                                } else if (isLineStickerPackHtml(addStickerHtml)) {
                                    try {
                                        const lineSP = getLineSPFromHtml(addStickerHtml);
                                        const stickerPack = convertLineSP(lineSP);
                                        await saveStickerPack(stickerPack);
                                    } catch (e: any) {
                                        console.error(e);
                                        errorMessage = e.message;
                                    }
                                } else {
                                    errorMessage = "Invalid sticker pack HTML";
                                }

                                if (!errorMessage) {
                                    setAddStickerHtml("");
                                    await refreshStickerPackMetas().catch(showFailure);
                                }

                                if (errorMessage) {
                                    Toasts.show({
                                        message: errorMessage,
                                        type: Toasts.Type.FAILURE,
                                        id: Toasts.genId(),
                                        options: {
                                            duration: 1000
                                        }
                                    });
                                } else {
                                    Toasts.show({
                                        message: "Sticker Pack added",
                                        type: Toasts.Type.SUCCESS,
                                        id: Toasts.genId(),
                                        options: {
                                            duration: 1000
                                        }
                                    });
                                }
                            }}
                        >Insert from HTML</Button>
                    </Flex>
                </div>
            }
            {
                tab === SettingsTabsKey.ADD_STICKER_PACK_FILE &&
                <div className="section">
                    <Heading>Add Sticker Pack from File</Heading>

                    <Button
                        size={Button.Sizes.SMALL}
                        onClick={async e => {
                            const input = document.createElement("input");
                            input.type = "file";
                            input.accept = ".stickerpack,.stickerpacks,.json";
                            input.onchange = async e => {
                                try {
                                    const file = input.files?.[0];
                                    if (!file) return;

                                    const fileText = await file.text();
                                    const fileJson = JSON.parse(fileText);
                                    let stickerPacks: StickerPack[] = [];
                                    if (Array.isArray(fileJson)) {
                                        stickerPacks = fileJson;
                                    } else {
                                        stickerPacks = [fileJson];
                                    }

                                    await saveStickerPacks(stickerPacks);
                                    await refreshStickerPackMetas();

                                    Toasts.show({
                                        message: "Sticker Packs added",
                                        type: Toasts.Type.SUCCESS,
                                        id: Toasts.genId(),
                                        options: {
                                            duration: 1000
                                        }
                                    });
                                } catch (e: any) {
                                    console.error(e);
                                    Toasts.show({
                                        message: e.message,
                                        type: Toasts.Type.FAILURE,
                                        id: Toasts.genId(),
                                        options: {
                                            duration: 1000
                                        }
                                    });
                                }
                            };
                            input.click();
                        }}
                    >
                        Open Sticker Pack File
                    </Button>
                </div>
            }
            {
                tab === SettingsTabsKey.MISC &&
                <div className="section">
                    <Heading>Misc tools</Heading>

                    <Flex flexDirection="row" style={{
                        alignItems: "center",
                        justifyContent: "start"
                    }} >
                        <Button
                            size={Button.Sizes.SMALL}
                            onClick={async e => {
                                try {
                                const result: StickerPack[] = [];
                                const stickerPacks = await getStickerPackMetas();
                                for (const stickerPack of stickerPacks) {
                                    const sp = await getStickerPack(stickerPack.id);
                                    if (sp) {
                                        result.push(sp);
                                    }
                                }

                                saveFile(new File([JSON.stringify(result)], "MoreStickers.stickerpacks", { type: "application/json" }));

                                Toasts.show({
                                    message: "Sticker Packs exported",
                                    type: Toasts.Type.SUCCESS,
                                    id: Toasts.genId(),
                                    options: {
                                        duration: 1000
                                    }
                                });
                                } catch { showFailure(); }
                            }}
                        >Export Sticker Packs</Button>
                        <Button
                            size={Button.Sizes.SMALL}
                            onClick={async e => {
                                try {
                                    await migrate();
                                    await refreshStickerPackMetas();
                                    if (mounted.current) setV1(await isV1());
                                } catch { showFailure(); }
                            }}
                            style={{
                                display: _isV1 ? "unset" : "none"
                            }}
                        >Migrate from v1</Button>
                    </Flex>
                </div>
            }
            <Divider style={{
                marginTop: "8px",
                marginBottom: "8px"
            }} />
            <Heading>Stickers Management</Heading>

            <div className="section">
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
                    gap: "8px"
                }}>
                    {
                        stickerPackMetas.map(meta => (
                            <StickerPackMetadata
                                key={meta.id}
                                meta={meta}
                                hoveredStickerPackId={hoveredStickerPackId}
                                setHoveredStickerPackId={setHoveredStickerPackId}
                                refreshStickerPackMetas={refreshStickerPackMetas}
                            />
                        ))
                    }
                </div>
            </div>

        </div>
    );
};

export function Header(props: { children: JSX.Element | JSX.Element[]; }) {
    return (
        <div className={cl("header")}>
            {props.children}
        </div>
    );
}

export function Wrapper(props: { children: JSX.Element | JSX.Element[]; }) {
    return (
        <div style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: "48px auto",
            gridTemplateRows: "auto 1fr auto",
        }}>
            {props.children}
        </div>
    );
}

export async function getRecentStickers(key: string = KEY): Promise<Sticker[]> {
    const stickers = (await DataStore.get(key)) ?? [];
    if (!Array.isArray(stickers)) throw new Error("Stored recent stickers are invalid and have been preserved");
    return stickers;
}

export async function setRecentStickers(stickers: Sticker[], key: string = KEY): Promise<void> {
    await DataStore.set(key, stickers);
}

export async function addRecentSticker(sticker: Sticker): Promise<void> {
    await DataStore.update<Sticker[]>(KEY, stickers =>
        [sticker, ...(stickers ?? []).filter(s => s.id !== sticker.id)].slice(0, 16));
}

export async function removeRecentStickerByPackId(packId: string): Promise<void> {
    await DataStore.update<Sticker[]>(KEY, stickers => stickers?.filter(s => s.stickerPackId !== packId) ?? []);
}
