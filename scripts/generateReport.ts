/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/// <reference types="../src/globals" />
/// <reference types="../src/modules" />

import { createHmac } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import pup, { Browser, ConsoleMessage, JSHandle, Page } from "puppeteer-core";

const CANARY = process.env.USE_CANARY === "true";
const logStderr = (...data: any[]) => console.error(`${CANARY ? "CANARY" : "STABLE"} ---`, ...data);

for (const variable of ["CHROMIUM_BIN"]) {
    if (!process.env[variable]) {
        logStderr(`Missing environment variable ${variable}`);
        process.exit(1);
    }
}

let metaData = {
    buildNumber: "Unknown Build Number",
    buildHash: "Unknown Build Hash"
};

let browser: Browser | undefined;
let page: Page;

async function maybeGetError(handle: JSHandle): Promise<string | undefined> {
    return await (handle as JSHandle<Error>)?.getProperty("message")
        .then(m => m?.jsonValue())
        .catch(() => undefined);
}

interface PatchInfo {
    plugin: string;
    type: string;
    id: string;
    match: string;
    error?: string;
};

const report = {
    badPatches: [] as PatchInfo[],
    slowPatches: [] as PatchInfo[],
    badStarts: [] as {
        plugin: string;
        error: string;
    }[],
    otherErrors: [] as string[],
    ignoredErrors: [] as string[],
    badWebpackFinds: [] as string[]
};

const IGNORED_DISCORD_ERRORS = [
    "KeybindStore: Looking for callback action",
    "Unable to process domain list delta: Client revision number is null",
    "Downloading the full bad domains file",
    /\[GatewaySocket\].{0,110}Cannot access '/,
    "search for 'name' in undefined",
    "Attempting to set fast connect zstd when unsupported",
    /Cannot read properties of undefined \(reading 'call'\)/,
    "Could not complete Remote Auth login, trying to restart with a new Remote Auth session."
] as Array<string | RegExp>;

function toCodeBlock(s: string, indentation = 0, isDiscord = false) {
    s = s.replace(/```/g, "`\u200B`\u200B`");

    s = s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
    );

    const indentationStr = " ".repeat(!isDiscord ? indentation : 0);
    const content = s.split("\n").map(s => indentationStr + s).join("\n");

    return `\`\`\`\n${content}\n${indentationStr}\`\`\``;
}

