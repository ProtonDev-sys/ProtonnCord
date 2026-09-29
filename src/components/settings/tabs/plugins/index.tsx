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

import { hasAnyVisibleSettings, isPluginEnabled, pluginRequiresRestart, stopPlugin } from "@api/PluginManager";
import { PlainSettings, useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { ChevronSmallDownIcon, MagnifyingGlassIcon, RestartIcon } from "@components/Icons";
import { SettingsTab } from "@components/settings";
import { getLoadedPluginDefinition } from "@shared/pluginDefinition";
import { ChangeList } from "@utils/ChangeList";
import { classes } from "@utils/misc";
import { useCleanupEffect } from "@utils/react";
import { PluginTag, PluginTags } from "@utils/types";
import { Alerts, ConfirmModal, openModal, Parser, React, useCallback, useMemo, useRef, useState } from "@webpack/common";
import type { PropsWithChildren } from "react";

import Plugins, { ExcludedPlugins, PluginManifest, PluginMeta } from "~plugins";

import { CatalogCard, createPluginCatalogView, PluginFilter, SearchStatus } from "./catalogView";
import { getReleaseNewPlugins } from "./newPluginRelease";
import { PluginCard } from "./PluginCard";
import { openDisableAllModal } from "./PluginModal";
import { cl, ExcludedReasons, logger, restartAfterSaving, showErrorToast } from "./shared";
import { openUIElementsModal } from "./UIElements";

export { cl, ExcludedReasons, logger, PluginDependencyList } from "./shared";

/** Cards rendered per step; the rest of a list is added in background steps instead of behind a button. */
const PAGE_SIZE = 48;
const DEFAULT_FILTER: PluginFilter = { value: "", tags: [], status: SearchStatus.ALL };

const CatalogPluginCard = React.memo(function CatalogPluginCard({ card, onRestartNeeded }: { card: CatalogCard; onRestartNeeded(name: string, key: string): void; }) {
    return <PluginCard {...card} onRestartNeeded={onRestartNeeded} />;
});

function RestartBanner({ pluginNames }: { pluginNames: string[]; }) {
    return (
        <div className={cl("restart-banner")} role="status">
            <RestartIcon width={20} height={20} className={cl("restart-icon")} />
            <div className={cl("restart-text")}>
                <span className={cl("restart-title")}>Restart required</span>
                <span className={cl("restart-detail")} title={pluginNames.join(", ")}>
                    {pluginNames.length === 1
                        ? `Changes to ${pluginNames[0]} apply after a restart.`
                        : `Changes to ${pluginNames.length} plugins apply after a restart.`}
                </span>
            </div>
            <Button size="small" onClick={restartAfterSaving}>Restart now</Button>
        </div>
    );
}

function SearchBar({ value, onChange }: { value: string; onChange(value: string): void; }) {
    const inputRef = useRef<HTMLInputElement>(null);

    return (
        <div className={cl("search")}>
            <MagnifyingGlassIcon width={18} height={18} className={cl("search-icon")} aria-hidden />
            <input
                ref={inputRef}
                className={cl("search-input")}
                type="text"
                value={value}
                onChange={e => onChange(e.currentTarget.value)}
                placeholder="Search plugins by name, description or keyword"
                aria-label="Search plugins"
                spellCheck={false}
                autoFocus
            />
            {!!value && (
                <button
                    type="button"
                    className={cl("search-clear")}
                    aria-label="Clear search"
                    onClick={() => {
                        onChange("");
                        inputRef.current?.focus();
                    }}
                >
                    <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
                        <path fill="currentColor" d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z" />
                    </svg>
                </button>
            )}
        </div>
    );
}

function Chip({ active, onClick, children, className }: PropsWithChildren<{ active: boolean; onClick(): void; className?: string; }>) {
    return (
        <button
            type="button"
            className={classes(cl("chip", { "chip-active": active }), className)}
            aria-pressed={active}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function ExcludedPluginsList({ search }: { search: string; }) {
    const matchingExcludedPlugins = search
        ? Object.entries(ExcludedPlugins).filter(([name]) => name.toLowerCase().includes(search))
        : [];

    if (!matchingExcludedPlugins.length) return null;

    return (
        <div className={cl("excluded")}>
            <span>Looking for one of these? They aren't available in this client:</span>
            <ul>
                {matchingExcludedPlugins.map(([name, reason]) => (
                    <li key={name}>
                        <b>{name}</b>: only available on the {ExcludedReasons[reason]}
                    </li>
                ))}
            </ul>
        </div>
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

    const [filter, setFilter] = useState<PluginFilter>(DEFAULT_FILTER);
    const [showTags, setShowTags] = useState(false);
    const [showRequired, setShowRequired] = useState(false);
    // Typing updates the input immediately; the list follows at a lower priority.
    const deferredFilter = React.useDeferredValue(filter);
    const [page, setPage] = useState({ filter: deferredFilter, count: PAGE_SIZE });
    const visibleCount = page.filter === deferredFilter ? page.count : PAGE_SIZE;
    const view = catalog.read(deferredFilter, newPluginsSet, visibleCount);
    const { enabledPlugins, matchingPlugins, counts } = view;
    const search = deferredFilter.value.toLowerCase();
    const isFiltering = filter.value !== "" || filter.tags.length > 0 || filter.status !== SearchStatus.ALL;

    const handleRestartNeeded = useCallback((name: string, key: string) => {
        if (key === "enabled") changes.handleChange(`${name}:${key}`);
        else changes.add(`${name}:${key}`);
    }, [changes]);
    const plugins = useMemo(() => view.cards.map(card => <CatalogPluginCard key={card.plugin.name} card={card} onRestartNeeded={handleRestartNeeded} />), [view.cards, handleRestartNeeded]);
    const requiredPlugins = useMemo(() => view.requiredCards.map(card => <CatalogPluginCard key={card.plugin.name} card={card} onRestartNeeded={handleRestartNeeded} />), [view.requiredCards, handleRestartNeeded]);

    // Fill in the remaining cards in the background so scrolling never waits on a "show more" step.
    React.useEffect(() => {
        if (visibleCount >= matchingPlugins) return;
        const timer = setTimeout(() => React.startTransition(() => setPage({ filter: deferredFilter, count: visibleCount + PAGE_SIZE })), 0);
        return () => clearTimeout(timer);
    }, [deferredFilter, visibleCount, matchingPlugins]);

    const setStatus = (status: SearchStatus) => setFilter(prev => ({ ...prev, status: prev.status === status ? SearchStatus.ALL : status }));
    const toggleTag = (tag: PluginTag) => setFilter(prev => ({
        ...prev,
        tags: prev.tags.includes(tag) ? prev.tags.filter(t => t !== tag) : [...prev.tags, tag]
    }));

    function resetCheckAndDo() {
        let restartNeeded = false;

        for (const plugin of enabledPlugins) {
            const pluginSettings = settings.plugins[plugin];
            const definition = Plugins[plugin];

            if (pluginRequiresRestart(definition)) {
                pluginSettings.enabled = false;
                handleRestartNeeded(plugin, "enabled");
                restartNeeded = true;
                continue;
            }

            const result = !definition.started || stopPlugin(definition);

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

    const statusChips: [SearchStatus, string][] = [
        [SearchStatus.ENABLED, "Enabled"],
        [SearchStatus.DISABLED, "Disabled"],
        [SearchStatus.FAVORITES, "Favorites"],
        ...newPluginsSet ? [[SearchStatus.NEW, "New"] as [SearchStatus, string]] : [],
    ];
    const sourceChips: [SearchStatus, string][] = [
        [SearchStatus.EQUICORD, "Protonn Cord"],
        [SearchStatus.VENCORD, "Vencord"],
        ...hasUserPlugins ? [[SearchStatus.USER_PLUGINS, "User plugins"] as [SearchStatus, string]] : [],
        [SearchStatus.API_PLUGINS, "APIs"],
    ];
    const totalEnabled = counts.enabledStockPlugins + counts.enabledUserPlugins;
    const totalPlugins = counts.totalStockPlugins + counts.totalUserPlugins;
    const pendingRestart = changes.hasChanges
        ? [...new Set([...changes.getChanges()].map(change => change.split(":")[0]))]
        : null;
    const requiredExpanded = showRequired || (isFiltering && !matchingPlugins && requiredPlugins.length > 0);

    return (
        <SettingsTab>
            <div className={cl("page")}>
                <div className={cl("toolbar")}>
                    {pendingRestart && <RestartBanner pluginNames={pendingRestart} />}

                    <SearchBar value={filter.value} onChange={value => setFilter(prev => ({ ...prev, value }))} />

                    <div className={cl("chips")} role="group" aria-label="Filter plugins">
                        <Chip active={filter.status === SearchStatus.ALL} onClick={() => setStatus(SearchStatus.ALL)}>All</Chip>
                        {statusChips.map(([status, label]) => (
                            <Chip key={status} active={filter.status === status} onClick={() => setStatus(status)}>{label}</Chip>
                        ))}
                        <span className={cl("chip-separator")} aria-hidden="true" />
                        {sourceChips.map(([status, label]) => (
                            <Chip key={status} active={filter.status === status} onClick={() => setStatus(status)}>{label}</Chip>
                        ))}
                        <span className={cl("chip-separator")} aria-hidden="true" />
                        <Chip active={showTags || filter.tags.length > 0} onClick={() => setShowTags(v => !v)} className={cl("tags-toggle")}>
                            Tags{filter.tags.length > 0 && <span className={cl("chip-count")}>{filter.tags.length}</span>}
                            <ChevronSmallDownIcon width={16} height={16} className={cl("chevron", { "chevron-open": showTags })} aria-hidden />
                        </Chip>
                    </div>

                    {showTags && (
                        <div className={cl("chips", "tag-chips")} role="group" aria-label="Filter by tag">
                            {PluginTags.map(tag => (
                                <Chip key={tag} active={filter.tags.includes(tag)} onClick={() => toggleTag(tag)}>{tag}</Chip>
                            ))}
                        </div>
                    )}
                </div>

                <div className={cl("summary")}>
                    <span className={cl("summary-text")} aria-live="polite">
                        {isFiltering
                            ? <><strong>{matchingPlugins}</strong> matching {matchingPlugins === 1 ? "plugin" : "plugins"}</>
                            : <><strong>{totalEnabled}</strong> of {totalPlugins} plugins enabled</>}
                    </span>
                    {isFiltering && (
                        <button type="button" className={cl("text-button")} onClick={() => setFilter(DEFAULT_FILTER)}>
                            Clear filters
                        </button>
                    )}
                    <div className={cl("summary-actions")}>
                        <Button size="small" variant="secondary" onClick={openUIElementsModal}>
                            Chat & message buttons
                        </Button>
                        {enabledPlugins.length > 0 && (
                            <Button size="small" variant="dangerSecondary" onClick={() => openDisableAllModal(enabledPlugins.length, resetCheckAndDo)}>
                                Disable all
                            </Button>
                        )}
                    </div>
                </div>

                <ErrorBoundary noop>
                    {plugins.length > 0
                        ? <div className={cl("grid")}>{plugins}</div>
                        : (
                            <div className={cl("empty")}>
                                <span className={cl("empty-title")}>No plugins match your filters</span>
                                {isFiltering && (
                                    <button type="button" className={cl("text-button")} onClick={() => setFilter(DEFAULT_FILTER)}>
                                        Clear filters
                                    </button>
                                )}
                                <ExcludedPluginsList search={search} />
                            </div>
                        )
                    }
                </ErrorBoundary>

                {requiredPlugins.length > 0 && (
                    <section className={cl("required")}>
                        <button
                            type="button"
                            className={cl("section-toggle")}
                            aria-expanded={requiredExpanded}
                            onClick={() => setShowRequired(!requiredExpanded)}
                        >
                            <ChevronSmallDownIcon width={20} height={20} className={cl("chevron", { "chevron-open": requiredExpanded })} aria-hidden />
                            <span className={cl("section-title")}>Required plugins</span>
                            <span className={cl("section-count")}>{requiredPlugins.length}</span>
                            <span className={cl("section-hint")}>Always on, or needed by plugins you enabled</span>
                        </button>
                        {requiredExpanded && <div className={cl("grid")}>{requiredPlugins}</div>}
                    </section>
                )}
            </div>
        </SettingsTab>
    );
}
