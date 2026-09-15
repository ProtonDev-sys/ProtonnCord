/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { OptionType } from "@utils/types";
import { UserStore } from "@webpack/common";
import { DragEvent } from "react";

const settings = definePluginSettings({
    showEquicordDonor: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Protonn Cord Donor badges in chat.",
        hidden: true,
        default: true
    },
    EquicordDonorPosition: {
        type: OptionType.NUMBER,
        description: "The position of the Protonn Cord Donor badges.",
        hidden: true,
        default: 0
    },
    showEquicordContributor: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Protonn Cord Contributor badges in chat.",
        hidden: true,
        default: true
    },
    EquicordContributorPosition: {
        type: OptionType.NUMBER,
        description: "The position of the Protonn Cord Contributor badge.",
        hidden: true,
        default: 1
    },
    showVencordDonor: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Vencord donor badges in chat.",
        hidden: true,
        default: true
    },
    VencordDonorPosition: {
        type: OptionType.NUMBER,
        description: "The position of the Vencord Donor badges.",
        hidden: true,
        default: 4
    },
    showVencordContributor: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Vencord contributor badges in chat.",
        hidden: true,
        default: true
    },
    VencordContributorPosition: {
        type: OptionType.NUMBER,
        description: "The position of the Vencord Contributor badge.",
        hidden: true,
        default: 5
    },
    showDiscordProfile: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Discord profile badges in chat.",
        hidden: true,
        default: true
    },
    DiscordProfilePosition: {
        type: OptionType.NUMBER,
        description: "The position of the Discord profile badges.",
        hidden: true,
        default: 6
    },
    showDiscordNitro: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Discord Nitro badges in chat.",
        hidden: true,
        default: true
    },
    DiscordNitroPosition: {
        type: OptionType.NUMBER,
        description: "The position of the Discord Nitro badge.",
        hidden: true,
        default: 7
    },
    badgeSettings: {
        type: OptionType.COMPONENT,
        description: "Setup badge layout and visibility",
        component: () => <BadgeSettings />
    }
});

export default settings;

const badgeImages = [
    { src: "https://badge.equicord.org/donor.webp", title: "Protonn Cord donor badges", key: "EquicordDonor" },
    { src: "https://equicord.org/assets/favicon.png", title: "Protonn Cord contributor badge", key: "EquicordContributor" },
    { src: "https://cdn.discordapp.com/emojis/1026533070955872337.png", title: "Vencord donor badges", key: "VencordDonor" },
    { src: "https://cdn.discordapp.com/emojis/1092089799109775453.png", title: "Vencord contributor badge", key: "VencordContributor" },
    { src: "https://cdn.discordapp.com/badge-icons/bf01d1073931f921909045f3a39fd264.png", title: "Discord profile badges (HypeSquad, Discord Staff, Early Supporter, etc.)", key: "DiscordProfile" },
    { src: "https://cdn.discordapp.com/badge-icons/2ba85e8026a8614b640c2837bcdfe21b.png", title: "Nitro badge", key: "DiscordNitro" }
] as const;

const BadgeSettings = () => {
    const currentSettings = settings.use();
    const images = badgeImages.map(image => ({
        ...image,
        shown: currentSettings[`show${image.key}`],
        position: currentSettings[`${image.key}Position`]
    })).sort((a, b) => a.position - b.position);

    const moveBadge = (dragIndex: number, dropIndex: number) => {
        if (dragIndex < 0 || dropIndex < 0 || dragIndex >= images.length || dropIndex >= images.length || dragIndex === dropIndex) return;
        const reordered = [...images];
        const [draggedImage] = reordered.splice(dragIndex, 1);
        reordered.splice(dropIndex, 0, draggedImage);
        reordered.forEach((image, index) => {
            settings.store[`${image.key}Position`] = index;
        });
    };

    const handleDrop = (event: DragEvent, dropIndex: number) => {
        event.preventDefault();
        const key = event.dataTransfer.getData("application/x-protonncord-badge");
        moveBadge(images.findIndex(image => image.key === key), dropIndex);
    };

    const currentUser = UserStore.getCurrentUser();

    return (
        <>
            <BaseText>Click a badge to show or hide it. Drag to reorder, or focus a badge and press Alt with the left or right arrow key.</BaseText>
            <div className="vc-sbic-badge-settings">
                {currentUser && (
                    <>
                        <img className="vc-sbic-settings-avatar" src={currentUser.getAvatarURL()} alt="" />
                        <BaseText className="vc-sbic-settings-username">{currentUser.globalName ?? currentUser.username}</BaseText>
                    </>
                )}
                {images.map((image, index) => (
                    <Button
                        key={image.key}
                        type="button"
                        variant="none"
                        size="min"
                        aria-label={image.title}
                        aria-pressed={image.shown}
                        className={`vc-sbic-image-container ${!image.shown ? "vc-sbic-disabled" : ""}`}
                        onDragOver={event => event.preventDefault()}
                        onDrop={event => handleDrop(event, index)}
                        onClick={() => { settings.store[`show${image.key}`] = !image.shown; }}
                        onKeyDown={event => {
                            if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                            event.preventDefault();
                            moveBadge(index, index + (event.key === "ArrowLeft" ? -1 : 1));
                        }}
                    >
                        <img
                            src={image.src}
                            draggable={image.shown}
                            onDragStart={event => event.dataTransfer.setData("application/x-protonncord-badge", image.key)}
                            title={image.title}
                            alt=""
                        />
                    </Button>
                ))}
            </div>
        </>
    );
};
