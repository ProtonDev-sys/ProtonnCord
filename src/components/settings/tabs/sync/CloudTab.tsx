/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { showNotification } from "@api/Notifications";
import { useSettings } from "@api/Settings";
import { parseCloudBackendUrl } from "@api/SettingsSync/cloudPolicy";
import { authorizeCloud, cancelCloudAuthorization, deauthorizeCloud, getCloudUserId } from "@api/SettingsSync/cloudSetup";
import { deleteCloudSettings, eraseAllCloudData, getCloudSettings, putCloudSettings, runCloudOperation } from "@api/SettingsSync/cloudSync";
import { Button } from "@components/Button";
import { CheckedTextInput } from "@components/CheckedTextInput";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { CloudDownloadIcon, CloudUploadIcon, SkullIcon } from "@components/Icons";
import { Link } from "@components/Link";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { localStorage } from "@utils/localStorage";
import { Margins } from "@utils/margins";
import { useForceUpdater } from "@utils/react";
import { findComponentByCodeLazy } from "@webpack";
import { Alerts, SearchableSelect, Select, useState } from "@webpack/common";

const ICON_STYLE: React.CSSProperties = { width: 20, height: 20, borderRadius: 4, verticalAlign: "middle" };

function ProtonnCordIcon() {
    return <img src="https://raw.githubusercontent.com/ProtonDev-sys/ProtonnCord/refs/heads/main/browser/icon.png" alt="Protonn Cord" style={ICON_STYLE} />;
}

function VencordIcon() {
    return <img src="https://raw.githubusercontent.com/Vendicated/Vencord/main/browser/icon.png" alt="Vencord" style={ICON_STYLE} />;
}

const RefreshIcon = findComponentByCodeLazy("M4 12a8 8 0 0 1 14.93-4H15");
const TrashIcon = findComponentByCodeLazy("2.81h8.36a3");

function validateUrl(url: string) {
    try {
        parseCloudBackendUrl(url);
        return true;
    } catch {
        return "Enter an HTTPS origin without credentials, a path, query, or fragment";
    }
}

const cloudBackendOptions = [
    { label: "Protonn Cord Cloud", value: "https://cloud.equicord.org/" },
    { label: "Vencord Cloud", value: "https://api.vencord.dev/" }
];

const syncDirectionOptions = [
    { label: "Two-way sync (changes go both directions)", value: "both" },
    { label: "This device is the source (upload only)", value: "push" },
    { label: "The cloud is the source (download only)", value: "pull" },
    { label: "Do not sync automatically (manual sync via buttons below only)", value: "manual" }
];

function canonicalCloudUrl(value: string) {
    try {
        return parseCloudBackendUrl(value).href;
    } catch {
        return undefined;
    }
}

function notifyCloudActionFailure() {
    showNotification({
        title: "Cloud Integration",
        body: "The cloud action could not be completed.",
        color: "var(--red-360)",
        noPersist: true,
    });
}

