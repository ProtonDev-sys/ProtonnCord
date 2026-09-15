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

import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { OpenExternalIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import definePlugin from "@utils/types";
import { Guild, User } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { Clickable, ConfirmModal, IconUtils, Menu, openModal, Parser, UserStore } from "@webpack/common";

import { Auth, clearAuth, initAuth, updateAuth } from "./auth";
import { openReviewsModal } from "./components/ReviewModal";
import { NotificationType, ReviewType } from "./entities";
import { getCurrentUserInfo, getReviews, readNotification } from "./reviewDbApi";
import { settings } from "./settings";
import { cl, showToast } from "./utils";

const DMSideBarClasses = findCssClassesLazy("widgetPreviews");
const ProfileCardClasses = findCssClassesLazy("cardsList", "firstCardContainer", "card", "container");
const ProfileCardContainerClasses = findCssClassesLazy("innerContainer", "icons", "icon", "displayCount", "displayCountText", "displayCountTextColor", "breadcrumb");
const ProfileCardOverlayClasses = findCssClassesLazy("overlay", "isPrivate", "outer");

const guildPopoutPatch: NavContextMenuPatchCallback = (children, { guild }: { guild: Guild, onClose(): void; }) => {
    if (!guild) return;
    children.push(
        <Menu.MenuItem
            label="View Reviews"
            id="vc-rdb-server-reviews"
            icon={OpenExternalIcon}
            action={() => openReviewsModal(guild.id, guild.name, ReviewType.Server)}
        />
    );
};

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User, onClose(): void; }) => {
    if (!user) return;
    children.push(
        <Menu.MenuItem
            label="View Reviews"
            id="vc-rdb-user-reviews"
            icon={OpenExternalIcon}
            action={() => openReviewsModal(user.id, user.username, ReviewType.User)}
        />
    );
};

let active = false;
let generation = 0;
let notificationTimer: ReturnType<typeof setTimeout> | undefined;

function stopNotifications() {
    generation++;
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = undefined;
    clearAuth();
}

async function loadNotifications() {
    if (!active) return;
    const s = settings.store;
    const accountId = UserStore.getCurrentUser()?.id;
    const currentGeneration = ++generation;
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = undefined;
    const isCurrent = () => active && currentGeneration === generation && accountId === UserStore.getCurrentUser()?.id;

    await initAuth();

    if (!isCurrent()) return;
    notificationTimer = setTimeout(() => {
        notificationTimer = undefined;
        void (async () => {
            if (!isCurrent() || !Auth.token) return;

            const user = await getCurrentUserInfo();
            if (user && isCurrent()) {
                await updateAuth({ user }, accountId);
                if (!isCurrent()) return;
                const { lastReviewId, lastReviewAccountId, notifyReviews } = s;
                const sameAccount = !lastReviewAccountId || lastReviewAccountId === accountId;

                if (notifyReviews) {
                    if (sameAccount && lastReviewId && lastReviewId < user.lastReviewID) {
                        if (user.lastReviewID !== 0)
                            showToast("You have new reviews on your profile!");
                    }
                }

                s.lastReviewId = user.lastReviewID;
                s.lastReviewAccountId = accountId;
                const { notification } = user;
                const { token } = Auth;
                if (notification) {
                    const props = notification.type === NotificationType.Ban ? {
                        cancelText: "Appeal",
                        confirmText: "Ok",
                        onCancel: async () => isCurrent() && token &&
                            VencordNative.native.openExternal(
                                "https://reviewdb.mantikafasi.dev/api/redirect?"
                                + new URLSearchParams({
                                    token,
                                    page: "dashboard/appeal"
                                })
                            )
                    } : {};

                    openModal(modalProps => (
                        <ConfirmModal
                            {...modalProps}
                            title={notification.title}
                            confirmText={props.confirmText ?? "OK"}
                            cancelText={props.cancelText}
                            variant="primary"
                            onCancel={props.onCancel}
                        >
                            {Parser.parse(
                                notification.content,
                                false
                            )}
                        </ConfirmModal>
                    ));

                    await readNotification(notification.id);
                }
            }
        })().catch(error => new Logger("ReviewDB").error("Failed to load notifications", error));
    }, 4000);
}

