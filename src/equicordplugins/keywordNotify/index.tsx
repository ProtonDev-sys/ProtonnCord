/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated, camila314, and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { DoubleCheckmarkIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { classes, isObject } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Message, MessageJSON, ScrollerBaseRef } from "@vencord/discord-types";
import { findByCodeLazy, findCssClassesLazy } from "@webpack";
import {
    ChannelStore,
    FluxDispatcher,
    ScrollerThin,
    TabBar,
    Tooltip,
    useEffect,
    useRef,
    UserStore,
    useState
} from "@webpack/common";
import type { JSX, RefObject } from "react";

import { KeywordEntries } from "./components/KeywordEntries";

interface KeywordEntry {
    regex: string;
    listIds?: string[];
    listType?: ListType;
    ignoreCase: boolean;
    ignoreBots?: boolean;
    whitelist: string[];
    blacklist: string[];
    listPriority: ListType;
}

type KeywordMessage = Omit<MessageJSON, "mentions" | "author"> & {
    mentions: { id: string; }[];
    author: MessageJSON["author"] & { bot?: boolean; };
};

function isKeywordEntry(value: unknown): value is KeywordEntry {
    if (!isObject(value)) return false;
    const entry = value as Partial<KeywordEntry>;
    return typeof entry.regex === "string" && [entry.whitelist, entry.blacklist, entry.listIds]
        .every(ids => ids == null || (Array.isArray(ids) && ids.every(id => typeof id === "string")));
}

export let keywordEntries: Array<KeywordEntry> = [];
let keywordLog: Array<Message> = [];
let storedKeywordLog: string[] = [];
const storedKeywordLogIds = new Set<string>();
let keywordLogWrite = Promise.resolve();
let keywordEntriesWrite = Promise.resolve();
let startGeneration = 0;
const regexCache = new Map<string, RegExp | null>();
let interceptor: (e: any) => void;

interface ScrollerContext {
    id: string;
    onKeyDown: () => void;
    orientation: string;
    ref: RefObject<unknown>;
    tabIndex: number;
}

interface ScrollerOpts {
    role: string;
    tabIndex: ScrollerContext["tabIndex"];
    "data-list-id": ScrollerContext["id"];
    onKeyDown: ScrollerContext["onKeyDown"];
    ref: ScrollerContext["ref"];
    "aria-orientation": ScrollerContext["orientation"];
}

const scrollerClass = findCssClassesLazy("singleMessage", "scroller");
const tabClass = findCssClassesLazy("inboxTitle", "tab");

const PopoutContainer = findByCodeLazy("navigator", "Provider");
const getMessageScrollerOptions: () => ScrollerOpts = findByCodeLazy("onKeyDown", "tabIndex", "useContext", "aria-orientation");
const createNavigator = findByCodeLazy("keyboardModeEnabled)", "scrollIntoViewNode");
const createMessageRecord = findByCodeLazy(".createFromServer(", ".isBlockedForMessage", "messageReference:");
export const KEYWORD_ENTRIES_KEY = "KeywordNotify_keywordEntries";
const KEYWORD_LOG_KEY = "KeywordNotify_log";

function storedMessageId(serialized: string): string | null {
    try {
        const id = JSON.parse(serialized)?.id;
        return typeof id === "string" ? id : null;
    } catch {
        return null;
    }
}

function trimStoredKeywordLog() {
    const amountToKeep = getAmountToKeep();
    while (storedKeywordLog.length > amountToKeep) {
        const removed = storedKeywordLog.shift();
        if (removed) {
            const id = storedMessageId(removed);
            if (id) storedKeywordLogIds.delete(id);
        }
    }
}

function getAmountToKeep() {
    const amount = settings.store.amountToKeep;
    return Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 50;
}

export function persistKeywordEntries() {
    const snapshot = structuredClone(keywordEntries);
    keywordEntriesWrite = keywordEntriesWrite.catch(() => undefined).then(() => DataStore.set(KEYWORD_ENTRIES_KEY, snapshot));
    return keywordEntriesWrite;
}

function persistKeywordLog() {
    const snapshot = [...storedKeywordLog];
    keywordLogWrite = keywordLogWrite.then(
        () => DataStore.set(KEYWORD_LOG_KEY, snapshot),
        () => DataStore.set(KEYWORD_LOG_KEY, snapshot),
    );
    return keywordLogWrite;
}

