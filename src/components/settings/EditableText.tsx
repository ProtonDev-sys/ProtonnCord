/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { React, useState } from "@webpack/common";

interface EditableTextProps {
    value: string;
    onChange: (newValue: string) => void;
    className?: string;
}

export function EditableText({ value, onChange, className }: EditableTextProps) {
    const [editing, setEditing] = useState(false);
    return editing ? (
        <input
            autoFocus
            className={className}
            defaultValue={value}
            onBlur={e => {
                setEditing(false);
                if (e.currentTarget.value !== value) onChange(e.currentTarget.value);
            }}
            onKeyDown={e => {
                if (e.key === "Enter" || e.key === "Escape") {
                    e.preventDefault();
                    if (e.key === "Escape") e.currentTarget.value = value;
                    e.currentTarget.blur();
                }
            }}
        />
    ) : (
        <BaseText
            className={className}
            onClick={() => setEditing(true)}
            style={{ cursor: "pointer" }}
        >
            {value}
        </BaseText>
    );
}
