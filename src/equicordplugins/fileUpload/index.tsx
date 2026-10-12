/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import { OpenExternalIcon } from "@components/Icons";
import { Devs, EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin from "@utils/types";
import { Channel, CloudUpload } from "@vencord/discord-types";
import { DraftType, Menu, PermissionsBits, PermissionStore, React, SelectedChannelStore, showToast, Toasts, UploadAttachmentStore, useEffect, UserStore, useState } from "@webpack/common";

import { settings } from "./settings";
import { serviceLabels, ServiceType } from "./types";
import { getMediaUrl } from "./utils/getMediaUrl";
import { cancelCurrentUpload, getUploadState, isConfigured, isExternalUploadAllowed, isFileTypeAllowed, isUploadBusy, logger, stopUploads, subscribeUploadState, uploadFile, uploadPickedFile, uploadProvidedFiles } from "./utils/upload";
const cl = classNameFactory("vc-file-upload-");
let started = false;
let uploadContextGeneration = 0;

interface UploadContext {
    accountId: string;
    channel: Channel;
    generation: number;
    pastedFile: boolean;
}

function isCurrentUploadContext(context: UploadContext): boolean {
    const { channel } = context;
    return started && context.generation === uploadContextGeneration
        && UserStore.getCurrentUser()?.id === context.accountId
        && SelectedChannelStore.getChannelId() === channel.id
        && (!channel.guild_id || PermissionStore.can(
            (channel.isThread() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES) | PermissionsBits.ATTACH_FILES, channel
        ));
}

function captureUploadContext(channel: Channel, draftType: number, options?: {
    requireConfirm?: boolean; isThumbnail?: boolean; filesMetadata?: unknown; origin?: string; fileUploadPastedFiles?: boolean;
}): UploadContext | undefined {
    const accountId = UserStore.getCurrentUser()?.id;
    const pastedFile = options?.origin === "clipboard" && options.fileUploadPastedFiles === true;
    if (!accountId || !channel?.id || draftType !== DraftType.ChannelMessage
        || options?.requireConfirm === false || options?.isThumbnail || options?.filesMetadata != null
        || !(settings.store.bypassDiscordUpload || pastedFile && settings.store.autoUploadPastedFiles)
        || !isConfigured() || isUploadBusy()) return;

    const context = { accountId, channel, generation: uploadContextGeneration, pastedFile };
    return isCurrentUploadContext(context) ? context : undefined;
}

async function interceptUploadFiles(files: readonly File[], context: UploadContext | undefined, exceedsCount: () => boolean, exceedsSize: () => boolean, openChat: () => void): Promise<boolean> {
    if (!context) return false;
    const canClaim = (checkBusy = true) => isCurrentUploadContext(context) && isConfigured() && (!checkBusy || !isUploadBusy())
        && files.length > 0 && files.every(file => file instanceof File && isFileTypeAllowed(file))
        && !exceedsCount() && (context.pastedFile && settings.store.autoUploadPastedFiles
            || settings.store.bypassDiscordUpload && (!settings.store.bypassDiscordUploadOnlyOverLimit || exceedsSize()));
    if (!canClaim()) return false;
    if (!await isExternalUploadAllowed(context.accountId, context.channel.id)) return false;
    if (!canClaim()) return false;
    openChat();
    if (!canClaim()) return false;

    // The uploader claims its busy state synchronously before its first await.
    void uploadProvidedFiles(files, undefined, () => canClaim(false)).catch(error => logger.warn("Upload handoff failed", error));
    return true;
}

function retireUploadContext() {
    uploadContextGeneration++;
    stopUploads();
}

function withUploadContext(action: () => Promise<unknown>, channelId = SelectedChannelStore.getChannelId()) {
    const accountId = UserStore.getCurrentUser()?.id;
    const generation = uploadContextGeneration;
    return () => {
        if (started && accountId && channelId && generation === uploadContextGeneration
            && UserStore.getCurrentUser()?.id === accountId && SelectedChannelStore.getChannelId() === channelId) return action();
    };
}

function formatBytes(bytes: number): string {
    if (!bytes) return "";

    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

const ProgressBarInner = () => {
    const [state, setState] = useState(getUploadState);

    useEffect(() => subscribeUploadState(() => setState(getUploadState())), []);

    if (state.phase === "idle") return null;

    const percentage = Math.max(0, Math.min(100, state.percent));
    const progressLabel = state.totalBytes > 0
        ? `${Math.round(percentage)}% - ${formatBytes(state.transferredBytes)} of ${formatBytes(state.totalBytes)}`
        : `${Math.round(percentage)}%`;

    return (
        <div
            className={cl("progress-wrap")}
            data-phase={state.phase}
        >
            <div className={cl("progress-head")}>
                <div className={cl("progress-label")}>
                    {state.status || "Uploading..."}
                </div>
                <div className={cl("progress-meta")}>
                    <span className={cl("progress-percent")}>
                        {progressLabel}
                    </span>
                    <span className={cl("progress-attempt")}>
                        {state.attempt > 0 && state.totalAttempts > 0 ? `${state.attempt}/${state.totalAttempts}` : ""}
                    </span>
                    {state.canCancel && (
                        <button
                            className={cl("progress-cancel")}
                            type="button"
                            onClick={cancelCurrentUpload}
                        >
                            Cancel
                        </button>
                    )}
                </div>
            </div>
            <div className={cl("progress-track")}>
                <div
                    className={cl("progress-fill")}
                    style={{ width: `${percentage}%` }}
                />
            </div>
            <div className={cl("progress-file")}>
                {state.fileName || ""}{state.currentServiceLabel ? ` • ${state.currentServiceLabel}` : ""}
            </div>
        </div>
    );
};

const ProgressBar = ErrorBoundary.wrap(ProgressBarInner, { noop: true });

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    const { itemSrc, itemHref, target } = props;
    const url = getMediaUrl({ src: itemSrc, href: itemHref, target });

    if (!url) return;

    const group = findGroupChildrenByChildId("open-native-link", children)
        ?? findGroupChildrenByChildId("copy-link", children);

    if (group && !group.some(child => child?.props?.id === "file-upload")) {
        const serviceType = settings.store.serviceType as ServiceType;
        const serviceName = serviceLabels[serviceType];

        group.push(
            <Menu.MenuItem
                label={`Upload to ${serviceName}`}
                key="file-upload"
                id="file-upload"
                action={withUploadContext(() => uploadFile(url))}
            />
        );
    }
};

const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    if ("href" in props && !props.src) return;

    const url = getMediaUrl(props);
    if (!url) return;

    if (children.some(child => child?.props?.id === "file-upload-group")) return;

    const serviceType = settings.store.serviceType as ServiceType;
    const serviceName = serviceLabels[serviceType];

    children.push(
        <Menu.MenuGroup id="file-upload-group">
            <Menu.MenuItem
                label={`Upload to ${serviceName}`}
                key="file-upload"
                id="file-upload"
                action={withUploadContext(() => uploadFile(url))}
            />
        </Menu.MenuGroup>
    );
};

