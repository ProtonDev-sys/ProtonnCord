/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";

import * as constants from "../src/equicordplugins/fileUpload/constants";
import * as types from "../src/equicordplugins/fileUpload/types";
import * as media from "../src/equicordplugins/fileUpload/utils/getMediaUrl";
import * as sharex from "../src/equicordplugins/fileUpload/utils/sharex";
import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordFilePaste, discordUploadPipeline } from "./fixtures/discordUploadPipeline";
import { declaration, React } from "./utils/discordClientFixture";
import { loadTestModule } from "./utils/loadTestModule";

const file = (size = 4, name = "kept.txt") => new File(["a".repeat(size)], name, { type: "text/plain" });
const channel = (id = "channel", guild_id?: string, thread = false) => Object.freeze({
    id, guild_id, type: (thread ? 11 : 0) as number, getGuildId: () => guild_id, isThread: () => thread,
    isPrivate: () => !guild_id, isManaged: () => false
});

function harness(config: Record<string, unknown> = {}, desktop = true) {
    let currentUser: { id: string; limit: number; } | undefined = { id: "account", limit: 10 };
    let selected = "channel";
    let permissions = 7n;
    let existing = 0;
    let totalLimit = 1000;
    let deferSizes = false;
    let normalize = async (upload: any) => upload;
    let protection = async (_account: string, _channel: string): Promise<any> => ({ status: "unconfigured" });
    let pick = async (): Promise<File | undefined> => file();
    let selectedUploads: any[] = [];
    let onOpen = () => {};
    let freezeDispatch = false;
    const requests: { bytes: ArrayBuffer; name: string; accountId?: string; result: PromiseWithResolvers<any>; }[] = [];
    const fetches: string[] = [];
    const fetchAccounts: (string | undefined)[] = [];
    const xhrRequests: { url?: string; body?: unknown; accountId?: string; }[] = [];
    const copied: string[] = [];
    const inserted: string[] = [];
    const errors: any[] = [];
    const drafts: any[] = [];
    const messages: unknown[] = [];
    const analytics: unknown[] = [];
    const opened: unknown[] = [];
    const chatOpen = new Set<string>();
    const protectionReads: string[][] = [];
    const interceptors: ((event: any) => void)[] = [];
    const listeners = new Set<unknown>();
    const store: any = {
        serviceType: types.ServiceType.CATBOX, disableFallbacks: true, autoCopy: true, autoSend: true,
        preserveOriginalFilename: true, corsProxyUrl: "none", bypassDiscordUpload: true,
        bypassDiscordUploadOnlyOverLimit: true, ...config
    };
    const logger = { error() {}, warn() {} };
    const common = {
        React, Menu: { MenuItem: "item", MenuGroup: "group", MenuSeparator: "separator" },
        DraftType: { ChannelMessage: 0 }, UserStore: { getCurrentUser: () => currentUser },
        SelectedChannelStore: { getChannelId: () => selected },
        PermissionStore: { can: (bits: bigint) => (permissions & bits) === bits }, PermissionsBits: { SEND_MESSAGES: 1n, ATTACH_FILES: 2n, SEND_MESSAGES_IN_THREADS: 4n },
        UploadAttachmentStore: { getUploadCount: () => existing, getUploads: () => selectedUploads },
        FluxDispatcher: { _interceptors: interceptors, addInterceptor: (fn: (event: any) => void) => interceptors.push(fn) },
        showToast() {}, Toasts: { Type: { MESSAGE: "message", FAILURE: "failure", SUCCESS: "success" } }
    };
    const globals = {
        React, File, Blob, URL, TextEncoder, TextDecoder, AbortController, Buffer, Headers, Response, FormData, ReadableStream,
        setTimeout: () => 1, clearTimeout() {}, IS_DISCORD_DESKTOP: desktop,
        async fetch(url: string) {
            fetches.push(url);
            fetchAccounts.push(currentUser?.id);
            return new Response(await file().arrayBuffer(), { status: 200, headers: { "Content-Type": "text/plain" } });
        },
        VencordNative: { pluginHelpers: {
            SecureMessaging: { getChannelProtection(account: string, channelId: string) {
                protectionReads.push([account, channelId]);
                return protection(account, channelId);
            } },
            FileUpload: {
                async fetchFile(url: string) {
                    fetches.push(url);
                    fetchAccounts.push(currentUser?.id);
                    return { success: true, data: await file().arrayBuffer(), contentType: "text/plain" };
                },
                uploadToCatbox(bytes: ArrayBuffer, name: string) {
                    const result = Promise.withResolvers<any>();
                    requests.push({ bytes, name, result, accountId: currentUser?.id });
                    return result.promise;
                }
            }
        } },
        XMLHttpRequest: class {
            upload = {};
            status = 200;
            statusText = "OK";
            responseURL = "https://example.invalid/file";
            response = store.serviceType === types.ServiceType.CATBOX ? "https://example.invalid/file" : '{"files":[{"url":"https://example.invalid/file"}]}';
            onload!: () => void;
            onloadend!: () => void;
            request: { url?: string; body?: unknown; accountId?: string; } = {};
            constructor() { xhrRequests.push(this.request); }
            open(_method: string, url: string) { this.request.url = url; }
            setRequestHeader() {}
            getAllResponseHeaders() { return "Content-Type: application/json"; }
            send(body: unknown) {
                this.request.body = body;
                this.request.accountId = currentUser?.id;
                Promise.resolve().then(() => { this.onload(); this.onloadend(); });
            }
            abort() {}
        },
        document: { addEventListener: (_event: string, listener: unknown) => listeners.add(listener),
            removeEventListener: (_event: string, listener: unknown) => listeners.delete(listener) }
    };
    const uploads = loadTestModule("src/equicordplugins/fileUpload/utils/upload.ts", {
        "@equicordplugins/fileUpload/constants": constants, "@equicordplugins/fileUpload/settings": { settings: { store } },
        "@equicordplugins/fileUpload/types": types,
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/clipboard": { copyToClipboard: async (value: string) => { copied.push(value); } },
        "@utils/discord": { insertTextIntoChatInputBox: (value: string) => inserted.push(value) },
        "@utils/web": { chooseFile: () => pick() }, "@webpack/common": common,
        "./apngToGif": { stopApngConversion() {} }, "./getMediaUrl": media, "./sharex": sharex, "./s3": {}
    }, globals);
    const plugin = loadTestModule("src/equicordplugins/fileUpload/index.tsx", {
        "@api/ContextMenu": { findGroupChildrenByChildId: (_id: string, children: unknown[]) => children },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } },
        "@components/Icons": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack": { findByPropsLazy: () => ({ getUserMaxFileSize: () => currentUser?.limit ?? 0 }) },
        "@webpack/common": common, "./settings": { settings: { store } }, "./types": types,
        "./utils/getMediaUrl": media, "./utils/upload": { ...uploads, logger }
    }, globals).default;
    plugin.start();
    const patch = plugin.patches[1];
    let pipeline: string = discordUploadPipeline.pipeline;
    for (const replacement of [patch.replacement].flat()) {
        pipeline = pipeline.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, "plugin"));
    }
    const factories = runInNewContext("({" + pipeline + "," + discordUploadPipeline.sizeCheck + "," + discordUploadPipeline.limits + "})", { File, plugin });
    const modules: Record<number, any> = {
        287809: { default: common.UserStore }, 71393: { A: { getGuild: () => ({ features: new Set(["boost"]) }) } },
        158045: { Ay: { getUserMaxFileSize: () => currentUser?.limit ?? 10, isPremium: () => false }, YE: () => false },
        796873: { filesize: (size: number) => size + " bytes" },
        292348: { jS: () => totalLimit }, 409481: { C: (size: number) => size },
        820465: { M: () => deferSizes }, 202541: { w6: 100, eZ: 50, PremiumTypes: { TIER_1: 1, TIER_2: 2 } },
        652215: { TbF: 10, XgB: 3, GuildFeatures: { MAX_FILE_SIZE_100_MB: "boost", MAX_FILE_SIZE_50_MB: "boost50" },
            HAw: { FILE_SIZE_LIMIT_EXCEEDED: "size-error", UPLOAD_FILE_LIMIT_ERROR: "count-error" }, rbe: { GUILD_VOICE: 2, GUILD_STAGE_VOICE: 13 } },
        660183: { intl: { string: (key: string) => key, formatToPlainString: (key: string, args: unknown) => [key, args] },
            t: new Proxy({}, { get: (_target, key) => String(key) }) },
        608299: { A: { addFiles(payload: any) {
            const event = { type: "UPLOAD_ATTACHMENT_ADD_FILES", ...payload };
            if (freezeDispatch) { Object.freeze(event.files); Object.freeze(event); }
            for (const interceptor of interceptors) interceptor(event);
            drafts.push(event);
        } } }, 111542: { N: (upload: any) => normalize(upload) }, 795129: { _: async (value: File) => (await value.arrayBuffer()).byteLength },
        494921: { openUploadError: (error: unknown) => errors.push(error) }, 522602: { A: common.UploadAttachmentStore },
        367513: { A: { updateChatOpen: (id: string, value: boolean) => { chatOpen.add(id); opened.push([id, value]); onOpen(); } } },
        198052: { A: { getChatOpen: (id: string) => chatOpen.has(id) } },
        274652: { x: { WEB: "web" } }, 174459: { default: { track: (...args: unknown[]) => analytics.push(args) } },
        666860: { zV: (...args: unknown[]) => analytics.push(args) }, 346293: { s: (value: unknown) => value },
        381941: { ty: { UPLOAD_ATTACHMENT_MAX_SIZE_ERROR: "max-size" }, Hx: { INSTANT_UPLOAD: "instant" } },
        280889: { bK: class { constructor(public item: any, public channelId: string) {} } },
        148494: { A: { sendMessage: (...args: unknown[]) => messages.push(args) } }
    };
    const requireHost = Object.assign((id: number): any => {
        if (!(id in modules)) {
            const result = {};
            if (id in factories) factories[id]({}, result, requireHost);
            modules[id] = result;
        }
        return modules[id];
    }, { d(target: object, exports: Record<string, () => unknown>) {
        for (const [key, get] of Object.entries(exports)) Object.defineProperty(target, key, { get });
    }, n: (value: unknown) => () => value });
    const pipelineExports = requireHost(518960);
    return {
        plugin, patch, uploads, store, requests, fetches, fetchAccounts, xhrRequests, copied, inserted, errors, drafts, messages, analytics, opened, interceptors, listeners, protectionReads,
        run: (files: readonly File[], target = channel(), draftType = 0, options?: any) => pipelineExports.R(files, target, draftType, options),
        account: (id?: string) => { currentUser = id ? { id, limit: 10 } : undefined; },
        selected: (id: string) => selected = id, allowed: (value: boolean) => permissions = value ? 7n : 0n,
        permissions: (value: bigint) => permissions = value,
        protection: (fn: typeof protection) => protection = fn, onOpen: (fn: () => void) => onOpen = fn,
        pick: (fn: typeof pick) => pick = fn, draftUploads: (values: any[]) => selectedUploads = values,
        menuAction(name: string, props: any, id: string): (() => Promise<unknown> | undefined) | undefined {
            const items: any[] = [];
            plugin.contextMenus[name](items, props);
            function find(value: any): any {
                if (Array.isArray(value)) return value.map(find).find(Boolean);
                if (value?.props?.id === id) return value.props.action;
                return value?.props?.children ? find(value.props.children) : undefined;
            }
            return find(items);
        },
        count: (value: number) => existing = value, totalLimit: (value: number) => totalLimit = value,
        deferSizes: (value: boolean) => deferSizes = value, normalize: (fn: typeof normalize) => normalize = fn,
        freezeDispatch: () => freezeDispatch = true,
        async finish(result: { success: boolean; url?: string; error?: string; } = { success: true, url: "https://example.invalid/file" }) {
            for (let index = 0; index < 8 && uploads.isUploadBusy(); index++) {
                await setImmediate();
                requests.at(-1)?.result.resolve(result);
                await setImmediate();
            }
            assert.equal(uploads.isUploadBusy(), false);
        }
    };
}

