/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const violations = [];
for (const file of files) {
    if ((/(?:^|\/)(?:\.env(?:\..+)?|credentials\.json|cookies\.json|local\.properties)$/u.test(file) || /^(?:settings|\.codex-artifacts)\//u.test(file)) && !file.endsWith(".env.example"))
        violations.push(`${file}: local configuration or account export`);
    if (/\.(?:pem|p12|pfx|jks|keystore|log|sqlite|db)$/u.test(file))
        violations.push(`${file}: credentials or local runtime data`);
    const content = await readFile(file, "utf8");
    if (/(?:[A-Z]:[\\/]+Users[\\/]+(?!test\b|fixture\b|Public\b|Default\b)[\w.-]+|D:[\\/]+Development[\\/]+protonn-cord\b|\bdesktop-[a-z0-9]{7}\b)/iu.test(content))
        violations.push(`${file}: personal machine path or hostname`);
    if (file === "scripts/testSecureMessagingLive.ts" && /const (?:TEST_CHANNEL_ID|EXPECTED_RECIPIENT_ID)\s*=\s*["']\d+/u.test(content))
        violations.push(`${file}: hardcoded live account target`);
}
if (violations.length) throw new Error(`Repository privacy check failed:\n${violations.join("\n")}`);
console.log(`Checked ${files.length} tracked files for private configuration, account exports and personal machine data.`);
