/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { ErrorCard } from "@components/ErrorCard";
import { Flex } from "@components/Flex";
import { HeadingSecondary } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { UPDATER_BRANCHES, type UpdaterBranch } from "@shared/Updater";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { relaunch } from "@utils/native";
import { changes, checkForUpdates, isNewer, resetUpdateState, update, updateError } from "@utils/updater";
import { ConfirmModal, openModal, React, Select, Toasts, useState } from "@webpack/common";

import { runWithDispatch } from "./runWithDispatch";

export interface CommonProps {
    repo: string;
    repoPending: boolean;
}

const UPDATE_BRANCH_LABELS: Record<UpdaterBranch, string> = {
    main: "Main (stable)",
    nightly: "Nightly (latest previews)",
    staging: "Staging (tested previews)",
};
const UPDATE_BRANCH_OPTIONS = UPDATER_BRANCHES.map(branch => ({
    label: UPDATE_BRANCH_LABELS[branch],
    value: branch,
}));

export function HashLink({ repo, hash, disabled = false }: { repo: string, hash: string, disabled?: boolean; }) {
    return (
        <Link href={`${repo}/commit/${hash}`} disabled={disabled}>
            {hash.slice(0, 7)}
        </Link>
    );
}

export function Changes({ updates, repo, repoPending }: CommonProps & { updates: typeof changes; }) {
    return (
        <Card className={Margins.top16} style={{ padding: 0 }} defaultPadding={false}>
            {updates.map(({ hash, author, message }, i) => (
                <div
                    key={hash}
                    style={{
                        padding: "12px 16px",
                        borderBottom: i < updates.length - 1 ? "1px solid var(--border-subtle)" : undefined
                    }}
                >
                    <Flex style={{ alignItems: "center", gap: 8 }}>
                        <code style={{ color: "var(--text-link)" }}>
                            <HashLink {...{ repo, hash }} disabled={repoPending} />
                        </code>
                        <Span size="sm" color="text-default">
                            {message}
                        </Span>
                        <Span size="sm" color="text-subtle">
                            — {author}
                        </Span>
                    </Flex>
                </div>
            ))}
        </Card>
    );
}

export function Newer(props: CommonProps) {
    return (
        <>
            <Paragraph>
                Your local copy has more recent commits than the remote repository. This usually happens when you've made local changes. Please stash or reset them before updating.
            </Paragraph>
            <Changes {...props} updates={changes} />
        </>
    );
}

export function Updatable(props: CommonProps & { disabled?: boolean; onBusyChange?(busy: boolean): void; }) {
    const settings = useSettings(["updateBranch"]);
    const [updates, setUpdates] = useState(changes);
    const [isChecking, setIsChecking] = useState(false);
    const [isUpdating, setIsUpdating] = useState(false);
    const [hasChecked, setHasChecked] = useState(false);
    const busy = isUpdating || isChecking;
    const disabled = props.disabled || busy;

    React.useEffect(() => {
        props.onBusyChange?.(busy);
    }, [busy, props.onBusyChange]);

    const isOutdated = (updates?.length ?? 0) > 0;

    return (
        <>
            <HeadingSecondary>Update branch</HeadingSecondary>
            <Paragraph className={Margins.bottom8}>
                Main is stable. Staging contains tested previews, while Nightly follows the latest preview work. Select a branch, check for updates, then install the available update.
            </Paragraph>
            <Select
                placeholder="Main (stable)"
                options={UPDATE_BRANCH_OPTIONS}
                isDisabled={disabled}
                closeOnSelect={true}
                select={(branch: UpdaterBranch) => {
                    if (disabled || settings.updateBranch === branch) return;
                    resetUpdateState();
                    settings.updateBranch = branch;
                }}
                isSelected={branch => branch === settings.updateBranch}
                serialize={branch => branch}
            />
            <Flex className={classes(Margins.top16, Margins.bottom8)} gap="8px">
                <Button
                    disabled={disabled}
                    onClick={runWithDispatch(setIsChecking, async () => {
                        const outdated = await checkForUpdates();
                        setHasChecked(true);

                        if (outdated || isNewer) {
                            setUpdates(changes);
                        } else {
                            setUpdates([]);

                            Toasts.show({
                                message: "No updates found!",
                                id: Toasts.genId(),
                                type: Toasts.Type.MESSAGE,
                                options: {
                                    position: Toasts.Position.BOTTOM
                                }
                            });
                        }
                    })}
                >
                    Check for Updates
                </Button>
                {isOutdated && !isNewer && (
                    <Button
                        size="small"
                        variant="primary"
                        disabled={disabled}
                        onClick={runWithDispatch(setIsUpdating, async () => {
                            if (await update()) {
                                setUpdates([]);

                                await new Promise<void>(r => {
                                    openModal(props => (
                                        <ConfirmModal
                                            {...props}
                                            title="Update Success!"
                                            subtitle="Successfully updated. Restart now to apply the changes?"
                                            confirmText="Restart"
                                            cancelText="Not now!"
                                            variant="primary"
                                            onConfirm={() => {
                                                relaunch();
                                                r();
                                            }}
                                            onCancel={r}
                                        />
                                    ));
                                });
                            }
                        })}
                    >
                        Update Now
                    </Button>
                )}
            </Flex>
            {isNewer ? <Newer {...props} /> : !updates && updateError ? (
                <>
                    <Span size="md" weight="medium" color="text-strong">Error checking for updates</Span>
                    <ErrorCard className={Margins.top8} style={{ padding: "1em" }}>
                        <p>{updateError.stderr || updateError.stdout || updateError.message || "An unknown error occurred"}</p>
                    </ErrorCard>
                </>
            ) : isOutdated ? (
                <>
                    <Paragraph>
                        There {updates.length === 1 ? "is 1 update" : `are ${updates.length} updates`} available. Click the button above to download and install.
                    </Paragraph>
                    <Changes updates={updates} {...props} />
                </>
            ) : (
                <Paragraph>
                    {hasChecked
                        ? `You're running the latest available version on ${settings.updateBranch}.`
                        : `Check for updates to see what's available on ${settings.updateBranch}.`}
                </Paragraph>
            )}
        </>
    );
}
