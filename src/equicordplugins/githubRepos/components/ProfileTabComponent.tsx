/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { fetchOrgRepos, fetchReposByUserId, fetchReposByUsername, fetchUserInfo, fetchUserOrgs } from "@equicordplugins/githubRepos/githubApi";
import { GitHubRepo, RepoGroup, RepoSortMode } from "@equicordplugins/githubRepos/types";
import { buildRepoGroups, PERSONAL_GROUP_KEY, sortGroups } from "@equicordplugins/githubRepos/utils";
import { React, useEffect, UserProfileStore, useState, useStateFromStores } from "@webpack/common";

import { cl, settings } from "..";
import { RepoCard } from "./RepoCard";
import { RepoSubTabs } from "./RepoSubTabs";

export function ProfileTabComponent({ id }: { id: string, theme: string; }) {
    const githubConnection = useStateFromStores([UserProfileStore], () => UserProfileStore.getUserProfile(id)?.connectedAccounts?.find(conn => conn.type === "github"), [id]);
    const { showStars, showLanguage } = settings.use(["showStars", "showLanguage"]);
    const [groups, setGroups] = useState<RepoGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeKey, setActiveKey] = useState<string>(PERSONAL_GROUP_KEY);
    const [sortMode, setSortMode] = useState<RepoSortMode>("count");

    const sortedGroups = sortGroups(groups, sortMode);
    const activeGroup = sortedGroups.find(g => g.key === activeKey) ?? sortedGroups[0];

    useEffect(() => {
        let active = true;
        setLoading(true);
        setError(null);
        setGroups([]);
        const fetchData = async () => {
            try {
                if (!githubConnection) {
                    setLoading(false);
                    return;
                }

                const username = githubConnection.name;
                const userInfoData = await fetchUserInfo(username);
                if (!active) return;
                const githubId = githubConnection.id;

                // Try to fetch by ID first, fall back to username
                let personalRepos: GitHubRepo[] | null = await fetchReposByUserId(githubId);
                if (!active) return;
                if (!personalRepos) personalRepos = await fetchReposByUsername(username);
                if (!active) return;

                const orgs = await fetchUserOrgs(username);
                if (!active) return;
                const orgReposEntries = await Promise.all(orgs.map(async org => [org.login, await fetchOrgRepos(org.login)]));
                if (!active) return;
                const orgRepos = Object.fromEntries(orgReposEntries);

                const builtGroups = buildRepoGroups(userInfoData?.username ?? username, personalRepos ?? [], orgs, orgRepos, userInfoData?.avatarUrl);
                setGroups(builtGroups);
                setActiveKey(builtGroups[0]?.key ?? PERSONAL_GROUP_KEY);
                setLoading(false);
            } catch (error) {
                if (!active) return;
                const errorMessage = error instanceof Error ? error.message : "Failed to fetch repositories";
                setError(errorMessage);
                setLoading(false);
            }
        };

        fetchData();
        return () => { active = false; };
    }, [id, githubConnection?.id, githubConnection?.name]);

    if (loading) return <BaseText size="xs" weight="semibold" className={cl("loading")} >
        Loading repositories...
    </BaseText>;

    if (error) return <BaseText size="xs" weight="semibold" className={cl("error")}>
        Error: {error}
    </BaseText>;

    if (!groups.length) return null;

    return (
        <div className={cl("container", "tab")}>
            <RepoSubTabs
                groups={sortedGroups}
                activeKey={activeGroup?.key ?? PERSONAL_GROUP_KEY}
                onSelect={setActiveKey}
                sortMode={sortMode}
                onToggleSort={() => setSortMode(mode => mode === "count" ? "alpha" : "count")}
                canSort={sortedGroups.length > 2}
            />
            <div className={cl("list")}>
                {activeGroup?.repos.map(repo => (
                    <RepoCard
                        key={repo.id}
                        repo={repo}
                        showStars={showStars}
                        showLanguage={showLanguage}
                    />))
                }
            </div>
        </div>
    );
}
