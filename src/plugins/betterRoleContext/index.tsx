/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { CopyIdIcon, ImageIcon, PencilIcon as SharedPencilIcon, UserIcon } from "@components/Icons";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import { getCurrentChannel, getCurrentGuild, getIntlMessage, openImageModal } from "@utils/discord";
import { isTruthy } from "@utils/guards";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Guild, Role } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy, findCssClassesLazy } from "@webpack";
import { ContextMenuApi, GuildRoleStore, Menu, PermissionStore, Popout, RoleMemberPopout, useRef } from "@webpack/common";

const GuildSettingsActions = findByPropsLazy("open", "selectRole", "updateGuild");
const MenuItemClasses = findCssClassesLazy("item", "labelContainer", "colorDefault", "label", "iconContainer");
const loadRoleMembers = findByCodeLazy(".GUILD_ROLE_MEMBER_IDS(", "requestMembersById");

const DeveloperMode = getUserSettingLazy("appearance", "developerMode")!;

function openRoleIconModal(roleId: string, roleIcon: string) {
    const format = settings.store.roleIconFileFormat;
    const original = `${location.protocol}//${window.GLOBAL_ENV.CDN_HOST}/role-icons/${roleId}/${roleIcon}.${format}`;
    const url = original.replace(`//${window.GLOBAL_ENV.CDN_HOST}/`, "//media.discordapp.net/");

    openImageModal({
        url,
        original,
        height: 128,
        width: 128
    });
}

function PencilIcon() {
    return <SharedPencilIcon width={18} height={18} />;
}

function AppearanceIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="currentColor" d="M 12,0 C 5.3733333,0 0,5.3733333 0,12 c 0,6.626667 5.3733333,12 12,12 1.106667,0 2,-0.893333 2,-2 0,-0.52 -0.2,-0.986667 -0.52,-1.346667 -0.306667,-0.346666 -0.506667,-0.813333 -0.506667,-1.32 0,-1.106666 0.893334,-2 2,-2 h 2.36 C 21.013333,17.333333 24,14.346667 24,10.666667 24,4.7733333 18.626667,0 12,0 Z M 4.6666667,12 c -1.1066667,0 -2,-0.893333 -2,-2 0,-1.1066667 0.8933333,-2 2,-2 1.1066666,0 2,0.8933333 2,2 0,1.106667 -0.8933334,2 -2,2 z M 8.666667,6.6666667 c -1.106667,0 -2.0000003,-0.8933334 -2.0000003,-2 0,-1.1066667 0.8933333,-2 2.0000003,-2 1.106666,0 2,0.8933333 2,2 0,1.1066666 -0.893334,2 -2,2 z m 6.666666,0 c -1.106666,0 -2,-0.8933334 -2,-2 0,-1.1066667 0.893334,-2 2,-2 1.106667,0 2,0.8933333 2,2 0,1.1066666 -0.893333,2 -2,2 z m 4,5.3333333 c -1.106666,0 -2,-0.893333 -2,-2 0,-1.1066667 0.893334,-2 2,-2 1.106667,0 2,0.8933333 2,2 0,1.106667 -0.893333,2 -2,2 z" />
        </svg>
    );
}

const settings = definePluginSettings({
    roleIconFileFormat: {
        type: OptionType.SELECT,
        description: "File format to use when viewing role icons",
        options: [
            {
                label: "png",
                value: "png",
                default: true
            },
            {
                label: "webp",
                value: "webp",
            },
            {
                label: "jpg",
                value: "jpg"
            }
        ]
    }
});

