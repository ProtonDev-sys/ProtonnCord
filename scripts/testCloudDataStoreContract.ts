import { strict as assert } from "assert";

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

    console.log("Cloud DataStore exclusion contract checks passed.");
}

void main();
