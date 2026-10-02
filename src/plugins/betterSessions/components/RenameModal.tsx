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

import { TextButton } from "@components/Button";
import { Heading } from "@components/Heading";
import { SessionInfo } from "@plugins/betterSessions/types";
import { getDataKey, getDefaultName, isSessionCacheCurrent, notifySessionNames, savedSessionsCache, saveSessionsToDataStore } from "@plugins/betterSessions/utils";
import { Logger } from "@utils/Logger";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, TextInput, Toasts } from "@webpack/common";
import { KeyboardEvent } from "react";

export function RenameModal({ props, session }: { props: RenderModalProps; session: SessionInfo["session"]; }) {
    const [accountKey] = React.useState(getDataKey);
    const [value, setValue] = React.useState(savedSessionsCache.get(session.id_hash)?.name ?? "");
    const saving = React.useRef(false);

    async function onSaveClick() {
        if (saving.current) return;
        if (accountKey !== getDataKey() || !isSessionCacheCurrent()) {
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.FAILURE, message: "The account changed. Reopen the device settings to rename this session." });
            return;
        }
        const previous = savedSessionsCache.get(session.id_hash);
        const renamed = { name: value, isNew: false };
        saving.current = true;
        try {
            savedSessionsCache.set(session.id_hash, renamed);
            await saveSessionsToDataStore();
            props.onClose();
        } catch (error) {
            if (accountKey === getDataKey() && isSessionCacheCurrent() && savedSessionsCache.get(session.id_hash) === renamed) {
                if (previous) savedSessionsCache.set(session.id_hash, previous);
                else savedSessionsCache.delete(session.id_hash);
                notifySessionNames();
            }
            new Logger("BetterSessions").error("Failed to save session name", error);
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.FAILURE, message: "Could not save the session name. Try again." });
        } finally {
            saving.current = false;
        }
    }

    return (
        <Modal
            {...props}
            title="Rename"
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: () => props.onClose()
                },
                {
                    text: "Save",
                    variant: "primary",
                    onClick: onSaveClick
                }
            ]}
        >
            <div>
                <Heading tag="h5">New device name</Heading>
                <TextInput
                    aria-label="New device name"
                    style={{ marginBottom: "10px" }}
                    placeholder={getDefaultName(session.client_info)}
                    value={value}
                    onChange={setValue}
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            void onSaveClick();
                        }
                    }}
                />
                <TextButton
                    type="button"
                    style={{
                        paddingLeft: "1px",
                        opacity: 0.6
                    }}
                    onClick={() => setValue("")}
                >
                    Reset Name
                </TextButton>
            </div>
        </Modal>
    );
}