function paste(h: ReturnType<typeof harness>, options: {
    files?: File[]; text?: string; command?: boolean; directory?: boolean; canPasteFiles?: boolean; target?: ReturnType<typeof channel>;
} = {}) {
    const patch = h.plugin.patches[2];
    let source: string = discordFilePaste;
    for (const replacement of patch.replacement) {
        const regex = canonicalizeMatch(replacement.match);
        assert.equal([...source.matchAll(new RegExp(regex.source, "g"))].length, 1);
        source = source.replace(regex, canonicalizeReplace(replacement.replace, "plugin"));
    }
    const state = { prevented: 0, stopped: 0, saved: 0, focused: 0, commands: [] as any[] };
    const editor = runInNewContext("new(class{" + source + "})()", {
        Blob, URL, plugin: h.plugin, L: { A: { getFocusedWindowId: () => null } }, y: { Q2: () => undefined }, eg() {},
        A: { A: { getActiveCommand: () => options.command ? { options: [{ name: "attachment", type: 11 }] } : null, getActiveOption: () => undefined } },
        m: { VE: (blob: Blob, name: string, type: string) => new File([blob], name, { type }) },
        _: { openUploadError: (error: unknown) => h.errors.push(error) },
        eE: { intl: { string: (value: string) => value }, t: {} },
        E: { n4: { ATTACHMENT: 11 } }, p: { A: { getUpload: () => undefined } },
        u: { A: { setFile: (value: unknown) => state.commands.push(value) } }, I: { x: { WEB: "web" } }
    });
    let done: Promise<unknown> = Promise.resolve();
    editor.props = {
        channel: options.target ?? channel(), canPasteFiles: options.canPasteFiles ?? true,
        maxCharacterCount: 1, type: { uploadLongMessages: true, drafts: { type: 0 } },
        promptToUpload: (...args: Parameters<typeof h.run>) => done = h.run(...args)
    };
    editor._getEditorWindow = () => undefined;
    editor.saveCurrentText = () => state.saved++;
    editor.focus = () => state.focused++;
    const items = (options.files ?? (options.text == null ? [file()] : [])).map(value => ({
        kind: "file", type: value.type, getAsFile: () => value,
        webkitGetAsEntry: () => options.directory ? { isFile: false } : null
    }));
    const result = editor.handlePaste({
        clipboardData: { items: Object.freeze(options.text == null ? items : [{ kind: "string", type: "text/plain" }]), getData: () => options.text },
        preventDefault: () => state.prevented++, stopPropagation: () => state.stopped++
    });
    return { done, result, state };
}

