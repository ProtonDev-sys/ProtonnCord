import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const plugin = loadTestModule("src/equicordplugins/normalizeMessageLinks/index.ts", {
    "@utils/constants": { Devs: {} },
    "@utils/types": { __esModule: true, default: (definition: unknown) => definition }
}, {}).default;

test("NormalizeMessageLinks normalizes only the exact Discord release-channel hosts", () => {
    for (const host of ["canary.discord.com", "ptb.discord.com"]) {
        assert.equal(plugin.normalizeHost(host), "discord.com");
    }
});

test("NormalizeMessageLinks preserves stable, custom, lookalike and port-qualified hosts", () => {
    for (const host of [
        "discord.com", "localhost", "canary.discordXcom", "ptb.discord-com",
        "other.canary.discord.com", "other.ptb.discord.com", "canary.discord.com:443",
        "ptb.discord.com.evil.example", "canaryXdiscord.com"
    ]) {
        assert.equal(plugin.normalizeHost(host), host, host);
    }
});
