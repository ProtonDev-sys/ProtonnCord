/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

const DEBUG_URL = process.env.DISCORD_DEBUG_URL ?? "http://127.0.0.1:9222";
const EXPECTED_REPOSITORY = "https://github.com/ProtonDev-sys/ProtonnCord";
const EXPECTED_BRANCH = "main";
const PATCHER_PATH = "dist/desktop/patcher.js";
const execFile = promisify(execFileCallback);

async function connectWithRetry(): Promise<Browser> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 80; attempt++) {
        try {
            return await puppeteer.connect({ browserURL: DEBUG_URL });
        } catch (error) {
            lastError = error;
            await sleep(250);
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Discord DevTools did not become available");
}

async function discordPage(browser: Browser): Promise<Page> {
    for (let attempt = 0; attempt < 120; attempt++) {
        const pages = await browser.pages();
        const page = pages.find(candidate => !candidate.isClosed() && candidate.url().includes("discord.com/channels"));
        if (page) {
            try {
                if (await page.evaluate(() => typeof VencordNative?.updater?.getUpdates === "function")) return page;
            } catch {
                // Discord can replace its renderer frame during startup.
            }
        }
        await sleep(250);
    }
    throw new Error("Discord did not expose the Protonn Cord updater bridge");
}

async function git(...args: string[]): Promise<string> {
    return (await execFile("git", args, {
        cwd: process.cwd(),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 60_000,
    })).stdout.trim();
}

function comparablePath(value: string): string {
    const absolute = resolve(value);
    return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

async function sourceFingerprint(): Promise<string> {
    const changed = new Set<string>();
    for (const args of [
        ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"],
        ["diff", "--cached", "--name-only", "-z"],
    ]) {
        const output = (await execFile("git", args, { cwd: process.cwd() })).stdout;
        for (const path of output.split("\0")) if (path) changed.add(path);
    }
    const digest = createHash("sha256");
    for (const path of [...changed].sort()) {
        digest.update(path, "utf8").update("\0");
        try {
            digest.update(await readFile(path));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            digest.update("<deleted>", "utf8");
        }
        digest.update("\0");
    }
    return digest.digest("hex");
}

async function main(): Promise<void> {
    const before = {
        head: await git("rev-parse", "HEAD"),
        patcherModifiedAt: (await stat(PATCHER_PATH)).mtimeMs,
        sourceFingerprint: await sourceFingerprint(),
        status: await git("status", "--porcelain=v1"),
    };
    const browser = await connectWithRetry();
    try {
        const page = await discordPage(browser);
        const diagnostics = await page.evaluate(() => VencordNative.updater.getDiagnostics());
        assert.equal(diagnostics.ok, true, "the live updater diagnostics must be available");
        if (!diagnostics.ok) throw new Error("the live updater diagnostics failed");
        assert.equal(diagnostics.value.backend, "git", "the live proof must exercise the Git updater, not the standalone HTTP updater");
        assert.equal(diagnostics.value.branch, EXPECTED_BRANCH, "the live proof runs only against Protonn Cord main");
        assert.equal(comparablePath(diagnostics.value.sourceRoot ?? ""), comparablePath(process.cwd()), "the connected client must use this exact source checkout");
        assert.equal(diagnostics.value.builtHead, before.head, "the active desktop bundle must have been built from the checked-out HEAD");
        assert.equal(await git("branch", "--show-current"), EXPECTED_BRANCH);
        const remoteHeadLine = await git("ls-remote", `${EXPECTED_REPOSITORY}.git`, `refs/heads/${EXPECTED_BRANCH}`);
        const remoteHead = remoteHeadLine.split(/\s+/u, 1)[0];
        assert.equal(remoteHead, before.head, "refusing to call the live updater because remote main advanced; rebuild and rerun first");

        const proof = await page.evaluate(async () => {
            const repo = await VencordNative.updater.getRepo();
            const updates = await VencordNative.updater.getUpdates();
            const pull = await VencordNative.updater.update();
            const rebuild = await VencordNative.updater.rebuild();
            const diagnostics = await VencordNative.updater.getDiagnostics();
            return { diagnostics, pull, rebuild, repo, updates };
        });

        assert.deepEqual(proof.repo, { ok: true, value: EXPECTED_REPOSITORY });
        assert.deepEqual(proof.updates, { ok: true, value: [] }, "the live updater must compare main with Protonn Cord main");
        assert.deepEqual(proof.pull, { ok: true, value: false }, "an up-to-date live pull must complete as a safe no-op");
        assert.deepEqual(proof.rebuild, { ok: true, value: true }, "the live updater rebuild must complete successfully");
        assert.equal(proof.diagnostics.ok, true);
        if (proof.diagnostics.ok) assert.equal(proof.diagnostics.value.builtHead, before.head);
    } finally {
        await browser.disconnect();
    }

    const after = {
        head: await git("rev-parse", "HEAD"),
        patcherModifiedAt: (await stat(PATCHER_PATH)).mtimeMs,
        sourceFingerprint: await sourceFingerprint(),
        status: await git("status", "--porcelain=v1"),
    };
    assert.equal(after.head, before.head, "the no-op updater must not move HEAD");
    assert.equal(after.status, before.status, "the live updater must not alter tracked or untracked source files");
    assert.equal(after.sourceFingerprint, before.sourceFingerprint, "the live updater must preserve the exact contents of every changed source file");
    assert.ok(after.patcherModifiedAt > before.patcherModifiedAt, "the live rebuild must strictly refresh the desktop bundle");

    console.log(JSON.stringify({
        head: after.head,
        rebuildRefreshedBundle: true,
        repository: EXPECTED_REPOSITORY,
        sourceTreePreserved: true,
        updates: 0,
    }, null, 2));
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