export default definePlugin({
    name: "ReviewDB",
    description: "Review other users (Adds a new settings to profiles)",
    dependencies: ["ProfileCollectionsAPI"],
    tags: ["Friends", "Servers"],
    authors: [Devs.mantikafasi, Devs.Ven],
    isModified: true,

    settings,
    contextMenus: {
        "guild-header-popout": guildPopoutPatch,
        "guild-context": guildPopoutPatch,
        "user-context": userContextPatch,
        "user-profile-actions": userContextPatch,
        "user-profile-overflow-menu": userContextPatch
    },

    flux: {
        CONNECTION_OPEN: loadNotifications,
        LOGOUT: stopNotifications,
    },

    start() {
        active = true;
        return loadNotifications();
    },

    stop() {
        active = false;
        stopNotifications();
    },

    renderProfileCollection: {
        priority: 0,
        render: ({ user, isSideBar = false }: { user: User; isSideBar?: boolean; }) => {
            const [reviewData] = useAwaiter(() => getReviews(user.id, { limit: 4 }), { deps: [user.id], fallbackValue: null });

            // Discord are masters at using a crap ton of html elements and css classes to create a simple ui that could have
            // been made with less than half of the number of elements, so we have to do this insanity to replicate their ui
            const reviewsSection = (
                <section className={ProfileCardClasses.container}>
                    <ul className={ProfileCardClasses.cardsList} tabIndex={-1}>
                        <li className={ProfileCardClasses.firstCardContainer}>
                            <Clickable
                                className={classes(ProfileCardContainerClasses.breadcrumb, reviewData?.hasOptedOut && cl("profile-popout-disabled"))}
                                onClick={() => !reviewData?.hasOptedOut && openReviewsModal(user.id, user.username, ReviewType.User)}
                            >
                                <div className={classes(ProfileCardOverlayClasses.overlay, ProfileCardContainerClasses.innerContainer, ProfileCardClasses.card)}>
                                    <Paragraph size={isSideBar ? "sm" : "xs"} weight="medium">User Reviews</Paragraph>
                                    {!!reviewData?.reviewCount
                                        ? (
                                            <div className={ProfileCardContainerClasses.icons}>
                                                {reviewData.reviews
                                                    .filter(review => review.id !== 0)
                                                    .slice(0, 4)
                                                    .map((review, idx) => {
                                                        const showCount = idx === 3 && reviewData.reviewCount > 4;

                                                        return (
                                                            <div className={ProfileCardContainerClasses.icon} key={review.id}>
                                                                <img
                                                                    src={review.sender.profilePhoto}
                                                                    alt={review.sender.username}
                                                                    className={showCount ? ProfileCardContainerClasses.displayCount : undefined}
                                                                    onError={e => e.currentTarget.src = IconUtils.getDefaultAvatarURL(review.sender.discordID)}
                                                                />
                                                                {showCount && (
                                                                    <div className={ProfileCardContainerClasses.displayCountText}>
                                                                        <Span className={ProfileCardContainerClasses.displayCountTextColor} size="xs" weight="medium" defaultColor={false}>
                                                                            +{reviewData.reviewCount - 4}
                                                                        </Span>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                            </div>
                                        )
                                        : <Paragraph size={isSideBar ? "sm" : "xs"}>{reviewData?.hasOptedOut ? "User opted out" : "No reviews yet"}</Paragraph>
                                    }
                                </div>
                            </Clickable>
                        </li>
                    </ul>
                </section>
            );

            return isSideBar
                ? <div className={DMSideBarClasses.widgetPreviews}>{reviewsSection}</div>
                : reviewsSection;
        },
    },
});