export function buildExtraRoleContextMenuItems(role: Role, guild: Guild, popoutRef?: React.RefObject<any>) {
    if (!role) return { before: [], after: [] };
    const { colorString, icon } = role;

    const before = [
        PermissionStore.getGuildPermissionProps(guild).canManageRoles && (
            <Menu.MenuItem
                key="vc-edit-role"
                id="vc-edit-role"
                label="Edit Role"
                action={async () => {
                    await GuildSettingsActions.open(guild.id, "ROLES");
                    GuildSettingsActions.selectRole(role.id);
                }}
                icon={PencilIcon}
            />
        ),
        colorString && (
            <Menu.MenuItem
                key="vc-copy-role-color"
                id="vc-copy-role-color"
                label="Copy Role Color"
                action={() => copyToClipboard(colorString)}
                icon={AppearanceIcon}
            />
        )
    ].filter(isTruthy);

    const after = [
        icon && (
            <Menu.MenuItem
                key="vc-view-role-icon"
                id="vc-view-role-icon"
                label="View Role Icon"
                action={() => openRoleIconModal(role.id, icon)}
                icon={ImageIcon}
            />
        ),
        popoutRef && (
            <Menu.MenuItem
                key="vc-view-role-members"
                id="vc-view-role-members"
                label="View Role Members"
                render={() => (
                    <Popout
                        position="right"
                        align="center"
                        targetElementRef={popoutRef}
                        preload={() => loadRoleMembers(guild.id, role.id)}
                        renderPopout={popoutProps => (
                            <RoleMemberPopout
                                popoutProps={popoutProps}
                                guildId={guild.id}
                                channelId={getCurrentChannel()!.id}
                                roleId={role.id}
                            />
                        )}
                    >
                        {popoutProps => (
                            <div
                                className={classes(MenuItemClasses.item, MenuItemClasses.labelContainer, MenuItemClasses.colorDefault)}
                                ref={popoutRef}
                                role="menuitem"
                                {...popoutProps}
                            >
                                <div className={MenuItemClasses.label}>View Role Members</div>
                                <div className={MenuItemClasses.iconContainer}>
                                    <UserIcon width={18} height={18} />
                                </div>
                            </div>
                        )}
                    </Popout>
                )}
            />
        )
    ].filter(isTruthy);

    return { before, after };
}

export function openRoleContextMenu(event: React.MouseEvent<HTMLElement>, { guildId, id: roleId }: { guildId: string; id: string; }) {
    const guild = getCurrentGuild();
    if (!guild || guild.id !== guildId) return;

    const role = GuildRoleStore.getRole(guildId, roleId);
    if (!role) return;

    ContextMenuApi.openContextMenu(event, () => {
        const popoutRef = useRef(null);
        const { before, after } = buildExtraRoleContextMenuItems(role, guild, popoutRef);

        return (
            <Menu.Menu
                navId="vc-better-role-context-member-list"
                onClose={ContextMenuApi.closeContextMenu}
                aria-label="Role Actions"
            >
                {before}
                {after}
                <Menu.MenuItem
                    key="vc-better-role-context-copy-role-id"
                    id="vc-better-role-context-copy-role-id"
                    label={getIntlMessage("COPY_ID_ROLE")}
                    icon={CopyIdIcon}
                    action={() => copyToClipboard(role.id)}
                />
            </Menu.Menu>
        );
    });
}

export default definePlugin({
    name: "BetterRoleContext",
    description: "Adds options to copy role color / edit role / view role icon when right clicking roles in the user profile or in the member list",
    tags: ["Roles", "Appearance"],
    authors: [Devs.Ven, Devs.goodbee, Devs.nightmaresan],
    dependencies: ["UserSettingsAPI"],
    settings,
    openRoleContextMenu,
    patches: [
        // Conflicts with RoleColorEverywhere which changes the code at the end of our match. (and also uses same find & similar match)
        // However, BetterRoleContext applies first (alphabetic order), so it's not an issue
        {
            find: 'tutorialId:"whos-online',
            replacement: {
                match: /(?<=#{intl::CHANNEL_MEMBERS_A11Y_LABEL}.{0,200}?"aria-hidden":!0,)children:.{0,200}?(?:—|\\u2014) ",\i\]\}\)\]/,
                replace: "onContextMenu:e=>$self.openRoleContextMenu(e,arguments[0]),$&"
            }
        }
    ],

    start() {
        // DeveloperMode needs to be enabled for the context menu to be shown
        DeveloperMode.updateSetting(true);
    },

    contextMenus: {
        "dev-context"(children, { id }: { id: string; }) {
            const guild = getCurrentGuild();
            if (!guild) return;

            const role = GuildRoleStore.getRole(guild.id, id);
            if (!role) return;

            const { before, after } = buildExtraRoleContextMenuItems(role, guild);
            children.unshift(...before);
            children.push(...after);
        }
    }
});
