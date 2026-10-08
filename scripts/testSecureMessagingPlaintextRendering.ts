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
import { composeSecureForwardText, parseSecureForwardText } from "../src/equicordplugins/secureMessaging.desktop/forwarding";

const sourcePath = "src/equicordplugins/secureMessaging.desktop/index.tsx";
const source = readFileSync(sourcePath, "utf8");
const functionNames = new Set([
    "EncryptedAttachmentStatus", "EncryptedMessageAccessory", "notifySecureMessageRow",
    "flushRenderDecryptions", "scheduleRenderDecryptBatch", "enqueueSettledRenderDecryption",
    "SecureMessageAccessory", "renderSecurePreviewContent",
]);

function decrypted(plaintext: string): Extract<DecryptIncomingResult, { status: "decrypted"; }> {
    return { status: "decrypted", plaintext, attachmentBundle: null, stickers: [], detachedTextIndex: null, counter: 1, envelopeId: "synthetic" };
}

test("provisional own rows never start persistent native replay processing", async () => {
    const parsed = createSourceFile("index.tsx", source, ScriptTarget.Latest, true);
    const declaration = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === "decryptCachedMessageForRender");
    assert.ok(declaration);
    const calls: string[] = [];
    const compiled = transpileModule(declaration.getText(parsed), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext },
    }).outputText;
    const render = runInNewContext(`${compiled}\n decryptCachedMessageForRender`, {
        secureOperationGeneration: 1,
        discordMessageNonce: (message: { nonce: string | null; }) => message.nonce,
        isProvisionalOutgoingMessage: (messageId: string, nonce: string | null) => messageId === nonce,
        decryptCachedMessage: async (_userId: string, message: { id: string; }) => { calls.push(message.id); return decrypted("fixture"); },
        enqueueSettledRenderDecryption: () => undefined,
    }) as (userId: string, message: unknown, apply: () => void) => void;
    const provisional = { id: "1554579244301541376", nonce: "1554579244301541376", author: { id: "self" } };
    render("self", provisional, () => undefined);
    assert.deepEqual(calls, []);
    render("self", { ...provisional, id: "1554579251049529437", nonce: null }, () => undefined);
    render("self", { ...provisional, author: { id: "peer" } }, () => undefined);
    await Promise.resolve();
    assert.deepEqual(calls, ["1554579251049529437", provisional.id]);
});

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
    let recoveryResult: DecryptIncomingResult = decrypted("recovered fixture");
    const recoveryCalls: unknown[] = [];
    const parserCalls: Array<{ text: string; inline?: boolean; state?: Record<string, unknown>; }> = [];
    let embedOnly = false;
    let attachmentStatus = { status: "ready", reason: "synthetic attachment failure" };
    const rowListeners = new Map<string, Set<() => void>>();
    const runtime = runInNewContext(`${compiled}\n({ EncryptedMessageAccessory, enqueueSettledRenderDecryption, renderSecurePreviewContent: typeof renderSecurePreviewContent === "function" ? renderSecurePreviewContent : undefined })`, {
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
        invalidateRecoveredDecryption: (_user: string, message: { id: string; }) => { results.delete(message.id); },
        discordEditedTimestamp: () => null, discordMessageNonce: () => null,
        Native: { recoverOwnMessage: async (...args: unknown[]) => { recoveryCalls.push(args); return recoveryResult; } },
        showToast: () => undefined, Toasts: { Type: { FAILURE: "failure" } },
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
        parseSecureForwardText,
        isEncryptedMessage: (content: string) => content.startsWith("PCEM3:"),
        isKeyAnnouncement: (content: string) => content.startsWith("PCKA1:"),
        classes: (...values: unknown[]) => values.filter(Boolean).join(" "), useEffect: () => undefined,
        MarkupClasses: { markup: "markup" }, MessageContentClasses: { messageContent: "messageContent" },
        shouldHideSecureEmbedOnlyPlaintext: () => embedOnly,
        Parser: { parse: (text: string, inline?: boolean, state?: Record<string, unknown>) => {
            metrics.parserCalls++;
            parserCalls.push({ text, inline, state });
            return { parsed: text };
        } },
        encryptedAttachmentCacheKey: () => "synthetic-attachment", encryptedAttachmentStatus: () => attachmentStatus,
        LockIcon: "LockIcon", BaseText: "BaseText", Button: "Button", ErrorBoundary: "ErrorBoundary", encryptedStatusText: () => "blocked",
        React: { Fragment: "Fragment", createElement: (type: unknown, props: unknown, ...children: unknown[]) => typeof type === "function"
            ? type({ ...props as object, children }) : { type, props, children } },
    }) as {
        EncryptedMessageAccessory(props: { message: typeof rows[number]; }): unknown;
        renderSecurePreviewContent(message: typeof rows[number]): unknown;
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
        metrics, render, drain, recoveryCalls, parserCalls,
        renderPreview(index = 0) {
            activeRowId = rows[index].id;
            return runtime.renderSecurePreviewContent(rows[index]);
        },
        setMessageContext: (context: { id?: string; channelId?: string; authorId?: string; }) => {
            if (context.id !== undefined) {
                const result = results.get(rows[0].id);
                rows[0].id = context.id;
                if (result) results.set(context.id, result);
            }
            if (context.channelId !== undefined) rows[0].channel_id = context.channelId;
            if (context.authorId !== undefined) rows[0].author.id = context.authorId;
        },
        setRecoveryResult: (value: DecryptIncomingResult) => { recoveryResult = value; },
        setProtection: (value: string) => { protection = value; },
        setAccount: (value: string) => { userId = value; },
        setGate: (value: string) => { gate = value; },
        setAttachmentRetry: () => { attachmentRetry = true; },
        changeCacheGeneration: () => { keySuffix += "generation"; },
        retryAction(label = "Retry message"): (() => void) | null {
            function find(node: any): (() => void) | null {
                if (!node || typeof node !== "object") return null;
                if (node.type === "Button" && node.children?.includes(label)) return node.props.onClick;
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

    test("decrypted and optimistic game mentions use Discord's message parser context", () => {
        const plaintext = "Play <@$700136079562375258> with <@123>\n`<@$700136079562375258>` ||<@$700136079562375258>||";
        for (const optimistic of [false, true]) {
            const h = fixture(1);
            if (optimistic) h.setOptimistic(plaintext);
            else h.setResult(decrypted(plaintext));
            h.render(0);
            assert.equal(h.parserCalls.length, 1);
            const [call] = h.parserCalls;
            assert.equal(call.text, plaintext, "Discord receives unchanged markdown, including code and spoilers");
            assert.equal(call.inline, false, "message text retains block markdown");
            assert.deepEqual({ ...call.state }, {
                allowGameMentions: true,
                channelId: "synthetic-channel",
                viewingChannelId: "synthetic-channel",
                messageId: "0",
                authorId: optimistic ? "synthetic-self" : "synthetic-peer",
            });
        }
    });

    test("message context changes reparse unchanged game mentions", () => {
        const h = fixture(1);
        h.setResult(decrypted("<@$700136079562375258>"));
        h.render(0);
        h.setMessageContext({ channelId: "another-channel" });
        h.render(0);
        assert.equal(h.parserCalls.length, 2);
        assert.equal(h.parserCalls[1].state?.channelId, "another-channel");
        assert.equal(h.parserCalls[1].state?.viewingChannelId, "another-channel");
        h.setMessageContext({ authorId: "another-peer" });
        h.render(0);
        assert.equal(h.parserCalls.length, 3);
        assert.equal(h.parserCalls[2].state?.authorId, "another-peer");
        h.setMessageContext({ id: "confirmed-message" });
        h.render(0);
        assert.equal(h.parserCalls.length, 4);
        assert.equal(h.parserCalls[3].state?.messageId, "confirmed-message");
        h.render(0);
        assert.equal(h.parserCalls.length, 4, "unchanged message context reuses parsed output");
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

    test("authenticated forwards render source text separately from the parsed note and body", () => {
        const h = fixture(1);
        const authorLabel = "*source* <script>alert(1)</script>";
        const text = composeSecureForwardText({ authorLabel, content: "**Private forwarded body**", timestampMs: 1_700_000_000_000 });
        const plaintext = `My **forwarding note**\n\n${text}`;
        h.setResult({ ...decrypted(plaintext), forward: parseSecureForwardText(plaintext)! });
        const tree = h.render(0) as { children: Array<{ type: string; props: { className?: string; }; }>; };
        const rendered = JSON.stringify(tree);
        assert.match(tree.children[0].props.className!, /pc-secure-forward-note/u);
        assert.equal(tree.children[1].type, "article", "the forwarding note precedes the copied message card");
        assert.doesNotMatch(JSON.stringify(tree.children[1]), /forwarding note/u);
        assert.match(rendered, /pc-secure-forward/u);
        assert.match(rendered, /Forwarded message/u);
        assert.match(rendered, /\*source\* <script>alert\(1\)<\/script>/u, "source attribution stays plain React text");
        assert.match(rendered, /2023-11-14T22:13:20\.000Z/u);
        assert.deepEqual(h.parserCalls.map(call => call.text), ["**Private forwarded body**", "My **forwarding note**"], "metadata never enters Discord's markdown or mention parser");
        assert.ok(h.parserCalls.every(call => call.state?.authorId === "synthetic-peer"), "the authenticated forwarding sender keeps the actual Discord author context");
        assert.doesNotMatch(rendered, /Forwarded copy from|messageSnapshots|messageReference/u);
        h.render(0);
        assert.equal(h.metrics.parserCalls, 2, "unchanged forward text reuses parsed body and note");
    });

    test("forward cards keep file-only attachment loading, retry and integrity checks", () => {
        const h = fixture(1);
        const plaintext = composeSecureForwardText({ authorLabel: "Original sender", content: "" });
        h.setResult({ ...decrypted(plaintext), forward: parseSecureForwardText(plaintext)!, attachmentBundle: { count: 1 } as never });
        h.setAttachments(1, "loading");
        const rendered = JSON.stringify(h.render(0));
        assert.match(rendered, /pc-secure-forward/u);
        assert.match(rendered, /Original sender/u);
        assert.match(rendered, /Loading encrypted previews/u);
        assert.equal(h.metrics.parserCalls, 0, "file-only forwards have no empty parsed message body");
        h.setAttachments(1, "failed");
        assert.match(JSON.stringify(h.render(0)), /Retry attachment/u);
        h.setAttachments(0);
        assert.match(JSON.stringify(h.render(0)), /incomplete or has conflicting/u);
    });

    test("optimistic forwards and pin previews use the same guarded forward card", () => {
        const plaintext = composeSecureForwardText({ authorLabel: "Forwarded author", content: "private copied content" });
        for (const optimistic of [false, true]) {
            const h = fixture(1);
            if (optimistic) h.setOptimistic(plaintext);
            else h.setResult({ ...decrypted(plaintext), forward: parseSecureForwardText(plaintext)! });
            const normal = JSON.stringify(h.render(0));
            const preview = JSON.stringify(h.renderPreview());
            for (const rendered of [normal, preview]) {
                assert.match(rendered, /pc-secure-forward/u);
                assert.match(rendered, /Forwarded author/u);
                assert.match(rendered, /private copied content/u);
                assert.doesNotMatch(rendered, /PCEM3:|Forwarded copy from/u);
            }
            assert.equal(h.parserCalls.length, 1, "pin and timeline reuse the same parsed text");
        }
    });

    test("forward metadata and body disappear when capture protection or authentication blocks content", () => {
        const plaintext = composeSecureForwardText({ authorLabel: "Private source author", content: "secret copied body", timestampMs: 1_700_000_000_000 });
        const h = fixture(1);
        h.setOptimistic(plaintext);
        h.setResult({ ...decrypted(plaintext), forward: parseSecureForwardText(plaintext)! });
        h.render(0);
        for (const protection of ["pending", "failed", "screenshot", "disabled"]) {
            h.setProtection(protection);
            for (const rendered of [h.render(0), h.renderPreview()]) {
                assert.doesNotMatch(JSON.stringify(rendered) ?? "", /pc-secure-forward|Private source author|secret copied body|2023-11-14/u);
            }
        }
        h.setProtection("ready");
        for (const blocked of [
            { status: "untrusted_author" }, { status: "invalid_message" }, { status: "replay_detected" },
            { status: "unavailable", reason: "security_key_locked" },
        ] satisfies DecryptIncomingResult[]) {
            h.setResult(blocked);
            assert.doesNotMatch(JSON.stringify(h.render(0)), /pc-secure-forward|Private source author|secret copied body|2023-11-14/u, "optimistic text cannot override a blocked authenticated outcome");
        }
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

    test("only an eligible own replay offers recovery and refreshes after native confirmation", async () => {
        const h = fixture(1);
        h.setResult({ status: "replay_detected", recoveryAvailable: true });
        assert.equal(h.retryAction("Recover my sent message"), null, "received messages never offer recovery");
        h.setOptimistic("own fixture");
        h.setResult({ status: "replay_detected" });
        assert.equal(h.retryAction("Recover my sent message"), null, "canonical conflicts never offer recovery");
        h.setResult({ status: "replay_detected", recoveryAvailable: true });
        const recover = h.retryAction("Recover my sent message");
        assert.ok(recover);
        recover();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.recoveryCalls.length, 1);
        assert.equal(h.metrics.refreshes, 1);
        assert.match(JSON.stringify(h.render(0)), /own fixture/u);
    });

    test("cancelled recovery preserves the blocked row and stale recovery actions cannot start", async () => {
        for (const change of ["cancel", "account", "generation", "gate", "capture"]) {
            const h = fixture(1);
            h.setOptimistic("own fixture");
            h.setResult({ status: "replay_detected", recoveryAvailable: true });
            h.setRecoveryResult({ status: "replay_detected", recoveryAvailable: true });
            const recover = h.retryAction("Recover my sent message");
            assert.ok(recover);
            if (change === "account") h.setAccount("other-account");
            if (change === "generation") h.changeCacheGeneration();
            if (change === "gate") h.setGate("locked");
            if (change === "capture") h.setProtection("screenshot");
            recover();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(h.recoveryCalls.length, change === "cancel" ? 1 : 0);
            assert.equal(h.metrics.refreshes, 0);
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

    test("a duplicate mounted copy's recoverable replay state yields to authenticated recovery", () => {
        const h = fixture(1);
        h.setLocalResult({ status: "replay_detected", recoveryAvailable: true });
        h.setResult(decrypted("confirmed recovered message"));
        const rendered = JSON.stringify(h.render(0));
        assert.match(rendered, /confirmed recovered message/u);
        assert.doesNotMatch(rendered, /Encrypted message blocked/u);
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