export const cl = classNameFactory("vc-keywordnotify-");

export async function addKeywordEntry(forceUpdate: () => void) {
    keywordEntries.push({
        regex: "",
        ignoreCase: false,
        ignoreBots: true,
        whitelist: [],
        blacklist: [],
        listPriority: ListType.BlackList,
    });
    forceUpdate();
    await persistKeywordEntries().catch(console.error);
}

export async function removeKeywordEntry(idx: number, forceUpdate: () => void) {
    keywordEntries.splice(idx, 1);
    forceUpdate();
    await persistKeywordEntries().catch(console.error);
}

function compiledRegex(regex: string, flags: string) {
    const key = JSON.stringify([regex, flags]);
    if (regexCache.has(key)) return regexCache.get(key);
    let compiled: RegExp | null;
    try {
        compiled = new RegExp(regex, flags);
    } catch {
        compiled = null;
    }
    if (regexCache.size >= 256) regexCache.delete(regexCache.keys().next().value!);
    regexCache.set(key, compiled);
    return compiled;
}

function safeMatchesRegex(str: unknown, regex: string, flags: string) {
    return typeof str === "string" && compiledRegex(regex, flags)?.test(str) === true;
}

export enum ListType {
    BlackList = "BlackList",
    Whitelist = "Whitelist"
}

function highlightKeywords(str: string, entries: Array<KeywordEntry>) {
    for (const entry of entries) {
        if (!entry.regex) continue;
        const match = compiledRegex(entry.regex, entry.ignoreCase ? "i" : "")?.exec(str);
        if (!match?.[0]) continue;
        return (
            <>
                <span>{str.substring(0, match.index)}</span>
                <span className="highlight">{match[0]}</span>
                <span>{str.substring(match.index + match[0].length)}</span>
            </>
        );
    }
    return [str];
}

const settings = definePluginSettings({
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore messages from bots",
        default: true,
        hidden: true,
    },
    amountToKeep: {
        type: OptionType.NUMBER,
        description: "Amount of messages to keep in the log",
        default: 50
    },
    keywords: {
        type: OptionType.COMPONENT,
        description: "Manage keywords",
        component: () => <KeywordEntries />
    }
});

