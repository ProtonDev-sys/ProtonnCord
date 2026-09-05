/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Decoration, getPresets, Preset } from "@plugins/decor/lib/api";
import { INVITE_KEY } from "@plugins/decor/lib/constants";
import { Authorization, useAuthorizationStore } from "@plugins/decor/lib/stores/AuthorizationStore";
import { useCurrentUserDecorationsStore } from "@plugins/decor/lib/stores/CurrentUserDecorationsStore";
import { decorationToAvatarDecoration } from "@plugins/decor/lib/utils/decoration";
import { settings } from "@plugins/decor/settings";
import { cl, DecorationModalClasses, requireAvatarDecorationModal, requireDialogOwner, useDialogActions } from "@plugins/decor/ui";
import { AvatarDecorationModalPreview } from "@plugins/decor/ui/components";
import DecorationGridCreate from "@plugins/decor/ui/components/DecorationGridCreate";
import DecorationGridNone from "@plugins/decor/ui/components/DecorationGridNone";
import DecorDecorationGridDecoration from "@plugins/decor/ui/components/DecorDecorationGridDecoration";
import SectionedGridList from "@plugins/decor/ui/components/SectionedGridList";
import { copyWithToast } from "@utils/discord";
import { Margins } from "@utils/margins";
import { Queue } from "@utils/Queue";
import { RenderModalProps, User } from "@vencord/discord-types";
import { ConfirmModal, Forms, Modal, openModal, Parser, Tooltip, useEffect, UserStore, UserSummaryItem, UserUtils, useState } from "@webpack/common";

import { openCreateDecorationModal } from "./CreateDecorationModal";
import { openGuidelinesModal } from "./GuidelinesModal";

interface Section {
    title: string;
    subtitle?: string;
    sectionKey: string;
    items: ("none" | "create" | Decoration)[];
    authorIds?: string[];
}

interface SectionHeaderProps {
    section: Section;
}

const fetchAuthorsQueue = new Queue();

function SectionHeader({ section }: SectionHeaderProps) {
    const [authors, setAuthors] = useState<User[]>([]);

    useEffect(() => {
        let cancelled = false;
        setAuthors([]);
        fetchAuthorsQueue.push(async () => {
            for (const authorId of new Set(section.authorIds ?? [])) {
                if (cancelled) return;
                const author = UserStore.getUser(authorId) ?? await UserUtils.getUser(authorId).catch(() => null);
                if (cancelled) return;
                if (author == null) continue;

                setAuthors(authors => [...authors, author]);
            }
        });
        return () => { cancelled = true; };
    }, [section.authorIds]);

    return <div>
        <Flex>
            <Forms.FormTitle style={{ flexGrow: 1 }}>{section.title}</Forms.FormTitle>
            {section.authorIds?.length ? <UserSummaryItem
                users={authors}
                guildId={undefined}
                renderIcon={false}
                max={5}
                showDefaultAvatarsForNullUsers
                size={16}
                showUserPopout
                className={Margins.bottom8}
            /> : null}
        </Flex>
        {section.subtitle &&
            <Paragraph className={Margins.bottom8}>
                {section.subtitle}
            </Paragraph>
        }
    </div>;
}