test("FileUpload finds the current pipeline without replacing the shared size validator", () => {
    const h = harness();
    assert.ok(discordUploadPipeline.pipeline.includes(canonicalizeMatch(h.patch.find)));
    assert.equal(discordUploadPipeline.sizeCheck.includes(canonicalizeMatch(h.patch.find)), false);
    let source: string = discordUploadPipeline.pipeline;
    for (const replacement of [h.patch.replacement].flat()) {
        const regex = canonicalizeMatch(replacement.match);
        assert.equal([...source.matchAll(new RegExp(regex.source, "g"))].length, 1);
        source = source.replace(regex, canonicalizeReplace(replacement.replace, "plugin"));
    }
    h.plugin.stop();
});

test("current upload pipeline hands oversized selections to the real uploader using account, guild, total and deferred limits", async () => {
    for (const scenario of ["individual", "guild", "aggregate", "deferred"]) {
        const h = harness();
        const files = Object.freeze(scenario === "aggregate" ? [file(6), file(6, "second.txt")] : [file(scenario === "guild" ? 101 : 11)]);
        if (scenario === "aggregate") h.totalLimit(10);
        if (scenario === "deferred") h.deferSizes(true);
        await h.run(files, channel("channel", scenario === "guild" ? "guild" : undefined));
        await setImmediate();
        assert.equal(h.requests.length, 1, scenario);
        assert.equal(h.drafts.length, 0, "a claimed batch must not also reach Discord");
        assert.equal(h.errors.length, 0);
        await h.finish();
        assert.equal(h.requests.length, files.length);
        assert.deepEqual(h.requests.map(request => request.name), files.map(file => file.name));
        assert.deepEqual(h.requests.map(request => request.bytes.byteLength), files.map(file => file.size));
        assert.equal(h.copied.length, files.length);
        assert.equal(h.inserted.length, files.length);
        assert.ok(Object.isFrozen(files));
        h.plugin.stop();
    }
});

