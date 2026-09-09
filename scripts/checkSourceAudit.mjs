/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const directory = "docs/source-audit";
const inventory = JSON.parse(readFileSync(join(directory, "inventory.json"), "utf8"));
const baseline = new Map(inventory.files.map(file => [file.path, file]));
const reviewed = new Map();
const errors = [];
const statuses = new Set(["reviewed", "changed", "removed", "asset", "generated"]);
const delegatedOwners = new Map([
    ["equicord_b_remaining_services", "equicord_b"],
    ["equicord_b_remaining_ui", "equicord_b"],
    ["infrastructure_discord_types", "infrastructure"],
    ["infrastructure_secure_tests", "infrastructure"],
    ["infrastructure_plugin_tests", "infrastructure"],
    ["infrastructure_remaining_tests", "infrastructure"]
]);

for (const file of readdirSync(join(directory, "reviews")).filter(file => file.endsWith(".json"))) {
    const records = JSON.parse(readFileSync(join(directory, "reviews", file), "utf8"));
    if (!Array.isArray(records)) throw new Error(`${file}: expected an array of reviews`);
    for (const record of records) {
        if (!record || typeof record !== "object" || typeof record.path !== "string"
            || record.path.includes("\\") || record.path.includes(":")
            || record.path.split("/").some(part => !part || part === "." || part === "..")) {
            errors.push(`${file}: review must name a repository-relative file`);
            continue;
        }
        const original = baseline.get(record.path);
        if (reviewed.has(record.path)) errors.push(`${record.path}: duplicate review`);
        if (!statuses.has(record.status)) errors.push(`${record.path}: invalid disposition`);
        if (typeof record.summary !== "string" || record.summary.trim().length < 25)
            errors.push(`${record.path}: missing substantive review summary`);
        if (!Array.isArray(record.validation) || record.validation.length === 0
            || record.validation.some(item => typeof item !== "string" || !item.trim()))
            errors.push(`${record.path}: missing review/validation evidence`);
        if ((original?.sha256 ?? null) !== record.baselineSha256)
            errors.push(`${record.path}: baseline hash does not match inventory`);
        const ledgerName = file.slice(0, -5);
        if (original && original.owner !== (delegatedOwners.get(ledgerName) ?? ledgerName))
            errors.push(`${record.path}: record is in the wrong owner's ledger`);
        if (record.status === "removed") {
            if (existsSync(record.path)) errors.push(`${record.path}: marked removed but still present`);
        } else if (!existsSync(record.path) || !statSync(record.path).isFile()) {
            errors.push(`${record.path}: reviewed file is missing`);
        } else if (!/^[a-f0-9]{64}$/.test(record.reviewedSha256 ?? "")) {
            errors.push(`${record.path}: missing reviewed-version SHA-256`);
        } else {
            const current = createHash("sha256").update(readFileSync(record.path)).digest("hex");
            if (current !== record.reviewedSha256) errors.push(`${record.path}: changed since review`);
        }
        reviewed.set(record.path, record);
    }
}

const pending = inventory.files.filter(file => !reviewed.has(file.path));
const currentFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean);
const newUnreviewed = [...new Set(currentFiles)].filter(path => !baseline.has(path) && !reviewed.has(path) && !path.startsWith(`${directory}/`));
const groups = Object.fromEntries([...new Set(inventory.files.map(file => file.owner))].map(owner => {
    const files = inventory.files.filter(file => file.owner === owner);
    return [owner, { reviewed: files.filter(file => reviewed.has(file.path)).length, total: files.length }];
}));
console.log(JSON.stringify({ baseCommit: inventory.baseCommit, groups, baselineReviewed: inventory.files.length - pending.length, baselineTotal: inventory.files.length, newUnreviewed, errors }, null, 2));
if (process.argv.includes("--pending")) console.log(JSON.stringify(pending.map(file => file.path), null, 2));
if (errors.length || process.argv.includes("--require-complete") && (pending.length || newUnreviewed.length)) process.exitCode = 1;