function ChangeDecorationModal({ owner, ...props }: RenderModalProps & { owner: Authorization; }) {
    const actions = useDialogActions(props.onClose);
    const authorization = useAuthorizationStore();
    const [error, setError] = useState<string | null>(null);
    const isCurrent = authorization.authorization === owner && authorization.isAuthorized();
    const showError = (error: unknown) => setError(error instanceof Error ? error.message : "Could not change the decoration.");
    // undefined = not trying, null = none, Decoration = selected
    const [tryingDecoration, setTryingDecoration] = useState<Decoration | null | undefined>(undefined);
    const isTryingDecoration = typeof tryingDecoration !== "undefined";

    const avatarDecoration = tryingDecoration != null ? decorationToAvatarDecoration(tryingDecoration) : tryingDecoration;

    const {
        decorations,
        selectedDecoration,
        fetch: fetchUserDecorations,
        select: selectDecoration,
        busy,
        loading,
        error: decorationError
    } = useCurrentUserDecorationsStore();
    const notice = error ?? authorization.error ?? decorationError;

    useEffect(() => {
        fetchUserDecorations(owner).catch(showError);
    }, [owner]);

    useEffect(() => {
        if (!isCurrent) actions.close();
    }, [isCurrent]);

    const activeSelectedDecoration = isTryingDecoration ? tryingDecoration : selectedDecoration;
    const hasDecorationPendingReview = decorations.some(d => d.reviewed === false);

    const [presets, setPresets] = useState<Preset[]>([]);
    useEffect(() => {
        const controller = new AbortController();
        getPresets(controller.signal).then(presets => {
            if (!controller.signal.aborted) setPresets(presets);
        }).catch(error => {
            if (!controller.signal.aborted) showError(error);
        });
        return () => controller.abort();
    }, [owner]);
    const presetDecorations = presets.flatMap(preset => preset.decorations);

    const activeDecorationPreset = presets.find(preset => preset.id === activeSelectedDecoration?.presetId);

    const ownDecorations = decorations.filter(d => !presetDecorations.some(p => p.hash === d.hash));

    const data = [
        {
            title: "Your Decorations",
            subtitle: "You can delete your own decorations by right clicking on them.",
            sectionKey: "ownDecorations",
            items: ["none", ...ownDecorations, "create"]
        },
        ...presets.map(preset => ({
            title: preset.name,
            subtitle: preset.description || undefined,
            sectionKey: `preset-${preset.id}`,
            items: preset.decorations,
            authorIds: preset.authorIds
        }))
    ] as Section[];

    return <Modal
        {...props}
        onClose={actions.close}
        title="Change Decoration"
        notice={notice ? { type: "critical", message: notice } : undefined}
        size="lg"
        actions={[
            {
                text: busy ? "Close" : "Cancel",
                variant: "secondary",
                onClick: actions.close
            },
            {
                text: "Apply",
                variant: "primary",
                loading: busy,
                onClick: () => {
                    if (tryingDecoration === undefined || busy || loading || !isCurrent) return;
                    setError(null);
                    selectDecoration(tryingDecoration, owner).then(actions.close).catch(showError);
                },
                disabled: !isTryingDecoration || busy || loading || !isCurrent || authorization.busy
            }
        ]}
        preview={
            <div className={cl("modal-footer-btn-container", Margins.top8)}>
                <Tooltip text="Join Decor's Discord Server for notifications on your decoration's review, and when new presets are released">
                    {tooltipProps => <Link
                        {...tooltipProps}
                        href={`https://discord.gg/${INVITE_KEY}`}
                    >
                        Discord Server
                    </Link>}
                </Tooltip>
                <Button
                    disabled={busy || authorization.busy || !isCurrent}
                    onClick={() => {
                        openModal(modalProps => (
                            <ConfirmModal
                                {...modalProps}
                                title="Log Out"
                                subtitle="Are you sure you want to log out of Decor?"
                                confirmText="Log Out"
                                cancelText="Cancel"
                                onConfirm={() => {
                                    authorization.remove(owner).then(actions.close).catch(showError);
                                }}
                            />
                        ));
                    }}
                    variant="dangerSecondary"
                >
                    Log Out
                </Button>
            </div>
        }
    >
        <div className={cl("change-decoration-modal-content", DecorationModalClasses.modal)}>
            <SectionedGridList
                renderItem={item => {
                    if (typeof item === "string") {
                        switch (item) {
                            case "none":
                                return <DecorationGridNone
                                    className={cl("change-decoration-modal-decoration")}
                                    isSelected={activeSelectedDecoration === null}
                                    onSelect={() => setTryingDecoration(null)}
                                />;
                            case "create":
                                return <Tooltip text="You already have a decoration pending review" shouldShow={hasDecorationPendingReview}>
                                    {tooltipProps => <DecorationGridCreate
                                        className={cl("change-decoration-modal-decoration")}
                                        {...tooltipProps}
                                        onSelect={() => {
                                            if (hasDecorationPendingReview || busy || loading || !isCurrent) return;
                                            setError(null);
                                            const open = settings.store.agreedToGuidelines ? openCreateDecorationModal : openGuidelinesModal;
                                            const signal = actions.begin();
                                            open(owner, signal).catch(error => {
                                                if (!signal.aborted) showError(error);
                                            });
                                        }}
                                    />}
                                </Tooltip>;
                        }
                    } else {
                        return <Tooltip text={"Pending review"} shouldShow={item.reviewed === false}>
                            {tooltipProps => (
                                <DecorDecorationGridDecoration
                                    {...tooltipProps}
                                    className={cl("change-decoration-modal-decoration")}
                                    onSelect={item.reviewed !== false ? () => setTryingDecoration(item) : () => { }}
                                    isSelected={activeSelectedDecoration?.hash === item.hash}
                                    decoration={item}
                                    owner={owner}
                                />
                            )}
                        </Tooltip>;
                    }
                }}
                getItemKey={item => typeof item === "string" ? item : item.hash}
                getSectionKey={section => section.sectionKey}
                renderSectionHeader={section => <SectionHeader section={section} />}
                sections={data}
            />

            <div className={cl("change-decoration-modal-preview")}>
                <AvatarDecorationModalPreview
                    avatarDecoration={avatarDecoration}
                    user={UserStore.getCurrentUser()}
                />
                {activeDecorationPreset && <Forms.FormTitle>Part of the {activeDecorationPreset.name} Preset</Forms.FormTitle>}
                {activeSelectedDecoration &&
                    <BaseText
                        size="sm"
                        weight="semibold"
                        style={{ color: "var(--text-strong)" }}
                    >
                        {activeSelectedDecoration.alt}
                    </BaseText>
                }
                {activeSelectedDecoration?.authorId && (
                    <BaseText key={`createdBy-${activeSelectedDecoration.authorId}`}>
                        Created by {Parser.parse(`<@${activeSelectedDecoration.authorId}>`)}
                    </BaseText>
                )}
                {activeDecorationPreset && (
                    <Button onClick={() => copyWithToast(activeDecorationPreset.id).catch(showError)}>
                        Copy Preset ID
                    </Button>
                )}
            </div>

        </div>
    </Modal>;
}

export const openChangeDecorationModal = async (owner: Authorization, signal: AbortSignal) => {
    requireDialogOwner(owner, signal);
    await requireAvatarDecorationModal();
    requireDialogOwner(owner, signal);
    return openModal(props => <ChangeDecorationModal {...props} owner={owner} />);
};
