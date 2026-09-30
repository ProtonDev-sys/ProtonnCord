import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isCallExpression, isExportAssignment, isFunctionDeclaration, isObjectLiteralExpression, isMethodDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { attachmentReservationEndpoint, installStartupRestGuard, messageEndpoint, settleGuardedRestFailure } from "../src/equicordplugins/secureMessaging.desktop/restGuardFailure";

const channelId = "100000000000000001";
const messageId = "100000000000000002";
const source = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8");
const parsed = createSourceFile("index.tsx", source, ScriptTarget.ES2022, true);

function compiledFunctions(names: string[]): string {
    const selected = parsed.statements.filter(statement => isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ""));
    assert.equal(selected.length, names.length);
    return transpileModule(selected.map(statement => statement.getText(parsed)).join("\n"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText;
}

test("REST endpoint classification covers relative and versioned API forms", () => {
    for (const prefix of ["", "/api", "/api/v9", "/api/v10", "https://discord.com/api/v10"]) {
        assert.deepEqual(messageEndpoint(`${prefix}/channels/${channelId}/messages?limit=1`, false), { channelId, messageId: null });
        assert.deepEqual(messageEndpoint(`${prefix}/channels/${channelId}/messages/${messageId}`, true), { channelId, messageId });
        assert.deepEqual(attachmentReservationEndpoint(`${prefix}/channels/${channelId}/attachments`), { channelId });
    }
    for (const route of ["/api/not-a-version/channels/invalid/messages", "/channels/invalid/messages", `/channels/${channelId}/pins`, "bad%url", "x".repeat(501)])
        assert.equal(messageEndpoint(route, false), null);
});

test("startup safety guard blocks requests and settles callbacks without affecting unrelated REST", async () => {
    let blocked = true;
    let calls = 0;
    const original = async () => { calls++; return "ok"; };
    const rest: Record<string, (...args: any[]) => Promise<any>> = { post: original, patch: original };
    const dispose = installStartupRestGuard(rest, () => blocked);
    await assert.rejects(rest.post({ url: `/channels/${channelId}/messages` } as never), /guards are unavailable/);
    const result = await new Promise<any>(resolve => rest.patch({ url: `/api/v10/channels/${channelId}/messages/${messageId}` } as never, resolve));
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.equal(await rest.post({ url: "/unrelated" } as never), "ok");
    blocked = false;
    assert.equal(await rest.post({ url: `/channels/${channelId}/messages` } as never), "ok");
    dispose();
    assert.equal(rest.post, original);
    assert.equal(rest.patch, original);
});

test("each optional startup installation failure retains a blocked REST boundary", async () => {
    const exported = parsed.statements.find(isExportAssignment);
    assert.ok(exported && isCallExpression(exported.expression));
    const definition = exported.expression.arguments[0];
    assert.ok(isObjectLiteralExpression(definition));
    const start = definition.properties.find(property => isMethodDeclaration(property) && property.name.getText(parsed) === "start");
    assert.ok(start && isMethodDeclaration(start) && start.body);
    const code = transpileModule(`function start() ${start.body.getText(parsed)}`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const stages = ["addMessagePreSendListener", "addMessagePreEditListener", "installNetworkGuard", "installAttachmentUploadGuard", "installEncryptedEditStarter", "installChatLoadGuard", "installMessageLengthBypass", "addMessageAccessory"];
    for (const failed of stages) {
        let calls = 0;
        const rest: Record<string, (...args: any[]) => Promise<any>> = { post: async () => { calls++; } };
        const context: Record<string, any> = {
            settings: { store: { externalLinkPreviews: false } },
            setExternalLinkPreviewsEnabled() {}, applicationGuardsBlocked: true,
            disposeStartupRestGuard: null, installStartupRestGuard, RestAPI: rest,
            secureOperationGeneration: 0, secureMessageListenersInstalled: false,
            secureRuntimeUserId: null, UserStore: { getCurrentUser: () => ({ id: "self" }) },
            chatAccessGateEnabled: true, chatAccessGeneration: 0, chatAccessCache: {},
            screenCaptureProtectionGeneration: 0, screenCaptureProtectionStatus: "disabled",
            setScreenCaptureProtectionStatus(status: string) { context.screenCaptureProtectionStatus = status; },
            outgoingListener() {}, editListener() {}, SECURE_LISTENER_PRIORITY: 100,
            document: { addEventListener() {} }, handleEncryptedAttachmentDownload() {},
            renderSecureMessageAccessory() {}, refreshChatGateRenderers() {},
            showToast() {}, Toasts: { Type: { FAILURE: "failure" } },
        };
        for (const stage of stages) context[stage] = () => { if (stage === failed) throw new Error(stage); };
        runInNewContext(`${code}\nstart();`, context);
        assert.equal(context.applicationGuardsBlocked, true, failed);
        assert.equal(context.chatAccessGateEnabled, true, failed);
        assert.equal(context.screenCaptureProtectionStatus, "failed", failed);
        await assert.rejects(rest.post({ url: `/channels/${channelId}/messages` } as never), /guards are unavailable/, failed);
        assert.equal(calls, 0, failed);
        context.disposeStartupRestGuard();
    }
});

test("POST and PATCH revalidate prepared authorization against fresh policy", async () => {
    for (const method of ["post", "patch"] as const) {
        for (const change of ["scope", "review", "capture", "protected", "account"]) {
            let finish!: () => void;
            const preparation = new Promise<void>(resolve => { finish = resolve; });
            let calls = 0;
            const request = { url: `/channels/${channelId}/messages${method === "patch" ? `/${messageId}` : ""}`, body: { content: "ciphertext" } };
            const scopes = new WeakMap<object, string>([[request, "before"]]);
            const context: Record<string, any> = {
                requestAuthorizationScopes: scopes, messageEndpoint, attachmentReservationEndpoint,
                protection: { kind: "snapshot", context: { localUserId: "self" }, conversation: { scope: "before" } },
                resolveConversationProtection: async () => context.protection,
                requiresProtectedNetworkGuard: () => true,
                conversationAuthorizationScope: (_: unknown, conversation: any) => conversation.scope,
                hasSelectedKeyReviewBlock: () => context.review,
                review: false, isKeyAnnouncement: () => false,
                screenCaptureProtectionStatus: "ready", networkGuardGeneration: 0, networkGuardEnabled: false,
                originalRestPost: null, originalRestPatch: null, guardedRestPost: null, guardedRestPatch: null,
                RestAPI: { post: async () => { calls++; }, patch: async () => { calls++; } },
                userId: "self", UserStore: { getCurrentUser: () => ({ id: context.userId }) },
                protectProgrammaticPost: async () => { await preparation; return request; },
                protectProgrammaticPatch: async () => { await preparation; return request; },
                settleGuardedRestFailure, revokePreparedSecureOperations() {},
                restorePostAuthorization() {}, restorePatchAuthorization() {},
            };
            runInNewContext(`${compiledFunctions(["assertRequestProtectionCurrent", "installNetworkGuard"])}\ninstallNetworkGuard();`, context);
            const pending = context.RestAPI[method](request);
            if (change === "scope") context.protection.conversation.scope = "after";
            if (change === "review") context.review = true;
            if (change === "capture") context.screenCaptureProtectionStatus = "failed";
            if (change === "protected") context.protection = { kind: "persisted_protected" };
            if (change === "account") context.userId = "other";
            finish();
            await assert.rejects(pending, /changed/, `${method}: ${change}`);
            assert.equal(calls, 0, `${method}: ${change}`);
        }
    }
});
