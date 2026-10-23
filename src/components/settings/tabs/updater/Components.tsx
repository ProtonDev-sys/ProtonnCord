/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Flex } from "@components/Flex";
import { HeadingSecondary } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { UPDATER_BRANCHES, type UpdaterBranch } from "@shared/Updater";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { relaunch } from "@utils/native";
import { changes, checkForUpdates, getUpdateState, repair, subscribeToUpdates, update } from "@utils/updater";
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

export function Newer({ updates, ...props }: CommonProps & { updates: typeof changes; }) {
    return (
        <>
            <Paragraph>
                Your local branch contains commits that are not on the selected remote branch. Review these differences before updating.
            </Paragraph>
            <Changes {...props} updates={updates} />
        </>
    );
}

export function Updatable(props: CommonProps & { disabled?: boolean; }) {
    const settings = useSettings(["updateBranch"]);
    const state = React.useSyncExternalStore(subscribeToUpdates, getUpdateState);
    const { changes: updates, isOutdated, isNewer, hasChecked, needsRestart } = state;
    const [isActing, setIsActing] = useState(false);
    const mounted = React.useRef(false);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const isCurrent = () => mounted.current && state.branch === settings.updateBranch;
    const busy = isActing || state.isInstalling || state.isChecking;
    const disabled = props.disabled || busy;

    const installUpdate = (action: () => Promise<boolean>) => runWithDispatch(setIsActing, async () => {
        const updated = await action();
        if (!isCurrent()) return;
        if (!updated) {
            Toasts.show({
                message: "The update could not be installed. Check for updates and try again.",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }

        await new Promise<void>((resolve, reject) => {
            let confirmed = false;
            openModal(props => (
                <ConfirmModal
                    {...props}
                    title="Update Success!"
                    subtitle="Successfully updated. Restart now to apply the changes?"
                    confirmText="Restart"
                    cancelText="Not now!"
                    variant="primary"
                    onConfirm={() => {
                        confirmed = true;
                        if (!isCurrent()) return resolve();
                        return relaunch().then(resolve, reject);
                    }}
                    onCancel={resolve}
                />
            ), { onCloseCallback: () => { if (!confirmed) resolve(); } });
        });
    }, isCurrent);

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
                    settings.updateBranch = branch;
                }}
                isSelected={branch => branch === settings.updateBranch}
                serialize={branch => branch}
            />
            <Flex className={classes(Margins.top16, Margins.bottom8)} gap="8px">
                <Button
                    disabled={disabled}
                    onClick={runWithDispatch(setIsActing, async () => {
                        const outdated = await checkForUpdates();
                        if (!isCurrent()) return;
                        if (!outdated && !getUpdateState().isNewer) {
                            Toasts.show({
                                message: "No updates found!",
                                id: Toasts.genId(),
                                type: Toasts.Type.MESSAGE,
                                options: {
                                    position: Toasts.Position.BOTTOM
                                }
                            });
                        }
                    }, isCurrent)}
                >
                    Check for Updates
                </Button>
                {isOutdated && !isNewer && (
                    <Button
                        size="small"
                        variant="primary"
                        disabled={disabled}
                        onClick={installUpdate(update)}
                    >
                        Update Now
                    </Button>
                )}
                <Button disabled={disabled} onClick={installUpdate(repair)}>
                    Repair Installation
                </Button>
                {needsRestart && (
                    <Button disabled={disabled} onClick={runWithDispatch(setIsActing, relaunch, isCurrent)}>
                        Restart Discord
                    </Button>
                )}
            </Flex>
            {needsRestart && <Paragraph>An update has been installed. Restart Discord to apply it.</Paragraph>}
            {isNewer ? <Newer {...props} updates={updates} /> : isOutdated ? (
                <>
                    <Paragraph>
                        There {updates.length === 1 ? "is 1 update" : `are ${updates.length} updates`} available. Click the button above to download and install.
                    </Paragraph>
                    <Changes updates={updates} {...props} />
                </>
            ) : (
                <Paragraph>
                    {hasChecked
                        ? needsRestart
                            ? `The latest available version on ${settings.updateBranch} is installed.`
                            : `You're running the latest available version on ${settings.updateBranch}.`
                        : `Check for updates to see what's available on ${settings.updateBranch}.`}
                </Paragraph>
            )}
        </>
    );
}
