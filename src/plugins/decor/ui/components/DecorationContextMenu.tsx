/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CopyIcon, DeleteIcon } from "@components/Icons";
import { Decoration } from "@plugins/decor/lib/api";
import { Authorization, useAuthorizationStore } from "@plugins/decor/lib/stores/AuthorizationStore";
import { useCurrentUserDecorationsStore } from "@plugins/decor/lib/stores/CurrentUserDecorationsStore";
import { cl } from "@plugins/decor/ui";
import { copyWithToast } from "@utils/discord";
import { RenderModalProps } from "@vencord/discord-types";
import { ContextMenuApi, Menu, Modal, openModal, showToast, Toasts, useEffect, useState } from "@webpack/common";

interface DecorationActionProps {
    decoration: Decoration;
    owner: Authorization;
}

function DeleteDecorationModal({ decoration, owner, ...props }: DecorationActionProps & RenderModalProps) {
    const { delete: deleteDecoration, busy } = useCurrentUserDecorationsStore();
    const authorization = useAuthorizationStore();
    const [error, setError] = useState<string | null>(null);
    const isCurrent = authorization.authorization === owner && authorization.isAuthorized();
    useEffect(() => {
        if (!isCurrent) props.onClose();
    }, [isCurrent]);
    return <Modal
        {...props}
        title="Delete Decoration"
        subtitle={`Are you sure you want to delete ${decoration.alt ?? "this decoration"}?`}
        notice={error ? { type: "critical", message: error } : undefined}
        actions={[
            { text: busy ? "Close" : "Cancel", variant: "secondary", onClick: props.onClose },
            {
                text: "Delete",
                variant: "critical-primary",
                disabled: busy || !isCurrent || authorization.busy,
                loading: busy,
                onClick: () => {
                    if (busy || !isCurrent) return;
                    setError(null);
                    deleteDecoration(decoration.hash, owner).then(props.onClose)
                        .catch(error => setError(error instanceof Error ? error.message : "Could not delete the decoration."));
                }
            }
        ]}
    />;
}

export default function DecorationContextMenu({ decoration, owner }: DecorationActionProps) {
    const authorization = useAuthorizationStore();

    return <Menu.Menu
        navId={cl("decoration-context-menu")}
        onClose={ContextMenuApi.closeContextMenu}
        aria-label="Decoration Options"
    >
        <Menu.MenuItem
            id={cl("decoration-context-menu-copy-hash")}
            label="Copy Decoration Hash"
            icon={CopyIcon}
            action={() => copyWithToast(decoration.hash).catch(() => showToast("Could not copy the decoration hash.", Toasts.Type.FAILURE))}
        />
        {authorization.authorization === owner && authorization.isAuthorized() && decoration.authorId === owner.userId &&
            <Menu.MenuItem
                id={cl("decoration-context-menu-delete")}
                label="Delete Decoration"
                color="danger"
                icon={DeleteIcon}
                action={() => openModal(props => (
                    <DeleteDecorationModal {...props} decoration={decoration} owner={owner} />
                ))}
            />
        }
    </Menu.Menu>;
}