async function handleUploadFileFromDraft(upload: CloudUpload, channelId: string) {
    const accountId = UserStore.getCurrentUser()?.id;
    if (SelectedChannelStore.getChannelId() !== channelId) return;
    const file = upload.item?.file;
    if (!file) return;

    if (!isFileTypeAllowed(file)) {
        showToast("File type not allowed by current filter", Toasts.Type.FAILURE);
        return;
    }

    if (!isConfigured()) {
        showToast("Please configure FileUpload settings first", Toasts.Type.FAILURE);
        return;
    }

    try {
        const succeeded = await uploadProvidedFiles([file], true);
        if (succeeded && UserStore.getCurrentUser()?.id === accountId && SelectedChannelStore.getChannelId() === channelId)
            upload.removeFromMsgDraft();
    } catch (e) {
        logger.warn("Draft upload encountered an unexpected error", e);
    }
}

const ExternalIcon = () => <OpenExternalIcon height={24} width={24} />;

const channelAttachMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!channel) return;
    if (channel.guild_id && !PermissionStore.can(
        (channel.isThread() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES) | PermissionsBits.ATTACH_FILES, channel
    )) return;
    if (children.some(child => child?.props?.id === "file-upload-manual" || child?.props?.id === "file-upload-uploads")) return;

    const uploads = UploadAttachmentStore.getUploads(channel.id, DraftType.ChannelMessage);
    const draftUploads = Array.isArray(uploads) ? uploads.filter((u: CloudUpload) => u.item?.file && isFileTypeAllowed(u.item.file)) : [];

    if (draftUploads.length > 0) {
        children.splice(1, 0,
            <Menu.MenuItem
                id="file-upload-uploads"
                key="file-upload-uploads"
                label="Upload to Host"
                iconLeft={ExternalIcon}
                leadingAccessory={{
                    type: "icon",
                    icon: ExternalIcon
                }}
            >
                {draftUploads.map((upload: CloudUpload) => (
                    <Menu.MenuItem
                        id={`file-upload-draft-${upload.id}`}
                        key={upload.id}
                        label={upload.filename}
                        action={withUploadContext(() => handleUploadFileFromDraft(upload, channel.id), channel.id)}
                    />
                ))}
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="file-upload-manual"
                    key="file-upload-manual"
                    label="Choose File..."
                    action={withUploadContext(uploadPickedFile, channel.id)}
                />
            </Menu.MenuItem>
        );
    } else {
        children.splice(1, 0,
            <Menu.MenuItem
                id="file-upload-manual"
                key="file-upload-manual"
                label="Upload to Host"
                iconLeft={ExternalIcon}
                leadingAccessory={{
                    type: "icon",
                    icon: ExternalIcon
                }}
                action={withUploadContext(uploadPickedFile, channel.id)}
            />
        );
    }
};

