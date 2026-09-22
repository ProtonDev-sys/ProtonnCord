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
import { secureMessageGroupNeighborIds } from "../src/equicordplugins/secureMessaging.desktop/messageGrouping";

const sourcePath = "src/equicordplugins/secureMessaging.desktop/index.tsx";
const source = readFileSync(sourcePath, "utf8");
const functionNames = new Set([
    "EncryptedAttachmentStatus", "EncryptedMessageAccessory", "flushSecureMessageGroupingChanges", "notifySecureMessageGroupingChanged",
    "flushRenderDecryptions", "scheduleRenderDecryptBatch", "enqueueSettledRenderDecryption", "groupObservationKey",
]);

function decrypted(plaintext: string): Extract<DecryptIncomingResult, { status: "decrypted"; }> {
    return { status: "decrypted", plaintext, attachmentBundle: null, stickers: [], detachedTextIndex: null, counter: 1, envelopeId: "synthetic" };
}

function fixture(count: number, implementation = source) {
    const targetedGrouping = implementation.includes("pendingSecureMessageGroupingMessages");
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
    const metrics = { rows: count, parserCalls: 0, rowRenders: 0, groupingCallbacks: 0, flushes: 0, retries: 0, stateUpdates: 0, refreshes: 0 };
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
    const groupingListeners = new Map<string, Set<() => void> | Map<string, Set<() => void>>>();
    const runtime = runInNewContext(`${compiled}\n({ EncryptedMessageAccessory, enqueueSettledRenderDecryption })`, {
        RENDER_DECRYPT_BATCH_SIZE: 24, secureOperationGeneration: 1,
        secureMessageGroupingNotificationScheduled: false,
        pendingSecureMessageGroupingChannels: new Set(), secureMessageGroupingRevisions: new Map(),
        pendingSecureMessageGroupingMessages: new Map(), secureMessageGroupNeighborIds,
        secureMessageGroupingListeners: groupingListeners, settledRenderDecryptions: [], renderDecryptBatchTimer: null,
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
        encryptedMessageMentionsUser: () => false, useRef: (value: unknown) => ({ current: value === null && layout ? card : value }),
        useSecureMessageGroupingRevision: () => 0, useStateFromStores: () => groupFlags,
        MessageStore: { getMessages: () => ({ _array: rows }) },
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
        enqueueSettledRenderDecryption(request: { channelId: string; messageId: string; generation: number; result: DecryptIncomingResult; apply(): void; }): void;
    };
    function render(index: number) {
        metrics.rowRenders++;
        activeRowId = rows[index].id;
        layoutEffects = [];
        return runtime.EncryptedMessageAccessory({ message: rows[index], nativeGroupStart: false });
    }
    const rowListeners = rows.map((_, index) => () => {
        metrics.groupingCallbacks++;
        render(index);
    });
    groupingListeners.set("synthetic-channel", targetedGrouping
        ? new Map(rows.map((row, index) => [row.id, new Set([rowListeners[index]])]))
        : new Set(rowListeners));
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
                    channelId: row.channel_id, messageId: row.id, generation: 1, result,
                    apply: () => { results.set(row.id, result); render(index); },
                });
                if (staggered) drain();
            });
            drain();
        },
    };
}

