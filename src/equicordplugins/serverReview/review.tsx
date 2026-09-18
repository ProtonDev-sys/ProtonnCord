/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import type { Guild, RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { closeModal, GuildStore, IconUtils, Modal, NavigationRouter, openModal, React, TextInput, useEffect, useRef, UserSettingsActionCreators, UserStore, useState, useStateFromStores } from "@webpack/common";

import { moveToFolder, ProtoFolder, withGuildIds } from "./folders";
import { ActivityHistory, activityKinds, DAY, GuildActivity, lastActivity, ReviewGroup,reviewGroup } from "./history";
import { settings } from "./settings";
import { changed, getHistory, getRevision, isCurrent, mark, markSelected, retry, SortedGuildStore, subscribe } from "./tracking";

const GuildActions = findByPropsLazy("leaveGuild");
const UserSettingsDelay = findByPropsLazy("INFREQUENT_USER_ACTION");
let modalKey: string | undefined;

const labels: Record<ReviewGroup, string> = {
    unused: "Unused",
    resources: "Emotes and sounds only",
    kept: "Kept",
    recent: "Recent / still tracking"
};
const activityLabels = { visit: "Opened", emoji: "Emoji", sticker: "Sticker", sound: "Soundboard" };

function dateLabel(timestamp: number) {
    return new Date(timestamp).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

async function moveServers(history: ActivityHistory, ids: string[], name: string) {
    if (!isCurrent(history)) throw new Error("The account changed. Reopen Server Review.");
    const actions = UserSettingsActionCreators.PreloadedUserSettingsActionCreators;
    const folderSettings = actions.ProtoClass.fields.find(field => field.localName === "guildFolders")?.T();
    const folderType = folderSettings?.fields.find(field => field.localName === "folders")?.T();
    if (!folderType?.fromJson) throw new Error("Discord's folder controls are unavailable. No servers were moved.");

    await actions.updateAsync("guildFolders", (value: { folders: ProtoFolder[]; }) => {
        if (!isCurrent(history)) throw new Error("The account changed. No servers were moved.");
        if (!Array.isArray(value.folders)) throw new Error("Discord's folder controls are unavailable.");
        const selected = ids.filter(id => GuildStore.getGuild(id));
        if (!selected.length) return false;
        const matching = value.folders.filter(folder => folder.id && folder.name?.value === name);
        if (matching.length > 1) throw new Error("More than one folder has this name. Choose a different folder name in Server Review settings.");
        const existing = matching[0];
        let id: string;
        if (existing) id = String(existing.id!.value);
        else {
            do { id = String(crypto.getRandomValues(new Uint32Array(1))[0]); }
            while (id === "0" || value.folders.some(folder => String(folder.id?.value) === id));
        }
        // Let Discord's protobuf implementation supply the right uint64 representation.
        const created: ProtoFolder = folderType.fromJson({ id, name, guildIds: selected });
        const destination = existing ? withGuildIds(existing,
            [...existing.guildIds, ...created.guildIds.filter(id => !existing.guildIds.some(old => String(old) === String(id)))]) : created;
        value.folders = moveToFolder(value.folders, selected, destination);
    }, UserSettingsDelay.INFREQUENT_USER_ACTION);
}

function ActivityDetail({ record }: { record: GuildActivity; }) {
    const recorded = activityKinds.filter(kind => record[kind]);
    return <BaseText size="xs" color="text-muted">
        {recorded.length
            ? recorded.map(kind => `${activityLabels[kind]} ${dateLabel(record[kind]!)}`).join(" · ")
            : `No activity recorded since ${dateLabel(record.since)}`}
    </BaseText>;
}

function ReviewModal(props: RenderModalProps) {
    React.useSyncExternalStore(subscribe, getRevision);
    const { days, folderName } = settings.use(["days", "folderName"]);
    const [history] = useState(getHistory);
    const guilds = useStateFromStores([GuildStore], () => Object.values(GuildStore.getGuilds()));
    const organized = useStateFromStores([SortedGuildStore], () => new Set<string>(SortedGuildStore.getGuildFolders()
        .filter(folder => folder.folderName === folderName.trim()).flatMap(folder => folder.guildIds)));
    const [group, setGroup] = useState<ReviewGroup>("unused");
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(0);
    const [leaveId, setLeaveId] = useState<string>();
    const [folderIds, setFolderIds] = useState<string[]>();
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [moved, setMoved] = useState<string[]>([]);
    const [left, setLeft] = useState<string[]>([]);
    const mounted = useRef(true);
    const confirmation = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!history || !isCurrent(history)) props.onClose();
    });
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    useEffect(() => { confirmation.current?.focus(); }, [leaveId, folderIds]);
    useEffect(() => { setPage(0); }, [group, query, days]);

    if (!history || !isCurrent(history)) return null;
    const now = Date.now();
    const lists: Record<ReviewGroup, Guild[]> = { unused: [], resources: [], kept: [], recent: [] };
    for (const guild of guilds) {
        if (left.includes(guild.id)) continue;
        const record = history.data.guilds[guild.id];
        if (record) lists[reviewGroup(record, days, now)].push(guild);
    }
    const rows = lists[group].filter(guild => guild.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .sort((a, b) => lastActivity(history.data.guilds[a.id]) - lastActivity(history.data.guilds[b.id]) || a.name.localeCompare(b.name));
    const toOrganize = rows.filter(guild => !organized.has(guild.id) && !moved.includes(guild.id));
    const lastPage = Math.max(0, Math.ceil(rows.length / 25) - 1);
    const currentPage = Math.min(page, lastPage);
    const leaveGuild = guilds.find(guild => guild.id === leaveId);
    const folderGuilds = folderIds?.map(id => guilds.find(guild => guild.id === id)).filter((guild): guild is Guild => !!guild);

    async function leave(guild: Guild) {
        if (!history || busy || !isCurrent(history)) return;
        setBusy(true);
        setNotice("");
        try {
            if (!GuildStore.getGuild(guild.id)) throw new Error("You are no longer in this server.");
            if (GuildStore.getGuild(guild.id).ownerId === UserStore.getCurrentUser()?.id)
                throw new Error("Transfer ownership in Server Settings before leaving this server.");
            await GuildActions.leaveGuild(guild.id);
            if (!isCurrent(history)) return;
            history.remove(guild.id);
            changed(true);
            if (!mounted.current) return;
            setLeft(previous => [...previous, guild.id]);
            setLeaveId(undefined);
            setNotice(`Left ${guild.name}.`);
        } catch {
            if (mounted.current && isCurrent(history)) setNotice("Could not leave this server. Check your connection and try again.");
        } finally {
            if (mounted.current && isCurrent(history)) setBusy(false);
        }
    }

    async function move() {
        if (!history || !folderIds || busy || !isCurrent(history)) return;
        setBusy(true);
        setNotice("");
        try {
            await moveServers(history, folderIds, folderName.trim());
            if (!mounted.current || !isCurrent(history)) return;
            setMoved(previous => [...new Set([...previous, ...folderIds])]);
            setFolderIds(undefined);
            setNotice(`Moved to ${folderName}.`);
        } catch (error) {
            if (mounted.current && isCurrent(history)) setNotice(error instanceof Error ? error.message : "Could not move these servers. Try again.");
        } finally {
            if (mounted.current && isCurrent(history)) setBusy(false);
        }
    }

    return <Modal {...props} size="lg" title="Server Review" subtitle={`Review period: ${days} days`}>
        <div className="pc-server-review">
            <Paragraph color="text-muted">Activity is recorded on this client while the plugin is enabled. Tracking starts when a server is first seen; earlier activity and use on other devices aren't available.</Paragraph>
            {history.error && <div role="alert"><Paragraph>{history.error}</Paragraph><Button variant="secondary" onClick={() => void retry()}>Retry</Button></div>}
            {!history.ready ? <Paragraph>{history.error ? "Review is unavailable until your saved activity can be loaded." : "Loading server activity…"}</Paragraph> : <>
                <div className="pc-server-review-tabs" role="tablist" aria-label="Server activity">
                    {(Object.keys(labels) as ReviewGroup[]).map(key => <Button key={key} role="tab" aria-selected={group === key} aria-controls="pc-server-review-list" id={`pc-server-review-tab-${key}`} variant={group === key ? "primary" : "secondary"} size="small" onClick={() => { setGroup(key); setLeaveId(undefined); setFolderIds(undefined); }} disabled={busy}>
                        {labels[key]} ({lists[key].length})
                    </Button>)}
                </div>
                <TextInput value={query} onChange={setQuery} placeholder="Find a server" aria-label="Find a server" />
                <Paragraph color="text-muted">
                    {group === "unused" && "No visits, emojis, stickers, or soundboard use during this period."}
                    {group === "resources" && `You still use these servers' emojis, stickers, or sounds. Keep them together in “${folderName}”.`}
                    {group === "kept" && "These servers won't appear in reminders. Remove Keep to include them again."}
                    {group === "recent" && "Recently opened servers and servers that haven't been tracked for the full review period yet."}
                </Paragraph>
                {group === "resources" && toOrganize.length > 0 && <Button variant="secondary" disabled={busy} onClick={() => { setFolderIds(toOrganize.map(guild => guild.id)); setLeaveId(undefined); }}>Move {toOrganize.length} listed servers to folder…</Button>}
                {notice && <Paragraph role="status">{notice}</Paragraph>}
                {leaveGuild && <div className="pc-server-review-confirm" ref={confirmation} tabIndex={-1} role="group" aria-label="Confirm leaving server">
                    <Paragraph>Leave <strong>{leaveGuild.name}</strong>? You'll lose access to its channels, emojis, stickers, and sounds. You'll need an invite to rejoin.</Paragraph>
                    <div className="pc-server-review-actions">
                        <Button variant="dangerPrimary" disabled={busy} onClick={() => void leave(leaveGuild)}>{busy ? "Leaving…" : "Leave server"}</Button>
                        <Button variant="secondary" disabled={busy} onClick={() => setLeaveId(undefined)}>Cancel</Button>
                    </div>
                </div>}
                {folderGuilds && <div className="pc-server-review-confirm" ref={confirmation} tabIndex={-1} role="group" aria-label="Confirm folder move">
                    <Paragraph>Move {folderGuilds.length} {folderGuilds.length === 1 ? "server" : "servers"} to <strong>{folderName}</strong>? They'll be removed from their current folders.</Paragraph>
                    <Paragraph className="pc-server-review-names">{folderGuilds.map(guild => guild.name).join(", ")}</Paragraph>
                    <div className="pc-server-review-actions">
                        <Button disabled={busy} onClick={() => void move()}>{busy ? "Moving…" : "Move to folder"}</Button>
                        <Button variant="secondary" disabled={busy} onClick={() => setFolderIds(undefined)}>Cancel</Button>
                    </div>
                </div>}
                <div id="pc-server-review-list" role="tabpanel" aria-labelledby={`pc-server-review-tab-${group}`}>
                    {!rows.length && <Paragraph>{query ? "No servers match this search." : "No servers in this list."}</Paragraph>}
                    {rows.slice(currentPage * 25, (currentPage + 1) * 25).map(guild => {
                        const record = history.data.guilds[guild.id];
                        const owned = guild.ownerId === UserStore.getCurrentUser()?.id;
                        return <div key={guild.id} className="pc-server-review-row">
                            {guild.icon && <img alt="" width={32} height={32} loading="lazy" src={IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 32, canAnimate: false })} />}
                            <div className="pc-server-review-info">
                                <BaseText weight="semibold">{guild.name}</BaseText>
                                <ActivityDetail record={record} />
                                {owned && <BaseText size="xs" color="text-muted">You own this server</BaseText>}
                            </div>
                            <div className="pc-server-review-actions">
                                <Button size="small" variant="secondary" disabled={busy} onClick={() => { mark(guild.id); NavigationRouter.transitionToGuild(guild.id); props.onClose(); }}>Open</Button>
                                <Button size="small" variant="secondary" disabled={busy} onClick={() => { history.keep(guild.id, !record.keep, now); changed(true); }}>{record.keep ? "Remove Keep" : "Keep"}</Button>
                                {group === "resources" && <Button size="small" variant="secondary" disabled={busy || moved.includes(guild.id) || organized.has(guild.id)} onClick={() => { setFolderIds([guild.id]); setLeaveId(undefined); }}>{organized.has(guild.id) || moved.includes(guild.id) ? "In folder" : "Folder…"}</Button>}
                                <Button size="small" variant="dangerSecondary" disabled={busy || owned} title={owned ? "Transfer ownership in Server Settings before leaving." : `Leave ${guild.name}`} onClick={() => { setLeaveId(guild.id); setFolderIds(undefined); setNotice(""); }}>Leave…</Button>
                            </div>
                        </div>;
                    })}
                </div>
                {lastPage > 0 && <div className="pc-server-review-actions">
                    <Button size="small" variant="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
                    <BaseText size="sm">Page {currentPage + 1} of {lastPage + 1}</BaseText>
                    <Button size="small" variant="secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next</Button>
                </div>}
                <div className="pc-server-review-actions">
                    <Button variant="secondary" disabled={busy} onClick={() => { history.snooze(Date.now() + 30 * DAY); changed(true); props.onClose(); }}>Remind me in 30 days</Button>
                    <Button variant="secondary" disabled={busy} onClick={props.onClose}>Done</Button>
                </div>
            </>}
        </div>
    </Modal>;
}

export function openReview() {
    if (modalKey || !getHistory()) return;
    markSelected();
    modalKey = openModal(props => <ReviewModal {...props} />, { onCloseCallback: () => { modalKey = undefined; } });
}

export function closeReview() {
    if (modalKey) closeModal(modalKey);
    modalKey = undefined;
}