export default definePlugin({
    name: "FileUpload",
    description: "Upload files to hosting services like Zipline, Nest, S3, and WebDAV",
    tags: ["Media"],
    authors: [EquicordDevs.creations, EquicordDevs.keircn, Devs.ScattrdBlade],
    settings,
    patches: [
        {
            find: ".CREATE_FORUM_POST||",
            replacement: {
                match: /(textValue:.{0,50}channelId:\i\.id\}\))(?:,\i(,))?/,
                replace: "$1,$self.renderUploadProgress()$2"
            }
        },
        // Claim only supported channel uploads after Discord prepares and validates the files.
        {
            find: "Unexpected mismatch between files and file metadata",
            group: true,
            replacement: [
                {
                    match: /(?=let\{filesMetadata:\i,requireConfirm:)/,
                    replace: "const fileUploadContext=$self.captureUploadContext(arguments[1],arguments[2],arguments[3]);"
                },
                {
                    match: /if\((\i\.type!==\i\.\i\.GUILD_VOICE&&\i\.type!==\i\.\i\.GUILD_STAGE_VOICE\|\|\i\.\i\.getChatOpen\(\i\.id\)\|\|\i\.\i\.updateChatOpen\(\i\.id,!0\)),(\i)\)/,
                    replace: "function fileUploadOpenChat(){return $1}if(fileUploadOpenChat(),$2)"
                },
                {
                    match: /if\((\(0,\i\.\i\))\(\{files:(\i),guildId:(\i)\}\)\)return void \i\((\i),\2\);if\((\i\.\i\.getUploadCount\(\4\.id,\i\)\+\i\.length>\i\.\i)\)/,
                    replace: "if(fileUploadContext&&await $self.interceptUploadFiles($2,fileUploadContext,()=>($5),()=>$1({files:$2,guildId:$3,canDeferSizeChecks:!1}),fileUploadOpenChat))return;$&"
                }
            ]
        },
        {
            find: 'origin:"clipboard"',
            group: true,
            replacement: [
                {
                    match: /(?<=let\{files:\i,errors:\i)(?=\}=function\(\i,\i\)\{)/,
                    replace: ",convertedStringToFile:fileUploadPasteIsText"
                },
                {
                    match: /(?<=origin:"clipboard")(?=\})/,
                    replace: ",fileUploadPastedFiles:!fileUploadPasteIsText"
                }
            ]
        },
    ],
    contextMenus: {
        "message": messageContextMenuPatch,
        "image-context": imageContextMenuPatch,
        "channel-attach": channelAttachMenuPatch
    },
    flux: { LOGOUT: retireUploadContext },

    start() {
        started = true;
    },
    stop() {
        started = false;
        retireUploadContext();
    },
    captureUploadContext,
    interceptUploadFiles,
    renderUploadProgress() {
        return <ProgressBar />;
    }
});