test("within boosted guild limits and declined integrations retain native files, metadata and instant-send behavior", async () => {
    const cases = ["guild", "off", "filter", "mixed", "draft", "instant", "thumbnail", "metadata", "channel", "signed-out", "permissions", "configuration"];
    for (const scenario of cases) {
        const h = harness({ bypassDiscordUploadOnlyOverLimit: scenario === "guild", uploadAllowedFileTypes: ["filter", "mixed"].includes(scenario) ? "txt" : "" });
        if (scenario === "off") h.store.bypassDiscordUpload = false;
        if (scenario === "signed-out") h.account();
        if (scenario === "permissions") h.allowed(false);
        if (scenario === "configuration") h.store.serviceType = types.ServiceType.ZIPLINE;
        h.freezeDispatch();
        const files = Object.freeze(scenario === "mixed" ? [file(), file(4, "kept.bin")] : [file(scenario === "guild" ? 50 : 4, scenario === "filter" ? "kept.bin" : "kept.txt")]);
        const target = channel(scenario === "channel" ? "other" : "channel", ["guild", "permissions"].includes(scenario) ? "guild" : undefined);
        const options = scenario === "instant" ? { requireConfirm: false } : scenario === "thumbnail" ? { isThumbnail: true }
            : scenario === "metadata" ? { filesMetadata: [{ clip: { id: "private-clip" } }] } : undefined;
        await h.run(files, target, scenario === "draft" ? 1 : 0, options);
        await setImmediate();
        assert.equal(h.requests.length, 0, scenario);
        assert.equal(h.errors.length, 0, scenario);
        if (scenario === "instant") assert.equal(h.messages.length, 1);
        else {
            assert.equal(h.drafts.length, 1, scenario);
            assert.equal(h.drafts[0].channelId, target.id);
            assert.deepEqual(Array.from(h.drafts[0].files, (upload: any) => upload.file), files);
            if (scenario === "thumbnail") assert.equal(h.drafts[0].files[0].isThumbnail, true);
            if (scenario === "metadata") assert.equal(h.drafts[0].files[0].clip.id, "private-clip");
        }
        h.plugin.stop();
    }
});

test("native empty, mismatched metadata, count and rejected normalization errors run before external upload", async () => {
    for (const scenario of ["empty", "metadata", "count", "normalize"]) {
        const h = harness({ bypassDiscordUploadOnlyOverLimit: false });
        if (scenario === "count") h.count(3);
        if (scenario === "normalize") h.normalize(async () => { throw new Error("conversion failed"); });
        const promise = h.run([file(scenario === "empty" ? 0 : scenario === "count" ? 4 : 11)], channel(), 0, scenario === "metadata" ? { filesMetadata: [] } : undefined);
        if (scenario === "metadata") await assert.rejects(promise, /Unexpected mismatch/);
        else if (scenario === "normalize") await assert.rejects(promise, /conversion failed/);
        else { await promise; assert.equal(h.errors.length, 1); }
        await setImmediate();
        assert.equal(h.requests.length, 0);
        assert.equal(h.drafts.length, 0);
        h.plugin.stop();
    }
});

test("declined oversized and over-count uploads preserve native errors without claiming a partial batch", async () => {
    for (const scenario of ["off", "mixed", "draft", "channel", "permission", "configuration", "thumbnail", "count"]) {
        const h = harness({ bypassDiscordUploadOnlyOverLimit: false, uploadAllowedFileTypes: "txt" });
        if (scenario === "off") h.store.bypassDiscordUpload = false;
        if (scenario === "permission") h.allowed(false);
        if (scenario === "configuration") h.store.serviceType = types.ServiceType.ZIPLINE;
        if (scenario === "count") h.count(3);
        const size = scenario === "permission" ? 101 : 11;
        const files = Object.freeze(scenario === "mixed" ? [file(4), file(size, "kept.bin")] : [file(size)]);
        await h.run(files, channel(scenario === "channel" ? "other" : "channel", scenario === "permission" ? "guild" : undefined),
            scenario === "draft" ? 1 : 0, scenario === "thumbnail" ? { isThumbnail: true } : undefined);
        await setImmediate();
        assert.equal(h.requests.length, 0, scenario);
        assert.equal(h.drafts.length, 0, scenario);
        assert.equal(h.errors.length, 1, scenario);
        assert.equal(files.at(-1)?.size, size);
        h.plugin.stop();
    }
});