async function printReport() {
    console.log();

    console.log("# Protonn Cord Report" + (CANARY ? " (Canary)" : ""));

    console.log();

    console.log("## Bad Patches");
    report.badPatches.forEach(p => {
        console.log(`- ${p.plugin} (${p.type})`);
        console.log(`  - ID: \`${p.id}\``);
        console.log(`  - Match: ${toCodeBlock(p.match, "  - Match: ".length)}`);
        if (p.error) console.log(`  - Error: ${toCodeBlock(p.error, "  - Error: ".length)}`);
    });

    console.log();

    console.log("## Bad Webpack Finds");
    report.badWebpackFinds.forEach(p => console.log("- " + toCodeBlock(p, "- ".length)));

    console.log();

    console.log("## Bad Starts");
    report.badStarts.forEach(p => {
        console.log(`- ${p.plugin}`);
        console.log(`  - Error: ${toCodeBlock(p.error, "  - Error: ".length)}`);
    });

    console.log();

    console.log("## Discord Errors");
    report.otherErrors.forEach(e => {
        console.log(`- ${toCodeBlock(e, "- ".length)}`);
    });

    console.log();

    console.log("## Ignored Discord Errors");
    report.ignoredErrors.forEach(e => {
        console.log(`- ${toCodeBlock(e, "- ".length)}`);
    });

    console.log();

    if (process.env.WEBHOOK_URL || process.env.REPORT_WEBHOOK_BODY_FILE) {
        const patchesToEmbed = (title: string, patches: PatchInfo[], color: number) => ({
            title,
            color,
            description: patches.map(p => {
                const lines = [
                    `**__${p.plugin} (${p.type}):__**`,
                    `ID: \`${p.id}\``,
                    `Match: ${toCodeBlock(p.match, "Match: ".length, true)}`
                ];
                if (p.error) lines.push(`Error: ${toCodeBlock(p.error, "Error: ".length, true)}`);

                return lines.join("\n");
            }).join("\n\n"),
        });

        const embeds = [
            {
                author: {
                    name: `Discord ${CANARY ? "Canary" : "Stable"} (${metaData.buildNumber})`,
                    url: `https://nelly.tools/builds/app/${metaData.buildHash}`,
                    icon_url: CANARY ? "https://cdn.discordapp.com/emojis/1252721945699549327.png?size=128" : "https://cdn.discordapp.com/emojis/1252721943463985272.png?size=128"
                },
                color: CANARY ? 0xfbb642 : 0x5865f2
            },
            report.badPatches.length > 0 && patchesToEmbed("Bad Patches", report.badPatches, 0xff0000),
            report.slowPatches.length > 0 && patchesToEmbed("Slow Patches", report.slowPatches, 0xf0b232),
            report.badWebpackFinds.length > 0 && {
                title: "Bad Webpack Finds",
                description: report.badWebpackFinds.map(f => toCodeBlock(f, 0, true)).join("\n") || "None",
                color: 0xff0000
            },
            report.badStarts.length > 0 && {
                title: "Bad Starts",
                description: report.badStarts.map(p => {
                    const lines = [
                        `**__${p.plugin}:__**`,
                        toCodeBlock(p.error, 0, true)
                    ];
                    return lines.join("\n");
                }
                ).join("\n\n") || "None",
                color: 0xff0000
            },
            report.otherErrors.length > 0 && {
                title: "Discord Errors",
                description: report.otherErrors.length ? toCodeBlock(report.otherErrors.join("\n"), 0, true) : "None",
                color: 0xff0000
            }
        ].filter(Boolean);

        if (embeds.length === 1) {
            embeds.push({
                title: "No issues found",
                description: "Seems like everything is working fine (for now)",
                color: 0x00ff00
            });
        }

        const body = JSON.stringify({
            username: "Protonn Cord Reporter" + (CANARY ? " (Canary)" : ""),
            embeds
        });

        // CI generates this artifact in the untrusted, secretless build job. A
        // separate fixed sender validates and signs it without executing any
        // code from the selected report ref.
        if (process.env.REPORT_WEBHOOK_BODY_FILE) {
            writeFileSync(process.env.REPORT_WEBHOOK_BODY_FILE, body, { encoding: "utf8", flag: "wx" });
        }

        if (!process.env.WEBHOOK_URL) return;

        const headers = {
            "Content-Type": "application/json"
        };

        // functions similar to https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
        // used by venbot to ensure webhook invocations are genuine (since we will pass the webhook url as a workflow input which is publicly visible)
        // generate a secret with something like `openssl rand -hex 128`
        if (process.env.WEBHOOK_SECRET) {
            headers["X-Signature"] = "sha256=" + createHmac("sha256", process.env.WEBHOOK_SECRET).update(body).digest("hex");
        }

        await fetch(process.env.WEBHOOK_URL, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(30_000)
        }).then(async res => {
            if (!res.ok) logStderr(`Webhook failed with status ${res.status}`);
            else logStderr("Posted to Webhook successfully");
            await res.body?.cancel();
        });
    }
}

const reporterTimeoutMs = Number(process.env.REPORTER_TIMEOUT_MS ?? 180_000);
if (!Number.isInteger(reporterTimeoutMs) || reporterTimeoutMs < 1_000 || reporterTimeoutMs > 900_000)
    throw new Error("REPORTER_TIMEOUT_MS must be an integer between 1000 and 900000");
let isFinishing = false;
let reporterTimeout: ReturnType<typeof setTimeout> | undefined;
let finishing: Promise<void> | undefined;

function waitForReporterCleanup<Value>(promise: Promise<Value>, timeoutMs: number, message = "Reporter browser cleanup timed out"): Promise<Value> {
    let timeout: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]).finally(() => clearTimeout(timeout));
}

