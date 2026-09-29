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

import "./PluginModal.css";

import { generateId } from "@api/Commands";
import { hasAnyVisibleSettings, isPluginEnabled, isSettingHidden } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { WarningIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Switch } from "@components/Switch";
import { getLoadedPluginDefinition } from "@shared/pluginDefinition";
import { gitRemote } from "@shared/vencordUserAgent";
import { classNameFactory } from "@utils/css";
import { makeLazy } from "@utils/lazy";
import { OptionType, Plugin, PluginTag } from "@utils/types";
import { RenderModalProps, User } from "@vencord/discord-types";
import { findCssClasses } from "@webpack";
import { Clickable, ConfirmModal, FluxDispatcher, Modal, openModal, React, Toasts, Tooltip, useEffect, useMemo, useRef, UserStore, UserSummaryItem, UserUtils, useState } from "@webpack/common";
import { Constructor } from "type-fest";

import { PluginManifest, PluginMeta } from "~plugins";

import { OptionComponentMap } from "./components";
import { openContributorModal } from "./ContributorModal";
import { FavoriteButton, GithubButton, WebsiteButton } from "./PluginModalButtons";
import { togglePlugin } from "./pluginToggle";
import { createSettingChangeScheduler } from "./settingUpdates";
import { getPluginSource, restartAfterSaving } from "./shared";

const cl = classNameFactory("vc-plugin-modal-");

const MAX_AUTHOR_AVATARS = 6;

const getAvatarStyles = makeLazy(() => findCssClasses("moreUsers", "avatar", "clickableAvatar"));
const getUserRecord = makeLazy(() => UserStore.getCurrentUser().constructor as Constructor<Partial<User>>);

interface PluginModalProps extends RenderModalProps {
    plugin: Plugin;
    onRestartNeeded(key: string): void;
}

export function makeDummyUser(user: { username: string; id?: string; avatar?: string; }) {
    const UserRecord = getUserRecord();
    const newUser = new UserRecord({
        username: user.username,
        id: user.id ?? generateId(),
        avatar: user.avatar,
        /** To stop discord making unwanted requests... */
        bot: true,
    });

    FluxDispatcher.dispatch({
        type: "USER_UPDATE",
        user: newUser,
    });

    return newUser;
}

function PluginTags({ tags }: { tags: PluginTag[]; }) {
    return (
        <div className={cl("tags")}>
            {tags.map(tag => (
                <div key={tag} className={cl("tag")}>{tag}</div>
            ))}
        </div>
    );
}

/** Enabled plugins that keep this plugin on; an empty list means it is required by Protonn Cord itself. */
function getRequiredBy(plugin: Plugin): string[] | null {
    if (plugin.required) return [];
    const dependants = Object.entries(PluginManifest)
        .filter(([name, entry]) => entry.dependencies?.includes(plugin.name) && isPluginEnabled(name))
        .map(([name]) => name);
    if (dependants.length) return dependants;
    return getLoadedPluginDefinition(plugin.name)?.isDependency ? [] : null;
}

