/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strict as assert } from "assert";
import { readFile } from "fs/promises";

import {
    CLOUD_SYNC_VALUE_KEYS,
    isCloudSyncValueKey,
    sanitizeCloudDocument,
} from "../src/api/SettingsSync/cloudPolicy";

const SECRET = "PC12_PRIVATE_DATASTORE_SENTINEL";

async function main() {
    assert.deepEqual(CLOUD_SYNC_VALUE_KEYS, ["settings", "quickCss"]);
    assert.equal(isCloudSyncValueKey("settings"), true);
    assert.equal(isCloudSyncValueKey("quickCss"), true);
    assert.equal(isCloudSyncValueKey("dataStore"), false);
    assert.equal(isCloudSyncValueKey("dataStore/private-token"), false);

    const sanitized = sanitizeCloudDocument({
        settings: { plugins: {} },
        quickCss: "",
        dataStore: { credential: SECRET },
        "dataStore/private-token": SECRET,
    });
    const serialized = JSON.stringify(sanitized);
    assert.doesNotMatch(serialized, /dataStore/u);
    assert.doesNotMatch(serialized, new RegExp(SECRET, "u"));
    assert.deepEqual(sanitized, { settings: { plugins: {} }, quickCss: "" });

    const cloudSyncSource = await readFile(new URL("../src/api/SettingsSync/cloudSync.ts", import.meta.url), "utf8");
    assert.match(cloudSyncSource, /isCloudSyncValueKey\(raw\.key\)/u,
        "remote manifests must use the same exact cloud-value policy");
    assert.doesNotMatch(cloudSyncSource, /DataStore\.(?:entries|setMany)\s*\(/u,
        "cloud sync must never enumerate or restore plugin DataStore records");

    const cloudTabSource = await readFile(new URL("../src/components/settings/tabs/sync/CloudTab.tsx", import.meta.url), "utf8");
    assert.match(cloudTabSource, /local DataStore records are never cloud synced/u,
        "the UI must disclose that DataStore is outside the cloud backup contract");

    console.log("Cloud DataStore exclusion contract checks passed.");
}

void main();
