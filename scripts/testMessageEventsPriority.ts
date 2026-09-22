import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { build, type Plugin } from "esbuild";

import type {
    MessageContentOptions,
    MessageEditListener,
    MessageEventListenerOptions,
    MessageLengthBypassListener,
    MessageObject,
    MessageSendListener,
    SendMessageOptions,
    SendMessageProps,
} from "../src/api/MessageEvents";
import messageEventsPlugin from "../src/plugins/_api/messageEvents";
import { canonicalizeMatch } from "../src/utils/patches";
import type { PatchReplacement } from "../src/utils/types";
import { discordMessageSendSource, patchDiscordMessageSend } from "./fixtures/discordMessageSend";

type MessageEventsModule = typeof import("../src/api/MessageEvents");

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const runtimeStubs: Plugin = {
    name: "message-events-runtime-stubs",
    setup(build) {
        build.onResolve({ filter: /^@utils\/Logger$/ }, () => ({ path: "logger", namespace: "message-events-test" }));
        build.onResolve({ filter: /^@webpack\/common$/ }, () => ({ path: "webpack-common", namespace: "message-events-test" }));

        build.onLoad({ filter: /^logger$/, namespace: "message-events-test" }, () => ({
            contents: "export class Logger { error() {} }",
            loader: "js",
        }));
        build.onLoad({ filter: /^webpack-common$/, namespace: "message-events-test" }, () => ({
            contents: "export const MessageStore = { getMessage() { return undefined; } };",
            loader: "js",
        }));
    },
};