// Runs in the page, reading source only. The patcher's toString proxy returns
// the original factory without invoking it or reading its exports/cache.
function captureFailedFactories({ ids, omittedModuleCount, maxBytes, probes = [], probeError, requestedIds = [], requestedIdsError }: {
    ids: string[]; omittedModuleCount: number; maxBytes: number; probes?: string[]; probeError?: string; requestedIds?: string[]; requestedIdsError?: string;
}) {
    const factories = globalThis.Vencord?.Webpack?.wreq?.m;
    const patchedSource = globalThis.Vencord?.WebpackPatcher?.SYM_PATCHED_SOURCE;
    const selected = new Set(ids.slice(0, 100));
    const requestedFactories = requestedIds.map(id => {
        const status = selected.has(id) || selected.size < 100 ? "selected" : "module-limit";
        if (status === "selected") selected.add(id);
        return { id, status };
    });
    const result = {
        version: 1, omittedModuleCount: omittedModuleCount + Math.max(0, ids.length - 100),
        factories: [] as Array<Record<string, string | number>>,
        ...(requestedFactories.length ? { requestedFactories } : {}),
        ...(requestedIdsError ? { requestedIdsError } : {}),
        ...(probeError ? { probeError } : {}),
        ...(probes.length ? {
            probes: probes.map(literal => ({ literal, status: "not-found", matchCount: 0, matches: [] as string[] })),
            probeScan: { complete: false, status: "complete", examinedEntries: 0, searchedCharacters: 0, unavailableFactories: 0 }
        } : {})
    };

    if (result.probes && result.probeScan) {
        const scan = result.probeScan;
        const deadline = performance.now() + 2_000;
        if (!factories) scan.status = "unavailable";
        // These limits bound literal comparisons as well as the number of factory
        // reads. An incomplete scan must never claim a unique or absent match.
        for (const id in factories) {
            if (performance.now() >= deadline) { scan.status = "time-limit"; break; }
            if (scan.examinedEntries >= 50_000) { scan.status = "entry-limit"; break; }
            scan.examinedEntries++;
            if (!Object.hasOwn(factories, id) || !/^(?:0|[1-9]\d{0,15})$/.test(id)) continue;
            try {
                const factory = factories[id];
                if (typeof factory !== "function") continue;
                const source = String(factory);
                const work = source.length * probes.length;
                if (work > 128 * 1024 * 1024 - scan.searchedCharacters) { scan.status = "character-limit"; break; }
                scan.searchedCharacters += work;
                for (const probe of result.probes) {
                    if (!source.includes(probe.literal)) continue;
                    probe.matchCount++;
                    if (probe.matches.length < 2) probe.matches.push(id);
                }
            } catch { scan.unavailableFactories++; }
        }
        scan.complete = scan.status === "complete" && scan.unavailableFactories === 0;
        if (scan.status === "complete" && !scan.complete) scan.status = "unavailable";
        for (const probe of result.probes) {
            if (probe.matchCount > 1) probe.status = "ambiguous";
            else if (!scan.complete) probe.status = "incomplete";
            else if (probe.matchCount === 1) {
                const [id] = probe.matches;
                probe.status = selected.has(id) || selected.size < 100 ? "selected" : "module-limit";
                if (probe.status === "selected") selected.add(id);
            }
        }
    }
    const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    let bytes = byteLength(result) + 64; // Reserve space for a growing omitted count.

    for (const id of selected) {
        let entry: Record<string, string | number> = { id, status: "missing" };
        try {
            const factory = factories && Object.hasOwn(factories, id) ? factories[id] : undefined;
            if (typeof factory === "function") {
                const original = String(factory);
                entry = { id, status: "size-limit", characters: original.length };
                if (original.length < maxBytes - bytes) {
                    const candidate = { id, status: "captured", original };
                    if (bytes + byteLength(candidate) + 1 <= maxBytes) entry = candidate;
                }
                if (entry.status === "captured" && typeof patchedSource === "symbol") {
                    const patched = factory[patchedSource];
                    if (typeof patched === "string") {
                        const candidate = { ...entry, patched };
                        if (patched.length < maxBytes - bytes && bytes + byteLength(candidate) + 1 <= maxBytes) entry = candidate;
                        else entry.patchedStatus = "size-limit";
                    }
                }
            }
        } catch {
            entry = { id, status: "unavailable" };
        }
        const size = byteLength(entry) + 1;
        if (bytes + size > maxBytes) result.omittedModuleCount++;
        else {
            bytes += size;
            result.factories.push(entry);
        }
    }
    return JSON.stringify(result);
}

function parseFactoryProbes(value: string | undefined): { probes: string[]; probeError?: string; } {
    if (value === undefined) return { probes: [] };
    try {
        if (value.length > 8_192) throw new Error();
        const probes: unknown = JSON.parse(value);
        if (!Array.isArray(probes) || probes.length > 8 || probes.some(probe => typeof probe !== "string" || !probe.length || probe.length > 128))
            throw new Error();
        return { probes: [...new Set(probes)] };
    } catch {
        return { probes: [], probeError: "REPORTER_FACTORY_PROBES must be a JSON array of at most 8 nonempty literal strings of at most 128 characters (8192 characters total)." };
    }
}

