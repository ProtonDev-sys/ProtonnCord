/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message } from "@vencord/discord-types";

const MESSAGE_ROW_SELECTOR = '[id^="chat-messages-"]';
const HISTORY_BOTTOM_THRESHOLD_PX = 64;
const SCROLL_EPSILON_PX = 0.5;
const RESTORE_FRAME_COUNT = 3;

export interface ScrollMetrics {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}

interface PendingScrollRestore {
    anchorId: string;
    anchorTop: number;
    remainingFrames: number;
    scroller: HTMLElement;
}

const pendingRestores = new WeakMap<HTMLElement, PendingScrollRestore>();

export function encryptedMessageRowId(channelId: string, messageId: string): string {
    return `chat-messages-${channelId}-${messageId}`;
}

export function shouldPreserveHistoryScroll(
    metrics: ScrollMetrics,
    bottomThreshold = HISTORY_BOTTOM_THRESHOLD_PX,
): boolean {
    if (![metrics.clientHeight, metrics.scrollHeight, metrics.scrollTop, bottomThreshold].every(Number.isFinite)) return false;
    if (metrics.clientHeight <= 0 || metrics.scrollHeight <= metrics.clientHeight || metrics.scrollTop < 0 || bottomThreshold < 0) return false;
    return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop > bottomThreshold;
}

export function targetMayAffectViewport(targetTop: number, viewportBottom: number): boolean {
    return Number.isFinite(targetTop) && Number.isFinite(viewportBottom) && targetTop < viewportBottom;
}

export function compensatedScrollTop(currentScrollTop: number, anchorTopBefore: number, anchorTopAfter: number): number {
    const correction = anchorTopAfter - anchorTopBefore;
    return [currentScrollTop, correction].every(Number.isFinite)
        ? currentScrollTop + correction
        : currentScrollTop;
}

function findScrollContainer(row: HTMLElement): HTMLElement | null {
    let fallback: HTMLElement | null = null;
    for (let element = row.parentElement; element; element = element.parentElement) {
        if (element.clientHeight <= 0 || element.scrollHeight <= element.clientHeight + 1) continue;
        fallback ??= element;
        try {
            if (/^(?:auto|overlay|scroll)$/u.test(getComputedStyle(element).overflowY)) return element;
        } catch {
            // A renderer can be removed while its encrypted media is finishing.
        }
    }
    return fallback;
}

function messageRows(scroller: HTMLElement): HTMLElement[] {
    return [...scroller.querySelectorAll<HTMLElement>(MESSAGE_ROW_SELECTOR)];
}

function firstVisibleMessageRow(scroller: HTMLElement, viewportTop: number, viewportBottom: number): HTMLElement | null {
    let nearest: { distance: number; row: HTMLElement; } | null = null;
    for (const row of messageRows(scroller)) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= viewportTop || rect.top >= viewportBottom) continue;
        const distance = Math.abs(rect.top - viewportTop);
        if (!nearest || distance < nearest.distance) nearest = { distance, row };
    }
    return nearest?.row ?? null;
}

function selectAnchor(scroller: HTMLElement, target: HTMLElement): HTMLElement | null {
    const viewport = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (!targetMayAffectViewport(targetRect.top, viewport.bottom)) return null;

    const rows = messageRows(scroller);
    if (targetRect.bottom > viewport.top) {
        const targetIndex = rows.indexOf(target);
        for (let index = targetIndex + 1; index > 0 && index < rows.length; index++) {
            const row = rows[index];
            if (row.getBoundingClientRect().bottom > viewport.top) return row;
        }
    }
    return firstVisibleMessageRow(scroller, viewport.top, viewport.bottom) ?? target;
}

function restoreAnchor(pending: PendingScrollRestore): void {
    const { scroller } = pending;
    if (pendingRestores.get(scroller) !== pending || !scroller.isConnected) {
        pendingRestores.delete(scroller);
        return;
    }

    const anchor = document.getElementById(pending.anchorId);
    if (!anchor || !scroller.contains(anchor)) {
        pendingRestores.delete(scroller);
        return;
    }

    const nextScrollTop = compensatedScrollTop(
        scroller.scrollTop,
        pending.anchorTop,
        anchor.getBoundingClientRect().top,
    );
    if (Math.abs(nextScrollTop - scroller.scrollTop) > SCROLL_EPSILON_PX) scroller.scrollTop = nextScrollTop;

    pending.remainingFrames--;
    if (pending.remainingFrames > 0) requestAnimationFrame(() => restoreAnchor(pending));
    else pendingRestores.delete(scroller);
}

function scheduleRestore(pending: PendingScrollRestore): void {
    queueMicrotask(() => {
        if (pendingRestores.get(pending.scroller) === pending)
            requestAnimationFrame(() => restoreAnchor(pending));
    });
}

export function preserveEncryptedMessageScroll(message: Message, mutateLayout: () => void): void {
    if (typeof document === "undefined" || typeof getComputedStyle !== "function" ||
        typeof requestAnimationFrame !== "function" || typeof queueMicrotask !== "function") {
        mutateLayout();
        return;
    }

    const row = document.getElementById(encryptedMessageRowId(message.channel_id, message.id));
    const scroller = row && findScrollContainer(row);
    if (!row || !scroller || !shouldPreserveHistoryScroll(scroller)) {
        mutateLayout();
        return;
    }

    let pending = pendingRestores.get(scroller);
    if (!pending) {
        const anchor = selectAnchor(scroller, row);
        if (!anchor?.id) {
            mutateLayout();
            return;
        }
        pending = {
            anchorId: anchor.id,
            anchorTop: anchor.getBoundingClientRect().top,
            remainingFrames: RESTORE_FRAME_COUNT,
            scroller,
        };
        pendingRestores.set(scroller, pending);
        scheduleRestore(pending);
    } else {
        pending.remainingFrames = RESTORE_FRAME_COUNT;
    }

    mutateLayout();
}