export default definePlugin({
    name: "KeywordNotify",
    authors: [EquicordDevs.camila314, EquicordDevs.x3rt, EquicordDevs.benjas333],
    description: "Sends a notification if a given message matches certain keywords or regexes",
    settings,
    patches: [
        {
            find: "#{intl::MENTIONS})",
            group: true,
            replacement: [
                {
                    match: /#{intl::Fn6Odn::raw}\)\}\)\}\):null/,
                    replace: "$&,$self.keywordTabBar()"
                },
                {
                    match: /:(\i)===\i\.\i\.MENTIONS\?\(0,.{0,500}null}/,
                    replace: ": $1 === 8 ? $self.keywordClearButton() $&",
                },
                {
                    match: /:(\i)===\i\.\i\.MENTIONS\?\(0,.{0,500}onJump:(\i)}\)/,
                    replace: ": $1 === 8 ? $self.tryKeywordMenu($2) $&",
                },
                {
                    match: /function (\i)\(\i\){let{message:\i,onJump/,
                    replace: "$self.RenderMsg = $1; $&",
                },
                {
                    match: /onClick:\(\)=>(\i\.\i\.deleteRecentMention\((\i)\.id\))/,
                    replace: "onClick: () => $2._keyword ? $self.deleteKeyword($2.id) : $1",
                },
            ]
        },
    ],

    async start() {
        const generation = ++startGeneration;
        this.onUpdate = () => null;
        await Promise.all([keywordLogWrite.catch(() => undefined), keywordEntriesWrite.catch(() => undefined)]);
        if (generation !== startGeneration) return;
        keywordLog = [];
        storedKeywordLog = [];
        storedKeywordLogIds.clear();
        keywordLogWrite = Promise.resolve();

        const entries = await DataStore.get(KEYWORD_ENTRIES_KEY) ?? [];
        if (generation !== startGeneration) return;
        if (!Array.isArray(entries) || !entries.every(isKeywordEntry)) throw new Error("Invalid saved KeywordNotify entries");
        keywordEntries = entries;
        keywordEntries.forEach(entry => {
            entry.ignoreBots = entry.ignoreBots ?? this.settings.store.ignoreBots;

            entry.whitelist = entry.whitelist ?? [];
            entry.blacklist = entry.blacklist ?? [];
            entry.listPriority = entry.listPriority ?? ListType.BlackList;

            if (entry.listType == null || entry.listIds == null) return;

            if (entry.listType === ListType.Whitelist) {
                entry.whitelist = entry.listIds;
            } else {
                entry.blacklist = entry.listIds;
            }
            delete entry.listIds;
            delete entry.listType;
        });
        await persistKeywordEntries();
        if (generation !== startGeneration) return;

        const persistedLog = await DataStore.get(KEYWORD_LOG_KEY);
        if (generation !== startGeneration) return;
        for (const serialized of Array.isArray(persistedLog) ? persistedLog : []) {
            if (typeof serialized !== "string") continue;
            try {
                const message = JSON.parse(serialized);
                if (typeof message?.id !== "string" || storedKeywordLogIds.has(message.id)) continue;
                storedKeywordLog.push(serialized);
                storedKeywordLogIds.add(message.id);
                this.addToLog(message);
            } catch (err) {
                console.error(err);
            }
        }
        const loadedLength = storedKeywordLog.length;
        trimStoredKeywordLog();
        if (storedKeywordLog.length !== loadedLength || storedKeywordLog.length !== (Array.isArray(persistedLog) ? persistedLog.length : 0))
            await persistKeywordLog();
        if (generation !== startGeneration) return;

        interceptor = (e: any) => {
            return this.modify(e);
        };
        FluxDispatcher.addInterceptor(interceptor);
    },
    stop() {
        startGeneration++;
        regexCache.clear();
        this.onUpdate = () => null;
        const index = FluxDispatcher._interceptors.indexOf(interceptor);
        if (index > -1) {
            FluxDispatcher._interceptors.splice(index, 1);
        }
    },

    applyKeywordEntries(m: KeywordMessage) {
        if (!m?.author || typeof m.channel_id !== "string") return;
        let matches = false;

        for (const entry of keywordEntries) {
            if (entry.regex === "") {
                continue;
            }

            let isInWhitelist = entry.whitelist.some(id => {
                const trimmed = id.trim();
                return trimmed === m.channel_id || trimmed === m.author.id;
            });
            if (!isInWhitelist) {
                const channel = ChannelStore.getChannel(m.channel_id);
                if (channel != null) {
                    isInWhitelist = entry.whitelist.some(id => id.trim() === channel.guild_id);
                }
            }

            let isInBlacklist = entry.blacklist.some(id => {
                const trimmed = id.trim();
                return trimmed === m.channel_id || trimmed === m.author.id;
            });
            if (!isInBlacklist) {
                const channel = ChannelStore.getChannel(m.channel_id);
                if (channel != null) {
                    isInBlacklist = entry.blacklist.some(id => id.trim() === channel.guild_id);
                }
            }

            const isWhitelistPrioritized = entry.listPriority === ListType.Whitelist;

            if (isInWhitelist && isInBlacklist) {
                if (!isWhitelistPrioritized) {
                    continue;
                }
            } else {
                if (entry.whitelist.length && !isInWhitelist) {
                    continue;
                }

                if (isInBlacklist) {
                    continue;
                }
            }

            if (m.author.bot && entry.ignoreBots && (!entry.whitelist.length || !entry.whitelist.includes(m.author.id))) {
                continue;
            }

            const flags = entry.ignoreCase ? "i" : "";
            if (safeMatchesRegex(m.content, entry.regex, flags)) {
                matches = true;
            } else {
                for (const embed of m.embeds ?? []) {
                    if (safeMatchesRegex(embed.description, entry.regex, flags) || safeMatchesRegex(embed.title, entry.regex, flags)) {
                        matches = true;
                        break;
                    } else if (embed.fields != null) {
                        for (const field of embed.fields as Array<{ name: string, value: string; }>) {
                            if (safeMatchesRegex(field.value, entry.regex, flags) || safeMatchesRegex(field.name, entry.regex, flags)) {
                                matches = true;
                                break;
                            }
                        }
                    }
                }
            }
            if (matches) break;
        }

        if (matches) {
            const id = UserStore.getCurrentUser()?.id;
            if (id != null) {
                if (Array.isArray(m.mentions) && !m.mentions.some(mention => mention.id === id))
                    m.mentions.push({ id: id });
            }

            if (m.author.id !== id) {
                this.storeMessage(m);
                this.addToLog(m);
            }
        }
    },
    storeMessage(m: KeywordMessage) {
        if (m == null || typeof m.id !== "string" || storedKeywordLogIds.has(m.id)) return;

        storedKeywordLog.push(JSON.stringify(m));
        storedKeywordLogIds.add(m.id);
        trimStoredKeywordLog();
        void persistKeywordLog().catch(console.error);
    },
    discardMessage(id: string) {
        if (!storedKeywordLogIds.delete(id)) return;
        storedKeywordLog = storedKeywordLog.filter(serialized => storedMessageId(serialized) !== id);
        void persistKeywordLog().catch(console.error);
    },
    addToLog(m: KeywordMessage) {
        if (m == null || keywordLog.some(e => e.id === m.id))
            return;

        let messageRecord: any;
        try {
            messageRecord = createMessageRecord(m);
        } catch (err) {
            console.error(err);
            return;
        }

        keywordLog.push(messageRecord);
        keywordLog.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

        while (keywordLog.length > getAmountToKeep()) {
            keywordLog.pop();
        }

        this.onUpdate();
    },

    deleteKeyword(id) {
        keywordLog = keywordLog.filter(e => e.id !== id);
        this.discardMessage(id);
        this.onUpdate();
    },

    keywordTabBar() {
        return (
            <TabBar.Item className={classes(tabClass.tab)} id={8}>
                Keywords
            </TabBar.Item>
        );
    },

    keywordClearButton() {
        return (
            <Tooltip text="Clear All">
                {({ onMouseLeave, onMouseEnter }) => (
                    <Button
                        variant="secondary"
                        size="iconOnly"
                        onMouseLeave={onMouseLeave}
                        onMouseEnter={onMouseEnter}
                        onClick={() => {
                            keywordLog = [];
                            storedKeywordLog = [];
                            storedKeywordLogIds.clear();
                            void persistKeywordLog().catch(console.error);
                            this.onUpdate();
                        }}>
                        <DoubleCheckmarkIcon width={16} height={16} className={"vc-double-checkmark-icon"} />
                    </Button>
                )}
            </Tooltip>
        );
    },

    tryKeywordMenu(onJump) {
        const [tempLogs, setKeywordLog] = useState(keywordLog);
        const navigatorScrollerRef = useRef<ScrollerBaseRef | null>(null);

        const navigator = createNavigator("keywords", navigatorScrollerRef);

        useEffect(() => {
            const onUpdate = () => setKeywordLog(Array.from(keywordLog));
            this.onUpdate = onUpdate;
            onUpdate();
            return () => {
                if (this.onUpdate === onUpdate) this.onUpdate = () => null;
            };
        }, []);

        const RenderMsgWrapper = (message: Message & { _keyword?: boolean; }): JSX.Element => {
            message._keyword = true;

            message.customRenderedContent = {
                content: highlightKeywords(message.content, keywordEntries)
            };

            return this.RenderMsg({
                message,
                onJump,
            });
        };

        const MessageScrollerHelper = ({ children }: { children: (scrollerOpts: ScrollerOpts) => JSX.Element; }) => {
            return children(getMessageScrollerOptions());
        };

        return (
            <ErrorBoundary>
                <PopoutContainer navigator={navigator}>
                    <MessageScrollerHelper>
                        {({ ref, ...restOpts }) => {
                            return <ScrollerThin
                                ref={thinScrollerRef => {
                                    navigatorScrollerRef.current = thinScrollerRef;
                                    // @ts-ignore
                                    ref.current = thinScrollerRef?.getScrollerNode() ?? null;
                                }}
                                className={classes(scrollerClass.scroller)}
                                onScroll={void 0}
                                {...restOpts}
                            >
                                {tempLogs.map(m => <div key={m.id}>{RenderMsgWrapper(m)}</div>)}
                            </ScrollerThin>;
                        }}
                    </MessageScrollerHelper>
                </PopoutContainer>
            </ErrorBoundary>
        );
    },

    modify(e) {
        if (e.type === "MESSAGE_CREATE" || e.type === "MESSAGE_UPDATE") {
            this.applyKeywordEntries(e.message);
        } else if (e.type === "LOAD_MESSAGES_SUCCESS") {
            for (let msg = 0; msg < e.messages.length; ++msg) {
                this.applyKeywordEntries(e.messages[msg]);
            }
        }
    }
});
