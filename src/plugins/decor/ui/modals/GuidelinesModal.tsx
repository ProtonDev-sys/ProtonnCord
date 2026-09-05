/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Authorization, useAuthorizationStore } from "@plugins/decor/lib/stores/AuthorizationStore";
import { settings } from "@plugins/decor/settings";
import { DecorationModalClasses, requireAvatarDecorationModal } from "@plugins/decor/ui";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useEffect, useState } from "@webpack/common";

import { openCreateDecorationModal } from "./CreateDecorationModal";

function GuidelinesModal({ owner, ...props }: RenderModalProps & { owner: Authorization; }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const authorization = useAuthorizationStore();
    const isCurrent = authorization.authorization === owner && authorization.isAuthorized();
    useEffect(() => {
        if (!isCurrent) props.onClose();
    }, [isCurrent]);
    return (
        <Modal
            {...props}
            title="Hold on"
            notice={error ? { type: "critical", message: error } : undefined}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: props.onClose, disabled: busy },
                {
                    text: "Continue",
                    variant: "primary",
                    disabled: busy || !isCurrent,
                    onClick: async () => {
                        if (busy || !isCurrent) return;
                        setBusy(true);
                        setError(null);
                        try {
                            await openCreateDecorationModal(owner);
                            settings.store.agreedToGuidelines = true;
                            props.onClose();
                        } catch (error) {
                            setError(error instanceof Error ? error.message : "Could not open the decoration editor.");
                        } finally {
                            setBusy(false);
                        }
                    }
                }
            ]}
        >
            <div className={DecorationModalClasses.modal}>
                <Paragraph>
                    By submitting a decoration, you agree to <Link
                        href="https://github.com/decor-discord/.github/blob/main/GUIDELINES.md"
                    >
                        the guidelines
                    </Link>. Not reading these guidelines may get your account suspended from creating more decorations in the future.
                </Paragraph>
            </div>
        </Modal>
    );
}

export const openGuidelinesModal = async (owner: Authorization) => {
    useAuthorizationStore.getState().requireAuthorization(owner);
    await requireAvatarDecorationModal();
    useAuthorizationStore.getState().requireAuthorization(owner);
    return openModal(props => <GuidelinesModal {...props} owner={owner} />);
};