test("normalized files and thread-specific send permissions govern the external handoff", async () => {
    const h = harness({ bypassDiscordUploadOnlyOverLimit: false, uploadAllowedFileTypes: "jpg" });
    h.permissions(6n);
    const converted = file(11, "converted.jpg");
    h.normalize(async upload => ({ ...upload, file: converted }));
    await h.run(Object.freeze([file(4, "source.heic")]), channel("channel", "guild", true));
    await setImmediate();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].name, converted.name);
    assert.equal(h.requests[0].bytes.byteLength, converted.size);
    await h.finish();
    h.permissions(2n);
    await h.run([file()], channel("channel", "guild", true));
    assert.equal(h.requests.length, 1, "attachment permission alone must not start an external upload");
    assert.equal(h.drafts.length, 1);
    h.plugin.stop();
});

test("late preparation cannot redirect uploads after stop, restart, logout, account, channel or settings changes", async () => {
    for (const scenario of ["stop", "restart", "logout", "account", "channel", "setting", "permission", "normalized-filter"]) {
        const h = harness({ bypassDiscordUploadOnlyOverLimit: false, uploadAllowedFileTypes: "txt" });
        const pending = Promise.withResolvers<any>();
        let prepared: any;
        h.normalize(upload => { prepared = upload; return pending.promise; });
        const operation = h.run([file()], channel("channel", "guild"));
        await setImmediate();
        assert.ok(prepared);
        if (scenario === "stop" || scenario === "restart") h.plugin.stop();
        if (scenario === "restart") h.plugin.start();
        if (scenario === "logout") { h.plugin.flux?.LOGOUT(); h.account("account"); }
        if (scenario === "account") h.account("another");
        if (scenario === "channel") h.selected("another");
        if (scenario === "setting") h.store.bypassDiscordUpload = false;
        if (scenario === "permission") h.allowed(false);
        pending.resolve(scenario === "normalized-filter" ? { ...prepared, file: file(4, "converted.bin") } : prepared);
        await operation;
        await setImmediate();
        assert.equal(h.requests.length, 0, scenario);
        assert.equal(h.drafts.length, 1, "declined handoffs leave the original host pipeline intact");
        if (scenario === "normalized-filter") assert.equal(h.drafts[0].files[0].file.name, "converted.bin");
        h.plugin.stop();
    }
});

test("busy uploads preserve native size errors and failed handoffs release state for a retry", async () => {
    const h = harness({ bypassDiscordUploadOnlyOverLimit: false });
    const files = Object.freeze([file(11)]);
    await h.run(files);
    await setImmediate();
    assert.equal(h.requests.length, 1);
    await h.run(files);
    assert.equal(h.requests.length, 1);
    assert.equal(h.errors.length, 1, "being busy must not suppress native validation");
    await h.finish({ success: false, error: "Service unavailable" });
    assert.equal(h.uploads.getUploadState().phase, "failed");
    assert.equal(h.copied.length, 0);
    assert.equal(h.inserted.length, 0);
    assert.equal(files[0].size, 11);
    await h.run(files);
    await h.finish();
    assert.equal(h.requests.length, 2);
    assert.equal(h.copied.length, 1);
    h.plugin.stop();
    assert.equal(h.listeners.size, 0);
    assert.equal(h.interceptors.length, 0);
});

test("automatic handoffs use the native protection policy for enabled, review-required and locked conversations", async () => {
    const accountId = "100000000000000001";
    const channelId = "200000000000000002";
    let conversation: { enabled: boolean; reviewRequired: object | null; } | undefined;
    let envelope: { protectedChannelIdsByUser: Record<string, string[]> | null; } | undefined;
    let vaultLoads = 0;
    const nativeProtection = declaration("src/equicordplugins/secureMessaging.desktop/native.ts", "getChannelProtection", {
        validateIpcCaller: () => undefined, validateLocalUserId: (value: string) => ({ ok: true, value }),
        isSnowflake: (value: string) => /^\d{17,20}$/.test(value), runSerialized: (fn: () => unknown) => fn(),
        readVaultStoredValue: async () => "test-vault", parseSecurityKeyVaultEnvelope: () => envelope,
        securityKeyVaultStateForValue: () => ({ status: "locked" }), SecurityKeyVaultError: Error,
        loadVault: async () => {
            vaultLoads++;
            return { accounts: { [accountId]: { conversations: conversation ? { [channelId]: conversation } : {} } } };
        }
    });
    for (const scenario of ["enabled", "review", "locked", "locked-unknown", "disabled", "unconfigured", "locked-other"]) {
        const h = harness({ bypassDiscordUploadOnlyOverLimit: false });
        h.account(accountId);
        h.selected(channelId);
        vaultLoads = 0;
        conversation = scenario === "unconfigured" ? undefined : { enabled: scenario === "enabled", reviewRequired: scenario === "review" ? { peerId: "changed-key" } : null };
        envelope = scenario.startsWith("locked") ? { protectedChannelIdsByUser: scenario === "locked-unknown" ? null : { [accountId]: [scenario === "locked-other" ? "300000000000000003" : channelId] } } : undefined;
        h.protection((account, target) => nativeProtection({}, account, target));
        const files = Object.freeze([file()]);
        await h.run(files, channel(channelId));
        await setImmediate();
        const allowed = ["disabled", "unconfigured", "locked-other"].includes(scenario);
        assert.deepEqual(h.protectionReads, Array.from({ length: allowed ? 2 : 1 }, () => [accountId, channelId]), scenario);
        assert.equal(h.requests.length, allowed ? 1 : 0, scenario);
        assert.equal(h.drafts.length, allowed ? 0 : 1, scenario);
        assert.equal(h.errors.length, 0, scenario);
        assert.equal(vaultLoads, scenario.startsWith("locked") ? 0 : allowed ? 2 : 1, "locked protection uses the native protected-channel index");
        if (allowed) await h.finish();
        else assert.equal(h.drafts[0].files[0].file, files[0], "protected plaintext remains on the native encryption path");
        h.plugin.stop();
    }
});

