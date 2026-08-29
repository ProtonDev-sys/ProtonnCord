import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { exactArrayBuffer } from "../src/equicordplugins/secureMessaging.desktop/exactArrayBuffer";
import { KeyReviewGate } from "../src/equicordplugins/secureMessaging.desktop/keyReviewGate";
import {
    SecureMessageGroup,
    secureMessageGroupFlags,
    type SecureMessageGroupCandidate,
} from "../src/equicordplugins/secureMessaging.desktop/messageGrouping";
import { ENCRYPTED_MESSAGE_PREFIX } from "../src/equicordplugins/secureMessaging.desktop/protocol";
import { createTaskQueue } from "../src/equicordplugins/secureMessaging.desktop/taskQueue";

interface Deferred<T = void> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail(label);
}

async function testTaskQueue(): Promise<void> {
    const run = createTaskQueue(2);
    const gates = Array.from({ length: 5 }, () => deferred());
    const starts: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const tasks = gates.map((gate, index) => run(async () => {
        starts.push(index);
        active++;
        maximumActive = Math.max(maximumActive, active);
        await gate.promise;
        active--;
        return index;
    }));

    await waitFor(() => starts.length === 2, "the bounded queue did not start its initial tasks");
    assert.deepEqual(starts, [0, 1], "the queue starts work in submission order");
    assert.equal(maximumActive, 2, "the queue respects its configured concurrency");

    gates[0].resolve();
    await waitFor(() => starts.length === 3, "the bounded queue did not release its first waiter");
    assert.deepEqual(starts, [0, 1, 2], "the queue releases waiters in FIFO order");
    gates[1].resolve();
    await waitFor(() => starts.length === 4, "the bounded queue did not release its second waiter");
    assert.equal(starts[3], 3);
    gates[2].resolve();
    await waitFor(() => starts.length === 5, "the bounded queue did not release its final waiter");
    assert.equal(starts[4], 4);
    gates[3].resolve();
    gates[4].resolve();
    assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
    assert.equal(maximumActive, 2, "queued work never exceeded the configured concurrency");

    const single = createTaskQueue(1);
    const rejectionGate = deferred();
    let secondStarted = false;
    const rejected = single(async () => {
        await rejectionGate.promise;
        throw new Error("expected queue test rejection");
    });
    const recovered = single(async () => {
        secondStarted = true;
        return 2;
    });
    rejectionGate.resolve();
    await assert.rejects(rejected, /expected queue test rejection/);
    assert.equal(await recovered, 2, "a rejected task releases its queue permit");
    assert.equal(secondStarted, true);
}

function testExactArrayBuffers(): void {
    const complete = new Uint8Array([1, 2, 3]);
    assert.equal(exactArrayBuffer(complete), complete.buffer, "a complete ArrayBuffer view is reused without copying");

    const backing = new Uint8Array([9, 4, 5, 8]);
    const slice = backing.subarray(1, 3);
    const exact = exactArrayBuffer(slice);
    assert.notEqual(exact, backing.buffer, "a subview receives an isolated exact-sized buffer");
    assert.deepEqual([...new Uint8Array(exact)], [4, 5]);
    backing[1] = 7;
    assert.deepEqual([...new Uint8Array(exact)], [4, 5], "the copied subview does not retain surrounding mutable bytes");
}

