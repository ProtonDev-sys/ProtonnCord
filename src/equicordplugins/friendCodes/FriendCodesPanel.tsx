/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { BaseText } from "@components/BaseText";
import { Flex } from "@components/Flex";
import { Heading, HeadingTertiary } from "@components/Heading";
import { copyToClipboard } from "@utils/clipboard";
import { findByPropsLazy, findCssClassesLazy } from "@webpack";
import { Button, Parser, showToast, Toasts, useEffect, useRef, useState } from "@webpack/common";

import { FriendInvite } from "./types";

const FormStyles = findCssClassesLazy("header", "title", "emptyState");
const { createFriendInvite, getAllFriendInvites, revokeFriendInvites } = findByPropsLazy("createFriendInvite");

function CopyButton({ copyText, copiedText, onClick }) {
    const [copied, setCopied] = useState(false);
    const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timeout.current), []);

    const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        setCopied(true);
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => setCopied(false), 1000);
        onClick(e);
    };

    return (
        <Button
            onClick={handleButtonClick}
            color={copied ? Button.Colors.GREEN : Button.Colors.BRAND}
            size={Button.Sizes.SMALL}
            look={Button.Looks.FILLED}
        >
            {copied ? copiedText : copyText}
        </Button>
    );
}

function FriendInviteCard({ invite }: { invite: FriendInvite; }) {
    return (
        <div className="vc-friend-codes-card">
            <Flex justifyContent="start">
                <div className="vc-friend-codes-card-title">
                    <HeadingTertiary style={{ textTransform: "none" }}>
                        {invite.code}
                    </HeadingTertiary>
                    <span>
                        Expires {Parser.parse(`<t:${new Date(invite.expires_at).getTime() / 1000}:R>`)} • {invite.uses}/{invite.max_uses} uses
                    </span>
                </div>
                <Flex justifyContent="end">
                    <CopyButton
                        copyText="Copy"
                        copiedText="Copied!"
                        onClick={() => copyToClipboard(`https://discord.gg/${invite.code}`)}
                    />
                </Flex>
            </Flex>
        </div>
    );
}

export default function FriendCodesPanel() {
    const [invites, setInvites] = useState<FriendInvite[]>([]);
    const [loading, setLoading] = useState(true);
    const [mutating, setMutating] = useState(false);
    const mutationPending = useRef(false);
    const active = useRef(true);

    const mutate = async (operation: () => Promise<void>, failure: string) => {
        if (mutationPending.current || loading || !active.current) return;
        mutationPending.current = true;
        setMutating(true);
        try {
            await operation();
        } catch {
            if (active.current) showToast(failure, Toasts.Type.FAILURE);
        } finally {
            mutationPending.current = false;
            if (active.current) setMutating(false);
        }
    };

    useEffect(() => {
        active.current = true;
        getAllFriendInvites()
            .then(value => { if (active.current) setInvites(value); })
            .catch(() => { if (active.current) showToast("Failed to load friend codes.", Toasts.Type.FAILURE); })
            .finally(() => { if (active.current) setLoading(false); });
        return () => { active.current = false; };
    }, []);

    return (
        <>
            <header className={FormStyles.header}>
                <Heading
                    tag="h2"
                    className={FormStyles.title}
                >
                    Your Friend Codes
                </Heading>

                <Flex
                    style={{ marginBottom: "16px" }}
                    justifyContent="space-between"
                >
                    <h2 className="vc-friend-codes-info-header">{`Friend Codes - ${invites.length}`}</h2>
                    <Flex justifyContent="end">
                        <Button
                            color={Button.Colors.GREEN}
                            look={Button.Looks.FILLED}
                            disabled={loading || mutating}
                            onClick={() => mutate(async () => {
                                const invite: FriendInvite = await createFriendInvite();
                                if (active.current) setInvites(current => [...current, invite]);
                            }, "Failed to create a friend code.")}
                        >
                            Create Friend Code
                        </Button>
                        <Button
                            style={{ marginLeft: "8px" }}
                            color={Button.Colors.RED}
                            look={Button.Looks.FILLED}
                            disabled={loading || mutating || !invites.length}
                            onClick={() => mutate(async () => {
                                await revokeFriendInvites();
                                if (active.current) setInvites([]);
                            }, "Failed to revoke friend codes.")}
                        >
                            Revoke all Friend Codes
                        </Button>
                    </Flex>
                </Flex>
            </header>
            {loading ? (
                <BaseText
                    size="md"
                    weight="semibold"
                    className="vc-friend-codes-text"
                >
                    Loading...
                </BaseText>
            ) : invites.length === 0 ? (
                <BaseText
                    size="md"
                    weight="semibold"
                    className="vc-friend-codes-text"
                >
                    You don't have any friend codes yet
                </BaseText>
            ) : (
                <div style={{ marginTop: "16px", display: "flex", flexWrap: "wrap", gap: "16px", justifyContent: "space-evenly" }}>
                    {invites.map(invite => (
                        <FriendInviteCard key={invite.code} invite={invite} />
                    ))}
                </div>
            )}
        </>
    );
}
