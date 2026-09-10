/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Decoration } from "@plugins/decor/lib/api";
import { Authorization } from "@plugins/decor/lib/stores/AuthorizationStore";
import { decorationToAvatarDecoration } from "@plugins/decor/lib/utils/decoration";
import { ContextMenuApi } from "@webpack/common";
import type { HTMLProps } from "react";

import { DecorationGridDecoration } from ".";
import DecorationContextMenu from "./DecorationContextMenu";

interface DecorDecorationGridDecorationProps extends HTMLProps<HTMLDivElement> {
    decoration: Decoration;
    owner: Authorization;
    isSelected: boolean;
    onSelect: () => void;
}

export default function DecorDecorationGridDecoration(props: DecorDecorationGridDecorationProps) {
    const { decoration, owner, ...decorationProps } = props;

    return <DecorationGridDecoration
        {...decorationProps}
        onContextMenu={e => {
            ContextMenuApi.openContextMenu(e, () => (
                <DecorationContextMenu
                    decoration={decoration}
                    owner={owner}
                />
            ));
        }}
        avatarDecoration={decorationToAvatarDecoration(decoration)}
    />;
}
