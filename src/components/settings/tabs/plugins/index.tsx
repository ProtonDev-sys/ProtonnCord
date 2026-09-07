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

import "./styles.css";

import { hasAnyVisibleSettings, isPluginEnabled, stopPlugin } from "@api/PluginManager";
import { PlainSettings, useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Divider } from "@components/Divider";
import ErrorBoundary from "@components/ErrorBoundary";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab } from "@components/settings";
import { getLoadedPluginDefinition } from "@shared/pluginDefinition";
import { ChangeList } from "@utils/ChangeList";
import { isTruthy } from "@utils/guards";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { reload } from "@utils/native";
import { useCleanupEffect, useIntersection } from "@utils/react";
import { PluginTags } from "@utils/types";
import { Alerts, ConfirmModal, openModal, Parser, React, SearchableSelect, Select, TextInput, Toasts, Tooltip, useCallback, useMemo, useRef, useState } from "@webpack/common";

import Plugins, { ExcludedPlugins, PluginManifest, PluginMeta } from "~plugins";

import { CatalogCard, createPluginCatalogView, PluginFilter, SearchStatus } from "./catalogView";
import { getReleaseNewPlugins } from "./newPluginRelease";
import { PluginCard } from "./PluginCard";
import { openWarningModal } from "./PluginModal";
import { StockPluginsCard, UserPluginsCard } from "./PluginStatCards";
import { cl, ExcludedReasons, logger, PluginDependencyList } from "./shared";
import { UIElementsButton } from "./UIElements";

export { cl, ExcludedReasons, logger, PluginDependencyList } from "./shared";

function showErrorToast(message: string) {
    Toasts.show({
        message,
        type: Toasts.Type.FAILURE,
        id: Toasts.genId(),
        options: {
            position: Toasts.Position.BOTTOM
        }
    });
}

async function restartAfterSaving() {
    try {
        await reload();
    } catch (error) {
        logger.error("Cannot restart before saving settings", error);
        showErrorToast("Your settings could not be saved. Try again before restarting.");
    }
}

function ReloadRequiredCard({ required, enabledPlugins, openWarningModal, resetCheckAndDo }) {
    return (
        <Card className={classes(cl("info-card"), required && "vc-warning-card")}>
            {required ? (
                <>
                    <HeadingTertiary>Restart required!</HeadingTertiary>
                    <Paragraph className={cl("dep-text")}>
                        Restart now to apply new plugins and their settings
                    </Paragraph>
                    <Button variant="primary" className={cl("restart-button")} onClick={restartAfterSaving}>
                        Restart
                    </Button>
                </>
            ) : (
                <>
                    <HeadingTertiary>Plugin Management</HeadingTertiary>
                    <Paragraph>Press the cog wheel or info icon to get more info on a plugin</Paragraph>
                    <Paragraph>Plugins with a cog wheel have settings you can modify!</Paragraph>
                </>
            )}
            {enabledPlugins.length > 0 && !required && (
                <Button
                    variant="secondary"
                    size="small"
                    className={"vc-plugins-disable-warning vc-modal-align-reset"}
                    onClick={() => {
                        return openWarningModal(null, undefined, false, enabledPlugins.length, resetCheckAndDo);
                    }}
                >
                    Disable All Plugins
                </Button>
            )}
        </Card>
    );
}

const PAGE_SIZE = 36;

const CatalogPluginCard = React.memo(function CatalogPluginCard({ card, onRestartNeeded }: { card: CatalogCard; onRestartNeeded(name: string, key: string): void; }) {
    if (!card.disabled) return <PluginCard {...card} onRestartNeeded={onRestartNeeded} />;

    const tooltip = card.requiredBy
        ? <PluginDependencyList deps={card.requiredBy} />
        : "This plugin is required for Protonn Cord to function.";
    return (
        <Tooltip text={tooltip}>
            {({ onMouseLeave, onMouseEnter }) => (
                <PluginCard {...card} onRestartNeeded={onRestartNeeded} onMouseLeave={onMouseLeave} onMouseEnter={onMouseEnter} />
            )}
        </Tooltip>
    );
});

