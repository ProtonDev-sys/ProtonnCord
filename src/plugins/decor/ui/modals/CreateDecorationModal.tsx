/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { INVITE_KEY, RAW_SKU_ID } from "@plugins/decor/lib/constants";
import { Authorization, useAuthorizationStore } from "@plugins/decor/lib/stores/AuthorizationStore";
import { useCurrentUserDecorationsStore } from "@plugins/decor/lib/stores/CurrentUserDecorationsStore";
import { validateDecorationFile } from "@plugins/decor/lib/utils/decoration";
import { cl, DecorationModalClasses, requireAvatarDecorationModal, requireCreateStickerModal, requireDialogOwner, useDialogActions } from "@plugins/decor/ui";
import { AvatarDecorationModalPreview } from "@plugins/decor/ui/components";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { filters, findComponentByCodeLazy, mapMangledModuleLazy } from "@webpack";
import { Modal, openModal, TextInput, useEffect, useMemo, UserStore, useState } from "@webpack/common";

const FileUpload = findComponentByCodeLazy(".currentTarget.files", "lineClamp:1");

const { HelpMessage, HelpMessageTypes } = mapMangledModuleLazy('POSITIVE="positive', {
    HelpMessageTypes: filters.byProps("POSITIVE", "WARNING", "INFO"),
    HelpMessage: filters.byCode("messageType:")
});

function useObjectURL(file: File | null) {
    const [preview, setPreview] = useState<{ file: File; url: string; } | null>(null);

    useEffect(() => {
        if (!file) {
            setPreview(null);
            return;
        }

        const url = URL.createObjectURL(file);
        setPreview({ file, url });

        return () => URL.revokeObjectURL(url);
    }, [file]);

    return preview && preview.file === file ? preview.url : null;
}

function CreateDecorationModal({ owner, ...props }: RenderModalProps & { owner: Authorization; }) {
    const actions = useDialogActions(props.onClose);
    const [name, setName] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [error, setError] = useState<string | null>(null);
    const authorization = useAuthorizationStore();
    const isCurrent = authorization.authorization === owner && authorization.isAuthorized();

    useEffect(() => {
        if (!isCurrent) actions.close();
    }, [isCurrent]);

    const { create: createDecoration, busy } = useCurrentUserDecorationsStore();

    const fileUrl = useObjectURL(file);

    const decoration = useMemo(() => fileUrl ? { asset: fileUrl, skuId: RAW_SKU_ID } : null, [fileUrl]);

    return <Modal
        {...props}
        onClose={actions.close}
        size="lg"
        title="Create Decoration"
        actions={[
            {
                text: busy ? "Close" : "Cancel",
                variant: "secondary",
                onClick: actions.close
            },
            {
                text: "Submit for Review",
                variant: "primary",
                loading: busy,
                onClick: () => {
                    if (!file || !name.trim() || busy || !isCurrent) return;
                    setError(null);
                    createDecoration({ alt: name, file }, owner)
                        .then(actions.close).catch(error => setError(error instanceof Error ? error.message : "Could not submit the decoration."));
                },
                disabled: !file || !name.trim() || busy || !isCurrent || authorization.busy
            }
        ]}
    >
        <div className={cl("create-decoration-modal-content", DecorationModalClasses.modal)}>
            <ErrorBoundary>
                <HelpMessage messageType={HelpMessageTypes.WARNING}>
                    Make sure your decoration does not violate <Link
                        href="https://github.com/decor-discord/.github/blob/main/GUIDELINES.md"
                    >
                        the guidelines
                    </Link> before submitting it.
                </HelpMessage>
                <div className={cl("create-decoration-modal-form-preview-container")}>
                    <div className={cl("create-decoration-modal-form")}>
                        {error !== null && <BaseText size="xs" color="text-danger" role="alert">{error}</BaseText>}
                        <section>
                            <Heading>File</Heading>
                            {busy ? <Paragraph>{file?.name}</Paragraph> : <FileUpload
                                filename={file?.name}
                                placeholder="Choose a file"
                                buttonText="Browse"
                                filters={[{ name: "Decoration file", extensions: ["png", "apng"] }]}
                                onFileSelect={async (selected: File | null) => {
                                    if (useCurrentUserDecorationsStore.getState().busy) return;
                                    const signal = actions.begin();
                                    setFile(null);
                                    setError(null);
                                    if (!selected) return;
                                    try {
                                        await validateDecorationFile(selected);
                                        if (!signal.aborted) setFile(selected);
                                    } catch (error) {
                                        if (!signal.aborted) setError(error instanceof Error ? error.message : "Could not read the decoration file.");
                                    }
                                }}
                            />}
                            <Paragraph className={Margins.top8}>
                                Choose a square PNG or APNG image.
                            </Paragraph>
                        </section>
                        <section>
                            <Heading>Name</Heading>
                            <TextInput
                                placeholder="Companion Cube"
                                value={name}
                                disabled={busy}
                                onChange={value => {
                                    if (useCurrentUserDecorationsStore.getState().busy) return;
                                    setName(value);
                                }}
                            />
                            <Paragraph className={Margins.top8}>
                                This name will be used when referring to this decoration.
                            </Paragraph>
                        </section>
                    </div>
                    <div>
                        <AvatarDecorationModalPreview
                            avatarDecoration={decoration}
                            user={UserStore.getCurrentUser()}
                        />
                    </div>
                </div>
                <HelpMessage messageType={HelpMessageTypes.INFO} className={Margins.bottom8}>
                    To receive updates on your decoration's review, join <Link
                        href={`https://discord.gg/${INVITE_KEY}`}
                    >
                        Decor's Discord server
                    </Link> and allow direct messages.
                </HelpMessage>
            </ErrorBoundary>
        </div>
    </Modal>;
}

export const openCreateDecorationModal = async (owner: Authorization, signal: AbortSignal) => {
    requireDialogOwner(owner, signal);
    await Promise.all([requireAvatarDecorationModal(), requireCreateStickerModal()]);
    requireDialogOwner(owner, signal);
    return openModal(props => <CreateDecorationModal {...props} owner={owner} />);
};
