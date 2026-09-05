/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { useAuthorizationStore } from "@plugins/decor/lib/stores/AuthorizationStore";
import { useCurrentUserDecorationsStore } from "@plugins/decor/lib/stores/CurrentUserDecorationsStore";
import { cl } from "@plugins/decor/ui";
import { openChangeDecorationModal } from "@plugins/decor/ui/modals/ChangeDecorationModal";
import { findComponentByCodeLazy } from "@webpack";
import { NewCustomizationSection, useEffect, useState } from "@webpack/common";

const CustomizationSection = findComponentByCodeLazy(".DESCRIPTION", "hasBackground:");

export interface DecorSectionProps {
    hideTitle?: boolean;
    hideDivider?: boolean;
    noMargin?: boolean;
    useNewSection?: boolean;
}

export default function DecorSection({ hideTitle = false, hideDivider = false, noMargin = false, useNewSection = false }: DecorSectionProps) {
    const authorization = useAuthorizationStore();
    const { selectedDecoration, select: selectDecoration, fetch: fetchDecorations, loading, busy, error: decorationError } = useCurrentUserDecorationsStore();
    const [error, setError] = useState<string | null>(null);
    const owner = authorization.authorization;
    const notice = error ?? authorization.error ?? decorationError;
    const showError = (error: unknown, expected = owner) => {
        if (useAuthorizationStore.getState().authorization === expected)
            setError(error instanceof Error ? error.message : "Could not change the decoration.");
    };

    useEffect(() => {
        setError(null);
        if (owner && authorization.isAuthorized()) fetchDecorations(owner).catch(showError);
    }, [owner]);

    const open = async () => {
        let expected = useAuthorizationStore.getState().authorization;
        try {
            expected = useAuthorizationStore.getState().requireAuthorization();
            await openChangeDecorationModal(expected);
        } catch (error) {
            showError(error, expected);
        }
    };

    const NewSection = useNewSection ? NewCustomizationSection : undefined;

    if (useNewSection && !NewSection) return null;

    const Section = (useNewSection ? NewCustomizationSection : CustomizationSection);
    const sectionProps = useNewSection
        ? { heading: hideTitle ? undefined : "Decor" }
        : {
            title: hideTitle ? undefined : "Decor",
            hasBackground: true,
            hideDivider,
            className: noMargin ? cl("section-remove-margin") : undefined
        };

    const changeLabel = useNewSection ? "Change" : "Change Decoration";
    const removeLabel = useNewSection ? "Remove" : "Remove Decoration";

    return (
        <Section {...sectionProps}>
            <Flex gap="4px">
                <Button
                    disabled={!authorization.ready || authorization.busy || busy}
                    onClick={() => {
                        setError(null);
                        if (!authorization.isAuthorized()) {
                            authorization.authorize().then(open, () => undefined);
                        } else {
                            open();
                        }
                    }}
                    variant="primary"
                    size="small"
                >
                    {changeLabel}
                </Button>
                {owner && selectedDecoration && authorization.isAuthorized() && (
                    <Button
                        disabled={loading || busy || authorization.busy}
                        onClick={() => {
                            setError(null);
                            selectDecoration(null, owner).catch(showError);
                        }}
                        variant="secondary"
                        size="small"
                    >
                        {removeLabel}
                    </Button>
                )}
            </Flex>
            {notice && <Paragraph role="alert">{notice}</Paragraph>}
        </Section>
    );
}
