/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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

async function gitOutput(...args: string[]): Promise<string> {
    if (Object.keys(process.env).some(key => /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(?:_.*)?)$/iu.test(key)))
        throw new Error("Refusing repository-selecting Git environment overrides");
    return (await execFile("git", args, {
        cwd: process.cwd(),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 60_000,
    })).stdout;
}

async function git(...args: string[]): Promise<string> {
    return (await gitOutput(...args)).trim();
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
        const output = await gitOutput(...args);
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

async function capture<T>(errors: unknown[], action: () => Promise<T>): Promise<T | undefined> {
    try {
        return await action();
    } catch (error) {
        errors.push(error);
    }
}

async function sourceState(errors: unknown[]) {
    return {
        head: await capture(errors, () => git("rev-parse", "HEAD")),
        patcherModifiedAt: await capture(errors, async () => (await stat(PATCHER_PATH)).mtimeMs),
        sourceFingerprint: await capture(errors, sourceFingerprint),
        status: await capture(errors, () => git("status", "--porcelain=v1")),
    };
}

async function main(): Promise<void> {
    const errors: unknown[] = [];
    const before = await sourceState(errors);
    if (errors.length) throw new AggregateError(errors, "The live updater source preflight failed");
    let browser: Browser | undefined;
    let proofCompleted = false;
    await capture(errors, async () => {
        browser = await connectWithRetry();
        const page = await discordPage(browser);
        const diagnostics = await page.evaluate(() => VencordNative.updater.getDiagnostics());
        assert.equal(diagnostics.ok, true, "the live updater diagnostics must be available");
        if (!diagnostics.ok) throw new Error("the live updater diagnostics failed");
        assert.equal(diagnostics.value.backend, "git", "the live proof must exercise the Git updater, not the standalone HTTP updater");
        assert.equal(diagnostics.value.branch, EXPECTED_BRANCH, "the live proof runs only against Protonn Cord main");
        assert.ok(typeof diagnostics.value.sourceRoot === "string" && isAbsolute(diagnostics.value.sourceRoot), "the connected client must report an absolute source checkout");
        assert.equal(comparablePath(diagnostics.value.sourceRoot), comparablePath(process.cwd()), "the connected client must use this exact source checkout");
        assert.equal(diagnostics.value.builtHead, before.head, "the active desktop bundle must have been built from the checked-out HEAD");
        assert.equal(await git("branch", "--show-current"), EXPECTED_BRANCH);
        const remoteHeadLine = await git("ls-remote", `${EXPECTED_REPOSITORY}.git`, `refs/heads/${EXPECTED_BRANCH}`);
        const remoteHead = remoteHeadLine.split(/\s+/u, 1)[0];
        assert.equal(remoteHead, before.head, "refusing to call the live updater because remote main advanced; rebuild and rerun first");

        const proof = await page.evaluate(async ({ branch, repository }) => {
            const repo = await VencordNative.updater.getRepo();
            if (!repo.ok || repo.value !== repository) throw new Error("Refusing the unexpected live updater repository");
            const updates = await VencordNative.updater.getUpdates(branch);
            if (!updates.ok || !Array.isArray(updates.value) || updates.value.length !== 0)
                throw new Error("Refusing to mutate a live checkout with failed or nonempty update results");
            const pull = await VencordNative.updater.update(branch);
            if (!pull.ok || pull.value !== false) throw new Error("Refusing to rebuild after a failed or non-no-op live update");
            const rebuild = await VencordNative.updater.rebuild(branch);
            const diagnostics = await VencordNative.updater.getDiagnostics(branch);
            return { diagnostics, pull, rebuild, repo, updates };
        }, { branch: EXPECTED_BRANCH, repository: EXPECTED_REPOSITORY } as const);

        assert.deepEqual(proof.repo, { ok: true, value: EXPECTED_REPOSITORY });
        assert.deepEqual(proof.updates, { ok: true, value: [] }, "the live updater must compare main with Protonn Cord main");
        assert.deepEqual(proof.pull, { ok: true, value: false }, "an up-to-date live pull must complete as a safe no-op");
        assert.deepEqual(proof.rebuild, { ok: true, value: true }, "the live updater rebuild must complete successfully");
        assert.equal(proof.diagnostics.ok, true);
        if (proof.diagnostics.ok) assert.equal(proof.diagnostics.value.builtHead, before.head);
        proofCompleted = true;
    });
    if (browser) await capture(errors, async () => { await browser!.disconnect(); });

    const after = await sourceState(errors);
    await capture(errors, async () => assert.equal(after.head, before.head, "the no-op updater must not move HEAD"));
    await capture(errors, async () => assert.equal(after.status, before.status, "the live updater must not alter tracked or untracked source files"));
    await capture(errors, async () => assert.equal(after.sourceFingerprint, before.sourceFingerprint, "the live updater must preserve the exact contents of every changed source file"));
    if (proofCompleted) await capture(errors, async () => assert.ok(after.patcherModifiedAt! > before.patcherModifiedAt!, "the live rebuild must strictly refresh the desktop bundle"));
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "The live updater proof, disconnect or preservation audit failed");

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