function parseFactoryIds(value: string | undefined): { requestedIds: string[]; requestedIdsError?: string; } {
    if (value === undefined) return { requestedIds: [] };
    try {
        if (value.length > 1_024) throw new Error();
        const ids: unknown = JSON.parse(value);
        if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== "string" || !/^(?:0|[1-9]\d{0,15})$/.test(id)))
            throw new Error();
        return { requestedIds: [...new Set(ids)] };
    } catch {
        return { requestedIds: [], requestedIdsError: "REPORTER_FACTORY_IDS must be a JSON array of at most 8 canonical numeric strings of at most 16 digits (1024 characters total)." };
    }
}

function terminateReporterBrowser() {
    try { browser?.process()?.kill(); }
    catch (error) { logStderr("Reporter browser termination failed", error); }
}

function finishReporter(timedOut = false, closeTimeoutMs = 10_000, finalTimeoutMs = 45_000) {
    if (finishing) return finishing;
    isFinishing = true;
    clearTimeout(reporterTimeout);

    if (timedOut) {
        const message = `Reporter did not complete within ${reporterTimeoutMs}ms`;
        logStderr(message);
        report.otherErrors.push(message);
        process.exitCode = 1;
    }

    finishing = (async () => {
        const finalTimeout = setTimeout(() => {
            terminateReporterBrowser();
            logStderr("Reporter finalization timed out");
            process.exit(1);
        }, finalTimeoutMs);
        try {
            const factoryPath = process.env.REPORTER_FACTORY_PATH;
            if (factoryPath && page && process.exitCode) {
                try {
                    const ids = [...new Set(report.badPatches.map(patch => patch.id).filter(id => /^(?:0|[1-9]\d{0,15})$/.test(id)))];
                    const maxBytes = 8 * 1024 * 1024;
                    const payload = await waitForReporterCleanup(page.evaluate(captureFailedFactories, {
                        ids: ids.slice(0, 100), omittedModuleCount: Math.max(0, ids.length - 100), maxBytes,
                        ...parseFactoryProbes(process.env.REPORTER_FACTORY_PROBES),
                        ...parseFactoryIds(process.env.REPORTER_FACTORY_IDS)
                    }), 5_000, "Reporter factory capture timed out");
                    if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > maxBytes)
                        throw new Error("Reporter factory capture exceeded its size limit");
                    writeFileSync(factoryPath, payload, { encoding: "utf8", flag: "wx" });
                } catch (error) {
                    logStderr("Could not capture failed reporter factories", describeError(error));
                }
            }
            const screenshotPath = process.env.REPORTER_SCREENSHOT_PATH;
            if (screenshotPath && page && process.exitCode) {
                try {
                    await waitForReporterCleanup(page.screenshot({ path: screenshotPath, type: "png", fullPage: false }), 5_000, "Reporter screenshot timed out");
                } catch (error) {
                    logStderr("Could not capture reporter screenshot", describeError(error));
                }
            }
            try {
                if (browser) await waitForReporterCleanup(browser.close(), closeTimeoutMs);
            } catch (error) {
                report.otherErrors.push(`Browser cleanup failed: ${String(error)}`);
                logStderr("Browser cleanup failed", error);
                process.exitCode = 1;
                terminateReporterBrowser();
            }
            try { await printReport(); }
            catch (error) {
                logStderr("Report publication failed", error);
                process.exitCode = 1;
            }
        } finally {
            clearTimeout(finalTimeout);
            process.exit();
        }
    })();
    return finishing;
}

async function failReporter(error: unknown) {
    if (!isFinishing) {
        const message = describeError(error);
        logStderr("Reporter failed", message);
        report.otherErrors.push(message);
        process.exitCode = 1;
    }
    await finishReporter();
}

