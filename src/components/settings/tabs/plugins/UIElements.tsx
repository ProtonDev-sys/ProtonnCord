/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./UIElements.css";

import { ChatBarButtonMap } from "@api/ChatButtons";
import { MessagePopoverButtonMap } from "@api/MessagePopover";
import { SettingsPluginUiElements, useSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { PlaceholderIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Switch } from "@components/Switch";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { IconComponent } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal } from "@webpack/common";

const cl = classNameFactory("vc-plugin-ui-elements-");

export function openUIElementsModal() {
    openModal(modalProps => <UIElementsModal {...modalProps} />);
}

function Section(props: {
    title: string;
    description: string;
    settings: SettingsPluginUiElements;
    buttonMap: Map<string, { icon: IconComponent; }>;
}) {
    const { buttonMap, description, title, settings } = props;

    const switches = Array.from(buttonMap, ([name, { icon }]) => {
        const Icon = icon ?? PlaceholderIcon;
        return (
            <BaseText size="md" weight="semibold" key={name} className={cl("switches-row")}>
                <ErrorBoundary noop><Icon height={20} width={20} /></ErrorBoundary>
                {name}
                <Switch
                    aria-label={name}
                    checked={settings[name]?.enabled ?? true}
                    onChange={v => {
                        settings[name] = { ...settings[name], enabled: v };
                    }}
                />
            </BaseText>
        );
    });

    return (
        <section>
            <BaseText tag="h3" size="lg" weight="semibold">{title}</BaseText>
            <Paragraph size="sm" className={classes(Margins.top8, Margins.bottom20)}>{description}</Paragraph>

            <div className={cl("switches")}>
                {switches.length === 0 && (
                    <Paragraph weight="medium" className={cl("switches-row")} style={{ color: "var(--text-muted)" }}>
                        Buttons of enabled plugins will appear here.
                    </Paragraph>
                )}
                {switches}
            </div>
        </section>
    );
}

function UIElementsModal(props: RenderModalProps) {
    const { uiElements } = useSettings(["uiElements.*"]);

    return (
        <Modal {...props} size="md" title="Manage plugin UI elements">
            <div className={cl("modal-content")}>
                <Section
                    title="Chatbar Buttons"
                    description="These are the buttons on the right side of the chat input bar"
                    buttonMap={ChatBarButtonMap}
                    settings={uiElements.chatBarButtons}
                />
                <Section
                    title="Message Popover Buttons"
                    description="These are the floating buttons on the right when you hover over a message"
                    buttonMap={MessagePopoverButtonMap}
                    settings={uiElements.messagePopoverButtons}
                />
            </div>
        </Modal>
    );
}
