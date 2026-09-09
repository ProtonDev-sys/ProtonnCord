/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Card } from "@components/Card";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { OptionType } from "@utils/types";
import { Forms, TextInput, Tooltip } from "@webpack/common";

import moreUserTags from ".";
import { Tag, tags } from "./consts";
import { TagSetting, TagSettings } from "./types";

function SettingsComponent() {
    const { tagSettings = {} as TagSettings } = settings.use(["tagSettings"]);
    const { localTags } = moreUserTags;

    const update = (name: typeof tags[number]["name"], value: Partial<TagSetting>) => {
        const current = settings.store.tagSettings;
        settings.store.tagSettings = {
            ...current,
            [name]: { text: tags.find(tag => tag.name === name)!.displayName, showInChat: true, showInNotChat: true, ...current?.[name], ...value }
        };
    };

    return (
        <Flex flexDirection="column">
            <div
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "16px",
                }}
            >
                {tags.map(t => (
                    <Card
                        key={t.name}
                        style={{
                            padding: "1em 1em 0",
                            width: "calc(33.333% - 11px)",
                            boxSizing: "border-box",
                        }}
                    >
                        <Forms.FormTitle style={{ width: "fit-content" }}>
                            <Tooltip text={t.description}>
                                {({ onMouseEnter, onMouseLeave }) => (
                                    <div
                                        onMouseEnter={onMouseEnter}
                                        onMouseLeave={onMouseLeave}
                                    >
                                        {t.displayName} Tag
                                    </div>
                                )}
                            </Tooltip>
                        </Forms.FormTitle>

                        <div style={{ marginBottom: "10px" }}>
                            <Paragraph style={{ fontSize: "13px" }}>
                                Example:
                            </Paragraph>
                            <Tag type={localTags[t.name]} />
                        </div>

                        <TextInput
                            type="text"
                            value={tagSettings[t.name]?.text ?? t.displayName}
                            placeholder={`Text on tag (default: ${t.displayName})`}
                            onChange={v => update(t.name, { text: v })}
                            className={Margins.bottom16}
                        />

                        <FormSwitch
                            title="Show in messages"
                            value={tagSettings[t.name]?.showInChat ?? true}
                            onChange={v => update(t.name, { showInChat: v })}
                            hideBorder
                        />

                        <FormSwitch
                            title="Show in member list and profiles"
                            value={tagSettings[t.name]?.showInNotChat ?? true}
                            onChange={v => update(t.name, { showInNotChat: v })}
                            hideBorder
                        />
                    </Card>
                ))}
            </div>
        </Flex>
    );
}

export const settings = definePluginSettings({
    dontShowForBots: {
        description: "Don't show extra tags for bots (excluding webhooks)",
        type: OptionType.BOOLEAN,
        default: false
    },
    dontShowBotTag: {
        description: "Only show extra tags for bots / Hide [APP] text",
        type: OptionType.BOOLEAN,
        default: false,
        restartNeeded: true
    },
    showWebhookTagFully: {
        description: "Show Webhook tag in followed channels like announcements",
        type: OptionType.BOOLEAN,
        default: false
    },
    tagSettings: {
        type: OptionType.COMPONENT,
        component: SettingsComponent,
        description: "fill me"
    },
    noAppsAllowed: {
        description: "Replaces app for bot",
        type: OptionType.BOOLEAN,
        default: false,
        restartNeeded: true
    }
});
