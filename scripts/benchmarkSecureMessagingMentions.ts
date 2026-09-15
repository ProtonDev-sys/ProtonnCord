/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { encryptMessage, generateIdentity, publicIdentity } from "../src/equicordplugins/secureMessaging.desktop/crypto";
import { encryptedMessageMentionsUser } from "../src/equicordplugins/secureMessaging.desktop/mentionNotifications";
import { parseEncryptedEnvelope, serializeEncryptedEnvelope } from "../src/equicordplugins/secureMessaging.desktop/protocol";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIRECTORY = "src/equicordplugins/secureMessaging.desktop/";
const USER_ID = "100000000000000002";
const OTHER_ID = "100000000000000003";
const CONTEXT = { channelId: "200000000000000001", discordAuthorId: "100000000000000001" };
const NOW = 1_800_000_000_000;
const BATCH_SIZE = 100;
const SAMPLES = 101;

type MentionLookup = typeof encryptedMessageMentionsUser;

interface Fixture {
    content: string;
    plaintext?: string;
    expected: boolean;
}

function loadLookup(read: (file: string) => string): MentionLookup {
    const load = (file: string, protocol?: Record<string, unknown>): Record<string, unknown> => {
        const exports: Record<string, unknown> = {};
        const compiled = ts.transpileModule(read(DIRECTORY + file), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        });
        runInNewContext(compiled.outputText, {
            exports,
            atob,
            btoa,
            TextEncoder,
            require: (name: string) => {
                assert.equal(name, "./protocol");
                assert.ok(protocol);
                return protocol;
            },
        });
        return exports;
    };
    const lookup = load("mentionNotifications.ts", load("protocol.ts")).encryptedMessageMentionsUser;
    assert.equal(typeof lookup, "function");
    return lookup as MentionLookup;
}

async function createFixtures(count: number): Promise<Record<string, Fixture[]>> {
    const identity = await generateIdentity(NOW);
    const recipients = await Promise.all([USER_ID, OTHER_ID].map(async userId =>
        publicIdentity(await generateIdentity(NOW + 1), userId)));
    const fixtures: Record<string, Fixture[]> = {};
    const mentions: Record<string, string[]> = {
        "no-mention": [],
        "current-user-mention": [USER_ID],
        "other-user-mention": [OTHER_ID],
    };
    for (const [scenario, mentionedUserIds] of Object.entries(mentions)) {
        fixtures[scenario] = [];
        fixtures[`${scenario}-decrypted`] = [];
        for (let index = 0; index < count; index++) {
            const plaintext = `A typical encrypted chat message number ${index}. ${mentionedUserIds.map(id => `<@${id}>`).join(" ")}`;
            const content = await encryptMessage({
                channelId: CONTEXT.channelId,
                counter: index + 1,
                identity,
                mentionedUserIds,
                now: NOW,
                plaintext,
                recipients,
                senderUserId: CONTEXT.discordAuthorId,
            });
            fixtures[scenario].push({ content, expected: mentionedUserIds.includes(USER_ID) });
            fixtures[`${scenario}-decrypted`].push({ content, plaintext, expected: mentionedUserIds.includes(USER_ID) });
        }
    }
    return fixtures;
}

function verify(lookup: MentionLookup, scenarios: Record<string, Fixture[]>): void {
    const current = scenarios["current-user-mention"][0].content;
    const noMention = scenarios["no-mention"][0].content;
    const { m: _mentions, ...envelope } = parseEncryptedEnvelope(current, CONTEXT);
    const legacy = serializeEncryptedEnvelope({ ...envelope, v: 1, i: "00000000-0000-4000-8000-000000000001" });
    const previous = serializeEncryptedEnvelope({ ...envelope, v: 2 });
    const plaintext = `Hello <@!${USER_ID}>`;
    const fixtures: Fixture[] = [
        ...Object.values(scenarios).flat(),
        { content: current, plaintext: "No visible mention", expected: true },
        { content: noMention, plaintext, expected: true },
        { content: legacy, expected: false },
        { content: legacy, plaintext, expected: true },
        { content: previous, expected: false },
        { content: previous, plaintext, expected: true },
        { content: `<@${USER_ID}>`, expected: false },
        { content: `PCEM3:["<@${USER_ID}>"]`, expected: false },
        { content: current + " ", expected: false },
        { content: current.replace(`<@${USER_ID}>`, `<@!${USER_ID}>`), expected: false },
        { content: current.replace(`<@${USER_ID}>`, `\\u003c@${USER_ID}>`), expected: false },
        { content: "PCEM3:{", plaintext, expected: true },
        { content: noMention, plaintext: `<@&${USER_ID}> <@${OTHER_ID}>`, expected: false },
    ];
    for (const fixture of fixtures) {
        assert.equal(lookup(fixture.content, CONTEXT, USER_ID, fixture.plaintext), fixture.expected);
        for (const userId of ["", "123", `<@${USER_ID}>`, USER_ID + "x"])
            assert.equal(lookup(fixture.content, CONTEXT, userId, fixture.plaintext), false);
    }
    assert.equal(lookup(current, { ...CONTEXT, channelId: "invalid" }, USER_ID), false);
    assert.equal(lookup(current, { ...CONTEXT, channelId: "invalid" }, USER_ID, plaintext), true);
}

function summarize(samples: number[]) {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(4)),
        p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(4)),
    };
}

async function main(): Promise<void> {
    const checkOnly = process.argv.includes("--check");
    const scenarios = await createFixtures(checkOnly ? 1 : BATCH_SIZE);
    verify(encryptedMessageMentionsUser, scenarios);
    if (checkOnly) {
        console.log("Secure messaging mention lookup checks passed.");
        return;
    }
    const baselineArgument = process.argv.find(argument => argument.startsWith("--baseline="));
    assert.ok(baselineArgument, "Pass --baseline=<git-ref> to compare with the working tree, or --check for correctness checks.");
    const baseline = execFileSync("git", ["rev-parse", "--verify", `${baselineArgument.slice(11)}^{commit}`], { cwd: ROOT, encoding: "utf8" }).trim();
    const before = loadLookup(file => execFileSync("git", ["show", `${baseline}:${file}`], { cwd: ROOT, encoding: "utf8" }));
    const after = loadLookup(file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    verify(before, scenarios);
    verify(after, scenarios);
    for (const [scenario, fixtures] of Object.entries(scenarios)) {
        const expected = fixtures.filter(fixture => fixture.expected).length;
        const measure = (lookup: MentionLookup): number => {
            let matches = 0;
            const startedAt = performance.now();
            for (const fixture of fixtures) matches += Number(lookup(fixture.content, CONTEXT, USER_ID, fixture.plaintext));
            const elapsed = performance.now() - startedAt;
            assert.equal(matches, expected);
            return elapsed;
        };
        for (let index = 0; index < 20; index++) {
            measure(before);
            measure(after);
        }
        const beforeSamples: number[] = [];
        const afterSamples: number[] = [];
        for (let index = 0; index < SAMPLES; index++) {
            if (index % 2 === 0) {
                beforeSamples.push(measure(before));
                afterSamples.push(measure(after));
            } else {
                afterSamples.push(measure(after));
                beforeSamples.push(measure(before));
            }
        }
        console.log(JSON.stringify({
            benchmark: "secure-messaging-mentions",
            baseline,
            node: process.version,
            scenario,
            batchSize: fixtures.length,
            samples: SAMPLES,
            before: summarize(beforeSamples),
            after: summarize(afterSamples),
        }));
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
