/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, isVariableStatement, JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8");
const parsed = createSourceFile("index.tsx", source, ScriptTarget.Latest, true);
const names = new Set(["ConversationManager", "KeyReviewModal", "SecureMessagingButton", "sendKeyAnnouncement"]);
const selected = parsed.statements.filter(statement => isFunctionDeclaration(statement)
    ? statement.name && names.has(statement.name.text)
    : isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => names.has(declaration.name.getText(parsed))));
const compiled = transpileModule(selected.map(statement => statement.getText(parsed)).join("\n"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext, jsx: JsxEmit.React },
}).outputText;

interface Element {
    type: string;
    props: Record<string, any>;
    children: Array<Element | string | false | null>;
}

function elements(node: unknown): Element[] {
    if (!node || typeof node !== "object" || !("children" in node)) return [];
    const element = node as Element;
    return [element, ...element.children.flatMap(child => Array.isArray(child) ? child.flatMap(elements) : elements(child))];
}

function harness() {
    const identity = { userId: "peer", fingerprint: "fixture-fingerprint", formattedFingerprint: "fixture fingerprint" };
    const channel = { id: "channel", recipients: ["peer"] };
    const snapshot = { channelId: channel.id, kind: "DM", participantIds: ["peer"] };
    const conversation = { status: "disabled", snapshot, participants: [{ status: "trusted", identity }], selectedRecipientIds: ["peer"] };
    const calls = { announcements: 0, closed: 0, refreshes: 0, reviews: [] as unknown[][], sent: 0, trusted: [] as unknown[][], toasts: [] as unknown[] };
    let userId = "self";
    const buckets = new Map<string, { values: Map<number, any>; effects: Map<number, { dependencies: unknown[]; cleanup?: () => void; }>; }>();
    let hooks!: ReturnType<typeof buckets.get> & {};
    let index = 0;
    let pendingEffects: Array<() => void> = [];
    const same = (previous: unknown[], next: unknown[]) => previous.length === next.length && previous.every((value, i) => Object.is(value, next[i]));
    const native = {
        getSecurityKeyVaultState: async () => ({ status: "not_configured" }),
        getIdentity: async () => ({ status: "ready", identity }),
        getConversation: async () => conversation as any,
        configureConversation: async (_user: string, value: { enabled: boolean; }) => {
            conversation.status = value.enabled ? "enabled" : "disabled";
            return conversation;
        },
        reviewAnnouncement: async (...args: unknown[]) => { calls.reviews.push(args); return { status: "trust_required", identity, reviewToken: "fresh-token" } as any; },
        trustReviewedKey: async (...args: unknown[]) => { calls.trusted.push(args); return { status: "review_expired" } as any; },
        createAnnouncement: async () => { calls.announcements++; return { status: "created", content: "synthetic announcement" }; },
    };
    const context = {
        Native: native, channel, chatAccessCache: { status: "ready", localUserId: "self" } as any,
        UserStore: { getCurrentUser: () => ({ id: userId }) }, ChannelStore: {},
        currentSnapshot: () => ({ localUserId: "self", snapshot }),
        useState(initial: unknown) {
            const slot = index++;
            const owner = hooks;
            if (!owner.values.has(slot)) owner.values.set(slot, typeof initial === "function" ? initial() : initial);
            return [owner.values.get(slot), (value: unknown) => owner.values.set(slot, typeof value === "function" ? value(owner.values.get(slot)) : value)];
        },
        useRef(initial: unknown) {
            const slot = index++;
            if (!hooks.values.has(slot)) hooks.values.set(slot, { current: initial });
            return hooks.values.get(slot);
        },
        useCallback(callback: unknown, dependencies: unknown[]) {
            const slot = index++;
            const previous = hooks.values.get(slot);
            if (!previous || !same(previous.dependencies, dependencies)) hooks.values.set(slot, { callback, dependencies });
            return hooks.values.get(slot).callback;
        },
        useEffect(callback: () => (() => void) | undefined, dependencies: unknown[]) {
            const slot = index++;
            const owner = hooks;
            const previous = owner.effects.get(slot);
            if (!previous || !same(previous.dependencies, dependencies)) pendingEffects.push(() => {
                previous?.cleanup?.();
                owner.effects.set(slot, { dependencies, cleanup: callback() });
            });
        },
        useStateFromStores: (_stores: unknown, select: () => unknown) => select(),
        useScreenCaptureProtectionStatus: () => "ready",
        isNativeFailure: (result: { status: string; }) => ["failed", "unavailable", "invalid_input"].includes(result.status),
        failureMessage: () => "synthetic native failure",
        conversationHasDetails: (result: { status: string; }) => !["failed", "unavailable", "invalid_input"].includes(result.status),
        conversationStatusMessage: (result: { status: string; }) => result.status,
        availableSelectedRecipientIds: () => ["peer"], updateMessageLengthBypass: () => undefined,
        refreshChatAccessState: async () => { calls.refreshes++; context.chatAccessCache = { status: "ready", localUserId: userId }; return true; },
        refreshMessageLengthBypassState: () => Promise.resolve(true),
        chatGateReason: () => null, revokePreparedSecureOperations: () => undefined,
        invalidateSecureRenderCaches: () => undefined, resetAnnouncementReviewState: () => undefined,
        userLabel: (id: string) => id, showToast: (...args: unknown[]) => calls.toasts.push(args), Toasts: { Type: { FAILURE: "failure", SUCCESS: "success" } },
        showFailure: () => calls.toasts.push("failure"), permitAnnouncement: () => undefined, authorizeWirePayload: () => undefined, revokeAnnouncement: () => undefined,
        sendMessage: async () => { calls.sent++; },
        Modal: "Modal", BaseText: "BaseText", Heading: "Heading", Checkbox: "Checkbox", Button: "Button", TextArea: "TextArea", Span: "Span",
        IdentityBlock: "IdentityBlock", ChatBarButton: "ChatBarButton", LockIcon: "LockIcon",
        React: { createElement: (type: string, props: unknown, ...children: Element["children"]) => ({ type, props, children }) },
    };
    const runtime = runInNewContext(`${compiled}\n({${[...names].join(",")}})`, context) as Record<string, (props: any, userId?: string) => any>;
    const modalProps = { onClose: () => calls.closed++ };
    const props = {
        manager: { channel, modalProps },
        button: { channel, isMainChat: true },
        review: { content: "synthetic announcement", discordEditedTimestamp: null, discordMessageId: "message", initialReview: { status: "trust_required", identity, reviewToken: "expired-token" }, localUserId: "self", modalProps, peerUserId: "peer" },
    };
    function render(name: string, input: unknown): Element {
        if (!buckets.has(name)) buckets.set(name, { values: new Map(), effects: new Map() });
        hooks = buckets.get(name)!;
        index = 0;
        pendingEffects = [];
        const result = runtime[name](input);
        pendingEffects.forEach(effect => effect());
        return result;
    }
    return {
        native, calls, context, props, render, runtime,
        switchAccount: () => { userId = "other"; },
        unmount: (name: string) => buckets.get(name)?.effects.forEach(effect => effect.cleanup?.()),
    };
}

