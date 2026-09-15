/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Heading } from "@components/Heading";
import { Margins } from "@components/margins";
import { classNameFactory } from "@utils/css";
import { RenderModalProps } from "@vencord/discord-types";
import { IconUtils, Modal, React, TextInput, Toasts, UserStore, useState } from "@webpack/common";

import { data, saveAvatar } from ".";

const cl = classNameFactory("vc-userpfp-");

function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export function SetAvatarModal({ userId, modalProps }: { userId: string; modalProps: RenderModalProps; }) {
    const { avatars } = data;
    const user = UserStore.getUser(userId);
    const originalAvatar = user ? IconUtils.getUserAvatarURL(user, true, 128) || "" : "";

    const [url, setUrl] = useState(avatars[userId] || "");
    const [preview, setPreview] = useState<string>(avatars[userId] || "");
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const busy = React.useRef(false);
    const fileGeneration = React.useRef(0);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    React.useEffect(() => () => { fileGeneration.current++; }, []);

    function handleKey(e: React.KeyboardEvent) {
        if (e.key === "Enter") saveUserAvatar();
    }

    function handleUrlChange(val: string) {
        fileGeneration.current++;
        setUrl(val);
        setPreview(val.trim());
    }

    async function handleFile(file: File) {
        if (!file.type.startsWith("image/")) return;

        if (file.type === "image/gif" || file.type === "image/webp") {
            Toasts.show({
                message: "GIFs/WebP must be added via URL. Upload your GIF/WebP to a image hosting service and paste the link.",
                type: Toasts.Type.FAILURE,
                id: Toasts.genId(),
            });
            return;
        }

        const currentGeneration = ++fileGeneration.current;
        try {
            const dataUrl = await fileToDataUrl(file);
            if (currentGeneration !== fileGeneration.current) return;
            setUrl(dataUrl);
            setPreview(dataUrl);
        } catch {
            if (currentGeneration === fileGeneration.current) setError("Unable to read this image.");
        }
    }

    async function saveUserAvatar() {
        await persistAvatar(url.trim() || null);
    }

    async function deleteUserAvatar() {
        await persistAvatar(null);
    }

    async function persistAvatar(value: string | null) {
        if (busy.current) return;
        busy.current = true;
        fileGeneration.current++;
        setSaving(true);
        setError("");
        try {
            await saveAvatar(userId, value);
            modalProps.onClose();
        } catch {
            setError("Unable to save this avatar. Please try again.");
        } finally {
            busy.current = false;
            setSaving(false);
        }
    }

    const actions = [
        {
            text: "Save",
            variant: "primary",
            disabled: saving,
            onClick: saveUserAvatar
        }
    ];

    if (avatars[userId]) {
        actions.unshift({
            text: "Delete",
            variant: "dangerPrimary",
            disabled: saving,
            onClick: deleteUserAvatar
        });
    }

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Custom Avatar"
            actions={actions}
        >
            <div onKeyDown={handleKey}>
                {error && <p role="alert">{error}</p>}
                {/* Preview */}
                <div className={cl("preview-row")}>
                    <div className={cl("preview-box")}>
                        <span className={cl("preview-label")}>Original</span>
                        <img src={originalAvatar} className={cl("avatar")} alt="original" />
                    </div>
                    <span className={cl("arrow")}>→</span>
                    <div className={cl("preview-box")}>
                        <span className={cl("preview-label")}>Local</span>
                        <img
                            src={preview || originalAvatar}
                            className={`${cl("avatar")} ${preview ? cl("avatar-active") : ""}`}
                            alt="local"
                        />
                    </div>
                </div>

                {/* URL input */}
                <section className={Margins.bottom8}>
                    <Heading tag="h3">Enter PNG/GIF URL</Heading>
                    <TextInput
                        placeholder="https://example.com/image.png"
                        value={url.startsWith("data:") ? "(uploaded file)" : url}
                        onChange={handleUrlChange}
                        disabled={saving}
                        autoFocus
                    />
                </section>

                {/* Drag & drop */}
                <div
                    className={`${cl("dropzone")} ${isDragging ? cl("dropzone-active") : ""}`}
                    onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={e => {
                        e.preventDefault();
                        setIsDragging(false);
                        const file = e.dataTransfer.files?.[0];
                        if (file) handleFile(file);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                >
                    {isDragging ? "Drop here!" : "⬆ Drag an image or click to upload (for GIFs or WebP use a URL instead)"}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg"
                        style={{ display: "none" }}
                        onChange={e => {
                            const file = e.currentTarget.files?.[0];
                            if (file) handleFile(file);
                            e.currentTarget.value = "";
                        }}
                    />
                </div>
            </div>
        </Modal>
    );
}
