/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { SessionInfo } from "@plugins/betterSessions/types";
import { cl } from "@plugins/betterSessions/utils";
import { openModal } from "@webpack/common";

import { RenameModal } from "./RenameModal";

export function RenameButton({ session, disabled }: { session: SessionInfo["session"]; disabled: boolean; }) {
    return (
        <Button
            variant="secondary"
            size="xs"
            className={cl("rename-btn")}
            disabled={disabled}
            onClick={() =>
                openModal(props => (
                    <RenameModal
                        props={props}
                        session={session}
                    />
                ))
            }
        >
            Rename
        </Button>
    );
}
