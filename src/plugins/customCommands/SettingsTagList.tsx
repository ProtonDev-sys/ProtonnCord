/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Flex } from "@components/Flex";
import { DeleteIcon, PencilIcon } from "@components/Icons";
import { Margins } from "@components/margins";
import { Paragraph } from "@components/Paragraph";

import { openCreateTagModal } from "./CreateTagModal";
import { getTags, removeTag, settings } from "./settings";

const SETTINGS_KEYS: ["tagsList"] = ["tagsList"];

export function SettingsTagList() {
    const { tagsList } = settings.use(SETTINGS_KEYS);

    return (
        <section className={Margins.top8}>
            <BaseText size="md" weight="semibold">Registered Tags</BaseText>
            <Flex flexDirection="column" gap="0.5em" className={Margins.top8}>
                {getTags(tagsList).map(tag => (
                    <Card key={tag.name} className="vc-customCommands-card">
                        <Paragraph size="md" weight="medium">{tag.name}</Paragraph>

                        <Button aria-label={`Edit ${tag.name}`} variant="secondary" size="iconOnly" onClick={() => openCreateTagModal(tag)}>
                            <PencilIcon width={20} height={20} />
                        </Button>
                        <Button aria-label={`Delete ${tag.name}`} variant="dangerSecondary" size="iconOnly" onClick={() => removeTag(tag.name)}>
                            <DeleteIcon width={20} height={20} />
                        </Button>
                    </Card>
                ))}
                <Button onClick={() => openCreateTagModal()}>Create Tag</Button>
            </Flex>
        </section>
    );
}