test("unknown, failed or unavailable protection checks retain native upload validation", async () => {
    for (const scenario of ["unknown", "failure", "unavailable", "throw", "oversized"]) {
        const h = harness({ bypassDiscordUploadOnlyOverLimit: false });
        h.protection(async () => {
            if (scenario === "throw") throw new Error("IPC unavailable");
            if (scenario === "unavailable") return undefined;
            return { status: scenario === "oversized" ? "protected" : scenario === "failure" ? "storage_unavailable" : "future-status" };
        });
        const files = Object.freeze([file(scenario === "oversized" ? 11 : 4)]);
        await h.run(files);
        await setImmediate();
        assert.equal(h.requests.length, 0, scenario);
        assert.equal(h.errors.length, scenario === "oversized" ? 1 : 0, scenario);
        assert.equal(h.drafts.length, scenario === "oversized" ? 0 : 1, scenario);
        if (h.drafts.length) assert.equal(h.drafts[0].files[0].file, files[0]);
        h.plugin.stop();
    }
});

test("pending native protection reads cannot claim uploads after context, settings, filters, count or busy state changes", async () => {
    for (const scenario of ["stop", "restart", "logout", "account", "channel", "setting", "only-over-limit", "permission", "configuration", "filter", "count", "busy"]) {
        const h = harness({ bypassDiscordUploadOnlyOverLimit: false, uploadAllowedFileTypes: "txt" });
        const pending = Promise.withResolvers<any>();
        h.protection(() => pending.promise);
        const files = Object.freeze([file()]);
        const operation = h.run(files, channel("channel", "guild"));
        await setImmediate();
        assert.deepEqual(h.protectionReads, [["account", "channel"]], scenario);
        assert.equal(h.requests.length, 0, "the protection query precedes every external request");
        if (scenario === "stop" || scenario === "restart") h.plugin.stop();
        if (scenario === "restart") h.plugin.start();
        if (scenario === "logout") { h.plugin.flux.LOGOUT(); h.account("account"); }
        if (scenario === "account") h.account("another");
        if (scenario === "channel") h.selected("another");
        if (scenario === "setting") h.store.bypassDiscordUpload = false;
        if (scenario === "only-over-limit") h.store.bypassDiscordUploadOnlyOverLimit = true;
        if (scenario === "permission") h.allowed(false);
        if (scenario === "configuration") h.store.serviceType = types.ServiceType.ZIPLINE;
        if (scenario === "filter") h.store.uploadAllowedFileTypes = "png";
        if (scenario === "count") h.count(3);
        const busy = scenario === "busy" ? h.uploads.uploadProvidedFiles([file(4, "busy.txt")]) : undefined;
        await setImmediate();
        pending.resolve({ status: "unconfigured" });
        await operation;
        await setImmediate();
        assert.equal(h.requests.length, scenario === "busy" ? 1 : 0, scenario);
        assert.equal(h.errors.length, scenario === "count" ? 1 : 0, scenario);
        assert.equal(h.drafts.length, scenario === "count" ? 0 : 1, scenario);
        if (h.drafts.length) assert.equal(h.drafts[0].files[0].file, files[0]);
        if (busy) { await h.finish(); assert.equal(await busy, true); }
        h.plugin.stop();
    }
});

test("accepted and declined voice or stage uploads preserve the original native chat-opening expression", async () => {
    for (const type of [2, 13]) {
        for (const scenario of ["native", "external", "protected", "changed-on-open", "already-open", "over-count"]) {
            const h = harness({ bypassDiscordUpload: scenario !== "native", bypassDiscordUploadOnlyOverLimit: false });
            const target = Object.freeze({ ...channel("channel", "guild"), type });
            const files = Object.freeze([file()]);
            if (scenario === "protected") h.protection(async () => ({ status: "protected" }));
            if (scenario === "over-count") h.count(3);
            if (scenario === "already-open") {
                h.store.bypassDiscordUpload = false;
                await h.run(files, target);
                h.store.bypassDiscordUpload = true;
                h.drafts.length = 0;
            }
            if (scenario === "changed-on-open") h.onOpen(() => h.selected("another"));
            await h.run(files, target);
            await setImmediate();
            const accepted = scenario === "external" || scenario === "already-open";
            assert.deepEqual(h.opened, scenario === "over-count" ? [] : [["channel", true]], `${type}: ${scenario}`);
            assert.equal(h.requests.length, accepted ? 1 : 0, `${type}: ${scenario}`);
            assert.equal(h.errors.length, scenario === "over-count" ? 1 : 0, scenario);
            assert.equal(h.drafts.length, accepted || scenario === "over-count" ? 0 : 1, scenario);
            if (accepted) await h.finish();
            h.plugin.stop();
        }
    }
});

