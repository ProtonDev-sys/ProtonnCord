/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { HeadingSecondary } from "@components/Heading";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { ColorPicker, Modal, React, showToast, useState } from "@webpack/common";

import { colors, updateCustomColor } from "./index";

const cl = classNameFactory("vc-customColors-");

export function SetColorModal({ id, modalProps }: { id: string, modalProps: RenderModalProps; }) {
    const storedColor = parseInt(colors[id], 16);
    const initialColor = Number.isNaN(storedColor) ? 372735 : storedColor;
    // color picker default to current color set for user (if null it's 0x05afff :3 )

    const [colorPickerColor, setColorPickerColor] = useState(initialColor);
    const saving = React.useRef(false);
    // hex color code as an int (NOT rgb 0-255)

    function setUserColor(color: number) {
        setColorPickerColor(color);
    }

    function handleKey(e: React.KeyboardEvent) {
        if (e.key === "Enter")
            saveUserColor();
    }

    async function persistColor(color?: string) {
        if (saving.current) return;
        saving.current = true;
        try {
            await updateCustomColor(id, color);
            modalProps.onClose();
        } catch (error) {
            console.error("Failed to save custom color:", error);
            showToast("Could not save custom color. Please try again.");
        } finally {
            saving.current = false;
        }
    }

    function saveUserColor() {
        return persistColor(colorPickerColor.toString(16).padStart(6, "0"));
    }

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Custom Color"
            actions={[
                {
                    text: "Save",
                    variant: "primary",
                    onClick: saveUserColor
                },
                {
                    text: "Delete Entry",
                    variant: "dangerPrimary",
                    onClick: () => persistColor()
                }
            ]}
        >
            <div onKeyDown={handleKey} className={cl("modal-content")}>
                <section className={Margins.bottom16}>
                    <HeadingSecondary>
                        Pick a Color
                    </HeadingSecondary>
                    <ColorPicker
                        color={colorPickerColor}
                        onChange={setUserColor}
                        showEyeDropper={false}
                    />
                </section>
            </div>
        </Modal>
    );
}