function formatAuthors(names: string[]) {
    if (names.length <= 3) return names.join(", ").replace(/, ([^,]*)$/, " and $1");
    return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

export default function PluginModal({ plugin, onRestartNeeded, onClose, transitionState }: PluginModalProps) {
    const AvatarStyles = getAvatarStyles();
    const pluginSettings = useSettings([`plugins.${plugin.name}.*`]).plugins[plugin.name];
    const hasSettings = hasAnyVisibleSettings(plugin);

    // avoid layout shift by showing dummy users while loading users
    const fallbackAuthors = useMemo(() => [makeDummyUser({ username: "Loading...", id: "-1465912127305809920" })], []);
    const [authors, setAuthors] = useState<Partial<User>[]>([]);
    const [settingsVersion, setSettingsVersion] = useState(0);
    const [restartPending, setRestartPending] = useState(false);
    const restartCallback = useRef(onRestartNeeded);
    restartCallback.current = onRestartNeeded;
    const settingChanges = useMemo(() => createSettingChangeScheduler((key, newValue) => {
        const option = plugin.settings?.def[key];
        if (!option || option.type === OptionType.CUSTOM) return;
        pluginSettings[key] = newValue;
        if (option.restartNeeded) restartCallback.current(key);
    }), [plugin, pluginSettings]);

    useEffect(() => () => settingChanges.flush(), [settingChanges]);

    useEffect(() => {
        let cancelled = false;
        setAuthors([]);
        (async () => {
            for (const user of plugin.authors.slice(0, MAX_AUTHOR_AVATARS)) {
                if (cancelled) break;
                try {
                    const author = user.id
                        ? await UserUtils.getUser(String(user.id))
                            .catch(() => makeDummyUser({ username: user.name }))
                        : makeDummyUser({ username: user.name });

                    if (!cancelled) setAuthors(a => [...a, author]);
                } catch (e) {
                    continue;
                }
            }
        })();
        return () => { cancelled = true; };
    }, [plugin.authors]);

    function handleResetClick() {
        openResetModal(plugin, onRestartNeeded, () => {
            settingChanges.cancel();
            setSettingsVersion(version => version + 1);
        });
    }

    function handleToggle() {
        const result = togglePlugin(plugin.name, (_, key) => restartCallback.current(key));
        if (result === "restart") setRestartPending(pending => !pending);
    }

    function renderSettings() {
        const { settings } = plugin;
        if (!hasSettings || !settings)
            return <Paragraph className={cl("no-settings")}>This plugin has no settings.</Paragraph>;

        const options = Object.entries(settings.def).map(([key, setting]) => {
            if (setting.type === OptionType.CUSTOM) return null;

            if (isSettingHidden(settings, setting)) return null;

            const Component = OptionComponentMap[setting.type];
            return (
                <ErrorBoundary noop key={`${settingsVersion}:${key}`}>
                    <Component
                        id={key}
                        setting={setting}
                        onChange={newValue => settingChanges.schedule(key, newValue)}
                        pluginSettings={pluginSettings}
                        definedSettings={settings}
                        closePluginSettings={onClose}
                    />
                </ErrorBoundary>
            );
        });

        return (
            <div className={`vc-plugins-settings ${cl("settings-list")}`}>
                {options}
            </div>
        );
    }

    function renderMoreUsers(_label: string) {
        const remainingAuthors = plugin.authors.slice(MAX_AUTHOR_AVATARS);

        return (
            <Tooltip text={remainingAuthors.map(u => u.name).join(", ")}>
                {({ onMouseEnter, onMouseLeave }) => (
                    <div
                        className={AvatarStyles.moreUsers}
                        onMouseEnter={onMouseEnter}
                        onMouseLeave={onMouseLeave}
                    >
                        +{remainingAuthors.length}
                    </div>
                )}
            </Tooltip>
        );
    }

    const pluginMeta = PluginMeta[plugin.name];
    const isEquicordPlugin = pluginMeta.folderName.startsWith("src/equicordplugins/");
    const source = getPluginSource(pluginMeta, plugin.isModified);
    const enabled = isPluginEnabled(plugin.name);
    const requiredBy = getRequiredBy(plugin);

    let statusDetail: string;
    if (requiredBy) statusDetail = requiredBy.length ? `Required by ${requiredBy.join(", ")}.` : "Required for Protonn Cord to work.";
    else if (restartPending) statusDetail = "Restart Discord to apply this change.";
    else statusDetail = enabled ? "This plugin is running." : "Turn this on to use the plugin.";

    return (
        <Modal
            transitionState={transitionState}
            onClose={onClose}
            size="lg"
            title={
                <div className={cl("header")}>
                    <BaseText tag="h1" weight="semibold" size="lg">{plugin.name}</BaseText>
                    {source && <span className={cl("source")} title={source.title}>{source.label}</span>}
                </div>
            }
            subtitle={
                <div className={cl("info")}>
                    <Paragraph size="md">{plugin.description}</Paragraph>
                    {!!plugin.tags?.length && <PluginTags tags={plugin.tags} />}
                </div>
            }
        >
            <div className={cl("content")}>
                <div className={cl("meta")}>
                    <div className={cl("authors")}>
                        <ErrorBoundary noop>
                            <UserSummaryItem
                                users={authors.length ? authors : fallbackAuthors}
                                guildId={undefined}
                                renderIcon={false}
                                showDefaultAvatarsForNullUsers
                                renderMoreUsers={renderMoreUsers}
                                renderUser={(user: User) => (
                                    <Clickable
                                        className={AvatarStyles.clickableAvatar}
                                        onClick={() => openContributorModal(user)}
                                    >
                                        <img
                                            className={AvatarStyles.avatar}
                                            src={user.getAvatarURL(void 0, 80, true)}
                                            alt={user.username}
                                            title={user.username}
                                        />
                                    </Clickable>
                                )}
                            />
                        </ErrorBoundary>
                        {plugin.authors.length > 0 && (
                            <span className={cl("author-names")}>
                                by {formatAuthors(plugin.authors.map(author => author.name))}
                            </span>
                        )}
                    </div>
                    {!pluginMeta.userPlugin && (
                        <div className={cl("links")}>
                            <FavoriteButton
                                isFavorite={pluginSettings.isFavorite ?? false}
                                onClick={() => pluginSettings.isFavorite = !pluginSettings.isFavorite}
                            />
                            <WebsiteButton
                                text="Website"
                                href={isEquicordPlugin ? `https://github.com/ProtonDev-sys/ProtonnCord/tree/main/${pluginMeta.folderName}` : `https://vencord.dev/plugins/${plugin.name}`}
                            />
                            <GithubButton
                                text="Source Code"
                                href={`https://github.com/${gitRemote}/tree/main/${pluginMeta.folderName}`}
                            />
                        </div>
                    )}
                </div>

                <div className={cl("status", { "status-enabled": enabled })}>
                    <div className={cl("status-text")}>
                        <BaseText size="md" weight="semibold" className={cl("status-title")}>
                            {enabled ? "Enabled" : "Disabled"}
                        </BaseText>
                        <BaseText size="sm" className={cl("status-detail")}>{statusDetail}</BaseText>
                    </div>
                    {restartPending && !requiredBy && (
                        <Button size="small" variant="secondary" onClick={restartAfterSaving}>Restart now</Button>
                    )}
                    <Switch
                        aria-label={`Enable ${plugin.name}`}
                        checked={enabled}
                        disabled={!!requiredBy}
                        onChange={handleToggle}
                    />
                </div>

                {!!plugin.settingsAboutComponent && (
                    <div className={cl("about-box")}>
                        <ErrorBoundary message="An error occurred while rendering this plugin's custom Info Component">
                            <plugin.settingsAboutComponent />
                        </ErrorBoundary>
                    </div>
                )}

                <section className={cl("settings")}>
                    <div className={cl("section-header")}>
                        <BaseText size="lg" weight="semibold" color="text-strong">Settings</BaseText>
                        {hasSettings && (
                            <Button size="small" variant="secondary" onClick={handleResetClick}>
                                Reset to defaults
                            </Button>
                        )}
                    </div>
                    {renderSettings()}
                </section>
            </div>
        </Modal>
    );
}

export function openPluginModal(plugin: Plugin, onRestartNeeded?: (pluginName: string, key: string) => void) {
    openModal(modalProps => (
        <PluginModal
            {...modalProps}
            plugin={plugin}
            onRestartNeeded={(key: string) => onRestartNeeded?.(plugin.name, key)}
        />
    ));
}

function resetSettings(plugin: Plugin, onRestartNeeded?: (key: string) => void) {
    const defaultSettings = plugin.settings?.def;
    const pluginName = plugin.name;

    if (!defaultSettings) return;

    const newSettings: Record<string, any> = {};
    let restartNeeded = false;

    for (const key in defaultSettings) {
        if (key === "enabled") continue;

        const setting = defaultSettings[key];
        const defaultValue = "default" in setting ? setting.default : undefined;
        if ((setting.type ?? OptionType.STRING) === OptionType.STRING) {
            newSettings[key] = defaultValue !== undefined ? defaultValue : "";
        } else if (defaultValue !== undefined) {
            newSettings[key] = defaultValue;
        } else if (setting.type === OptionType.BOOLEAN) {
            newSettings[key] = false;
        } else if (setting.type === OptionType.SELECT) {
            const selected = setting.options.find(option => option.default);
            if (selected) newSettings[key] = selected.value;
        }

        if (newSettings[key] !== null && typeof newSettings[key] === "object") {
            try {
                newSettings[key] = structuredClone(newSettings[key]);
            } catch {
                // Preserve legacy non-data defaults, matching the settings store.
            }
        }

        if (setting?.restartNeeded) {
            restartNeeded = true;
        }
    }

    const currentSettings = plugin.settings?.store;
    if (currentSettings) {
        Object.assign(currentSettings, newSettings);
    }

    if (restartNeeded) {
        onRestartNeeded?.(plugin.name);
    }

    Toasts.show({
        message: `Settings for ${pluginName} have been reset.`,
        id: Toasts.genId(),
        type: Toasts.Type.SUCCESS,
        options: {
            position: Toasts.Position.TOP
        }
    });
}

function IrreversibleWarning() {
    return (
        <div className={cl("warning")}>
            <WarningIcon width={16} height={16} />
            <span>This action cannot be undone.</span>
        </div>
    );
}

export function openResetModal(plugin: Plugin, onRestartNeeded?: (key: string) => void, beforeReset?: () => void) {
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Reset settings"
            confirmText="Reset"
            cancelText="Cancel"
            variant="critical-primary"
            onConfirm={() => {
                beforeReset?.();
                resetSettings(plugin, onRestartNeeded);
            }}
        >
            <Paragraph>
                Are you sure you want to reset all settings for <strong>{plugin.name}</strong> to their default values?
            </Paragraph>
            <IrreversibleWarning />
        </ConfirmModal>
    ));
}

export function openDisableAllModal(enabledPlugins: number, disableAll: () => void) {
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Disable all plugins"
            confirmText="Disable all"
            cancelText="Cancel"
            variant="critical-primary"
            onConfirm={disableAll}
        >
            <Paragraph>Are you sure you want to disable {enabledPlugins} plugins?</Paragraph>
            <IrreversibleWarning />
        </ConfirmModal>
    ));
}
