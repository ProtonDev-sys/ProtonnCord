/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strict as assert } from "assert";
import { readFile } from "fs/promises";

import { normalizeNavidromeAlbumArtMode } from "../src/equicordplugins/richPresence/services/navidromePrivacy";

async function main() {
    const service = await readFile(new URL("../src/equicordplugins/richPresence/services/navidrome.ts", import.meta.url), "utf8");
    const settings = await readFile(new URL("../src/equicordplugins/richPresence/settings.ts", import.meta.url), "utf8");
    const settingsPanel = await readFile(new URL("../src/equicordplugins/richPresence/SettingsPanel.tsx", import.meta.url), "utf8");

    assert.doesNotMatch(service, /\/rest\/getCoverArt/, "authenticated Navidrome cover-art URLs must never be constructed");
    assert.doesNotMatch(service, /albumArtMode\s*===\s*["']instance["']/, "legacy instance mode must fail closed");
    assert.match(service, /normalizeNavidromeAlbumArtMode\(settings\.store\.nd_albumArtMode\)/,
        "the service must normalize persisted album-art modes before use");
    assert.doesNotMatch(settings, /value:\s*["']instance["']/, "the unsafe album-art mode must not be offered");
    assert.doesNotMatch(settingsPanel, /value:\s*["']instance["']/, "the visible settings panel must not offer the unsafe album-art mode");
    assert.match(settings, /disclose reusable server credentials/, "the UI must explain why instance-hosted art is unavailable");
    assert.match(settingsPanel, /disclose reusable server credentials/, "the visible settings panel must explain why instance-hosted art is unavailable");

    assert.equal(normalizeNavidromeAlbumArtMode("lastfm"), "lastfm", "Last.fm mode must remain available");
    assert.equal(normalizeNavidromeAlbumArtMode("none"), "none", "disabled album art must remain disabled");
    assert.equal(normalizeNavidromeAlbumArtMode("instance"), "none", "persisted legacy instance mode must fail closed");
    assert.equal(normalizeNavidromeAlbumArtMode("unexpected"), "none", "unknown persisted modes must fail closed");

    const resolverCalls = [...service.matchAll(/getAsset\(appId,\s*([^\n)]+)/g)].map(match => match[1]);
    assert.deepEqual(
        resolverCalls,
        ["resolvedCoverArtUrl", '"navidrome"', '"navidrome"'],
        "Discord's asset resolver may only receive Last.fm output or fixed public keys"
    );

    console.log("Navidrome asset privacy tests passed.");
}

void main();
