/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

async function activityName(template: string, item: Record<string, unknown>, privacy = false) {
    const config = {
        jf_serverUrl: "https://fixture.invalid", jf_apiKey: "fixture", jf_userId: "fixture",
        jf_nameDisplay: "custom", jf_customName: template, jf_privacyMode: privacy, jf_overrideType: "off"
    };
    const mocks: Record<string, unknown> = {
        "@utils/Logger": { Logger: class { warn() {} error() {} } },
        "@utils/text": { formatDurationMs: String },
        "@webpack/common": { FluxDispatcher: { dispatch() {} }, showToast() {} },
        "./polling": { createPresencePolling: () => ({}) },
        "./assetCache": { getCachedApplicationAsset: async () => "fixture-asset" }
    };
    const api = loadTestModule("src/equicordplugins/richPresence/services/jellyfin.ts", mocks, {
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; },
        fetch: async () => ({ ok: true, headers: { get: () => "application/json" },
            json: async () => [{ UserId: "fixture", NowPlayingItem: { Type: "Audio", ...item } }] })
    }, "\nexport { getActivity };", { compilerOptions: { jsx: undefined }, mockImports: false });
    return (await api.getActivity(config, { signal: new AbortController().signal, isCurrent: () => true, wait: (work: Promise<unknown>) => work })).name;
}

for (const value of ["$&", "$$", "$`", "$'", "{artist}", "{year}", "Title with {unknown}"]) {
    test(`Jellyfin preserves literal metadata ${JSON.stringify(value)}`, async () => {
        assert.equal(await activityName("{name} / {name} on Jellyfin", {
            Name: value, Artists: ["Fixture artist"], ProductionYear: 2026
        }), `${value} / ${value} on Jellyfin`);
    });
}

test("Jellyfin formats each supported placeholder once, including zero values", async () => {
    assert.equal(await activityName("{name}|{series}|{season}|{episode}|{artist}|{album}|{year}|{unknown}", {
        Name: "Track", SeriesName: "Series", ParentIndexNumber: 0, IndexNumber: 2,
        Artists: ["Artist {album}"], Album: "Album $&", ProductionYear: 2026
    }), "Track|Series|0|2|Artist {album}|Album $&|2026|{unknown}");
});

test("Jellyfin preserves absent-field fallbacks and privacy mode", async () => {
    assert.equal(await activityName("{name}|{series}|{artist}|{album}|{year}", {}), "Unknown||||");
    assert.equal(await activityName("{name} on Jellyfin", { Name: "Private title" }, true), "Jellyfin");
});
