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

import { Logger } from "@utils/Logger";
import type { Channel, CloudUpload, CustomEmoji, Message } from "@vencord/discord-types";
import { MessageStore } from "@webpack/common";
import type { Promisable } from "type-fest";

const MessageEventsLogger = new Logger("MessageEvents", "#e5c890");

export interface MessageObject {
    content: string,
    validNonShortcutEmojis: CustomEmoji[];
    invalidEmojis: any[];
    tts: boolean;
}

export interface MessageContentOptions {
    content: string;
    channelId: string;
    command: unknown | null;
    isGif?: boolean;
    stickers?: string[];
    uploads?: CloudUpload[];
    alsoForwardToChannelId?: string;

    // If you end up using these, update their type
    scheduledTimestamp?: unknown;
    mediaMention?: unknown;
}

export interface SendMessageOptions extends MessageContentOptions {
    attachmentsToUpload?: CloudUpload[];
    flags?: number;
    messageReference?: Message["messageReference"];
    allowedMentions?: {
        parse: string[];
        repliedUser: boolean;
    };
    location: string;
    stickerIds?: string[];
}

export interface SendMessageProps {
    hasStickers: boolean;
    hasAttachments: boolean;
    content: string;
    channel: Channel;
    type?: any;
    openWarningPopout: (props: any) => any;
}

export interface MessageEventListenerResult {
    cancel?: boolean;
    stop?: boolean;
}

export interface MessageEventListenerOptions {
    /** Higher priority listeners run first. Defaults to 0. */
    priority?: number;
    /** Cancel the send or edit if this listener throws. Defaults to false. */
    cancelOnError?: boolean;
}

export type MessageSendListener = (channelId: string, messageObj: MessageObject, options: SendMessageOptions, props: SendMessageProps) => Promisable<void | MessageEventListenerResult>;
export type MessageEditListener = (channelId: string, messageId: string, messageObj: MessageObject) => Promisable<void | MessageEventListenerResult>;
export type MessageLengthBypassListener = () => boolean;

type MessageEventListener = (...args: any[]) => Promisable<void | MessageEventListenerResult>;

interface ListenerRegistration<Listener extends MessageEventListener> {
    listener: Listener;
    priority: number;
    order: number;
    cancelOnError: boolean;
}

interface ListenerStore<Listener extends MessageEventListener> {
    registrations: Map<Listener, ListenerRegistration<Listener>>;
    nextOrder: number;
}

function createListenerStore<Listener extends MessageEventListener>(): ListenerStore<Listener> {
    return {
        registrations: new Map(),
        nextOrder: 0,
    };
}

function addListener<Listener extends MessageEventListener>(
    store: ListenerStore<Listener>,
    listener: Listener,
    options: number | MessageEventListenerOptions,
): Listener {
    const priority = typeof options === "number" ? options : options?.priority ?? 0;
    const normalizedPriority = typeof priority === "number" && !Number.isNaN(priority) ? priority : 0;

    if (!store.registrations.has(listener)) {
        store.registrations.set(listener, {
            listener,
            priority: normalizedPriority,
            order: store.nextOrder++,
            cancelOnError: typeof options === "object" && options?.cancelOnError === true,
        });
    }

    return listener;
}

async function runListeners<Listener extends MessageEventListener>(
    store: ListenerStore<Listener>,
    invoke: (listener: Listener) => Promisable<void | MessageEventListenerResult>,
    errorMessage: string,
): Promise<boolean> {
    const registrations = Array.from(store.registrations.values())
        .sort((a, b) => b.priority - a.priority || a.order - b.order);

    for (const registration of registrations) {
        if (store.registrations.get(registration.listener) !== registration) continue;

        try {
            const result = await invoke(registration.listener);
            if (result?.cancel) return true;
            if (result?.stop) break;
        } catch (e) {
            MessageEventsLogger.error(errorMessage, e);
            if (registration.cancelOnError) return true;
        }
    }

    return false;
}

const sendListeners = createListenerStore<MessageSendListener>();
const editListeners = createListenerStore<MessageEditListener>();
const messageLengthBypassListeners = new Set<MessageLengthBypassListener>();

export function _shouldBypassMessageLengthLimit(): boolean {
    for (const listener of messageLengthBypassListeners) {
        try {
            if (listener()) return true;
        } catch (error) {
            MessageEventsLogger.error("MessageLengthBypassHandler: Listener encountered an unknown error\n", error);
        }
    }
    return false;
}

export async function _handlePreSend(channelId: string, messageObj: MessageObject, options: SendMessageOptions, props: SendMessageProps, contentOptions: MessageContentOptions) {
    const listenerOptions = { ...contentOptions, ...options };

    const cancelled = await runListeners(
        sendListeners,
        listener => listener(channelId, messageObj, listenerOptions, props),
        "MessageSendHandler: Listener encountered an unknown error\n",
    );
    if (listenerOptions.attachmentsToUpload) options.attachmentsToUpload = listenerOptions.attachmentsToUpload;
    if ("flags" in listenerOptions) options.flags = listenerOptions.flags;
    return cancelled;
}

export async function _handlePreEdit(channelId: string, messageId: string, messageObj: MessageObject) {
    return runListeners(
        editListeners,
        listener => listener(channelId, messageId, messageObj),
        "MessageEditHandler: Listener encountered an unknown error\n",
    );
}

/**
 * Note: This event fires off before a message is sent, allowing you to edit the message.
 * Higher priority listeners run first. Listeners with the same priority run in registration order.
 * Pass `cancelOnError: true` for fail-closed listeners whose errors must cancel the send.
 */
export function addMessagePreSendListener(listener: MessageSendListener, options: number | MessageEventListenerOptions = {}) {
    return addListener(sendListeners, listener, options);
}
/**
 * Note: This event fires off before a message's edit is applied, allowing you to further edit the message.
 * Higher priority listeners run first. Listeners with the same priority run in registration order.
 * Pass `cancelOnError: true` for fail-closed listeners whose errors must cancel the edit.
 */
export function addMessagePreEditListener(listener: MessageEditListener, options: number | MessageEventListenerOptions = {}) {
    return addListener(editListeners, listener, options);
}
export function removeMessagePreSendListener(listener: MessageSendListener) {
    return sendListeners.registrations.delete(listener);
}
export function removeMessagePreEditListener(listener: MessageEditListener) {
    return editListeners.registrations.delete(listener);
}
export function addMessageLengthBypassListener(listener: MessageLengthBypassListener) {
    messageLengthBypassListeners.add(listener);
    return listener;
}
export function removeMessageLengthBypassListener(listener: MessageLengthBypassListener) {
    return messageLengthBypassListeners.delete(listener);
}

// Message clicks
export type MessageClickListener = (message: Message, channel: Channel, event: MouseEvent) => void;

const listeners = new Set<MessageClickListener>();

export function _handleClick(message: Message, channel: Channel, event: MouseEvent) {
    // message object may be outdated, so (try to) fetch latest one
    message = MessageStore.getMessage(channel.id, message.id) ?? message;
    for (const listener of listeners) {
        try {
            listener(message, channel, event);
        } catch (e) {
            MessageEventsLogger.error("MessageClickHandler: Listener encountered an unknown error\n", e);
        }
    }
}

export function addMessageClickListener(listener: MessageClickListener) {
    listeners.add(listener);
    return listener;
}

export function removeMessageClickListener(listener: MessageClickListener) {
    return listeners.delete(listener);
}
