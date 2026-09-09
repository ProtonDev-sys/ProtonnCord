/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Margins } from "@components/margins";
import type { Theme, ThemeLikeProps } from "@equicordplugins/themeLibrary/types";
import { getThemeLibraryToken, isAuthorized } from "@equicordplugins/themeLibrary/utils/auth";
import { LikeIcon } from "@equicordplugins/themeLibrary/utils/Icons";
import { useEffect, useRef, useState } from "@webpack/common";

import { logger, themeRequest } from "./ThemeTab";

export const LikesComponent = ({ themeId, likedThemes: initialLikedThemes }: { themeId: Theme["id"], likedThemes: ThemeLikeProps | undefined; }) => {
    const [likesCount, setLikesCount] = useState(0);
    const [likedThemes, setLikedThemes] = useState(initialLikedThemes);
    const debounce = useRef(false);
    const generation = useRef(0);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        generation.current++;
        debounce.current = false;
        setBusy(false);
        setLikedThemes(initialLikedThemes);
        return () => { generation.current++; };
    }, [initialLikedThemes, themeId]);

    useEffect(() => {
        const likes = getThemeLikes(themeId);
        setLikesCount(likes);
    }, [likedThemes, themeId]);

    function getThemeLikes(themeId: Theme["id"]): number {
        const themeLike = likedThemes?.likes.find(like => String(like.themeId) === String(themeId));
        return themeLike ? themeLike.likes : 0;
    }

    const handleLikeClick = async (themeId: Theme["id"]) => {
        if (debounce.current) return;
        debounce.current = true;
        setBusy(true);
        const currentGeneration = generation.current;
        const current = () => generation.current === currentGeneration;
        let changed = false;
        try {
            if (!await isAuthorized() || !current()) return;
            const theme = likedThemes?.likes.find(like => String(like.themeId) === String(themeId));
            const hasLiked = theme?.hasLiked ?? false;
            const endpoint = hasLiked ? "/likes/remove" : "/likes/add";
            const token = await getThemeLibraryToken();
            if (!token || !current()) return;
            const nextLikes = Math.max(0, likesCount + (hasLiked ? -1 : 1));
            setLikesCount(nextLikes);
            const response = await themeRequest(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`,
                },
                body: JSON.stringify({
                    themeId: themeId,
                }),
            });
            if (!current()) return;

            if (!response.ok) {
                setLikesCount(likesCount);
                return logger.error("Couldnt update likes, response not ok");
            }
            changed = true;
            setLikedThemes(previous => ({
                status: previous?.status ?? 200,
                likes: [...(previous?.likes ?? []).filter(like => String(like.themeId) !== String(themeId)), { themeId, likes: nextLikes, hasLiked: !hasLiked }]
            }));

            const fetchLikes = async () => {
                try {
                    const response = await themeRequest("/likes/get", {
                        headers: {
                            "Authorization": `Bearer ${token}`,
                        },
                    });
                    if (!response.ok) return;
                    const data = await response.json();
                    if (current() && data && Array.isArray(data.likes)) setLikedThemes(data);
                } catch (err) {
                    logger.error(err);
                }
            };

            await fetchLikes();
        } catch (err) {
            if (current() && !changed) setLikesCount(likesCount);
            logger.error(err);
        } finally {
            if (current()) {
                debounce.current = false;
                setBusy(false);
            }
        }
    };

    const hasLiked = likedThemes?.likes.some(like => String(like.themeId) === String(themeId) && like?.hasLiked === true) ?? false;

    return (
        <Button onClick={() => handleLikeClick(themeId)}
            variant="secondary"
            size="medium"
            disabled={themeId === "preview" || busy}
            className={Margins.right8}
        >
            {LikeIcon(hasLiked || themeId === "preview")} {themeId === "preview" ? 143 : likesCount}
        </Button>
    );
};
