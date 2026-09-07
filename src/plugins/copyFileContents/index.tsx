/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { CopyIcon, NoEntrySignIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { copyWithToast } from "@utils/discord";
import definePlugin from "@utils/types";
import { Toasts, Tooltip } from "@webpack/common";

export default definePlugin({
    name: "CopyFileContents",
    description: "Adds a button to text file attachments to copy their contents",
    tags: ["Utility"],
    authors: [Devs.Obsidian, Devs.Nuckyz],
    patches: [
        {
            find: "#{intl::PREVIEW_BYTES_LEFT}",
            replacement: [
                // Inline preview
                {
                    match: /fileContents:(\i),bytesLeft:(\i)\}\):null,/,
                    replace: "$&$self.addCopyButton({fileContents:$1,bytesLeft:$2}),"
                },
                // Modal
                {
                    match: /align:"\i"\}\),(?=\(0,\i\.jsx\)\(\i,\{wordWrap:\i,setWordWrap:\i)/,
                    replace: "$&$self.addCopyButton(arguments[0]),"
                }
            ]
        }
    ],

    addCopyButton: ErrorBoundary.wrap(({ fileContents, bytesLeft }: { fileContents: string, bytesLeft: number; }) => (
        <Tooltip text={bytesLeft > 0 ? "File too large to copy" : "Copy File Contents"}>
            {tooltipProps => (
                <Button
                    {...tooltipProps}
                    type="button"
                    variant="none"
                    size="iconOnly"
                    className="vc-cfc-button"
                    aria-label={bytesLeft > 0 ? "File too large to copy" : "Copy File Contents"}
                    aria-disabled={bytesLeft > 0}
                    onClick={async () => {
                        if (bytesLeft > 0) return;
                        try {
                            await copyWithToast(fileContents);
                        } catch {
                            Toasts.show({ id: Toasts.genId(), message: "Could not copy file contents", type: Toasts.Type.FAILURE });
                        }
                    }}
                >
                    {bytesLeft > 0
                        ? <NoEntrySignIcon width={18} height={18} color="var(--channel-icon)" />
                        : <CopyIcon width={18} height={18} />}
                </Button>
            )}
        </Tooltip>
    ), { noop: true }),
});
