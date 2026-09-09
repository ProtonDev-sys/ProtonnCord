/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tests = readdirSync(new URL("./", import.meta.url))
    .filter(name => /^testAudit.+\.ts$/.test(name))
    .sort()
    .map(name => `scripts/${name}`);
if (!tests.length) throw new Error("No source-audit regression tests were found");

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), ...tests], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