test("expired trust reviews can refresh in place and require a new explicit comparison", async () => {
    const h = harness();
    let modal = h.render("KeyReviewModal", h.props.review);
    elements(modal).find(element => element.type === "Checkbox")!.props.onChange(null, true);
    modal = h.render("KeyReviewModal", h.props.review);
    await modal.props.actions[0].onClick();
    await setImmediate();
    modal = h.render("KeyReviewModal", h.props.review);
    assert.equal(modal.props.actions[0].disabled, true);
    assert.match(JSON.stringify(modal), /The review expired/u);
    h.native.reviewAnnouncement = async (...args: unknown[]) => {
        h.calls.reviews.push(args);
        return { status: "trust_required", identity: { fingerprint: "new-fingerprint", formattedFingerprint: "new fingerprint" }, reviewToken: "fresh-token" };
    };
    modal.props.actions.find((action: any) => action.text === "Refresh review").onClick();
    await setImmediate();
    modal = h.render("KeyReviewModal", h.props.review);
    assert.deepEqual(h.calls.reviews, [["self", "peer", "synthetic announcement", "message", null]]);
    assert.equal(modal.props.actions[0].disabled, true, "refreshing a token must not reuse fingerprint confirmation");
    elements(modal).find(element => element.type === "Checkbox")!.props.onChange(null, true);
    modal = h.render("KeyReviewModal", h.props.review);
    modal.props.actions[0].onClick();
    await setImmediate();
    assert.equal(h.calls.trusted[1][2], "fresh-token");
    assert.equal(h.calls.trusted[1][3], "new-fingerprint", "confirmation belongs to the fingerprint displayed after refresh");
});

