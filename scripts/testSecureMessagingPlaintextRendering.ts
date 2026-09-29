/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import type { DecryptIncomingResult } from "../src/equicordplugins/secureMessaging.desktop/native";

const sourcePath = "src/equicordplugins/secureMessaging.desktop/index.tsx";
const source = readFileSync(sourcePath, "utf8");
const functionNames = new Set([
    "EncryptedAttachmentStatus", "EncryptedMessageAccessory", "notifySecureMessageRow",
    "flushRenderDecryptions", "scheduleRenderDecryptBatch", "enqueueSettledRenderDecryption",
]);

function decrypted(plaintext: string): Extract<DecryptIncomingResult, { status: "decrypted"; }> {
    return { status: "decrypted", plaintext, attachmentBundle: null, stickers: [], detachedTextIndex: null, counter: 1, envelopeId: "synthetic" };
}

function fixture(count: number, implementation = source) {
    const parsed = createSourceFile("index.tsx", implementation, ScriptTarget.Latest, true);
    const functions = parsed.statements.filter(statement =>
        isFunctionDeclaration(statement) && statement.name && functionNames.has(statement.name.text)
    ).map(statement => statement.getText(parsed)).join("\n");
    const compiled = transpileModule(functions, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext, jsx: JsxEmit.React },
    }).outputText;
    const rows = Array.from({ length: count }, (_, index) => ({
        id: String(index), channel_id: "synthetic-channel", content: `PCEM3:synthetic-${index}`,
        author: { id: "synthetic-peer" }, attachments: [], stickerItems: [],
    }));
    const results = new Map<string, DecryptIncomingResult>();
    const memos = new Map<string, { dependencies: unknown[]; value: unknown; }>();
    const timers: Array<() => void> = [];
    const microtasks: Array<() => void> = [];
    const metrics = { rows: count, parserCalls: 0, rowRenders: 0, rowCallbacks: 0, flushes: 0, retries: 0, stateUpdates: 0, refreshes: 0 };
    let activeRowId = "";
    let protection = "ready";
    let userId = "synthetic-self";
    let keySuffix = "";
    let gate: string | null = null;
    let attachmentRetry = false;
    let localResult: DecryptIncomingResult | undefined;
    let optimistic: string | undefined;
    let embedOnly = false;
    let attachmentStatus = { status: "ready", reason: "synthetic attachment failure" };
    const rowListeners = new Map<string, Set<() => void>>();
    const runtime = runInNewContext(`${compiled}\n({ EncryptedMessageAccessory, enqueueSettledRenderDecryption })`, {
        RENDER_DECRYPT_BATCH_SIZE: 24, secureOperationGeneration: 1,
        secureMessageRowListeners: rowListeners, settledRenderDecryptions: [], renderDecryptBatchTimer: null,
        setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
        queueMicrotask: (callback: () => void) => microtasks.push(callback),
        ReactDOM: { flushSync: (callback: () => void) => { metrics.flushes++; callback(); } },
        UserStore: { getCurrentUser: () => ({ id: userId }) },
        decryptCacheKey: (_user: string, message: { id: string; }) => message.id + keySuffix,
        useState: (initial: unknown) => [typeof initial === "function"
            ? localResult ? { key: activeRowId + keySuffix, result: localResult } : initial()
            : initial, () => { metrics.stateUpdates++; }],
        get screenCaptureProtectionStatus() { return protection; }, chatGateReason: () => gate,
        invalidateFailedDecryption: (_user: string, message: { id: string; }) => { metrics.retries++; results.delete(message.id); },
        decryptCachedMessage: async () => undefined, invalidateEncryptedMessageEmbeds: () => undefined,
        retryEncryptedAttachmentLoad: () => { if (attachmentRetry) metrics.refreshes++; return attachmentRetry; },
        updateMessage: () => { metrics.refreshes++; },
        useMemo: (calculate: () => unknown, dependencies: unknown[]) => {
            let memo = memos.get(activeRowId);
            if (!memo || dependencies.length !== memo.dependencies.length || dependencies.some((value, index) => !Object.is(value, memo?.dependencies[index]))) {
                memo = { dependencies, value: calculate() };
                memos.set(activeRowId, memo);
            }
            return memo.value;
        },
        useScreenCaptureProtectionStatus: () => protection,
        getCachedDecryption: (_user: string, message: { id: string; }) => results.get(message.id) ?? null,
        getOptimisticOutgoingPlaintext: () => optimistic, encryptedMessageInlineEmbedStatus: () => "absent",
        classes: (...values: unknown[]) => values.filter(Boolean).join(" "), useEffect: () => undefined,
        MarkupClasses: { markup: "markup" }, MessageContentClasses: { messageContent: "messageContent" },
        shouldHideSecureEmbedOnlyPlaintext: () => embedOnly,
        Parser: { parse: (text: string) => { metrics.parserCalls++; return { parsed: text }; } },
        encryptedAttachmentCacheKey: () => "synthetic-attachment", encryptedAttachmentStatus: () => attachmentStatus,
        LockIcon: "LockIcon", BaseText: "BaseText", Button: "Button", encryptedStatusText: () => "blocked",
        React: { Fragment: "Fragment", createElement: (type: unknown, props: unknown, ...children: unknown[]) => typeof type === "function"
            ? type({ ...props as object, children }) : { type, props, children } },
    }) as {
        EncryptedMessageAccessory(props: { message: typeof rows[number]; }): unknown;
        enqueueSettledRenderDecryption(request: { channelId: string; messageId: string; generation: number; result: DecryptIncomingResult; apply(): void; }): void;
    };
    function render(index: number) {
        metrics.rowRenders++;
        activeRowId = rows[index].id;
        return runtime.EncryptedMessageAccessory({ message: rows[index] });
    }
    rows.forEach((row, index) => rowListeners.set(row.id, new Set([() => {
        metrics.rowCallbacks++;
        render(index);
    }])));
    function drain() {
        while (timers.length) {
            timers.shift()?.();
            while (microtasks.length) microtasks.shift()?.();
        }
    }
    return {
        metrics, render, drain,
        setProtection: (value: string) => { protection = value; },
        setAccount: (value: string) => { userId = value; },
        setGate: (value: string) => { gate = value; },
        setAttachmentRetry: () => { attachmentRetry = true; },
        changeCacheGeneration: () => { keySuffix += "generation"; },
        retryAction(): (() => void) | null {
            function find(node: any): (() => void) | null {
                if (!node || typeof node !== "object") return null;
                if (node.type === "Button" && node.children?.includes("Retry message")) return node.props.onClick;
                for (const child of Array.isArray(node) ? node : node.children ?? []) {
                    const action = find(child);
                    if (action) return action;
                }
                return null;
            }
            return find(render(0));
        },
        setResult: (value: DecryptIncomingResult) => { results.set(rows[0].id, value); },
        setLocalResult: (value: DecryptIncomingResult) => { localResult = value; },
        setEmbedOnly: (value: boolean) => { embedOnly = value; },
        setAttachments: (count: number, status = "ready") => {
            rows[0].attachments = Array.from({ length: count }, () => ({})) as never[];
            attachmentStatus = { ...attachmentStatus, status };
        },
        setOptimistic: (value: string) => { optimistic = value; rows[0].author.id = "synthetic-self"; },
        settleHistory(staggered: boolean) {
            rows.forEach((row, index) => {
                const result = decrypted(`synthetic plaintext ${index}`);
                runtime.enqueueSettledRenderDecryption({
                    channelId: row.channel_id, messageId: row.id, generation: 1, result,
                    apply: () => { results.set(row.id, result); render(index); },
                });
                if (staggered) drain();
            });
            drain();
        },
    };
}