test("the native clipboard path keeps separate paste and general bypass settings without intercepting text or commands", async () => {
    for (const scenario of ["paste-only", "disabled", "bypass-only", "protected", "mixed", "long-text", "short-text", "command", "directory", "permission"]) {
        const h = harness({ bypassDiscordUpload: scenario === "bypass-only", bypassDiscordUploadOnlyOverLimit: false,
            autoUploadPastedFiles: !["disabled", "bypass-only"].includes(scenario), uploadAllowedFileTypes: "txt" });
        if (scenario === "protected") h.protection(async () => ({ status: "protected" }));
        const result = paste(h, {
            files: scenario === "mixed" ? [file(), file(4, "kept.bin")] : undefined,
            text: scenario === "long-text" ? "body" : scenario === "short-text" ? "x" : undefined,
            command: scenario === "command", directory: scenario === "directory",
            canPasteFiles: scenario !== "permission", target: channel("channel", scenario === "permission" ? "guild" : undefined)
        });
        await result.done;
        await setImmediate();
        const accepted = scenario === "paste-only" || scenario === "bypass-only";
        const nativeUnclaimed = ["short-text", "directory", "permission"].includes(scenario);
        assert.equal(h.requests.length, accepted ? 1 : 0, scenario);
        assert.equal(h.drafts.length, accepted || nativeUnclaimed || scenario === "command" ? 0 : 1, scenario);
        assert.equal(result.state.commands.length, scenario === "command" ? 1 : 0, scenario);
        assert.equal(result.result, !nativeUnclaimed, scenario);
        for (const effect of ["prevented", "stopped", "saved", "focused"] as const)
            assert.equal(result.state[effect], nativeUnclaimed ? 0 : 1, `${scenario}: native ${effect}`);
        if (scenario === "long-text") assert.equal(h.drafts[0].files[0].file.name, "message.txt");
        if (scenario === "mixed") assert.equal(h.drafts[0].files.length, 2);
        if (scenario === "directory") assert.equal(h.errors.length, 1);
        assert.equal(h.listeners.size, 0, "FileUpload no longer intercepts clipboard events");
        if (accepted) await h.finish();
        h.plugin.stop();
    }
});

test("disabling paste upload while native protection is pending restores the normal attachment path", async () => {
    const h = harness({ bypassDiscordUpload: false, autoUploadPastedFiles: true });
    const pending = Promise.withResolvers<any>();
    h.protection(() => pending.promise);
    const original = file();
    const result = paste(h, { files: [original] });
    await setImmediate();
    assert.equal(h.protectionReads.length, 1);
    assert.equal(h.requests.length, 0);
    h.store.autoUploadPastedFiles = false;
    pending.resolve({ status: "unconfigured" });
    await result.done;
    assert.equal(h.requests.length, 0);
    assert.equal(h.drafts[0].files[0].file, original);
    h.plugin.stop();
});

test("manual file, picker, draft, image, message and renderer HTTP uploads share the native protection guard", async () => {
    for (const route of ["provided", "picker", "draft", "image", "message", "xhr"]) {
        for (const protectedChannel of [true, false]) {
            const h = harness(route === "xhr" ? { serviceType: types.ServiceType.ZIPLINE, serviceUrl: "https://example.invalid", ziplineToken: "test-token" } : {});
            h.protection(async () => ({ status: protectedChannel ? "protected" : "unconfigured" }));
            const original = file();
            let removed = 0;
            let operation: Promise<unknown> | undefined;
            if (route === "draft") {
                h.draftUploads([{ id: "draft", filename: original.name, item: { file: original }, removeFromMsgDraft: () => removed++ }]);
                operation = h.menuAction("channel-attach", { channel: channel() }, "file-upload-draft-draft")?.();
            } else if (route === "picker") operation = h.menuAction("channel-attach", { channel: channel() }, "file-upload-manual")?.();
            else if (route === "image") operation = h.menuAction("image-context", { src: "https://example.invalid/kept.png" }, "file-upload")?.();
            else if (route === "message") operation = h.menuAction("message", { itemSrc: "https://example.invalid/kept.png" }, "file-upload")?.();
            else operation = h.uploads.uploadProvidedFiles([original]);
            assert.ok(operation, route);
            await setImmediate();
            await h.finish();
            await operation;
            const nativeUpload = !protectedChannel && route !== "xhr";
            assert.equal(h.requests.length, nativeUpload ? 1 : 0, route);
            assert.equal(h.xhrRequests.length, !protectedChannel && route === "xhr" ? 1 : 0, route);
            assert.equal(h.fetches.length, !protectedChannel && ["image", "message"].includes(route) ? 1 : 0, route);
            assert.equal(h.copied.length, protectedChannel ? 0 : 1, route);
            assert.equal(h.inserted.length, protectedChannel ? 0 : 1, route);
            assert.equal(removed, !protectedChannel && route === "draft" ? 1 : 0, route);
            if (protectedChannel) assert.match(h.uploads.getUploadState().status, /Secure Messaging/);
            h.plugin.stop();
        }
    }
});

