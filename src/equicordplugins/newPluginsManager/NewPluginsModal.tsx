/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Settings, useSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { Link } from "@components/Link";
import { Notice } from "@components/Notice";
import { PluginCard } from "@components/settings/tabs/plugins/PluginCard";
import { PluginDependencyList } from "@components/settings/tabs/plugins/shared";
import { ChangeList } from "@utils/ChangeList";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { reload } from "@utils/native";
import { useForceUpdater } from "@utils/react";
import { RenderModalProps } from "@vencord/discord-types";
import { closeModal, Modal, openModal, showToast, Toasts, Tooltip, useMemo } from "@webpack/common";
import { ReactNode } from "react";

import { PluginManifest as Plugins } from "~plugins";

import { getNewPluginChanges, KnownPluginSettingsMap, writeKnownSettings } from "./knownSettings";

const cl = classNameFactory("vc-new-plugins-");
const logger = new Logger("NewPluginsManager");

let hasSeen = false;

interface ModalComponentProps {
    modalProps: RenderModalProps;
    newPlugins: Set<string>;
    newSettings: KnownPluginSettingsMap;
}

function NewPluginsModal({ modalProps, newPlugins, newSettings }: ModalComponentProps) {
    const settings = useSettings();
    const changes = useMemo(() => new ChangeList<string>(), []);
    const forceUpdate = useForceUpdater();

    const depMap = useMemo(() => {
        const o = {} as Record<string, string[]>;
        for (const plugin in Plugins) {
            const deps = Plugins[plugin].dependencies;
            if (deps) {
                for (const dep of deps) {
                    o[dep] ??= [];
                    o[dep].push(plugin);
                }
            }
        }
        return o;
    }, []);

    const sortedPlugins = useMemo(() => {
        const mapPlugins = (array: string[]) => array.map(pn => Plugins[pn]).sort((a, b) => a.name.localeCompare(b.name));
        return [
            ...mapPlugins([...newPlugins]),
            ...mapPlugins([...newSettings.keys()].filter(p => !newPlugins.has(p)))
        ];
    }, []);

    const onRestartNeeded = (name: string) => {
        changes.handleChange(name);
        forceUpdate();
    };

    const pluginCards: ReactNode[] = [];
    const requiredPluginCards: ReactNode[] = [];

    for (const p of sortedPlugins) {
        if (p.hidden) continue;

        const isRequired = p.required || depMap[p.name]?.some(d => settings.plugins[d].enabled);

        if (isRequired) {
            const tooltipText = p.required
                ? "This plugin is required for Protonn Cord to function."
                : <PluginDependencyList deps={depMap[p.name]?.filter(d => settings.plugins[d].enabled)} />;

            requiredPluginCards.push(
                <Tooltip text={tooltipText} key={p.name}>
                    {({ onMouseLeave, onMouseEnter }) => (
                        <PluginCard
                            onMouseLeave={onMouseLeave}
                            onMouseEnter={onMouseEnter}
                            onRestartNeeded={onRestartNeeded}
                            disabled={true}
                            plugin={p}
                            isNew={newPlugins.has(p.name)}
                        />
                    )}
                </Tooltip>
            );
        } else {
            pluginCards.push(
                <PluginCard
                    onRestartNeeded={onRestartNeeded}
                    disabled={false}
                    plugin={p}
                    key={p.name}
                    isNew={newPlugins.has(p.name)}
                />
            );
        }
    }

    const totalCount = pluginCards.length + requiredPluginCards.length;

    const handleContinue = async () => {
        if (changes.hasChanges) {
            try {
                await reload();
            } catch (error) {
                logger.error("Cannot restart before saving settings", error);
                showToast("Your settings could not be saved. Try again before restarting.", Toasts.Type.FAILURE);
            }
        } else {
            modalProps.onClose();
        }
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title={
                <div className={cl("header-content")}>
                    <BaseText size="lg" weight="semibold" className={cl("title")}>
                        New Plugins and Settings ({totalCount})
                    </BaseText>
                </div>
            }
            subtitle={
                <>
                    <BaseText size="sm" className={cl("description")}>
                        New plugins have been added since your last visit. Enable any you'd like or continue to dismiss.
                    </BaseText>
                    <br />
                    <Notice.Info className={cl("notice")}>
                        Equicord is Open Source Software. If you enjoy using it, consider supporting us <Link href="https://github.com/sponsors/thororen1234" target="_blank" rel="noopener noreferrer">here</Link>.
                    </Notice.Info>
                </>
            }
            actions={[
                {
                    text: "Don't show this again",
                    onClick: () => {
                        Settings.plugins.NewPluginsManager.enabled = !settings?.plugins?.NewPluginsManager?.enabled;
                    },
                    variant: "secondary"
                },
                {
                    text: changes.hasChanges ? "Restart" : "Continue",
                    onClick: handleContinue,
                    variant: "primary"
                }
            ]}
        >
            <div className={cl("grid")}>
                {pluginCards}
                {requiredPluginCards}
            </div>
        </Modal >
    );
}

export async function openNewPluginsModal() {
    const { newPlugins, newSettings } = await getNewPluginChanges();
    if ((newPlugins.size || newSettings.size) && !hasSeen) {
        hasSeen = true;
        await writeKnownSettings();
        const modalKey = openModal(modalProps => (
            <ErrorBoundary noop onError={() => closeModal(modalKey)}>
                <NewPluginsModal
                    modalProps={modalProps}
                    newPlugins={newPlugins}
                    newSettings={newSettings}
                />
            </ErrorBoundary>
        ));
    }
}
