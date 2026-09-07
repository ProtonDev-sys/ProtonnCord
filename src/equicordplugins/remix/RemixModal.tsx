/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, useEffect, useRef, useState } from "@webpack/common";

import { sendRemix } from ".";
import { exportImg } from "./editor/components/Canvas";
import { Editor } from "./editor/Editor";
import { SendIcon } from "./icons/SendIcon";

interface Props {
    modalProps: RenderModalProps;
    close: () => void;
    url?: string;
}

export default function RemixModal({ modalProps, close, url }: Props) {
    const generation = useRef(0);
    const pending = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => () => {
        generation.current++;
        pending.current = false;
    }, []);

    function dismiss() {
        generation.current++;
        pending.current = false;
        close();
    }

    async function send() {
        if (pending.current) return;
        const owner = generation.current;
        pending.current = true;
        setBusy(true);
        setError(null);
        try {
            const blob = await exportImg();
            if (owner !== generation.current) return;
            await sendRemix(blob);
            if (owner === generation.current) dismiss();
        } catch {
            if (owner === generation.current) setError("Could not prepare the image. Check the image and crop, then try again.");
        } finally {
            if (owner === generation.current) {
                pending.current = false;
                setBusy(false);
            }
        }
    }

    return (
        <Modal
            {...modalProps}
            onClose={dismiss}
            size="lg"
            title="Remix"
            notice={error ? { message: error, type: "critical" } : undefined}
            actions={[
                {
                    text: (
                        <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <SendIcon /> Send
                        </span>
                    ) as any,
                    variant: "primary",
                    disabled: busy,
                    loading: busy,
                    onClick: send
                },
                {
                    text: "Close",
                    variant: "dangerPrimary",
                    onClick: dismiss
                }
            ]}
        >
            <Editor url={url} />
        </Modal>
    );
}