function groupingFixture() {
    const names = new Set([
        "groupObservationKey", "flushSecureMessageGroupingChanges", "notifySecureMessageGroupingChanged",
        "useSecureMessageGroupingRevision", "observedNativeMessageGroupStart",
        "setNativeMessageGroupStartObservation", "removeNativeMessageGroupStartObservation",
    ]);
    const parsed = createSourceFile("index.tsx", source, ScriptTarget.Latest, true);
    const functions = parsed.statements.filter(statement =>
        isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)
    ).map(statement => statement.getText(parsed)).join("\n");
    const compiled = transpileModule(functions, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const rows = new Map<string, { id: string; }[]>();
    const listeners = new Map<string, Map<string, Set<() => void>>>();
    const revisions = new Map<string, number>();
    const pending = new Map<string, Set<string>>();
    const microtasks: (() => void)[] = [];
    let subscriber: { calls: number; cleanup(): void; };
    const runtime = runInNewContext(`${compiled}\n({ notifySecureMessageGroupingChanged, useSecureMessageGroupingRevision, setNativeMessageGroupStartObservation, removeNativeMessageGroupStartObservation })`, {
        secureMessageGroupingNotificationScheduled: false,
        secureMessageGroupingListeners: listeners, secureMessageGroupingRevisions: revisions,
        pendingSecureMessageGroupingMessages: pending, nativeMessageGroupStartObservations: new Map(),
        secureMessageGroupNeighborIds, MessageStore: { getMessages: (channel: string) => ({ _array: rows.get(channel) }) },
        queueMicrotask: (callback: () => void) => microtasks.push(callback),
        useState: (initial: () => number) => {
            const current = subscriber;
            return [initial(), () => current.calls++];
        },
        useLayoutEffect: (effect: () => () => void) => { subscriber.cleanup = effect(); },
    }) as {
        notifySecureMessageGroupingChanged(channel: string, id: string): void;
        useSecureMessageGroupingRevision(channel: string, id: string): number;
        setNativeMessageGroupStartObservation(channel: string, id: string, owner: object, start: boolean): void;
        removeNativeMessageGroupStartObservation(channel: string, id: string, owner: object): void;
    };
    return {
        rows, listeners, revisions, pending,
        notify: runtime.notifySecureMessageGroupingChanged,
        observe: runtime.setNativeMessageGroupStartObservation,
        unobserve: runtime.removeNativeMessageGroupStartObservation,
        flush() { while (microtasks.length) microtasks.shift()?.(); },
        mount(channel: string, id: string) {
            subscriber = { calls: 0, cleanup() {} };
            runtime.useSecureMessageGroupingRevision(channel, id);
            subscriber.calls = 0;
            return subscriber;
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
            assert.equal(h.metrics.groupingCallbacks, staggered ? 298 : 108, "grouping refreshes only affected rows and their neighbors");
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

    test("joined cards bridge the actual row gap without covering preceding text", () => {
        const h = fixture(1);
        h.setResult(decrypted("fixture"));
        assert.equal(h.measureJoin(106, 100), "6px");
        assert.equal(h.measureJoin(102, 100), "2px", "density changes replace the previous measurement");
        assert.equal(h.measureJoin(98, 100), "0px", "overlapping rows must not create a negative connector");
        assert.equal(h.measureJoin(106, null), "0px", "a missing previous row cannot leave a stale connector");
        assert.equal(h.measureJoin(106, 100, false), "0px", "splitting a group clears its connector");
    });

    test("group updates deduplicate neighboring rows and stay inside their channel", () => {
        const h = groupingFixture();
        h.rows.set("a", ["0", "1", "2", "3", "4"].map(id => ({ id })));
        h.rows.set("b", [{ id: "2" }]);
        const rows = ["0", "1", "2", "3", "4"].map(id => h.mount("a", id));
        const otherChannel = h.mount("b", "2");
        const secondCopy = h.mount("a", "2");
        h.notify("a", "2"); h.notify("a", "2"); h.notify("a", "3");
        h.flush();
        assert.deepEqual(rows.map(row => row.calls), [0, 1, 1, 1, 1]);
        assert.equal(secondCopy.calls, 1);
        assert.equal(otherChannel.calls, 0);
        secondCopy.cleanup();
        h.notify("a", "0"); h.flush();
        assert.deepEqual(rows.map(row => row.calls), [1, 2, 1, 1, 1]);
        assert.equal(secondCopy.calls, 1);
    });

    test("inserted rows use their current neighbors and removed rows refresh the channel", () => {
        const h = groupingFixture();
        const messages = ["first", "middle", "last"].map(id => ({ id }));
        h.rows.set("channel", messages);
        const rows = messages.map(row => h.mount("channel", row.id));
        h.notify("channel", "first"); h.flush();
        messages.splice(1, 0, { id: "inserted" });
        const inserted = h.mount("channel", "inserted");
        h.notify("channel", "inserted"); h.flush();
        assert.deepEqual(rows.map(row => row.calls), [2, 2, 0]);
        assert.equal(inserted.calls, 1);
        messages.splice(1, 1);
        inserted.cleanup();
        h.notify("channel", "inserted"); h.flush();
        assert.deepEqual(rows.map(row => row.calls), [3, 3, 1]);
        assert.equal(inserted.calls, 1);
    });

    test("native group boundary changes and disposed observations refresh affected neighbors", () => {
        const h = groupingFixture();
        h.rows.set("channel", ["0", "1", "2", "3"].map(id => ({ id })));
        const rows = ["0", "1", "2", "3"].map(id => h.mount("channel", id));
        const owner = {};
        h.observe("channel", "1", owner, false); h.flush();
        h.observe("channel", "1", owner, false); h.flush();
        assert.deepEqual(rows.map(row => row.calls), [1, 1, 1, 0]);
        h.observe("channel", "1", owner, true); h.flush();
        h.unobserve("channel", "1", owner); h.flush();
        assert.deepEqual(rows.map(row => row.calls), [3, 3, 3, 0]);
    });

    test("subscription cleanup removes revisions and cannot delete subscribers created after a reset", () => {
        const h = groupingFixture();
        h.rows.set("channel", [{ id: "row" }]);
        const old = h.mount("channel", "row");
        h.listeners.clear(); h.revisions.clear(); h.pending.clear();
        const current = h.mount("channel", "row");
        old.cleanup();
        h.notify("channel", "row"); h.flush();
        assert.equal(current.calls, 1);
        assert.equal(old.calls, 0);
        current.cleanup();
        assert.equal(h.listeners.size, 0);
        assert.equal(h.revisions.size, 0);
        h.notify("channel", "row"); h.flush();
        assert.equal(current.calls, 1);
        assert.equal(h.pending.size, 0);
    });
}
