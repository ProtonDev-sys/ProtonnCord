/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { generateId, sendBotMessage } from "@api/Commands";
import { Devs } from "@utils/constants";
import definePlugin, { IconComponent, StartAt } from "@utils/types";
import { CloudUpload, MessageAttachment } from "@vencord/discord-types";
import { DraftStore, DraftType, showToast, Toasts, UploadAttachmentStore, UserStore, useStateFromStores } from "@webpack/common";

const PREVIEW_ATTACHMENT_URL_TTL_MS = 5 * 60 * 1000;
const objectURLMap = new Map<string, { timeoutId: number; urls: string[]; }>();
const pendingAttachmentCleanups = new Set<() => void>();
let active = false;
let generation = 0;

function cleanupAllPreviews() {
    generation++;
    for (const cleanup of pendingAttachmentCleanups) cleanup();
    for (const messageId of objectURLMap.keys()) cleanupPreviewMessage(messageId);
}

function cleanupPreviewMessage(messageId: string) {
    const tracked = objectURLMap.get(messageId);
    if (!tracked) return;

    window.clearTimeout(tracked.timeoutId);
    for (const url of tracked.urls) URL.revokeObjectURL(url);
    objectURLMap.delete(messageId);
}

const getDraft = (channelId: string) => DraftStore.getDraft(channelId, DraftType.ChannelMessage);

const getImageBox = (url: string): Promise<{ width: number, height: number; } | null> =>
    new Promise(res => {
        const img = new Image();
        const timeout = window.setTimeout(() => {
            finish(null);
            img.src = "";
        }, 10000);
        const finish = (box: { width: number; height: number; } | null) => {
            window.clearTimeout(timeout);
            img.onload = null;
            img.onerror = null;
            res(box);
        };
        img.onload = () => finish({ width: img.width, height: img.height });

        img.onerror = () => finish(null);

        img.src = url;
    });

function createPreviewAttachmentUrlTracker() {
    const objectUrls = new Set<string>();
    const cleanup = () => {
        for (const url of objectUrls) {
            URL.revokeObjectURL(url);
        }
        objectUrls.clear();
    };

    return {
        add(url: string) {
            objectUrls.add(url);
            return url;
        },
        cleanup,
        release() {
            const result = [...objectUrls];
            objectUrls.clear();
            return result;
        }
    };
}

const getAttachments = async (channelId: string) => {
    const urls = createPreviewAttachmentUrlTracker();
    pendingAttachmentCleanups.add(urls.cleanup);

    try {
        const attachments = await Promise.all(
            UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage)
            .map(async (upload: CloudUpload) => {
                const { isImage, filename, spoiler, item: { file } } = upload;
                const url = urls.add(URL.createObjectURL(file));
                const attachment: MessageAttachment = {
                    id: generateId(),
                    filename: spoiler ? "SPOILER_" + filename : filename,
                    // weird eh? if i give it the normal content type the preview doenst work
                    content_type: undefined,
                    size: upload.getSize(),
                    spoiler,
                    // discord adds query params to the url, so we need to add a hash to prevent that
                    url: url + "#",
                    proxy_url: url + "#",
                };

                if (isImage) {
                    const box = await getImageBox(url);
                    if (box) {
                        attachment.width = box.width;
                        attachment.height = box.height;
                    }
                }

                return attachment;
            })
        );

        return { attachments, cleanup: () => urls.cleanup(), release: () => urls.release() };
    } catch (error) {
        urls.cleanup();
        throw error;
    } finally {
        pendingAttachmentCleanups.delete(urls.cleanup);
    }
};

const PreviewIcon: IconComponent = ({ height = 20, width = 20, className }) => {
    return (
        <svg
            fill="currentColor"
            fillRule="evenodd"
            width={width}
            height={height}
            className={className}
            viewBox="0 0 24 24"
            style={{ scale: "1.096", translate: "0 -1px" }}
        >
            <path d="M22.89 11.7c.07.2.07.4 0 .6C22.27 13.9 19.1 21 12 21c-7.11 0-10.27-7.11-10.89-8.7a.83.83 0 0 1 0-.6C1.73 10.1 4.9 3 12 3c7.11 0 10.27 7.11 10.89 8.7Zm-4.5-3.62A15.11 15.11 0 0 1 20.85 12c-.38.88-1.18 2.47-2.46 3.92C16.87 17.62 14.8 19 12 19c-2.8 0-4.87-1.38-6.39-3.08A15.11 15.11 0 0 1 3.15 12c.38-.88 1.18-2.47 2.46-3.92C7.13 6.38 9.2 5 12 5c2.8 0 4.87 1.38 6.39 3.08ZM15.56 11.77c.2-.1.44.02.44.23a4 4 0 1 1-4-4c.21 0 .33.25.23.44a2.5 2.5 0 0 0 3.32 3.32Z" />
        </svg>
    );
};

const PreviewButton: ChatBarButtonFactory = ({ isAnyChat, isEmpty, type: { attachments }, channel: { id: channelId } }) => {
    const draft = useStateFromStores([DraftStore], () => getDraft(channelId));

    if (!isAnyChat) return null;

    const hasAttachments = attachments && UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage).length > 0;
    const hasContent = !isEmpty && draft?.length > 0;

    if (!hasContent && !hasAttachments) return null;

    return (
        <ChatBarButton
            tooltip="Preview Message"
            onClick={async () => {
                if (!active) return;
                const requestGeneration = generation;
                const author = UserStore.getCurrentUser();
                const content = getDraft(channelId);
                let previewAttachments: Awaited<ReturnType<typeof getAttachments>> | undefined;

                try {
                    previewAttachments = hasAttachments ? await getAttachments(channelId) : undefined;
                    if (!active || requestGeneration !== generation || author?.id !== UserStore.getCurrentUser()?.id) {
                        previewAttachments?.cleanup();
                        return;
                    }
                    const message = sendBotMessage(
                        channelId,
                        {
                            content,
                            author,
                            attachments: previewAttachments?.attachments,
                        }
                    );
                    if (previewAttachments) {
                        const timeoutId = window.setTimeout(
                            () => cleanupPreviewMessage(message.id),
                            PREVIEW_ATTACHMENT_URL_TTL_MS,
                        );
                        objectURLMap.set(message.id, { timeoutId, urls: previewAttachments.release() });
                    }
                } catch (error) {
                    previewAttachments?.cleanup();
                    console.error("[PreviewMessage] Could not create preview", error);
                    showToast("Could not create the message preview", Toasts.Type.FAILURE);
                }
            }}
            buttonProps={{
                style: {
                    translate: "0 2px"
                }
            }}
        >
            <PreviewIcon />
        </ChatBarButton>
    );

};

export default definePlugin({
    name: "PreviewMessage",
    description: "Lets you preview your message before sending it.",
    dependencies: ["ChatInputButtonAPI"],
    tags: ["Chat", "Utility"],
    authors: [Devs.Aria],
    // start early to ensure we're the first plugin to add our button
    // This makes the popping in less awkward
    startAt: StartAt.Init,

    chatBarButton: {
        icon: PreviewIcon,
        render: PreviewButton
    },

    start() {
        active = true;
        generation++;
    },

    flux: {
        LOGOUT: cleanupAllPreviews,
        MESSAGE_DELETE({ id: messageId }) {
            cleanupPreviewMessage(messageId);
        }
    },

    stop() {
        active = false;
        cleanupAllPreviews();
    },
});
