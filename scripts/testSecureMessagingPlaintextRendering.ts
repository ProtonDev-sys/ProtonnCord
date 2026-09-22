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
    "EncryptedAttachmentStatus", "EncryptedMessageAccessory", "flushSecureMessageGroupingChanges", "notifySecureMessageGroupingChanged",
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
    const metrics = { rows: count, parserCalls: 0, rowRenders: 0, groupingCallbacks: 0, flushes: 0 };
    let activeRowId = "";
    let protection = "ready";
    let optimistic: string | undefined;
    let embedOnly = false;
    let attachmentStatus = { status: "ready", reason: "synthetic attachment failure" };
    let groupFlags = 0;
    let layout: { cardTop: number; previousBottom: number | null; } | null = null;
    let layoutEffects: Array<() => void> = [];
    const styles = new Map<string, string>();
    const card = {
        closest: () => ({
            querySelector: () => null,
            previousElementSibling: { querySelector: () => layout?.previousBottom == null
                ? null : { getBoundingClientRect: () => ({ bottom: layout?.previousBottom }) } },
        }),
        getBoundingClientRect: () => ({ top: layout?.cardTop }),
        style: {
            getPropertyValue: (name: string) => styles.get(name),
            setProperty: (name: string, value: string) => styles.set(name, value),
        },
    };
    const groupingListeners = new Map<string, Set<() => void>>();
    const runtime = runInNewContext(`${compiled}\n({ EncryptedMessageAccessory, enqueueSettledRenderDecryption })`, {
        RENDER_DECRYPT_BATCH_SIZE: 24, secureOperationGeneration: 1,
        secureMessageGroupingNotificationScheduled: false,
        pendingSecureMessageGroupingChannels: new Set(), secureMessageGroupingRevisions: new Map(),
        secureMessageGroupingListeners: groupingListeners, settledRenderDecryptions: [], renderDecryptBatchTimer: null,
        setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
        queueMicrotask: (callback: () => void) => microtasks.push(callback),
        ReactDOM: { flushSync: (callback: () => void) => { metrics.flushes++; callback(); } },
        UserStore: { getCurrentUser: () => ({ id: "synthetic-self" }) },
        decryptCacheKey: (_user: string, message: { id: string; }) => message.id,
        useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => undefined],
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
        encryptedMessageMentionsUser: () => false, useRef: (value: unknown) => ({ current: value === null && layout ? card : value }),
        useSecureMessageGroupingRevision: () => 0, useStateFromStores: () => groupFlags, MessageStore: {},
        classes: (...values: unknown[]) => values.filter(Boolean).join(" "), SecureMessageGroup: { Previous: 1, Next: 2 },
        useLayoutEffect: (callback: () => void) => layoutEffects.push(callback), useEffect: () => undefined,
        setNativeMessageGroupStartObservation: () => undefined, removeNativeMessageGroupStartObservation: () => undefined,
        shouldHideSecureEmbedOnlyPlaintext: () => embedOnly,
        Parser: { parse: (text: string) => { metrics.parserCalls++; return { parsed: text }; } },
        encryptedAttachmentCacheKey: () => "synthetic-attachment", encryptedAttachmentStatus: () => attachmentStatus,
        LockIcon: "LockIcon", BaseText: "BaseText", Button: "Button", encryptedStatusText: () => "blocked",
        React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => typeof type === "function"
            ? type({ ...props as object, children }) : { type, props, children } },
    }) as {
        EncryptedMessageAccessory(props: { message: typeof rows[number]; nativeGroupStart: boolean; }): unknown;
        enqueueSettledRenderDecryption(request: { channelId: string; generation: number; result: DecryptIncomingResult; apply(): void; }): void;
    };
    function render(index: number) {
        metrics.rowRenders++;
        activeRowId = rows[index].id;
        layoutEffects = [];
        return runtime.EncryptedMessageAccessory({ message: rows[index], nativeGroupStart: false });
    }
    groupingListeners.set("synthetic-channel", new Set(rows.map((_, index) => () => {
        metrics.groupingCallbacks++;
        render(index);
    })));
    function drain() {
        while (timers.length) {
            timers.shift()?.();
            while (microtasks.length) microtasks.shift()?.();
        }
    }
    return {
        metrics, render, drain,
        setProtection: (value: string) => { protection = value; },
        setResult: (value: DecryptIncomingResult) => { results.set(rows[0].id, value); },
        setEmbedOnly: (value: boolean) => { embedOnly = value; },
        measureJoin: (cardTop: number, previousBottom: number | null, joined = true) => {
            layout = { cardTop, previousBottom };
            groupFlags = joined ? 1 : 0;
            render(0);
            layoutEffects.forEach(effect => effect());
            return styles.get("--pc-secure-message-join-gap");
        },
        setAttachments: (count: number, status = "ready") => {
            rows[0].attachments = Array.from({ length: count }, () => ({})) as never[];
            attachmentStatus = { ...attachmentStatus, status };
        },
        setOptimistic: (value: string) => { optimistic = value; rows[0].author.id = "synthetic-self"; },
        settleHistory(staggered: boolean) {
            rows.forEach((row, index) => {
                const result = decrypted(`synthetic plaintext ${index}`);
                runtime.enqueueSettledRenderDecryption({
                    channelId: row.channel_id, generation: 1, result,
                    apply: () => { results.set(row.id, result); render(index); },
                });
                if (staggered) drain();
            });
            drain();
        },
    };
}

if (process.argv.includes("--benchmark")) {
    const baseline = "cbd83c03";
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
            assert.equal(h.metrics.groupingCallbacks, staggered ? 10_000 : 500, "grouping notifications retain their existing behavior");
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

    test("media-only rows keep their replacement marker without an empty plaintext element", () => {
        const h = fixture(1);
        for (const plaintext of ["", " \n\t"]) {
            h.setResult({ ...decrypted(plaintext), stickers: [{ id: "1", name: "fixture", formatType: 1 }] });
            const rendered = JSON.stringify(h.render(0));
            assert.match(rendered, /pc-secure-replaces-content/u, "ciphertext stays hidden while native media is visible");
            assert.match(rendered, /pc-secure-message-without-text/u);
            assert.doesNotMatch(rendered, /pc-secure-card-plaintext/u);
        }
        assert.equal(h.metrics.parserCalls, 0, "whitespace does not create a plaintext node that prevents :empty matching");
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

    test("joined cards bridge the actual row gap without covering preceding text", () => {
        const h = fixture(1);
        h.setResult(decrypted("fixture"));
        assert.equal(h.measureJoin(106, 100), "6px");
        assert.equal(h.measureJoin(102, 100), "2px", "density changes replace the previous measurement");
        assert.equal(h.measureJoin(98, 100), "0px", "overlapping rows must not create a negative connector");
        assert.equal(h.measureJoin(106, null), "0px", "a missing previous row cannot leave a stale connector");
        assert.equal(h.measureJoin(106, 100, false), "0px", "splitting a group clears its connector");
    });
}