function testKeyReviewGate(): void {
    const gate = new KeyReviewGate();
    gate.begin("local", "peer", "attempt-old", 1);
    gate.fail("local", "peer", "attempt-old");
    gate.finish("local", "peer", "attempt-old");
    assert.equal(gate.isBlocked("local", "peer"), true);

    gate.begin("local", "peer", "attempt-new", 2);
    assert.equal(gate.isBlocked("local", "peer"), true, "a newer review supersedes an older failure and remains pending");
    gate.fail("local", "peer", "attempt-old");
    gate.succeed("local", "peer", "attempt-old");
    assert.equal(gate.isBlocked("local", "peer"), true, "stale outcomes cannot change the latest attempt");
    gate.succeed("local", "peer", "attempt-new");
    assert.equal(gate.isBlocked("local", "peer"), true, "a successful review remains blocked until every matching caller finishes");
    gate.finish("local", "peer", "attempt-new");
    assert.equal(gate.isBlocked("local", "peer"), false);

    gate.begin("local", "peer", "attempt-new", 2);
    gate.begin("local", "peer", "attempt-new", 2);
    gate.finish("local", "peer", "attempt-new");
    assert.equal(gate.isBlocked("local", "peer"), true, "duplicate consumers share a counted pending review");
    gate.finish("local", "peer", "attempt-new");
    assert.equal(gate.isBlocked("local", "peer"), false);

    gate.begin("local", "peer", "attempt-older", 1);
    gate.fail("local", "peer", "attempt-older");
    gate.finish("local", "peer", "attempt-older");
    assert.equal(gate.isBlocked("local", "peer"), false, "late historical announcements cannot re-block a newer verified key");

    gate.begin("other-local", "peer", "attempt", 1);
    assert.equal(gate.isBlocked("local", "peer"), false, "review state is isolated by signed-in account");
    assert.equal(gate.isBlocked("other-local", "peer"), true);
    gate.clear();
    assert.equal(gate.isBlocked("other-local", "peer"), false);
}

function groupedMessage(id: string, timestamp: number): SecureMessageGroupCandidate {
    return {
        attachments: [],
        author: { id: "100000000000000001" },
        components: [],
        content: `${ENCRYPTED_MESSAGE_PREFIX}{}`,
        embeds: [],
        id,
        reactions: [],
        stickerItems: [],
        timestamp: new Date(timestamp),
    };
}

function testMessageGroupingIndexCache(): void {
    const first = groupedMessage("first", 0);
    const middle = groupedMessage("middle", 0);
    const last = groupedMessage("last", 0);
    const messages = [first, middle, last];
    assert.equal(
        secureMessageGroupFlags(middle, messages),
        SecureMessageGroup.Previous | SecureMessageGroup.Next,
    );

    messages.splice(0, messages.length, middle, first, last);
    assert.equal(
        secureMessageGroupFlags(middle, messages),
        SecureMessageGroup.Next,
        "same-array message reordering rebuilds the cached ID index",
    );
    messages.push(groupedMessage("fourth", 0));
    assert.equal(
        secureMessageGroupFlags(last, messages),
        SecureMessageGroup.Previous | SecureMessageGroup.Next,
        "same-array length changes rebuild the cached ID index",
    );
}