if (process.argv.includes("--benchmark")) {
    const baseline = process.argv.find(argument => argument.startsWith("--baseline="))?.slice(11) ?? "afb415a23";
    const before = execFileSync("git", ["show", `${baseline}:${sourcePath}`], { encoding: "utf8" });
    for (const [version, implementation] of [[baseline, before], ["working tree", source]]) {
        for (const count of [50, 100]) {
            for (const staggered of [false, true]) {
                const measured = fixture(count, implementation);
                measured.settleHistory(staggered);
                process.stdout.write(`${JSON.stringify({ source: version, pattern: staggered ? "staggered" : "burst", ...measured.metrics })}\n`);
            }
        }
    }
} else {
    for (const staggered of [false, true]) {
        test(`${staggered ? "staggered" : "burst"} history updates parse each plaintext once`, () => {
            const h = fixture(100);
            h.settleHistory(staggered);
            assert.equal(h.metrics.parserCalls, 100);
            assert.equal(h.metrics.rowCallbacks, 100, "each settled decryption refreshes only its own row");
        });
    }

    test("changed plaintext reparses while unchanged plaintext reuses its parsed output", () => {
        const h = fixture(1);
        h.setResult(decrypted("first plaintext"));
        const first = h.render(0);
        assert.deepEqual(h.render(0), first);
        assert.equal(h.metrics.parserCalls, 1);
        h.setResult(decrypted("edited plaintext"));
        assert.notDeepEqual(h.render(0), first);
        assert.equal(h.metrics.parserCalls, 2);
    });

    test("protected and blocked states discard parsed plaintext before it can be shown again", () => {
        const h = fixture(1);
        h.setResult(decrypted("private fixture"));
        h.render(0);
        h.setProtection("screenshot");
        assert.doesNotMatch(JSON.stringify(h.render(0)), /private fixture/u);
        assert.equal(h.metrics.parserCalls, 1);
        h.setProtection("ready");
        h.render(0);
        assert.equal(h.metrics.parserCalls, 2, "showing plaintext again cannot reuse the protected render's memo");
        h.setResult({ status: "untrusted_author" });
        assert.doesNotMatch(JSON.stringify(h.render(0)), /private fixture/u);
        assert.equal(h.metrics.parserCalls, 2);
    });

    test("embed-only and blocked optimistic content do not start markdown parsing", () => {
        const h = fixture(1);
        h.setOptimistic("optimistic fixture");
        h.setEmbedOnly(true);
        h.render(0);
        assert.equal(h.metrics.parserCalls, 0);
        h.setEmbedOnly(false);
        h.render(0);
        assert.equal(h.metrics.parserCalls, 1);
        h.setResult({ status: "replay_detected" });
        assert.doesNotMatch(JSON.stringify(h.render(0)), /optimistic fixture/u);
        assert.equal(h.metrics.parserCalls, 1);
    });

    test("media-only rows render no empty plaintext element beside native media", () => {
        const h = fixture(1);
        for (const plaintext of ["", " \n\t"]) {
            h.setResult({ ...decrypted(plaintext), stickers: [{ id: "1", name: "fixture", formatType: 1 }] });
            assert.doesNotMatch(JSON.stringify(h.render(0)), /pc-secure-message|messageContent/u);
        }
        assert.equal(h.metrics.parserCalls, 0);
    });

    test("decrypted text renders with Discord's own message typography instead of a custom card", () => {
        const h = fixture(1);
        h.setResult(decrypted("styled fixture"));
        const rendered = JSON.stringify(h.render(0));
        assert.match(rendered, /"className":"markup messageContent pc-secure-message"/u);
        assert.doesNotMatch(rendered, /pc-secure-card/u);
    });

    test("media-only attachment cards retain loading, retry and integrity failures", () => {
        const h = fixture(1);
        h.setResult({ ...decrypted(""), attachmentBundle: { count: 1 } as never });
        h.setAttachments(1, "ready");
        assert.doesNotMatch(JSON.stringify(h.render(0)), /Loading encrypted previews|Retry attachment|incomplete/u);
        h.setAttachments(1, "loading");
        assert.match(JSON.stringify(h.render(0)), /Loading encrypted previews/u);
        h.setAttachments(1, "failed");
        assert.match(JSON.stringify(h.render(0)), /Retry attachment/u);
        h.setAttachments(0);
        assert.match(JSON.stringify(h.render(0)), /incomplete or has conflicting/u);
    });

    test("Retry message discards transient failure text and schedules a fresh shared render attempt", () => {
        for (const result of [
            { status: "failed", error: "cryptographic_operation_failed" },
            { status: "unavailable", reason: "security_key_locked" },
        ] satisfies DecryptIncomingResult[]) {
            const h = fixture(1);
            h.setResult(result);
            const retry = h.retryAction();
            assert.ok(retry);
            retry();
            assert.equal(h.metrics.retries, 1);
            assert.equal(h.metrics.stateUpdates, 2);
            assert.equal(h.metrics.refreshes, 1);
            assert.match(JSON.stringify(h.render(0)), /Decrypting encrypted message/u);
        }
        for (const result of [decrypted("text"), { status: "untrusted_author" }, { status: "replay_detected" }, { status: "invalid_message" }] satisfies DecryptIncomingResult[]) {
            const h = fixture(1);
            h.setResult(result);
            assert.equal(h.retryAction(), null);
        }
        const h = fixture(1);
        h.setResult({ status: "failed", error: "cryptographic_operation_failed" });
        h.setAttachmentRetry();
        h.retryAction()?.();
        assert.equal(h.metrics.refreshes, 1, "attachment recovery owns the host refresh when it starts a retry");
    });

    test("stale retry actions respect account, cache generation, chat gate and capture protection changes", () => {
        for (const change of ["account", "generation", "gate", "capture"]) {
            const h = fixture(1);
            h.setResult({ status: "failed", error: "cryptographic_operation_failed" });
            const retry = h.retryAction();
            assert.ok(retry);
            if (change === "account") h.setAccount("different-user");
            if (change === "generation") h.changeCacheGeneration();
            if (change === "gate") h.setGate("locked");
            if (change === "capture") h.setProtection("screenshot");
            retry();
            assert.equal(h.metrics.retries, 0, change);
            assert.equal(h.metrics.stateUpdates, 0, change);
        }
    });

    test("a duplicate mounted copy's transient state yields to the shared retry result", () => {
        for (const initial of [
            { status: "failed", error: "cryptographic_operation_failed" },
            { status: "unavailable", reason: "security_key_locked" },
        ] satisfies DecryptIncomingResult[]) {
            const h = fixture(1);
            h.setLocalResult(initial);
            h.setResult(initial);
            assert.ok(h.retryAction());
            h.setResult(decrypted("recovered in another view"));
            assert.match(JSON.stringify(h.render(0)), /recovered in another view/);
            assert.equal(h.retryAction(), null);
            h.setResult({ status: "untrusted_author" });
            assert.doesNotMatch(JSON.stringify(h.render(0)), /recovered in another view/);
            assert.equal(h.retryAction(), null);
        }
    });

    test("envelope rows share one highlight whose tone follows decryption and capture protection", () => {
        const h = rowFixture();
        assert.deepEqual(h.classes({ content: "ordinary", mentioned: true }), { mentioned: true }, "ordinary messages only keep Discord's own flags");
        assert.deepEqual(h.classes({ content: "PCKA1:announcement" }), { "mentioned": false, "pc-secure-row": true },
            "key announcements hide their payload without an encrypted highlight");
        assert.deepEqual(h.classes(), { "mentioned": false, "pc-secure-row pc-secure-row-encrypted": true }, "pending envelopes are already highlighted");
        h.result = decrypted("hello");
        assert.deepEqual(h.classes(), { "mentioned": false, "pc-secure-row pc-secure-row-encrypted": true });
        h.result = { status: "untrusted_author" };
        assert.deepEqual(h.classes(), { "mentioned": false, "pc-secure-row pc-secure-row-danger": true });
        h.protection = "screenshot";
        assert.deepEqual(h.classes(), { "mentioned": false, "pc-secure-row pc-secure-row-warning pc-secure-row-hidden": true });
        h.protection = "failed";
        assert.deepEqual(h.classes(), { "mentioned": false, "pc-secure-row pc-secure-row-danger pc-secure-row-hidden": true });
        h.protection = "disabled";
        assert.deepEqual(h.classes(), { mentioned: false }, "a stopped plugin leaves rows untouched");
    });

    test("encrypted mentions use Discord's own mention highlight", () => {
        const h = rowFixture();
        h.result = decrypted("<@local>");
        h.mentions = true;
        assert.deepEqual(h.classes(), { "mentioned": true, "pc-secure-row pc-secure-row-encrypted": true });
    });

    test("rows subscribe only for envelopes and refresh when their own decryption settles", () => {
        const h = rowFixture();
        h.classes({ content: "ordinary" });
        assert.equal(h.effects.length, 1);
        assert.equal(h.effects[0](), undefined, "ordinary messages never subscribe");
        assert.equal(h.rowListeners.size, 0);
        h.effects.length = 0;
        h.classes({ id: "a" });
        h.classes({ id: "b" });
        const cleanups = h.effects.map(effect => effect());
        assert.equal(h.captureListeners.size, 2);
        h.runtime.notifySecureMessageRow("a");
        assert.deepEqual(h.refreshes, ["a"], "a settled decryption refreshes only the row showing it");
        for (const listener of h.captureListeners) listener("screenshot");
        assert.deepEqual(h.refreshes, ["a", "a", "b"], "capture protection changes refresh every envelope row");
        cleanups.forEach(cleanup => (cleanup as () => void)());
        assert.equal(h.rowListeners.size, 0);
        assert.equal(h.captureListeners.size, 0);
    });
}