async function loadMessageEvents(): Promise<MessageEventsModule> {
    const result = await build({
        absWorkingDir: projectRoot,
        bundle: true,
        entryPoints: ["src/api/MessageEvents.ts"],
        format: "esm",
        platform: "node",
        plugins: [runtimeStubs],
        write: false,
    });
    const [output] = result.outputFiles;

    assert(output, "MessageEvents test bundle was generated");
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`;
    return import(moduleUrl);
}

const messageObj: MessageObject = {
    content: "test",
    invalidEmojis: [],
    tts: false,
    validNonShortcutEmojis: [],
};

const contentOptions: MessageContentOptions = {
    channelId: "channel",
    command: null,
    content: "test",
};

const sendOptions: SendMessageOptions = {
    ...contentOptions,
    location: "test",
};

const sendProps: SendMessageProps = {
    channel: {} as SendMessageProps["channel"],
    content: "test",
    hasAttachments: false,
    hasStickers: false,
    openWarningPopout: () => undefined,
};

function handleSend(events: MessageEventsModule): Promise<boolean> {
    return events._handlePreSend("channel", messageObj, sendOptions, sendProps, contentOptions);
}

function handleEdit(events: MessageEventsModule): Promise<boolean> {
    return events._handlePreEdit("channel", "message", messageObj);
}

function applyReplacement(source: string, replacement: PatchReplacement): string {
    const match = canonicalizeMatch(replacement.match);
    return typeof replacement.replace === "string"
        ? source.replace(match, replacement.replace)
        : source.replace(match, replacement.replace);
}

function testCurrentDiscordSendPatch(): string {
    const patch = messageEventsPlugin.patches?.find(candidate => candidate.find === ".handleSendMessage,onResize:");
    assert(patch, "the MessageEvents chat-input patch exists");
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    assert.equal(replacements.length, 3, "the chat-input patch updates its callback, send interception and upload handoff atomically");

    const source = discordMessageSendSource;
    const patched = patchDiscordMessageSend();

    assert.notEqual(patched, source, "the current Discord chat-input source must match the MessageEvents patch");
    assert.match(patched, /\.then\(async e=>\{let\{valid:s,failureReason:f\}=e;/, "the callback remains valid when pre-send work awaits encryption");
    assert.equal(
        patched.split("Vencord.Api.MessageEvents._handlePreSend").length - 1,
        1,
        "the current Discord chat-input send path invokes MessageEvents exactly once",
    );
    assert.match(
        patched,
        /const vcContentOptions=\{content:t,channelId:h\.id,uploads:n,.+?scheduledTimestamp:.+?\},vcSendProps=\{openWarningPopout:.+?channel:h\};if\(await Vencord\.Api\.MessageEvents\._handlePreSend\(h\.id,_,I,vcSendProps,vcContentOptions\)\)/,
        "the patch reconstructs Discord's validation props and forwards raw pending-upload options",
    );
    assert.doesNotThrow(() => Function(patched), "the patched current Discord chat-input source must remain valid JavaScript");
    return patched;
}

async function testCurrentDiscordUploadHandoff(events: MessageEventsModule, patched: string): Promise<void> {
    for (const scenario of ["ordinary", "replacement", "empty", "generated", "cancelled"] as const) {
        const originals = (scenario === "generated" ? [] : [{
            id: "draft", filename: "image.png", status: scenario === "ordinary" ? "COMPLETED" : "NOT_STARTED",
            uploadedFilename: scenario === "ordinary" ? "uploaded-image.png" : "", responseUrl: scenario === "ordinary" ? "https://upload.invalid/original" : "",
        }]) as NonNullable<SendMessageOptions["uploads"]>;
        const replacements = (scenario === "empty" ? [] : [{
            id: "draft", filename: "encrypted.pcaf", status: "COMPLETED",
            uploadedFilename: "uploaded-encrypted.pcaf", responseUrl: "https://upload.invalid/encrypted",
        }]) as NonNullable<SendMessageOptions["uploads"]>;
        const sends: { message: MessageObject; options: SendMessageOptions; }[] = [];
        const listener: MessageSendListener = (_channel, message, options) => {
            assert.equal(options.uploads, originals, "listeners see the original pending draft");
            if (scenario === "ordinary") return;
            message.content = "PCEM3:fixture";
            options.uploads = options.attachmentsToUpload = replacements;
            return scenario === "cancelled" ? { cancel: true } : { stop: true };
        };
        events.addMessagePreSendListener(listener);
        try {
            const outcome = await runInNewContext(`${patched}\nchatInput.props={chatInputType:0};chatInput.handleSendMessage();`, {
                Vencord: { Api: { MessageEvents: events } },
                t: "plain caption", n: originals, l: [], h: { id: "channel" }, A: false,
                o: null, i: null, a: false, m: null, p: false, c: null, r: null,
                nb: { i: async () => ({ valid: true }) },
                tU: { Ay: { parse: (_channel: unknown, content: string) => ({ ...messageObj, content }) } },
                nB: { Hx: { CHAT_INPUT: "chat_input" } },
                x: { A: {
                    getSendMessageOptions: () => ({}),
                    sendMessage: (_channel: string, message: MessageObject, options: SendMessageOptions) => sends.push({ message, options }),
                } },
            });
            assert.equal(outcome.shouldClear, scenario !== "cancelled", scenario);
            if (scenario === "cancelled") {
                assert.equal(sends.length, 0, "cancellation must stop the host continuation");
                continue;
            }
            assert.equal(sends.length, 1, scenario);
            const expected = scenario === "ordinary" ? originals : replacements;
            assert.equal(sends[0].options.attachmentsToUpload, expected,
                `${scenario}: native send must receive the selected upload instances after the host finishes assembling options`);
            assert.deepEqual(sends[0].options.attachmentsToUpload?.map(upload => [upload.filename, upload.status, upload.uploadedFilename]),
                expected.map(upload => [upload.filename, upload.status, upload.uploadedFilename]));
            assert.equal(sends[0].message.content, scenario === "ordinary" ? "plain caption" : "PCEM3:fixture");
            assert.equal(originals[0]?.filename, scenario === "generated" ? undefined : "image.png", "handoff preserves original drafts");
            if (scenario !== "ordinary" && originals.length) assert.equal(originals[0].status, "NOT_STARTED");
        } finally {
            events.removeMessagePreSendListener(listener);
        }
    }
}

function testCurrentDiscordMessageLengthPatch(): void {
    const patch = messageEventsPlugin.patches?.find(candidate => candidate.find === 'type:"MESSAGE_LENGTH_UPSELL"');
    assert(patch, "the MessageEvents message-length patch exists");
    const replacement = Array.isArray(patch.replacement) ? patch.replacement[0] : patch.replacement;
    assert(replacement, "the MessageEvents message-length replacement exists");

    const source = 'function validate(content,limit){if(content.length>limit)return{type:"MESSAGE_LENGTH_UPSELL"};return null}';
    const patched = applyReplacement(source, replacement);
    assert.notEqual(patched, source, "the current Discord message-length source must match the MessageEvents patch");
    assert.match(patched, /!Vencord\.Api\.MessageEvents\._shouldBypassMessageLengthLimit\(\)&&content\.length>limit/);
    assert.doesNotThrow(() => Function(patched), "the patched message-length check must remain valid JavaScript");
}

function testMessageLengthBypassListeners(events: MessageEventsModule): void {
    const falseListener: MessageLengthBypassListener = () => false;
    const throwingListener: MessageLengthBypassListener = () => { throw new Error("expected predicate failure"); };
    const trueListener: MessageLengthBypassListener = () => true;

    assert.equal(events._shouldBypassMessageLengthLimit(), false, "Discord's length limit remains active without an explicit listener");
    assert.equal(events.addMessageLengthBypassListener(falseListener), falseListener);
    events.addMessageLengthBypassListener(throwingListener);
    assert.equal(events._shouldBypassMessageLengthLimit(), false, "false and throwing predicates fail closed");
    events.addMessageLengthBypassListener(trueListener);
    assert.equal(events._shouldBypassMessageLengthLimit(), true, "one explicit predicate can route oversized text through pre-send handling");
    assert.equal(events.removeMessageLengthBypassListener(trueListener), true);
    assert.equal(events.removeMessageLengthBypassListener(trueListener), false);
    assert.equal(events._shouldBypassMessageLengthLimit(), false, "removing the true predicate restores Discord's normal length gate");
    events.removeMessageLengthBypassListener(falseListener);
    events.removeMessageLengthBypassListener(throwingListener);
}

async function testSendOrderingAndAsyncHandlers(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const listeners: MessageSendListener[] = [];
    const add = (listener: MessageSendListener, options?: number | MessageEventListenerOptions) => {
        listeners.push(options === undefined
            ? events.addMessagePreSendListener(listener)
            : events.addMessagePreSendListener(listener, options));
    };

    try {
        add(() => { order.push("default-first"); });
        add(() => { order.push("low"); }, -10);
        add(async () => {
            order.push("high-start");
            await Promise.resolve();
            order.push("high-end");
        }, { priority: 10 });
        add(() => { order.push("default-second"); }, 0);

        assert.equal(await handleSend(events), false, "an ordinary listener chain permits the send");
        assert.deepEqual(
            order,
            ["high-start", "high-end", "default-first", "default-second", "low"],
            "send listeners run from highest to lowest priority, await async work, and preserve registration order for ties",
        );
    } finally {
        listeners.forEach(listener => events.removeMessagePreSendListener(listener));
    }
}

async function testSendStop(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const stopper: MessageSendListener = () => {
        order.push("stop");
        return { stop: true };
    };
    const skipped: MessageSendListener = () => { order.push("skipped"); };

    events.addMessagePreSendListener(skipped, -1);
    events.addMessagePreSendListener(stopper, 1);
    try {
        assert.equal(await handleSend(events), false, "stop ends listener processing without cancelling the send");
        assert.deepEqual(order, ["stop"], "listeners after stop are not invoked");
    } finally {
        events.removeMessagePreSendListener(stopper);
        events.removeMessagePreSendListener(skipped);
    }
}

async function testSendOptionMutationsReachDiscord(events: MessageEventsModule): Promise<void> {
    const options: SendMessageOptions = {
        ...contentOptions,
        location: "mutation test",
    };
    const listener: MessageSendListener = (_channelId, _message, mutableOptions) => {
        mutableOptions.attachmentsToUpload = [];
        mutableOptions.uploads = [];
        return { stop: true };
    };
    events.addMessagePreSendListener(listener);
    try {
        assert.equal(await events._handlePreSend("channel", messageObj, options, sendProps, contentOptions), false);
        assert.deepEqual(options.attachmentsToUpload, [], "listeners can add an attachment upload to Discord's send options");
    } finally {
        events.removeMessagePreSendListener(listener);
    }
}

async function testSendCancel(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const before: MessageSendListener = () => { order.push("before"); };
    const cancel: MessageSendListener = () => {
        order.push("cancel");
        return { cancel: true };
    };
    const skipped: MessageSendListener = () => { order.push("skipped"); };

    events.addMessagePreSendListener(skipped, -1);
    events.addMessagePreSendListener(cancel, 1);
    events.addMessagePreSendListener(before, 2);
    try {
        assert.equal(await handleSend(events), true, "the existing cancel result still aborts the send");
        assert.deepEqual(order, ["before", "cancel"], "cancel prevents all remaining listeners from running");
    } finally {
        events.removeMessagePreSendListener(before);
        events.removeMessagePreSendListener(cancel);
        events.removeMessagePreSendListener(skipped);
    }
}

async function testSendRemoval(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const removed: MessageSendListener = () => { order.push("removed"); };
    const retained: MessageSendListener = () => { order.push("retained"); };

    assert.equal(events.addMessagePreSendListener(removed, 100), removed, "add keeps returning the listener for API compatibility");
    events.addMessagePreSendListener(retained);
    assert.equal(events.removeMessagePreSendListener(removed), true, "a registered send listener can be removed");
    assert.equal(events.removeMessagePreSendListener(removed), false, "removing the same send listener twice reports false");
    try {
        assert.equal(await handleSend(events), false);
        assert.deepEqual(order, ["retained"], "a removed send listener is not invoked");
    } finally {
        events.removeMessagePreSendListener(retained);
    }
}

async function testSendDuplicateRegistrationAndMidDispatchRemoval(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const pending: MessageSendListener = () => { order.push("pending"); };
    const remover: MessageSendListener = () => {
        order.push("remover");
        events.removeMessagePreSendListener(pending);
    };
    const first: MessageSendListener = () => { order.push("first"); };

    events.addMessagePreSendListener(pending);
    events.addMessagePreSendListener(remover, 1);
    events.addMessagePreSendListener(first, 2);
    events.addMessagePreSendListener(remover, 100);
    try {
        assert.equal(await handleSend(events), false);
        assert.deepEqual(
            order,
            ["first", "remover"],
            "adding a listener twice remains a no-op and removing a pending listener prevents its invocation",
        );
    } finally {
        events.removeMessagePreSendListener(first);
        events.removeMessagePreSendListener(remover);
        events.removeMessagePreSendListener(pending);
    }
}

async function testSendThrownHandlerFailsOpen(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageSendListener = () => {
        order.push("throw");
        throw new Error("expected test error");
    };
    const after: MessageSendListener = async () => {
        await Promise.resolve();
        order.push("after");
    };

    events.addMessagePreSendListener(after);
    events.addMessagePreSendListener(throwing, 1);
    try {
        assert.equal(await handleSend(events), false, "a throwing send listener fails open");
        assert.deepEqual(order, ["throw", "after"], "send processing continues after a listener throws");
    } finally {
        events.removeMessagePreSendListener(throwing);
        events.removeMessagePreSendListener(after);
    }
}

async function testSendThrownHandlerCancelsOnError(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageSendListener = async () => {
        order.push("throw-start");
        await Promise.resolve();
        order.push("throw-end");
        throw new Error("expected fail-closed test error");
    };
    const after: MessageSendListener = () => { order.push("after"); };

    events.addMessagePreSendListener(after);
    events.addMessagePreSendListener(throwing, { priority: 1, cancelOnError: true });
    try {
        assert.equal(await handleSend(events), true, "cancelOnError cancels a send when its listener rejects");
        assert.deepEqual(
            order,
            ["throw-start", "throw-end"],
            "send cancellation is returned immediately and no later listener runs",
        );
    } finally {
        events.removeMessagePreSendListener(throwing);
        events.removeMessagePreSendListener(after);
    }
}

async function testSendDuplicatePreservesOriginalFailOpenRegistration(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageSendListener = () => {
        order.push("throw");
        throw new Error("expected duplicate registration test error");
    };
    const before: MessageSendListener = () => { order.push("before"); };
    const after: MessageSendListener = () => { order.push("after"); };

    events.addMessagePreSendListener(throwing, { priority: 1 });
    events.addMessagePreSendListener(before, 2);
    events.addMessagePreSendListener(after);
    assert.equal(
        events.addMessagePreSendListener(throwing, { priority: 100, cancelOnError: true }),
        throwing,
        "duplicate add still returns the listener",
    );
    try {
        assert.equal(await handleSend(events), false, "a duplicate registration cannot change fail-open to fail-closed");
        assert.deepEqual(
            order,
            ["before", "throw", "after"],
            "a duplicate registration preserves the original priority, order, and error policy",
        );
    } finally {
        events.removeMessagePreSendListener(throwing);
        events.removeMessagePreSendListener(before);
        events.removeMessagePreSendListener(after);
    }
}

async function testEditOrderingStopAndAsyncHandlers(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const high: MessageEditListener = async () => {
        order.push("high-start");
        await Promise.resolve();
        order.push("high-end");
    };
    const stopper: MessageEditListener = () => {
        order.push("default-stop");
        return { stop: true };
    };
    const skipped: MessageEditListener = () => { order.push("skipped"); };

    events.addMessagePreEditListener(skipped, -1);
    events.addMessagePreEditListener(stopper);
    events.addMessagePreEditListener(high, 1);
    try {
        assert.equal(await handleEdit(events), false, "stop ends edit processing without cancelling the edit");
        assert.deepEqual(
            order,
            ["high-start", "high-end", "default-stop"],
            "edit listeners honor priority, await async handlers, and stop before lower-priority handlers",
        );
    } finally {
        events.removeMessagePreEditListener(high);
        events.removeMessagePreEditListener(stopper);
        events.removeMessagePreEditListener(skipped);
    }
}

async function testEditCancelAndRemoval(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const removed: MessageEditListener = () => { order.push("removed"); };
    const cancel: MessageEditListener = async () => {
        await Promise.resolve();
        order.push("cancel");
        return { cancel: true };
    };
    const skipped: MessageEditListener = () => { order.push("skipped"); };

    assert.equal(events.addMessagePreEditListener(removed, 100), removed, "edit add keeps returning the listener");
    events.addMessagePreEditListener(skipped, -1);
    events.addMessagePreEditListener(cancel, 1);
    assert.equal(events.removeMessagePreEditListener(removed), true, "a registered edit listener can be removed");
    assert.equal(events.removeMessagePreEditListener(removed), false, "removing the same edit listener twice reports false");
    try {
        assert.equal(await handleEdit(events), true, "cancel still aborts an edit");
        assert.deepEqual(order, ["cancel"], "removed and post-cancel edit listeners are not invoked");
    } finally {
        events.removeMessagePreEditListener(cancel);
        events.removeMessagePreEditListener(skipped);
    }
}

async function testEditThrownHandlerFailsOpen(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageEditListener = () => {
        order.push("throw");
        throw new Error("expected test error");
    };
    const after: MessageEditListener = () => { order.push("after"); };

    events.addMessagePreEditListener(after);
    events.addMessagePreEditListener(throwing, 1);
    try {
        assert.equal(await handleEdit(events), false, "a throwing edit listener fails open");
        assert.deepEqual(order, ["throw", "after"], "edit processing continues after a listener throws");
    } finally {
        events.removeMessagePreEditListener(throwing);
        events.removeMessagePreEditListener(after);
    }
}

async function testEditThrownHandlerCancelsOnError(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageEditListener = () => {
        order.push("throw");
        throw new Error("expected fail-closed test error");
    };
    const after: MessageEditListener = () => { order.push("after"); };

    events.addMessagePreEditListener(after);
    events.addMessagePreEditListener(throwing, { priority: 1, cancelOnError: true });
    try {
        assert.equal(await handleEdit(events), true, "cancelOnError cancels an edit when its listener throws");
        assert.deepEqual(order, ["throw"], "edit cancellation is returned immediately and no later listener runs");
    } finally {
        events.removeMessagePreEditListener(throwing);
        events.removeMessagePreEditListener(after);
    }
}

async function testEditDuplicatePreservesOriginalFailClosedRegistration(events: MessageEventsModule): Promise<void> {
    const order: string[] = [];
    const throwing: MessageEditListener = () => {
        order.push("throw");
        throw new Error("expected duplicate registration test error");
    };
    const before: MessageEditListener = () => { order.push("before"); };
    const after: MessageEditListener = () => { order.push("after"); };

    events.addMessagePreEditListener(throwing, { priority: 1, cancelOnError: true });
    events.addMessagePreEditListener(before, 2);
    events.addMessagePreEditListener(after);
    events.addMessagePreEditListener(throwing, -100);
    try {
        assert.equal(await handleEdit(events), true, "a duplicate registration cannot change fail-closed to fail-open");
        assert.deepEqual(
            order,
            ["before", "throw"],
            "a duplicate registration preserves its original priority and prevents later edit listeners",
        );
    } finally {
        events.removeMessagePreEditListener(throwing);
        events.removeMessagePreEditListener(before);
        events.removeMessagePreEditListener(after);
    }
}

async function main(): Promise<void> {
    const patchedSend = testCurrentDiscordSendPatch();
    testCurrentDiscordMessageLengthPatch();
    const events = await loadMessageEvents();

    await testCurrentDiscordUploadHandoff(events, patchedSend);

    testMessageLengthBypassListeners(events);

    await testSendOrderingAndAsyncHandlers(events);
    await testSendOptionMutationsReachDiscord(events);
    await testSendStop(events);
    await testSendCancel(events);
    await testSendRemoval(events);
    await testSendDuplicateRegistrationAndMidDispatchRemoval(events);
    await testSendThrownHandlerFailsOpen(events);
    await testSendThrownHandlerCancelsOnError(events);
    await testSendDuplicatePreservesOriginalFailOpenRegistration(events);
    await testEditOrderingStopAndAsyncHandlers(events);
    await testEditCancelAndRemoval(events);
    await testEditThrownHandlerFailsOpen(events);
    await testEditThrownHandlerCancelsOnError(events);
    await testEditDuplicatePreservesOriginalFailClosedRegistration(events);

    console.log("message event priority checks passed");
}

void main();
