/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { useAwaiter } from "@utils/react";
import { ChannelStore, useCallback, useEffect, useMemo, UserStore, useState } from "@webpack/common";

import { bookmarkFolderColors, logger } from "./constants";
import { Bookmark, BookmarkFolder, Bookmarks, UseBookmark, UseBookmarkMethods } from "./types";

export function isBookmarkFolder(bookmark: Bookmark | BookmarkFolder | null | undefined): bookmark is BookmarkFolder {
    return bookmark != null && "bookmarks" in bookmark;
}

export function bookmarkPlaceholderName(bookmark: Omit<Bookmark | BookmarkFolder, "name">) {
    if (isBookmarkFolder(bookmark as Bookmark | BookmarkFolder)) return "Folder";

    const { channelId } = (bookmark as Bookmark);

    // handle special synthetic pages
    if (channelId?.startsWith("__")) {
        const specialPagesMap: Record<string, string> = {
            "__quests__": "Quests",
            "__message-requests__": "Message Requests",
            "__friends__": "Friends",
            "__shop__": "Shop",
            "__library__": "Library",
            "__discovery__": "Discovery",
            "__nitro__": "Nitro",
            "__icymi__": "ICYMI",
            "__activity__": "Activity",
        };

        return specialPagesMap[channelId] || "Special Page";
    }

    const channel = ChannelStore.getChannel(channelId);

    if (!channel) return "Bookmark";
    if (channel.name) return `#${channel.name}`;
    if (channel.recipients) return UserStore.getUser(channel.recipients?.[0])?.username
        ?? "Unknown User";
    return "Bookmark";
}

export function useBookmarks(userId: string): UseBookmark {
    const [bookmarks, _setBookmarks] = useState<{ [k: string]: Bookmarks; }>({});
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [saveStatus, setSaveStatus] = useState({ userId, saving: false, failed: false });
    const writer = useMemo(() => ({ pending: undefined as Bookmarks | undefined, running: false, disposed: false }), [userId]);
    useEffect(() => {
        writer.disposed = false;
        return () => { writer.disposed = true; };
    }, [writer]);
    const savePendingBookmarks = useCallback(async () => {
        if (writer.running || writer.disposed || !writer.pending) return;
        writer.running = true;
        setSaveStatus({ userId, saving: true, failed: false });
        try {
            while (writer.pending && !writer.disposed) {
                const snapshot = writer.pending;
                try {
                    await DataStore.update("ChannelTabs_bookmarks", old => ({ ...old, [userId]: snapshot }));
                    if (writer.pending === snapshot) writer.pending = undefined;
                } catch (error) {
                    logger.error("Failed to save bookmarks", error);
                    if (writer.pending !== snapshot) continue;
                    if (!writer.disposed) setSaveStatus({ userId, saving: false, failed: true });
                    return;
                }
            }
            if (!writer.disposed) setSaveStatus({ userId, saving: false, failed: false });
        } finally {
            writer.running = false;
        }
    }, [userId, writer]);
    const setBookmarks = useCallback((bookmarks: { [k: string]: Bookmarks; }) => {
        _setBookmarks(bookmarks);
        writer.pending = structuredClone(bookmarks[userId]);
        void savePendingBookmarks();
    }, [userId, writer, savePendingBookmarks]);

    const [, loadError, loading] = useAwaiter(() => DataStore.get("ChannelTabs_bookmarks"), {
        fallbackValue: undefined,
        deps: [userId, loadAttempt],
        onSuccess(bookmarks: { [k: string]: Bookmarks; }) {
            _setBookmarks({ ...bookmarks, [userId]: bookmarks?.[userId] ?? [] });
        },
        onError: error => logger.error("Failed to load bookmarks", error)
    });

    const methods = {
        addBookmark: (bookmark, folderIndex) => {
            if (loading || loadError || writer.disposed || !bookmarks[userId]) return;

            if (typeof folderIndex === "number" && !(isBookmarkFolder(bookmarks[userId][folderIndex])))
                return logger.error("Attempted to add bookmark to non-folder " + folderIndex, bookmarks);

            const name = bookmark.name ?? bookmarkPlaceholderName(bookmark);
            if (typeof folderIndex === "number")
                (bookmarks[userId][folderIndex] as BookmarkFolder).bookmarks.push({ ...bookmark, name });
            else bookmarks[userId].push({ ...bookmark, name });

            setBookmarks({
                ...bookmarks
            });
        },
        addFolder(name, iconColor, iconName) {
            if (loading || loadError || writer.disposed || !bookmarks[userId]) return -1;
            const length = bookmarks[userId].push({
                name: name?.trim() || "Folder",
                iconColor: iconColor ?? bookmarkFolderColors.Black,
                iconName,
                bookmarks: []
            });

            setBookmarks({
                ...bookmarks
            });
            return length - 1;
        },
        editBookmark(index, newBookmark) {
            if (loading || loadError || writer.disposed || !Number.isInteger(index) || !bookmarks[userId]?.[index]) return;
            Object.entries(newBookmark).forEach(([k, v]) => {
                bookmarks[userId][index][k] = v;
            });
            setBookmarks({
                ...bookmarks
            });
        },
        deleteBookmark(index, folderIndex) {
            if (loading || loadError || writer.disposed || !bookmarks[userId] || !Number.isInteger(index)) return;

            if (typeof folderIndex === "number") {
                const folder = bookmarks[userId][folderIndex];
                if (!isBookmarkFolder(folder))
                    return logger.error("Attempted to delete bookmark from non-folder " + folderIndex, bookmarks);

                if (index < 0 || index > (folder.bookmarks.length - 1))
                    return logger.error("Attempted to delete bookmark at index " + index, bookmarks);

                folder.bookmarks.splice(index, 1);
            } else {
                if (index < 0 || index > (bookmarks[userId].length - 1))
                    return logger.error("Attempted to delete bookmark at index " + index, bookmarks);

                bookmarks[userId].splice(index, 1);
            }

            setBookmarks({
                ...bookmarks
            });
        },
        moveDraggedBookmarks(index1, index2) {
            if (loading || loadError || writer.disposed || !bookmarks[userId]) return;
            if (!Number.isInteger(index1) || !Number.isInteger(index2)
                || index1 < 0 || index1 >= bookmarks[userId].length
                || index2 < 0 || index2 >= bookmarks[userId].length)
                return logger.error(`Out of bounds drag (swap between indexes ${index1} and ${index2})`, bookmarks);

            const firstItem = bookmarks[userId].splice(index1, 1)[0];
            bookmarks[userId].splice(index2, 0, firstItem);

            setBookmarks({
                ...bookmarks
            });
        }
    } as UseBookmarkMethods;

    return [loading || loadError ? undefined : bookmarks[userId], methods, {
        loadError: !!loadError,
        saveError: saveStatus.userId === userId && saveStatus.failed,
        saving: saveStatus.userId === userId && saveStatus.saving,
        retryLoad: () => setLoadAttempt(attempt => attempt + 1),
        retrySave: () => { void savePendingBookmarks(); }
    }];
}
