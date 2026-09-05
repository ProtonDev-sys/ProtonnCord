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
import { GUILD_ID, INVITE_KEY, RAW_SKU_ID } from "@plugins/decor/lib/constants";
import { Authorization, useAuthorizationStore } from "@plugins/decor/lib/stores/AuthorizationStore";
import { useCurrentUserDecorationsStore } from "@plugins/decor/lib/stores/CurrentUserDecorationsStore";
import { cl, DecorationModalClasses, requireAvatarDecorationModal, requireCreateStickerModal } from "@plugins/decor/ui";
import { AvatarDecorationModalPreview } from "@plugins/decor/ui/components";
import { openInviteModal } from "@utils/discord";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { filters, findComponentByCodeLazy, mapMangledModuleLazy } from "@webpack";
import { closeAllModals, FluxDispatcher, GuildStore, Modal, NavigationRouter, openModal, TextInput, useEffect, useMemo, UserStore, useState } from "@webpack/common";

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
    const [name, setName] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [error, setError] = useState<string | null>(null);
    const authorization = useAuthorizationStore();
    const isCurrent = authorization.authorization === owner && authorization.isAuthorized();

    useEffect(() => {
        setError(null);
    }, [file, name]);

    useEffect(() => {
        if (!isCurrent) props.onClose();
    }, [isCurrent]);

    const { create: createDecoration, busy } = useCurrentUserDecorationsStore();

    const fileUrl = useObjectURL(file);

    const decoration = useMemo(() => fileUrl ? { asset: fileUrl, skuId: RAW_SKU_ID } : null, [fileUrl]);

    return <Modal
        {...props}
        size="lg"
        title="Create Decoration"
        actions={[
            {
                text: "Cancel",
                variant: "secondary",
                onClick: props.onClose
            },
            {
                text: "Submit for Review",
                variant: "primary",
                loading: busy,
                onClick: () => {
                    if (!file || !name.trim() || busy || !isCurrent) return;
                    setError(null);
                    createDecoration({ alt: name.trim(), file }, owner)
                        .then(props.onClose).catch(error => setError(error instanceof Error ? error.message : "Could not submit the decoration."));
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
                            <FileUpload
                                filename={file?.name}
                                placeholder="Choose a file"
                                buttonText="Browse"
                                filters={[{ name: "Decoration file", extensions: ["png", "apng"] }]}
                                onFileSelect={setFile}
                            />
                            <Paragraph className={Margins.top8}>
                                File should be APNG or PNG.
                            </Paragraph>
                        </section>
                        <section>
                            <Heading>Name</Heading>
                            <TextInput
                                placeholder="Companion Cube"
                                value={name}
                                onChange={setName}
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
                        onClick={async e => {
                            e.preventDefault();
                            if (!GuildStore.getGuild(GUILD_ID)) {
                                const inviteAccepted = await openInviteModal(INVITE_KEY);
                                if (inviteAccepted) {
                                    closeAllModals();
                                    FluxDispatcher.dispatch({ type: "LAYER_POP_ALL" });
                                }
                            } else {
                                closeAllModals();
                                FluxDispatcher.dispatch({ type: "LAYER_POP_ALL" });
                                NavigationRouter.transitionToGuild(GUILD_ID);
                            }
                        }}
                    >
                        Decor's Discord server
                    </Link> and allow direct messages.
                </HelpMessage>
            </ErrorBoundary>
        </div>
    </Modal>;
}

export const openCreateDecorationModal = async (owner: Authorization) => {
    useAuthorizationStore.getState().requireAuthorization(owner);
    await Promise.all([requireAvatarDecorationModal(), requireCreateStickerModal()]);
    useAuthorizationStore.getState().requireAuthorization(owner);
    return openModal(props => <CreateDecorationModal {...props} owner={owner} />);
};