async function handleConsole(e: ConsoleMessage) {
    const level = e.type();
    const rawArgs = e.args();

    async function getText(skipFirst = true) {
        let args = e.args();
        if (skipFirst) args = args.slice(1);

        try {
            return await Promise.all(
                args.map(async a => {
                    return await maybeGetError(a) || await a.jsonValue();
                })
            ).then(a => a.join(" ").trim());
        } catch {
            return e.text();
        }
    }

    const firstArg = await rawArgs[0]?.jsonValue();

    const isMod = firstArg === "[Protonn Cord]" || firstArg === "[Equicord]" || firstArg === "[ProtonnCord]";
    const isDebug = firstArg === "[PUP_DEBUG]";
    const isReporterMeta = firstArg === "[REPORTER_META]";

    if (isReporterMeta) {
        metaData = await rawArgs[1].jsonValue() as any;
        return;
    }

    outer:
    if (isMod) {
        try {
            var args = await Promise.all(e.args().map(a => a.jsonValue()));
        } catch {
            break outer;
        }

        const [, tag, message, otherMessage] = args as Array<string>;

        switch (tag) {
            case "WebpackPatcher:":
                const patchFailMatch = message.match(/Patch by (.+?) (had no effect|errored|found no module) \(Module id is (.+?)\): (.+)/);
                const patchSlowMatch = message.match(/Patch by (.+?) (took [\d.]+?ms) \(Module id is (.+?)\): (.+)/);
                const match = patchFailMatch ?? patchSlowMatch;
                if (!match) break;

                logStderr(await getText());
                process.exitCode = 1;

                const [, plugin, type, id, regex] = match;
                const list = patchFailMatch ? report.badPatches : report.slowPatches;
                list.push({
                    plugin,
                    type,
                    id,
                    match: regex,
                    error: await maybeGetError(e.args()[3])
                });

                break;
            case "PluginManager:":
                const failedToStartMatch = message.match(/Failed to start (.+)/);
                if (!failedToStartMatch) break;

                logStderr(await getText());
                process.exitCode = 1;

                const [, name] = failedToStartMatch;
                report.badStarts.push({
                    plugin: name,
                    error: await maybeGetError(e.args()[3]) ?? "Unknown error"
                });

                break;
            case "LazyChunkLoader:":
                logStderr(await getText());

                switch (message) {
                    case "A fatal error occurred:":
                        await failReporter(new Error(await getText()));
                        return;
                }

                break;
            case "Reporter:":
                logStderr(await getText());

                switch (message) {
                    case "A fatal error occurred:":
                        await failReporter(new Error(await getText()));
                        return;
                    case "Webpack Find Fail:":
                        process.exitCode = 1;
                        report.badWebpackFinds.push(otherMessage);
                        break;
                    case "Finished test":
                        await finishReporter();
                }
        }
    }

    if (isDebug) {
        logStderr(await getText());
    } else if (level === "error") {
        const text = await getText(false);

        if (text.length && !text.startsWith("Failed to load resource: the server responded with a status of") && !text.includes("Webpack")) {
            if (IGNORED_DISCORD_ERRORS.some(regex => text.match(regex))) {
                report.ignoredErrors.push(text);
            } else {
                logStderr("[Unexpected Error]", text);
                report.otherErrors.push(text);
                process.exitCode = 1;
            }
        }
    }
}

function describeError(error: unknown): string {
    const details = error as { message?: unknown; stack?: unknown; } | null;
    const message = typeof details?.message === "string" ? details.message : String(error);
    const stack = typeof details?.stack === "string" ? details.stack : message;
    return stack.split("\n", 25).join("\n").slice(0, 8_000);
}

function handlePageError(error: unknown) {
    const details = describeError(error);
    if (details.includes("Sentry successfully disabled")) return;

    logStderr("[Page Error]", details);
    report.otherErrors.push(details);
    process.exitCode = 1;
}

async function main() {
    try {
        browser = await pup.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_BIN,
            args: ["--disable-dev-shm-usage", ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])]
        });
        reporterTimeout = setTimeout(() => void finishReporter(true), reporterTimeoutMs);
        page = await browser.newPage();
        await page.setBypassCSP(true);
        let consoleMessages = Promise.resolve();
        page.on("console", e => {
            // Keep the completion marker behind earlier asynchronous finding reads.
            consoleMessages = consoleMessages.then(() => handleConsole(e)).catch(failReporter);
        });
        page.on("error", e => { void failReporter(e); });
        page.on("pageerror", handlePageError);
        await page.evaluateOnNewDocument(`
    if (location.host.endsWith("discord.com")) {
        ${readFileSync("./dist/browser/browser.js", "utf-8")};
    }
`);

        await page.goto(CANARY ? "https://canary.discord.com/login" : "https://discord.com/login", { timeout: 120000 });
    } catch (error) {
        await failReporter(error);
    }
}

void main();
