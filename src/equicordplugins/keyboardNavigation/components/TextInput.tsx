/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React, TextInput, useEffect, useState } from "@webpack/common";

interface SimpleTextInputProps {
    modalProps: RenderModalProps;
    onSelect: (inputValue: string) => void;
    placeholder?: string;
    info?: string;
}

export function SimpleTextInput({ modalProps, onSelect, placeholder, info }: SimpleTextInputProps) {
    const [inputValue, setInputValue] = useState("");

    const handleKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case "Enter":
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                onSelect(inputValue);
                modalProps.onClose();
                break;
            default:
                break;
        }
    };

    useEffect(() => {
        setInputValue("");
    }, []);

    return (
        <Modal {...modalProps} size="sm" title="Text Input">
            <div className="vc-keyboard-navigation-simple-text" onKeyDown={handleKeyDown}>
                <TextInput
                    autoFocus
                    value={inputValue}
                    onChange={e => setInputValue(e as unknown as string)}
                    style={{ width: "100%", borderRadius: "5px" }}
                    placeholder={placeholder ?? "Type and press Enter"}
                />
                {info && <div className="vc-keyboard-navigation-textinfo">{info}</div>}
            </div>
        </Modal>
    );
}

export function openSimpleTextInput(placeholder?: string, info?: string): Promise<string | null> {
    return new Promise(resolve => {
        openModal(modalProps => (
            <SimpleTextInput
                modalProps={modalProps}
                onSelect={inputValue => resolve(inputValue)}
                placeholder={placeholder}
                info={info}
            />
        ), { onCloseCallback: () => resolve(null) });
    });
}