function testSourceBoundaries(): void {
    const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const index = source("src/equicordplugins/secureMessaging.desktop/index.tsx");
    const decryptCache = source("src/equicordplugins/secureMessaging.desktop/decryptCache.ts");
    const attachmentCache = source("src/equicordplugins/secureMessaging.desktop/attachmentCache.ts");
    const embedCache = source("src/equicordplugins/secureMessaging.desktop/embedCache.ts");
    const crypto = source("src/equicordplugins/secureMessaging.desktop/crypto.ts");
    const attachments = source("src/equicordplugins/secureMessaging.desktop/attachments.ts");
    const reviewCache = source("src/equicordplugins/secureMessaging.desktop/announcementReviewCache.ts");
    const grouping = source("src/equicordplugins/secureMessaging.desktop/messageGrouping.ts");
    const gate = source("src/equicordplugins/secureMessaging.desktop/keyReviewGate.ts");
    const packageJson = source("package.json");
    const workflow = source(".github/workflows/test.yml");

    assert.match(decryptCache, /const runDecryptTask = createTaskQueue\(4\)/);
    assert.match(decryptCache, /result = await runDecryptTask\(async \(\): Promise<DecryptIncomingResult> =>/,
        "only an active native decrypt attempt occupies a queue permit");
    assert.doesNotMatch(decryptCache, /runDecryptTask\(\(\) =>\s*decryptWithRetry/,
        "retry backoff does not hold a decrypt permit");
    assert.match(decryptCache, /TRANSIENT_FAILURE_TTL_MS = 30_000/,
        "temporary native failures do not poison the immutable-message cache forever");

    assert.match(attachmentCache, /const runAttachmentLoad = createTaskQueue\(4\)/);
    assert.match(attachmentCache, /const runAttachmentDecrypt = createTaskQueue\(4\)/);
    assert.match(attachmentCache, /const runAttachmentDownload = createTaskQueue\(2\)/);
    assert.match(attachmentCache, /decryptIncomingAttachmentsCached/,
        "detached text and attachment rendering deduplicate the same native bundle operation");
    assert.doesNotMatch(attachmentCache, /MAX_IN_FLIGHT_LOADS/,
        "attachment load pressure is queued rather than surfaced as a user-facing failure");
    assert.match(attachmentCache, /new Blob\(\[exactArrayBuffer\(attachment\.data\)\]/,
        "large decrypted attachments avoid an unconditional second byte copy");

    assert.match(embedCache, /const runUnfurlTask = createTaskQueue\(4\)/);
    assert.match(embedCache, /const embeds = await runUnfurlTask\(async \(\) =>/,
        "only an active REST attempt occupies an unfurl queue permit");
    assert.doesNotMatch(embedCache, /entry\.promise = runUnfurlTask/,
        "unfurl retry backoff does not starve unrelated previews");
    assert.match(embedCache, /TRANSIENT_ENTRY_TTL = 30_000/);
    assert.match(embedCache, /retries: 0/,
        "the secure unfurl layer owns retries instead of multiplying REST retries");

    assert.match(reviewCache, /const runReviewTask = createTaskQueue\(4\)/);
    assert.match(reviewCache, /let cacheGeneration = 0/);
    assert.doesNotMatch(reviewCache, /oldestSettled \?\? oldest/,
        "pending review promises are not evicted and duplicated under pressure");
    assert.match(gate, /isNewerAttempt/,
        "out-of-order historical key reviews cannot override the latest announcement state");

    assert.match(index, /const RENDER_DECRYPT_BATCH_SIZE = 24/);
    assert.doesNotMatch(index, /Promise\.all\(batch\.map\(request => request\.promise\)\)/,
        "one slow decrypt cannot block every visible encrypted row");
    assert.match(index, /secureMessageGroupingListeners = new Map<string, Set<\(\) => void>>/,
        "grouping updates are scoped to the affected channel");
    assert.doesNotMatch(index, /messageLengthBypassKeys/,
        "message-length bypass state remains bounded to the selected conversation");
    assert.match(index, /announcementReviewOrder/,
        "key-review gate ordering is derived from Discord message chronology");
    assert.match(index, /reviewAnnouncementCached/,
        "Flux and accessory key reviews share a bounded native request cache");
    assert.match(index, /Native\.setScreenCaptureProtection\(true\)\.catch\(\(\) => undefined\)/,
        "plugin shutdown absorbs native cleanup rejections");

    const startSource = index.slice(index.indexOf("    start() {"), index.indexOf("    stop() {"));
    assert.doesNotMatch(startSource, /throw error;/,
        "a partial guard installation cannot throw through the host plugin lifecycle");
    const connectionSource = index.slice(
        index.indexOf("async function handleSecureConnectionOpen"),
        index.indexOf("function IdentityBlock"),
    );
    assert.equal(
        connectionSource.match(/invalidateSecureRenderCaches\(\)/g)?.length,
        1,
        "an account reconnect invalidates render caches once",
    );

    assert.match(crypto, /return exactArrayBuffer\(value\)/);
    assert.match(attachments, /return exactArrayBuffer\(value\)/);
    assert.doesNotMatch(grouping, /findIndex\(/,
        "each encrypted accessory no longer scans the full message array for its own ID");
    assert.match(packageJson, /"testSecureMessagingPerformance": "tsx scripts\/testSecureMessagingPerformance\.ts"/);
    assert.match(workflow, /Test Secure Messaging performance boundaries/);
    assert.equal(
        existsSync(new URL("../scripts/applySecureMessagingPerformanceTest.py", import.meta.url)),
        false,
        "one-time audit patch scripts are not shipped",
    );
    assert.equal(
        existsSync(new URL("../.github/workflows/apply-secure-messaging-performance-test.yml", import.meta.url)),
        false,
        "one-time self-modifying workflows are not shipped",
    );
}

async function main(): Promise<void> {
    await testTaskQueue();
    testExactArrayBuffers();
    testKeyReviewGate();
    testMessageGroupingIndexCache();
    testSourceBoundaries();
    console.log("Secure Messaging performance boundary tests passed.");
}

void main();