function CloudTab() {
    const settings = useSettings(["cloud.authenticated", "cloud.url", "cloud.settingsSync"]);
    const [inputKey, setInputKey] = useState(0);
    const forceUpdate = useForceUpdater();

    const { cloud } = settings;
    const [pendingUrl, setPendingUrl] = useState(cloud.url);
    const isAuthenticated = cloud.authenticated;
    const syncEnabled = isAuthenticated && cloud.settingsSync;

    async function changeUrl(url: string, reauthorize: boolean) {
        const initiatingUserId = getCloudUserId();
        let previousOrigin: string | undefined;
        try {
            previousOrigin = new URL(cloud.url).origin;
        } catch { }
        return await runCloudOperation(async signal => {
            if (getCloudUserId() !== initiatingUserId || previousOrigin && new URL(cloud.url).origin !== previousOrigin) return;
            cancelCloudAuthorization();
            const canonicalUrl = parseCloudBackendUrl(url).href;
            if (canonicalUrl === canonicalCloudUrl(cloud.url)) {
                setPendingUrl(canonicalUrl);
                return;
            }

            cloud.url = canonicalUrl;
            cloud.authenticated = false;
            if (reauthorize && getCloudUserId() === initiatingUserId && new URL(cloud.url).href === canonicalUrl)
                await authorizeCloud(signal);

            setPendingUrl(canonicalUrl);
            if (reauthorize) setInputKey(prev => prev + 1);
        });
    }

    return (
        <SettingsTab>
            <Heading className={Margins.top16}>Cloud Integration</Heading>
            <Paragraph className={Margins.bottom16}>
                Sync a privacy-filtered subset of Protonn Cord preferences across devices. The cloud backend can read synced preferences and QuickCSS; credentials, private plugin configuration, and DataStore content stay on this device.
            </Paragraph>

            <Notice.Info className={Margins.bottom16}>
                Protonn Cord can use a compatible cloud backend with enhanced features.
                View the <Link href="https://equicord.org/cloud/policy">cloud privacy policy</Link> to see what it stores and how it uses your data.
                The backend is BSD 3.0 licensed, so you can self-host if preferred.
            </Notice.Info>

            <Notice.Warning className={Margins.bottom16}>
                Older clients may have uploaded credentials that this client cannot verify or erase automatically. Update every client, request provider-side deletion on each former backend that is still reachable over a valid HTTPS origin, and rotate previously synced API keys, passwords, and tokens. Local-only fields must be entered again on each device.
            </Notice.Warning>

            <FormSwitch
                title="Enable Cloud Integration"
                description="Connect to the cloud backend for settings synchronization. This will request authorization if you haven't set up cloud integration yet."
                value={isAuthenticated}
                onChange={v => {
                    if (v) {
                        void runCloudOperation(signal => authorizeCloud(signal)).catch(notifyCloudActionFailure);
                    } else {
                        cancelCloudAuthorization();
                        cloud.authenticated = false;
                    }
                }}
                hideBorder
            />

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Cloud Backend</Heading>
            <Paragraph className={Margins.bottom16}>
                Choose which cloud backend to use for storing your settings. You can switch between Protonn Cord's and Vencord's cloud services, or use a self-hosted instance.
            </Paragraph>

            <div className={Margins.bottom8}>
                <SearchableSelect
                    options={cloudBackendOptions}
                    value={cloudBackendOptions.find(o => o.value === cloud.url)?.value}
                    onChange={v => { void changeUrl(v, true).catch(notifyCloudActionFailure); }}
                    closeOnSelect={true}
                    renderOptionPrefix={o => o?.value?.includes("equicord") ? <ProtonnCordIcon /> : <VencordIcon />}
                />
            </div>

            <Flex gap="8px" alignItems="center">
                <div style={{ flex: 1 }}>
                    <CheckedTextInput
                        key={`backendUrl-${inputKey}`}
                        initialValue={cloud.url}
                        onChange={setPendingUrl}
                        validate={validateUrl}
                    />
                </div>
                <Button
                    disabled={!canonicalCloudUrl(pendingUrl) || canonicalCloudUrl(pendingUrl) === canonicalCloudUrl(cloud.url)}
                    onClick={() => { void changeUrl(pendingUrl, false).catch(notifyCloudActionFailure); }}
                >
                    Apply
                </Button>
                <Button
                    disabled={!isAuthenticated}
                    onClick={async () => {
                        try {
                            const initiatingUserId = getCloudUserId();
                            let initiatingOrigin: string | undefined;
                            try {
                                initiatingOrigin = new URL(cloud.url).origin;
                            } catch { }
                            await runCloudOperation(async signal => {
                                if (getCloudUserId() !== initiatingUserId || !initiatingOrigin || new URL(cloud.url).origin !== initiatingOrigin) return;
                                cancelCloudAuthorization();
                                cloud.authenticated = false;
                                await deauthorizeCloud(initiatingOrigin, initiatingUserId);
                                if (getCloudUserId() === initiatingUserId && new URL(cloud.url).origin === initiatingOrigin)
                                    await authorizeCloud(signal);
                            });
                        } catch {
                            notifyCloudActionFailure();
                        }
                    }}
                >
                    <Flex gap="8px" alignItems="center">
                        <RefreshIcon color="currentColor" />
                        Reauthorize
                    </Flex>
                </Button>
            </Flex>

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Settings Sync</Heading>
            <Paragraph className={Margins.bottom16}>
                Synchronize low-risk core preferences, plugin favorite state, explicitly cloud-safe plugin options, and QuickCSS. Plugin enabled state, structured credential fields, custom connection profiles, plugin-private data, logs, and local DataStore records are never cloud synced. Use an explicit offline export if you need to back up DataStore. QuickCSS is uploaded verbatim, so do not place secrets in it.
            </Paragraph>

            <FormSwitch
                title="Enable Settings Sync"
                description="When enabled, your settings can be synced to and from the cloud. Use the actions below to manually sync."
                value={cloud.settingsSync}
                onChange={v => { cloud.settingsSync = v; }}
                disabled={!isAuthenticated}
                hideBorder
            />

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Sync Rules for This Device</Heading>
            <Paragraph className={Margins.bottom16}>
                This setting controls how settings move between <strong>this device</strong> and the cloud. You can let changes flow both ways, or choose one place to be the main source of truth.
            </Paragraph>

            <Select
                options={syncDirectionOptions}
                isSelected={v => v === (localStorage.Vencord_cloudSyncDirection ?? "both")}
                select={v => {
                    localStorage.Vencord_cloudSyncDirection = v;
                    forceUpdate();
                }}
                serialize={v => v}
                isDisabled={!syncEnabled}
            />

            <Flex gap="8px" className={Margins.top16}>
                <Button
                    style={{ flex: 1 }}
                    disabled={!syncEnabled}
                    onClick={() => putCloudSettings(true)}
                >
                    <Flex gap="8px" alignItems="center">
                        <CloudUploadIcon />
                        Sync to Cloud
                    </Flex>
                </Button>
                <Button
                    style={{ flex: 1 }}
                    disabled={!syncEnabled}
                    onClick={() => getCloudSettings(true, true)}
                >
                    <Flex gap="8px" alignItems="center">
                        <CloudDownloadIcon />
                        Sync from Cloud
                    </Flex>
                </Button>
            </Flex>

            {!isAuthenticated && (
                <Notice.Warning className={Margins.top8}>
                    Enable cloud integration above to use settings sync features.
                </Notice.Warning>
            )}

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Danger Zone</Heading>
            <Paragraph className={Margins.bottom16}>
                Request deletion from the current backend. Delete Cloud Settings requests removal of visible sync records; Delete Cloud Account requests full account erasure. Old clients may reintroduce data, and retained backups cannot be verified from this client, so rotate any credentials previously synced.
            </Paragraph>

            <Flex gap="8px">
                <Button
                    variant="dangerPrimary"
                    size="medium"
                    disabled={!isAuthenticated}
                    onClick={() => deleteCloudSettings()}
                >
                    <Flex gap="8px" alignItems="center">
                        <TrashIcon color="currentColor" />
                        Delete Cloud Settings
                    </Flex>
                </Button>
                <Button
                    variant="dangerSecondary"
                    size="medium"
                    disabled={!isAuthenticated}
                    onClick={() => Alerts.show({
                        title: "Delete Cloud Account",
                        body: "Request account erasure from the current backend? The client cannot verify retained backups, and older clients may reintroduce data. Rotate any credentials that were previously synced.",
                        onConfirm: eraseAllCloudData,
                        confirmText: "Delete Account",
                        confirmColor: "vc-cloud-erase-data-danger-btn",
                        cancelText: "Cancel"
                    })}
                >
                    <Flex gap="8px" alignItems="center">
                        <SkullIcon />
                        Delete Cloud Account
                    </Flex>
                </Button>
            </Flex>
        </SettingsTab>
    );
}

export default wrapTab(CloudTab, "Cloud");