function ExcludedPluginsList({ search }: { search: string; }) {
    const matchingExcludedPlugins = search
        ? Object.entries(ExcludedPlugins)
            .filter(([name]) => name.toLowerCase().includes(search))
        : [];

    return (
        <Paragraph className={Margins.top16}>
            {matchingExcludedPlugins.length
                ? <>
                    <Paragraph>Are you looking for:</Paragraph>
                    <ul>
                        {matchingExcludedPlugins.map(([name, reason]) => (
                            <li key={name}>
                                <b>{name}</b>: Only available on the {ExcludedReasons[reason]}
                            </li>
                        ))}
                    </ul>
                </>
                : "No plugins meet the search criteria."
            }
        </Paragraph>
    );
}

export default function PluginSettings() {
    const settings = useSettings();
    const changeRef = useRef<ChangeList<string>>(null);
    const changes = changeRef.current ??= new ChangeList<string>();

    useCleanupEffect(() => {
        return () => {
            if (!changes.hasChanges) return;

            const allChanges = [...changes.getChanges()];
            const pluginNames = [...new Set(allChanges.map(s => s.split(":")[0]))];
            const maxDisplay = 15;
            const displayed = pluginNames.slice(0, maxDisplay);
            const remainingCount = pluginNames.length - displayed.length;

            openModal(props => (
                <ConfirmModal
                    {...props}
                    title="Restart required"
                    confirmText="Restart now"
                    cancelText="Later!"
                    variant="primary"
                    onConfirm={restartAfterSaving}
                >
                    <>
                        <p>The following plugins require a restart:</p>
                        <div>
                            {displayed.map((s, i) => (
                                <React.Fragment key={i}>
                                    {i > 0 && ", "}
                                    {Parser.parse("`" + s + "`")}
                                </React.Fragment>
                            ))}
                            {remainingCount > 0 && <span> and {remainingCount} more</span>}
                        </div>
                    </>
                </ConfirmModal>
            ));
        };
    }, []);

    const catalog = useMemo(() => createPluginCatalogView({
        plugins: PluginManifest,
        metadata: PluginMeta,
        isEnabled: isPluginEnabled,
        isDependency: name => getLoadedPluginDefinition(name)?.isDependency ?? false,
        getSettings: name => PlainSettings.plugins[name],
        hasVisibleSettings: name => hasAnyVisibleSettings(Plugins[name])
    }), []);
    const hasUserPlugins = useMemo(() => !IS_STANDALONE && Object.values(PluginMeta).some(m => m.userPlugin), []);
    const newPluginsSet = useMemo(() => getReleaseNewPlugins(VERSION, Object.keys(PluginManifest)), []);
    const [searchValue, setSearchValue] = useState<PluginFilter>({ value: "", tags: [], status: SearchStatus.ALL });
    const [page, setPage] = useState({ filter: searchValue, count: PAGE_SIZE });
    const visibleCount = page.filter === searchValue ? page.count : PAGE_SIZE;
    const view = catalog.read(searchValue, newPluginsSet, visibleCount);
    const { enabledPlugins, matchingPlugins, counts: { totalStockPlugins, totalUserPlugins, enabledStockPlugins, enabledUserPlugins } } = view;
    const search = searchValue.value.toLowerCase();
    const onSearch = (query: string) => setSearchValue(prev => ({ ...prev, value: query }));
    const handleRestartNeeded = useCallback((name: string, key: string) => changes.handleChange(`${name}:${key}`), [changes]);
    const plugins = useMemo(() => view.cards.map(card => <CatalogPluginCard key={card.plugin.name} card={card} onRestartNeeded={handleRestartNeeded} />), [view.cards, handleRestartNeeded]);
    const requiredPlugins = useMemo(() => view.requiredCards.map(card => <CatalogPluginCard key={card.plugin.name} card={card} onRestartNeeded={handleRestartNeeded} />), [view.requiredCards, handleRestartNeeded]);

    function resetCheckAndDo() {
        let restartNeeded = false;

        for (const plugin of enabledPlugins) {
            const pluginSettings = settings.plugins[plugin];

            if (Plugins[plugin].patches?.length) {
                pluginSettings.enabled = false;
                changes.handleChange(plugin);
                restartNeeded = true;
                continue;
            }

            const result = stopPlugin(Plugins[plugin]);

            if (!result) {
                logger.error(`Error while stopping plugin ${plugin}`);
                showErrorToast(`Error while stopping plugin ${plugin}`);
                continue;
            }

            pluginSettings.enabled = false;
        }

        if (restartNeeded) {
            Alerts.show({
                title: "Restart Required",
                body: (
                    <>
                        <p style={{ textAlign: "center" }}>Some plugins require a restart to fully disable.</p>
                        <p style={{ textAlign: "center" }}>Would you like to restart now?</p>
                    </>
                ),
                confirmText: "Restart Now",
                cancelText: "Later",
                onConfirm: restartAfterSaving
            });
        }
    }

    const showMore = useCallback(() => setPage({ filter: searchValue, count: Math.min(visibleCount + PAGE_SIZE, matchingPlugins) }), [searchValue, visibleCount, matchingPlugins]);
    const [sentinelRef, isSentinelVisible] = useIntersection();
    React.useEffect(() => {
        if (isSentinelVisible && visibleCount < matchingPlugins) {
            const timeout = setTimeout(showMore, 100);
            return () => clearTimeout(timeout);
        }
    }, [isSentinelVisible, visibleCount, matchingPlugins, showMore]);

    return (
        <SettingsTab>
            <ReloadRequiredCard required={changes.hasChanges} enabledPlugins={enabledPlugins} openWarningModal={openWarningModal} resetCheckAndDo={resetCheckAndDo} />

            <div className={cl("stats-container")}>
                <StockPluginsCard
                    totalStockPlugins={totalStockPlugins}
                    enabledStockPlugins={enabledStockPlugins}
                />
                <UserPluginsCard
                    totalUserPlugins={totalUserPlugins}
                    enabledUserPlugins={enabledUserPlugins}
                />
            </div>

            <div className={cl("ui-elements")}>
                <UIElementsButton />
            </div>

            <HeadingTertiary className={classes(Margins.top20, Margins.bottom8)}>
                Filters
            </HeadingTertiary>

            <ErrorBoundary noop>
                <TextInput
                    inputClassName={cl("filter-control")}
                    placeholder="Search for a plugin..."
                    value={searchValue.value}
                    onChange={onSearch}
                    autoFocus
                />
            </ErrorBoundary>

            <ErrorBoundary noop>
                <div className={classes(Margins.bottom20, Margins.top8, cl("filter-controls"))}>
                    <Select
                        options={[
                            { label: "Show All", value: SearchStatus.ALL, default: true },
                            { label: "Show Favorites", value: SearchStatus.FAVORITES },
                            { label: "Show Enabled", value: SearchStatus.ENABLED },
                            { label: "Show Disabled", value: SearchStatus.DISABLED },
                            { label: "Show Protonn Cord", value: SearchStatus.EQUICORD },
                            { label: "Show Vencord", value: SearchStatus.VENCORD },
                            { label: "Show New", value: SearchStatus.NEW },
                            hasUserPlugins && { label: "Show UserPlugins", value: SearchStatus.USER_PLUGINS },
                            { label: "Show API Plugins", value: SearchStatus.API_PLUGINS },
                        ].filter(isTruthy)}
                        serialize={String}
                        select={status => setSearchValue(prev => ({ ...prev, status }))}
                        isSelected={v => v === searchValue.status}
                        closeOnSelect={true}
                        placeholder="Filter by Type"
                    />
                    <SearchableSelect
                        options={PluginTags.map(tag => ({ label: tag, value: tag }))}
                        value={searchValue.tags}
                        onChange={tags => setSearchValue(prev => ({ ...prev, tags }))}
                        closeOnSelect={false}
                        placeholder="Filter by Tags"
                        multi
                    />
                </div>
            </ErrorBoundary>

            <HeadingTertiary className={Margins.top20}>Plugins</HeadingTertiary>
            <Paragraph aria-live="polite">{matchingPlugins} matching plugins{requiredPlugins.length ? ` and ${requiredPlugins.length} required` : ""}</Paragraph>

            {plugins.length || requiredPlugins.length
                ? (
                    <>
                        <div className={cl("grid")}>
                            {plugins.length
                                ? plugins
                                : <Paragraph>No plugins meet the search criteria.</Paragraph>
                            }
                        </div>
                        {visibleCount < matchingPlugins && (
                            <div ref={sentinelRef} className={Margins.top16}>
                                <Button variant="secondary" onClick={showMore}>Show more plugins ({plugins.length} of {matchingPlugins})</Button>
                            </div>
                        )}
                    </>
                )
                : <ExcludedPluginsList search={search} />
            }

            <Divider className={Margins.top20} />

            <HeadingTertiary className={classes(Margins.top20, Margins.bottom8)}>
                Required Plugins
            </HeadingTertiary>

            <div className={cl("grid")}>
                {requiredPlugins.length
                    ? requiredPlugins
                    : <Paragraph>No plugins meet the search criteria.</Paragraph>
                }
            </div>
        </SettingsTab >
    );
}
