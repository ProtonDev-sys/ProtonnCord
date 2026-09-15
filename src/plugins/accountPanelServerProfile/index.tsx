/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import alwaysExpandProfiles from "@equicordplugins/alwaysExpandProfiles";
import { Devs } from "@utils/constants";
import { getCurrentChannel } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { ContextMenuApi, Menu, useEffect, UserProfileActions, UserStore } from "@webpack/common";

interface PopoutProps extends Record<string, unknown> {
    closePopout?(): void;
    onRequestClose?(): void;
}

interface UserProfileProps {
    popoutProps: PopoutProps;
    currentUser: User;
    originalRenderPopout: () => React.ReactNode;
}

const UserProfile = findComponentByCodeLazy(".isNonUserBot()?", ",onClickContainer:");
let openAlternatePopout = false;
let accountPanelRef: React.RefObject<HTMLDivElement | null> = { current: null };

const AccountPanelContextMenu = ErrorBoundary.wrap(() => {
    const { prioritizeServerProfile } = settings.use(["prioritizeServerProfile"]);

    return (
        <Menu.Menu
            navId="vc-ap-server-profile"
            onClose={ContextMenuApi.closeContextMenu}
        >
            <Menu.MenuItem
                id="vc-ap-view-alternate-popout"
                label={prioritizeServerProfile ? "View Account Profile" : "View Server Profile"}
                disabled={getCurrentChannel()?.getGuildId() == null}
                action={() => {
                    if (isPluginEnabled(alwaysExpandProfiles.name)) {
                        const currentUserId = UserStore.getCurrentUser()?.id;
                        if (!currentUserId) return;

                        const currentChannel = getCurrentChannel();
                        UserProfileActions.openUserProfileModal({
                            userId: currentUserId,
                            guildId: prioritizeServerProfile ? undefined : currentChannel?.getGuildId(),
                            channelId: currentChannel?.id
                        });
                        return;
                    }
                    openAlternatePopout = true;
                    accountPanelRef.current?.click();
                }}
            />
            <Menu.MenuCheckboxItem
                id="vc-ap-prioritize-server-profile"
                label="Prioritize Server Profile"
                checked={prioritizeServerProfile}
                action={() => settings.store.prioritizeServerProfile = !prioritizeServerProfile}
            />
        </Menu.Menu>
    );
}, { noop: true });

const settings = definePluginSettings({
    prioritizeServerProfile: {
        type: OptionType.BOOLEAN,
        description: "Prioritize Server Profile when left clicking your account panel",
        default: false
    }
});

export default definePlugin({
    name: "AccountPanelServerProfile",
    description: "Right click your account panel in the bottom left to view your profile in the current server",
    tags: ["Appearance", "Servers"],
    authors: [Devs.Nuckyz, Devs.relitrix],
    settings,

    patches: [
        {
            find: "handleOpenSettingsContextMenu=",
            group: true,
            replacement: [
                {
                    match: /(\.AVATAR,children:.+?renderPopout:\((\i),\i\)=>)\{(.+?)\}(?=,position)(?<=currentUser:(\i).+?)/,
                    replace: (_, rest, popoutProps, originalPopout, currentUser) => `${rest}$self.UserProfile({popoutProps:${popoutProps},currentUser:${currentUser},originalRenderPopout:()=>{${originalPopout}}})`
                },
                {
                    match: /\.AVATAR,children:.+?onRequestClose:\(\)=>\{/,
                    replace: "$&$self.onPopoutClose();"
                },
                {
                    match: /ref:(\i),style:\i(?=.{0,250}#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL})/,
                    replace: "$&,onContextMenu:($self.grabRef($1),$self.openAccountPanelContextMenu)"
                }
            ]
        }
    ],

    get accountPanelRef() {
        return accountPanelRef;
    },

    grabRef(ref: React.RefObject<HTMLDivElement>) {
        accountPanelRef = ref;
        return ref;
    },

    openAccountPanelContextMenu(event: React.UIEvent) {
        ContextMenuApi.openContextMenu(event, AccountPanelContextMenu);
    },

    onPopoutClose() {
        openAlternatePopout = false;
    },

    UserProfile: ErrorBoundary.wrap(({ popoutProps, currentUser, originalRenderPopout }: UserProfileProps) => {
        if (
            (settings.store.prioritizeServerProfile && openAlternatePopout) ||
            (!settings.store.prioritizeServerProfile && !openAlternatePopout)
        ) {
            return originalRenderPopout();
        }

        const currentChannel = getCurrentChannel();
        const guildId = currentChannel?.getGuildId();
        if (!currentChannel || guildId == null) {
            return originalRenderPopout();
        }

        if (isPluginEnabled(alwaysExpandProfiles.name)) {
            return <ServerProfileLauncher popoutProps={popoutProps} userId={currentUser.id} guildId={guildId} channelId={currentChannel.id} />;
        }

        if (!UserProfile.$$vencordGetWrappedComponent()) return originalRenderPopout();

        return (
            <UserProfile
                {...popoutProps}
                user={currentUser}
                currentUser={currentUser}
                guildId={guildId}
                channelId={currentChannel.id}
            />
        );
    }, { noop: true })
});

function ServerProfileLauncher({ popoutProps, userId, guildId, channelId }: { popoutProps: PopoutProps; userId: string; guildId: string; channelId: string; }) {
    useEffect(() => {
        (popoutProps.closePopout ?? popoutProps.onRequestClose)?.();
        UserProfileActions.openUserProfileModal({ userId, guildId, channelId });
    }, [channelId, guildId, popoutProps, userId]);
    return null;
}
