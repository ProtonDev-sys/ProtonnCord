import assert from "node:assert/strict";

import {
    getNewSettings,
    isNotifiablePlugin,
    isSerializedKnownSettings,
    normalizeKnownSettings,
    serializeKnownSettings,
} from "../src/equicordplugins/newPluginsManager/knownSettingsData";

function entries(settings: Map<string, Set<string>>): [string, string[]][] {
    return Array.from(settings, ([plugin, pluginSettings]) => [plugin, Array.from(pluginSettings)]);
}

const expected = [
    ["First", ["alpha", "beta"]],
    ["Second", ["gamma"]],
] satisfies [string, string[]][];

assert.deepEqual(entries(normalizeKnownSettings(new Map<unknown, unknown>([
    ["First", new Set(["alpha", "beta"])],
    ["Second", ["gamma"]],
]))), expected, "Map-backed data is normalized");

assert.deepEqual(entries(normalizeKnownSettings(expected)), expected, "entry-array data is normalized");
assert.deepEqual(entries(normalizeKnownSettings({ First: ["alpha", "beta"], Second: ["gamma"] })), expected, "record data is normalized");

const addedSettings = getNewSettings(
    normalizeKnownSettings({ First: ["beta", "delta"], Third: ["epsilon"] }),
    normalizeKnownSettings({ First: ["alpha", "beta"], Second: ["gamma"] }),
);

assert.deepEqual(entries(addedSettings), [
    ["First", ["delta"]],
    ["Third", ["epsilon"]],
], "only settings added to current plugins are returned");
assert.deepEqual(entries(normalizeKnownSettings(serializeKnownSettings(addedSettings))), entries(addedSettings), "serialized settings round-trip");
assert.equal(isSerializedKnownSettings(expected), true, "the canonical storage representation is detected");
assert.equal(isSerializedKnownSettings(new Map()), false, "legacy Map storage is migrated");
assert.equal(isSerializedKnownSettings({ First: ["alpha"] }), false, "legacy record storage is migrated");
assert.equal(isNotifiablePlugin({}), true, "ordinary plugins are shown");
assert.equal(isNotifiablePlugin({ hidden: true }), false, "hidden plugins are not announced");
assert.equal(isNotifiablePlugin({ required: true }), false, "required plugins are not announced");

console.log("newPluginsManager synthetic checks passed");