for (const rejected of [true, false]) test(`configuration ${rejected ? "rejected" : "structured"} load failures offer retry instead of indefinite Loading text`, async () => {
    const h = harness();
    h.native.getSecurityKeyVaultState = async () => {
        if (rejected) throw new Error("offline");
        return { status: "failed" };
    };
    h.render("ConversationManager", h.props.manager);
    await setImmediate();
    let modal = h.render("ConversationManager", h.props.manager);
    assert.doesNotMatch(JSON.stringify(modal), /Loading…/u);
    const retry = elements(modal).find(element => element.type === "Button" && element.children.includes("Retry loading"));
    assert.ok(retry);
    h.native.getSecurityKeyVaultState = async () => ({ status: "not_configured" });
    retry.props.onClick();
    await setImmediate();
    modal = h.render("ConversationManager", h.props.manager);
    assert.equal(modal.props.actions[0].disabled, false);
    assert.doesNotMatch(JSON.stringify(modal), /Retry loading/u);
});

test("public key sharing is single-flight and rejected creation reports a failure", async () => {
    const h = harness();
    h.render("ConversationManager", h.props.manager);
    await setImmediate();
    const modal = h.render("ConversationManager", h.props.manager);
    const share = elements(modal).find(element => element.type === "Button" && element.children.includes("Share public key"))!;
    share.props.onClick();
    share.props.onClick();
    await setImmediate();
    assert.equal(h.calls.announcements, 1);
    assert.equal(h.calls.sent, 1);
    h.native.createAnnouncement = async () => { throw new Error("offline"); };
    await h.runtime.sendKeyAnnouncement("channel", "self");
    assert.equal(h.calls.sent, 1);
    assert.match(JSON.stringify(h.calls.toasts.at(-1)), /could not be created or sent/u);
});

test("same-chat saves update the chatbar status through settled access state", async () => {
    const h = harness();
    h.render("SecureMessagingButton", h.props.button);
    h.render("ConversationManager", h.props.manager);
    await setImmediate();
    let manager = h.render("ConversationManager", h.props.manager);
    elements(manager).find(element => element.type === "Checkbox" && JSON.stringify(element).includes("Enable encryption"))!.props.onChange(null, true);
    manager = h.render("ConversationManager", h.props.manager);
    manager.props.actions[0].onClick();
    await setImmediate();
    h.render("SecureMessagingButton", h.props.button);
    await setImmediate();
    const button = h.render("SecureMessagingButton", h.props.button);
    assert.equal(button.props.tooltip, "Secure Messaging: encrypted");
});

test("unrelated store notifications and pending access checks do not refetch conversation status", async () => {
    const h = harness();
    let lookups = 0;
    h.native.getConversation = async () => { lookups++; return { status: "disabled" }; };
    h.render("SecureMessagingButton", h.props.button);
    await setImmediate();
    h.render("SecureMessagingButton", h.props.button);
    assert.equal(lookups, 1, "an unchanged access snapshot skips additional native calls");
    h.context.chatAccessCache = { status: "pending", localUserId: "self" };
    h.render("SecureMessagingButton", h.props.button);
    assert.equal(lookups, 1);
    h.context.chatAccessCache = { status: "ready", localUserId: "self" };
    h.render("SecureMessagingButton", h.props.button);
    assert.equal(lookups, 2);
});

for (const invalidation of ["new request", "account change", "unmount"] as const) {
    test(`chatbar rejects a stale conversation response after ${invalidation}`, async () => {
        const h = harness();
        let resolve!: (result: unknown) => void;
        h.native.getConversation = () => new Promise(next => { resolve = next; });
        h.render("SecureMessagingButton", h.props.button);
        if (invalidation === "new request") {
            h.context.chatAccessCache = { status: "ready", localUserId: "self" };
            h.native.getConversation = async () => ({ status: "disabled" });
            h.render("SecureMessagingButton", h.props.button);
            await setImmediate();
        } else if (invalidation === "account change") h.switchAccount();
        else h.unmount("SecureMessagingButton");
        resolve({ status: "enabled" });
        await setImmediate();
        assert.notEqual(h.render("SecureMessagingButton", h.props.button).props.tooltip, "Secure Messaging: encrypted");
    });
}