function rowFixture() {
    const names = new Set(["secureMessageRow", "useSecureMessageRow", "notifySecureMessageRow"]);
    const parsed = createSourceFile("index.tsx", source, ScriptTarget.Latest, true);
    const functions = parsed.statements.filter(statement =>
        isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)
    ).map(statement => statement.getText(parsed)).join("\n");
    const compiled = transpileModule(functions, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const rowListeners = new Map<string, Set<() => void>>();
    const captureListeners = new Set<(status: string) => void>();
    const effects: (() => (() => void) | undefined)[] = [];
    const refreshes: string[] = [];
    let currentId = "";
    const state = {
        result: null as DecryptIncomingResult | null, protection: "ready", mentions: false,
        rowListeners, captureListeners, effects, refreshes,
    };
    const runtime = runInNewContext(`${compiled}\n({ useSecureMessageRow, notifySecureMessageRow })`, {
        secureMessageRowListeners: rowListeners, screenCaptureProtectionListeners: captureListeners,
        get screenCaptureProtectionStatus() { return state.protection; },
        isEncryptedMessage: (content: string) => content.startsWith("PCEM3:"),
        isKeyAnnouncement: (content: string) => content.startsWith("PCKA1:"),
        UserStore: { getCurrentUser: () => ({ id: "local" }) },
        getCachedDecryption: () => state.result, getOptimisticOutgoingPlaintext: () => undefined,
        encryptedMessageMentionsUser: () => state.mentions,
        useState: () => {
            const id = currentId;
            return [0, () => refreshes.push(id)];
        },
        useEffect: (effect: () => (() => void) | undefined) => effects.push(effect),
    }) as {
        useSecureMessageRow(message: object, mentionedClassName: string): Record<string, boolean>;
        notifySecureMessageRow(id: string): void;
    };
    return Object.assign(state, {
        runtime,
        classes(overrides: { id?: string; content?: string; mentioned?: boolean; } = {}) {
            const message = { id: "row", channel_id: "channel", content: "PCEM3:envelope", author: { id: "peer" }, mentioned: false, ...overrides };
            currentId = message.id;
            return { ...runtime.useSecureMessageRow(message, "mentioned") };
        },
    });
}
