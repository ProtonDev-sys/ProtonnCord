/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
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

import { downloadSettingsBackup, uploadSettingsBackup } from "@api/SettingsSync/offline";
import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { Margins } from "@utils/margins";
import { useState } from "@webpack/common";

const backupTypes = [
    ["all", "All Settings"],
    ["plugins", "Settings"],
    ["css", "QuickCSS"],
    ["datastore", "DataStore"]
] as const;

function BackupAndRestoreTab() {
    const [busy, setBusy] = useState(false);
    async function run(action: () => Promise<void>) {
        if (busy) return;
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
        }
    }
    return (
        <SettingsTab>
            <Heading className={Margins.top16}>Backup & Restore</Heading>
            <Paragraph className={Margins.bottom20}>
                Import and export your Protonn Cord settings as a JSON file. This allows you to easily transfer your settings to another device, or recover them after reinstalling Protonn Cord or Discord.
            </Paragraph>

            <Notice.Warning className={Margins.bottom20}>
                Imported values replace matching settings and DataStore entries. Values absent from the backup are kept. Export a backup first if you want to preserve your current configuration.
            </Notice.Warning>

            <Divider className={Margins.bottom20} />

            <Heading>Import Settings</Heading>
            <Paragraph className={Margins.bottom16}>
                Select a previously exported file and choose which sections to import. Restart afterward to apply all changes.
            </Paragraph>

            <Flex gap="8px" className={Margins.bottom20} style={{ flexWrap: "wrap" }}>
                {backupTypes.map(([type, label]) => (
                    <Button key={type} onClick={() => run(() => uploadSettingsBackup(type))} disabled={busy} size="small" variant={type === "all" ? "secondary" : "primary"}>
                        Import {label}
                    </Button>
                ))}
            </Flex>

            <Divider className={Margins.bottom20} />

            <Heading>Export Settings</Heading>
            <Paragraph className={Margins.bottom16}>
                Choose the sections to save as a JSON file. Backups can include saved credentials and private plugin data, so keep them private. DataStore values that JSON cannot restore are reported instead of being silently lost.
            </Paragraph>

            <Flex gap="8px" style={{ flexWrap: "wrap" }}>
                {backupTypes.map(([type, label]) => (
                    <Button key={type} onClick={() => run(() => downloadSettingsBackup(type))} disabled={busy} size="small" variant={type === "all" ? "secondary" : "primary"}>
                        Export {label}
                    </Button>
                ))}
            </Flex>
        </SettingsTab>
    );
}

export default wrapTab(BackupAndRestoreTab, "Backup & Restore");