test("stale menu actions and file pickers cannot move an upload to another account, channel or lifecycle", async () => {
    for (const scenario of ["channel", "account", "logout", "restart", "picker-channel", "picker-account", "picker-stop"]) {
        const h = harness();
        const pending = Promise.withResolvers<File | undefined>();
        h.pick(() => pending.promise);
        const action = h.menuAction("channel-attach", { channel: channel() }, "file-upload-manual");
        assert.ok(action);
        const operation = scenario.startsWith("picker") ? action() : undefined;
        if (scenario.includes("channel")) h.selected("another");
        if (scenario.includes("account")) h.account("another");
        if (scenario === "logout") h.plugin.flux.LOGOUT();
        if (scenario === "restart" || scenario === "picker-stop") h.plugin.stop();
        if (scenario === "restart") h.plugin.start();
        if (operation) { pending.resolve(file()); await operation; }
        else assert.equal(action(), undefined);
        assert.equal(h.protectionReads.length, 0, scenario);
        assert.equal(h.requests.length, 0, scenario);
        h.plugin.stop();
    }
});

test("the transport rechecks protection and automatic context after file preparation without retrying a blocked request on another host", async () => {
    for (const scenario of ["protection", "unknown", "account", "channel", "stop", "count", "filter", "permission", "configuration", "setting"]) {
        const h = harness({ bypassDiscordUploadOnlyOverLimit: false, uploadAllowedFileTypes: "txt", disableFallbacks: false });
        const pending = Promise.withResolvers<any>();
        h.protection(async () => h.protectionReads.length === 1 ? { status: "unconfigured" } : pending.promise);
        const files = Object.freeze([file()]);
        await h.run(files, channel("channel", "guild"));
        await setImmediate();
        assert.equal(h.protectionReads.length, 2, scenario);
        assert.equal(h.requests.length, 0);
        if (scenario === "account") h.account("another");
        if (scenario === "channel") h.selected("another");
        if (scenario === "stop") h.plugin.stop();
        if (scenario === "count") h.count(3);
        if (scenario === "filter") h.store.uploadAllowedFileTypes = "png";
        if (scenario === "permission") h.allowed(false);
        if (scenario === "configuration") h.store.serviceType = types.ServiceType.ZIPLINE;
        if (scenario === "setting") h.store.bypassDiscordUpload = false;
        pending.resolve({ status: scenario === "protection" ? "protected" : scenario === "unknown" ? "storage_unavailable" : "unconfigured" });
        await h.finish();
        assert.equal(h.requests.length, 0, scenario);
        assert.equal(h.xhrRequests.length, 0, scenario);
        assert.equal(h.protectionReads.length, 2, "a protection or context failure cannot become a fallback upload");
        assert.equal(h.copied.length, 0);
        assert.equal(h.inserted.length, 0);
        assert.equal(files[0].name, "kept.txt");
        h.plugin.stop();
    }
});

test("the last async protection boundary cannot send a native, XHR or browser fetch request under a changed account", async () => {
    const later = (turns: number, action: () => void) => turns ? queueMicrotask(() => later(turns - 1, action)) : action();
    for (const route of ["native", "xhr", "browser"]) {
        let dispatched = 0;
        for (let turns = 1; turns <= 8; turns++) {
            const h = harness(route === "xhr" ? { serviceType: types.ServiceType.ZIPLINE, serviceUrl: "https://example.invalid", ziplineToken: "test-token" } : {}, route !== "browser");
            h.protection(async () => {
                later(turns, () => h.account("changed-account"));
                return { status: "unconfigured" };
            });
            const operation = route === "browser" ? h.uploads.uploadFile("https://example.invalid/kept.txt") : h.uploads.uploadProvidedFiles([file()]);
            if (route === "browser") later(turns, () => h.account("changed-account"));
            await setImmediate();
            await h.finish();
            await operation;
            const accounts = [...h.requests.map(request => request.accountId), ...h.fetchAccounts, ...h.xhrRequests.filter(request => request.body != null).map(request => request.accountId)];
            assert.ok(accounts.every(account => account === "account"), `${route}: microtask ${turns}`);
            dispatched += accounts.length;
            h.plugin.stop();
        }
        assert.ok(dispatched > 0, `${route}: requests before an account switch remain functional`);
    }
    const h = harness();
    const operation = h.uploads.uploadProvidedFiles([file()], false, () => {
        queueMicrotask(() => h.account("changed-account"));
        return true;
    });
    await setImmediate();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].accountId, "account", "the synchronous assertion and transport call must share one continuation");
    await h.finish();
    assert.equal(await operation, false, "a later account change still discards the response");
    h.plugin.stop();
});
