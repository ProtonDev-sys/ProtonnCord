/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

const checker = resolve("scripts/checkSourceAudit.mjs");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("coverage hashes survive checkout line endings but reject changed source and binary bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "protonn-audit-coverage-"));
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("protonn-audit-coverage-"));
    const source = "export const value = 1;\r\n";
    const binary = Buffer.from([0, 255, 13, 10]);
    const files = [
        { path: "fixture.js", owner: "infrastructure", sha256: digest(source) },
        { path: "fixture.bin", owner: "infrastructure", sha256: digest(binary) },
    ];
    const reviews = files.map(file => ({
        path: file.path,
        baselineSha256: file.sha256,
        status: "reviewed",
        summary: "Controlled fixture for checkout-independent source review hashes.",
        validation: ["Synthetic checker integration fixture."],
        reviewedHashEncoding: file.path.endsWith(".js") ? "utf8-lf" : "raw",
        reviewedSha256: file.path.endsWith(".js") ? digest(source.replace(/\r\n/g, "\n")) : digest(binary),
    }));
    const run = () => {
        const result = spawnSync(process.execPath, [checker, "--require-complete"], { cwd: root, encoding: "utf8" });
        assert.ifError(result.error);
        return { status: result.status, report: JSON.parse(result.stdout) };
    };
    try {
        execFileSync("git", ["init", "--quiet", root]);
        await mkdir(join(root, "docs/source-audit/reviews"), { recursive: true });
        await writeFile(join(root, "docs/source-audit/inventory.json"), JSON.stringify({ baseCommit: "fixture", files }));
        await writeFile(join(root, "docs/source-audit/reviews/infrastructure.json"), JSON.stringify(reviews));
        await writeFile(join(root, "fixture.js"), source);
        await writeFile(join(root, "fixture.bin"), binary);
        assert.equal(run().status, 0, "reviewed CRLF source is accepted");
        await writeFile(join(root, "fixture.js"), source.replace(/\r\n/g, "\n"));
        assert.equal(run().status, 0, "an LF checkout retains the review");
        await writeFile(join(root, "fixture.js"), "export const value = 2;\n");
        const changedSource = run();
        assert.equal(changedSource.status, 1);
        assert.ok(changedSource.report.errors.includes("fixture.js: changed since review"));
        await writeFile(join(root, "fixture.js"), source);
        await writeFile(join(root, "fixture.bin"), Buffer.from([0, 255, 10]));
        assert.equal(run().status, 1, "binary CRLF bytes must never be normalized");
        await writeFile(join(root, "fixture.bin"), binary);
        reviews[1].reviewedHashEncoding = "utf8-lf";
        await writeFile(join(root, "docs/source-audit/reviews/infrastructure.json"), JSON.stringify(reviews));
        assert.equal(run().status, 1, "binary data cannot claim text hash encoding");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
