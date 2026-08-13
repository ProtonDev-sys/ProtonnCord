/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strict as assert } from "assert";
import { readFile } from "fs/promises";

async function main() {
    const service = await readFile(new URL("../src/equicordplugins/richPresence/services/navidrome.ts", import.meta.url), "utf8");
    const settings = await readFile(new URL("../src/equicordplugins/richPresence/settings.ts", import.meta.url), "utf8");

    assert.doesNotMatch(service, /\/rest\/getCoverArt/, "authenticated Navidrome cover-art URLs must never be constructed");
    assert.doesNotMatch(service, /albumArtMode\s*===\s*["']instance["']/, "legacy instance mode must fail closed");
    assert.doesNotMatch(settings, /value:\s*["']instance["']/, "the unsafe album-art mode must not be offered");
    assert.match(settings, /disclose reusable server credentials/, "the UI must explain why instance-hosted art is unavailable");

    const resolverCalls = [...service.matchAll(/getAsset\(appId,\s*([^\n)]+)/g)].map(match => match[1]);
    assert.deepEqual(
        resolverCalls,
        ["resolvedCoverArtUrl", '"navidrome"', '"navidrome"'],
        "Discord's asset resolver may only receive Last.fm output or fixed public keys"
    );

    console.log("Navidrome asset privacy tests passed.");
}

void main();
