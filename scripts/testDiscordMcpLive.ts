import assert from "node:assert/strict";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import puppeteer, { Page } from "puppeteer-core";

const DEBUG_URL = process.env.DISCORD_DEBUG_URL ?? "http://127.0.0.1:9222";

interface RpcWaiter {
    resolve(value: any): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
}

function readTestIdentity() {
    const required = ["DISCORD_MCP_TEST_ACCOUNT_ID", "DISCORD_MCP_TEST_CHANNEL_ID", "DISCORD_MCP_TEST_RECIPIENT_ID"] as const;
    for (const name of required) {
        assert.match(process.env[name] ?? "", /^\d{17,20}$/u, `Set ${name} explicitly to the authorized test identity/destination snowflake before running this live harness`);
    }
    assert.notEqual(process.env.DISCORD_MCP_TEST_ACCOUNT_ID, process.env.DISCORD_MCP_TEST_RECIPIENT_ID, "The test destination must be another explicitly authorized user");
    return {
        accountId: process.env.DISCORD_MCP_TEST_ACCOUNT_ID!,
        channelId: process.env.DISCORD_MCP_TEST_CHANNEL_ID!,
        recipientId: process.env.DISCORD_MCP_TEST_RECIPIENT_ID!,
    };
}

async function manageTestPlugin(input: { identity: ReturnType<typeof readTestIdentity>; token: string; phase: "activate" | "verify" | "restore"; }) {
    const global = globalThis as any;
    const vencord = global.Vencord;
    const common = vencord?.Webpack?.Common;
    const key = Symbol.for("ProtonnCord.DiscordMCP.liveTest");
    if (common?.UserStore?.getCurrentUser()?.id !== input.identity.accountId)
        throw new Error("Connected Discord account does not match DISCORD_MCP_TEST_ACCOUNT_ID; refusing mutations" + (input.phase === "restore" && global[key] ? "; saved ownership state is retained; inspect manually after verifying the original account" : ""));
    const plugin = vencord.Plugins.plugins.DiscordMCP;
    if (!plugin) throw new Error("DiscordMCP plugin is missing from the built client");
    if (input.phase === "restore") {
        const state = global[key];
        if (!state) return;
        if (state.token !== input.token) throw new Error("Another live harness owns the saved plugin state");
        try {
            if (state.startedByTest && plugin.started && !vencord.Plugins.stopPlugin(plugin))
                throw new Error("Test-owned DiscordMCP activation could not be stopped");
        } finally {
            const settings = vencord.Settings.plugins.DiscordMCP;
            if (settings) {
                for (const name of ["enabled", "allowedChannelIds"]) {
                    if (state.fields[name].present) settings[name] = state.fields[name].value;
                    else delete settings[name];
                }
                if (!state.hadSettings && Object.keys(settings).length === 0) delete vencord.Settings.plugins.DiscordMCP;
            }
        }
        delete global[key];
        return;
    }
    const channel = common.ChannelStore?.getChannel(input.identity.channelId);
    if (channel?.type !== 1 || channel.recipients?.length !== 1 || channel.recipients[0] !== input.identity.recipientId)
        throw new Error("DISCORD_MCP_TEST_CHANNEL_ID is not the one-to-one DM for DISCORD_MCP_TEST_RECIPIENT_ID; refusing mutations");
    if (input.phase === "verify") return;
    if (global[key]) throw new Error("Another live harness already owns plugin settings");
    const previous = vencord.Settings.plugins.DiscordMCP;
    const state = {
        token: input.token,
        hadSettings: Object.hasOwn(vencord.Settings.plugins, "DiscordMCP"),
        startedByTest: !plugin.started,
        fields: Object.fromEntries(["enabled", "allowedChannelIds"].map(name => [name, {
            present: previous != null && Object.hasOwn(previous, name),
            value: previous?.[name],
        }])),
    };
    global[key] = state;
    const settings = vencord.Settings.plugins.DiscordMCP ??= {};
    delete settings.allowedChannelIds;
    settings.enabled = true;
    if (state.startedByTest && !vencord.Plugins.startPlugin(plugin)) throw new Error("DiscordMCP failed to start");
    const bridge = await global.VencordNative.pluginHelpers.DiscordMCP.initializeBridge();
    return {
        legacyAllowlistRemoved: !("allowedChannelIds" in settings),
        enabled: settings.enabled,
        pluginStarted: plugin.started,
        queueDirectory: bridge.queueDirectory,
    };
}

function withDeadline<Value>(promise: Promise<Value>, timeoutMs: number, label: string): Promise<Value> {
    let timeout: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`${label} timed out; outcome may be unknown`)), timeoutMs); }),
    ]).finally(() => clearTimeout(timeout));
}

function createRpcClient(child: ChildProcessWithoutNullStreams, defaultTimeoutMs = 45_000) {
    const pending = new Map<number, RpcWaiter>();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let nextId = 1;
    let failure: Error | undefined;
    const fail = (error: Error) => {
        failure ??= error;
        for (const waiter of pending.values()) {
            clearTimeout(waiter.timeout);
            waiter.reject(failure);
        }
        pending.clear();
    };
    child.once("error", fail);
    child.once("close", (code, signal) => fail(new Error(`MCP child closed (${code ?? signal}); pending outcomes may be unknown`)));
    child.stdin.on("error", fail);
    lines.on("line", line => {
        try {
            const message = JSON.parse(line);
            const waiter = pending.get(message?.id);
            if (!waiter) return;
            pending.delete(message.id);
            clearTimeout(waiter.timeout);
            if (message.error) waiter.reject(new Error(message.error.message));
            else waiter.resolve(message.result);
        } catch {
            fail(new Error("MCP child emitted invalid JSON; pending outcomes may be unknown"));
        }
    });
    return {
        rpc(method: string, params?: unknown, timeoutMs = defaultTimeoutMs) {
            if (failure) return Promise.reject(failure);
            const id = nextId++;
            return new Promise<any>((resolvePromise, rejectPromise) => {
                const timeout = setTimeout(() => {
                    pending.delete(id);
                    rejectPromise(new Error(`${method} RPC timed out; outcome may be unknown`));
                }, timeoutMs);
                pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout });
                try {
                    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => {
                        if (error) fail(error);
                    });
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            });
        },
        dispose() {
            fail(new Error("MCP RPC client disposed; pending outcomes may be unknown"));
            lines.close();
        },
    };
}

async function cleanupLiveTest(input: {
    channelId: string; subscriptionId?: string; sentMessageId?: string; deleteAttempted: boolean; pendingSend: boolean; marker?: string;
    callTool?: (name: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
    restore(): Promise<unknown>; dispose(): void; kill(): void; disconnect(): Promise<unknown>;
    warn(message: string): void;
}, timeoutMs = 5_000) {
    const attempt = async (label: string, operation: () => Promise<unknown>) => {
        try { await withDeadline(operation(), timeoutMs, label); }
        catch (error) { input.warn(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    if (input.subscriptionId && input.callTool)
        await attempt(`Unsubscribe ${input.subscriptionId}`, () => input.callTool!("discord_unsubscribe_channel", { subscription_id: input.subscriptionId }, timeoutMs));
    if (input.pendingSend) input.warn(`Send outcome unknown in channel ${input.channelId}; marker ${input.marker ?? "unavailable"}. Inspect manually; no automatic resend or deletion.`);
    if (input.sentMessageId) {
        const label = `Message ${input.sentMessageId} in channel ${input.channelId} may be retained or its deletion outcome unknown; inspect manually`;
        if (input.deleteAttempted) input.warn(label + "; no automatic delete retry");
        else if (input.callTool) await attempt(label, async () => {
            const result = await input.callTool!("discord_delete_own_message", { channel_id: input.channelId, message_id: input.sentMessageId }, timeoutMs);
            if (result?.deleted !== true) throw new Error("Deletion was not confirmed; no automatic retry");
        });
        else input.warn(label);
    }
    try { input.dispose(); } catch (error) { input.warn(`RPC disposal failed: ${String(error)}`); }
    try { input.kill(); } catch (error) { input.warn(`MCP child termination failed: ${String(error)}`); }
    await attempt("Restore test-owned plugin settings/lifecycle", input.restore);
    await attempt("Disconnect test browser session", input.disconnect);
}

async function connectWithRetry(timeoutMs = 60_000, attemptTimeoutMs = 5_000, retryDelayMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = new Error("Discord connection deadline expired; outcome may be unknown");
    while (Date.now() < deadline) {
        let abandoned = false;
        try {
            const connection = puppeteer.connect({ browserURL: DEBUG_URL, defaultViewport: null }).then(async browser => {
                if (!abandoned) return browser;
                try { await withDeadline(Promise.resolve().then(() => browser.disconnect()), 5_000, "Disconnect late Discord connection"); }
                catch (error) {
                    console.error(`Late Discord connection cleanup failed; session outcome may be unknown: ${String(error)}`);
                    process.exitCode = 1;
                }
                throw new Error("Abandoned Discord connection completed late; it will not be used or replayed");
            });
            return await withDeadline(connection, Math.min(attemptTimeoutMs, Math.max(1, deadline - Date.now())), "Discord connection attempt");
        } catch (error) {
            abandoned = true;
            lastError = error;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs > 0) await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(retryDelayMs, remainingMs)));
    }
    throw lastError;
}

async function main() {
    const identity = readTestIdentity();
    const TEST_CHANNEL_ID = identity.channelId;
    const EXPECTED_RECIPIENT_ID = identity.recipientId;
    const token = `mcp-live-${Date.now()}-${Math.random()}`;
    const browser = await connectWithRetry();
    let mcp: ChildProcessWithoutNullStreams | undefined;
    let sentMessageId: string | undefined;
    let subscriptionId: string | undefined;
    let callTool: ((name: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<any>) | undefined;
    let page: Page | undefined;
    let disposeRpc = () => {};
    let deleteAttempted = false;
    let pendingSend = false;
    let marker: string | undefined;

    try {
        const pages = await browser.pages();
        page = pages.find(candidate => /^https:\/\/(?:canary\.|ptb\.)?discord\.com\/channels(?:\/|$)/u.test(candidate.url()));
        assert.ok(page, "No Discord channel page is attached; refusing to use an arbitrary browser tab");
        await page.waitForFunction(() => Boolean((globalThis as any).Vencord?.Plugins?.plugins), { timeout: 30_000 });

        const pluginState = await withDeadline(page.evaluate(manageTestPlugin, { identity, token, phase: "activate" as const }), 10_000, "Plugin activation");
        assert.ok(pluginState);

        assert.equal(pluginState.enabled, true, "DiscordMCP is enabled in persisted ProtonnCord settings");
        assert.equal(pluginState.pluginStarted, true, "DiscordMCP started in the renderer");
        assert.equal(pluginState.legacyAllowlistRemoved, true, "the obsolete channel allowlist setting was removed");
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
        const routeBefore = new URL(page.url()).pathname;

        mcp = spawn(process.execPath, [resolve("tools/discord-mcp/server.mjs")], {
            cwd: resolve("."),
            env: { ...process.env, PROTONN_CORD_DISCORD_MCP_DIR: pluginState.queueDirectory },
            stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;

        const lastToolContent = new Map<string, any[]>();
        let stderr = "";
        mcp.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-65_536); });
        const client = createRpcClient(mcp);
        const { rpc } = client;
        disposeRpc = client.dispose;
        callTool = async (name, args = {}, timeoutMs = 45_000) => {
            await withDeadline(page!.evaluate(manageTestPlugin, { identity, token, phase: "verify" as const }), Math.min(timeoutMs, 5_000), "Account/destination verification");
            const result = await rpc("tools/call", { name, arguments: args }, timeoutMs);
            if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
            lastToolContent.set(name, result.content ?? []);
            return result.structuredContent;
        };

        const initialized = await rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "ProtonnCord live test", version: "1" },
        });
        assert.equal(initialized.serverInfo.name, "discord-mcp");
        const toolList = await rpc("tools/list");
        assert.equal(toolList.tools.length, 22, "all scoped tools are exposed over stdio MCP");

        const status = await callTool("discord_connection_status");
        assert.equal(status.connected, true);
        assert.equal(status.channelAccess, "all_accessible_channels");
        assert.equal(status.capabilities.allAccessibleChannels, true);
        assert.equal(status.capabilities.changesActiveView, false);
        assert.equal(status.capabilities.silentBackground, true);
        assert.equal(status.capabilities.subscriptions, true);
        assert.equal(status.capabilities.messageSearch, true);
        assert.equal(status.capabilities.serverFolders, true);
        assert.equal(status.capabilities.serverActivity, true);
        assert.equal(status.capabilities.membershipChanges, false);
        assert.equal(status.capabilities.relationshipChanges, false);
        assert.equal(status.capabilities.blocking, false);
        assert.equal(status.capabilities.arbitraryRequests, false);

        const servers = await callTool("discord_list_servers");
        assert.ok(Array.isArray(servers) && servers.length > 0, "server listing returns the live account's servers");
        const folders = await callTool("discord_list_server_folders");
        assert.ok(Array.isArray(folders.entries), "folder listing returns the live server bar");
        const activity = await callTool("discord_list_server_activity", { days: 30 });
        assert.equal(activity.servers.length, servers.length, "activity includes every visible server");
        assert.ok(["live", "saved_only", "none"].includes(activity.coverage));
        const serverChannels = await callTool("discord_list_server_channels", { guild_id: servers[0].id });
        assert.ok(Array.isArray(serverChannels), "server channel listing succeeds");

        const dms = await callTool("discord_list_dms");
        const testDm = dms.find((channel: any) => channel.id === TEST_CHANNEL_ID);
        const otherDm = dms.find((channel: any) => channel.id !== TEST_CHANNEL_ID);
        assert.ok(testDm, "test DM is present in the DM listing");
        assert.ok(
            testDm.recipients.some((recipient: any) => recipient?.id === EXPECTED_RECIPIENT_ID),
            "test channel belongs to the supplied testing user"
        );

        const messages = await callTool("discord_read_messages", { channel_id: TEST_CHANNEL_ID, limit: 100 });
        assert.ok(Array.isArray(messages) && messages.length > 0, "message reads return live messages");
        const bulkMessages = await callTool("discord_bulk_read_messages", {
            channel_ids: [TEST_CHANNEL_ID, ...(otherDm ? [otherDm.id] : [])],
            limit_per_channel: 10,
        });
        assert.equal(bulkMessages.channels[0].channelId, TEST_CHANNEL_ID);
        assert.equal(bulkMessages.channels.length, otherDm ? 2 : 1, "bulk reads accept every visible channel supplied");
        assert.ok(bulkMessages.totalMessages > 0, "bulk message reads return live messages");
        assert.ok(
            messages.some((message: any) => message.author?.id === EXPECTED_RECIPIENT_ID),
            "received messages from the supplied testing user are readable"
        );
        const routeBeforeChannelSearch = new URL(page.url()).pathname;
        const searchStartedAt = performance.now();
        const searchResults = await callTool("discord_search_messages", {
            channel_id: TEST_CHANNEL_ID,
            author_id: EXPECTED_RECIPIENT_ID,
            sort_order: "desc",
            limit: 5,
        });
        const searchLatencyMs = Math.round(performance.now() - searchStartedAt);
        assert.equal(searchResults.scope.type, "channel", "search stays scoped to the requested DM");
        assert.ok(searchResults.resultCount > 0, "headless search returns live indexed messages");
        assert.ok(
            searchResults.messages.every((message: any) => message.author?.id === EXPECTED_RECIPIENT_ID),
            "Discord applies the requested author filter"
        );
        assert.equal(new URL(page.url()).pathname, routeBeforeChannelSearch, "headless search does not navigate or open Discord search UI");

        const routeBeforeServerSearch = new URL(page.url()).pathname;
        let serverSearchProof: { guildId: string; resultCount: number; } | undefined;
        for (const server of servers.slice(0, 3)) {
            const channels = server.id === servers[0].id
                ? serverChannels
                : await callTool("discord_list_server_channels", { guild_id: server.id });
            for (const channel of channels.filter((candidate: any) => [0, 5, 10, 11, 12].includes(candidate.type)).slice(0, 5)) {
                const sample = await callTool("discord_read_messages", { channel_id: channel.id, limit: 1 })
                    .catch(() => []);
                const authorId = sample[0]?.author?.id;
                if (!authorId) continue;
                const serverSearch = await callTool("discord_search_messages", {
                    guild_id: server.id,
                    author_id: authorId,
                    sort_order: "desc",
                    limit: 1,
                }).catch(() => null);
                if (!serverSearch?.resultCount) continue;
                assert.equal(serverSearch.scope.type, "guild");
                assert.equal(serverSearch.messages[0].guildId, server.id);
                serverSearchProof = { guildId: server.id, resultCount: serverSearch.resultCount };
                break;
            }
            if (serverSearchProof) break;
        }
        assert.ok(serverSearchProof, "server-wide headless search returns a live indexed message");
        assert.equal(new URL(page.url()).pathname, routeBeforeServerSearch, "server-wide search also leaves Discord's route unchanged");
        const newest = messages[0];
        const voiceMessage = messages.find((message: any) => message.isVoiceMessage);
        assert.ok(voiceMessage, "the test-channel sample contains a voice-message fixture");
        const voiceAttachment = voiceMessage.attachments[0];
        assert.equal(typeof voiceAttachment.durationSeconds, "number", "voice duration is populated");
        assert.ok(voiceAttachment.durationSeconds > 0, "voice duration is positive");
        assert.ok(
            voiceAttachment.waveform === null || typeof voiceAttachment.waveform === "string",
            "the message list reports Discord's waveform without guessing when the API omits it"
        );

        const fetched = await callTool("discord_get_message", {
            channel_id: TEST_CHANNEL_ID,
            message_id: voiceMessage.id,
        });
        assert.equal(fetched.id, voiceMessage.id, "single-message lookup matches the list result");
        assert.equal(typeof fetched.attachments[0].waveform, "string", "single-message lookup populates a generated voice waveform");
        assert.ok(fetched.attachments[0].waveform.length > 0, "generated voice waveform is non-empty");
        assert.equal(fetched.attachments[0].waveformSource, "generated");

        const downloaded = await callTool("discord_download_attachment", {
            channel_id: TEST_CHANNEL_ID,
            message_id: voiceMessage.id,
            attachment_id: voiceAttachment.id,
        });
        assert.ok(downloaded.download.size > 0, "voice attachment bytes were downloaded");
        assert.match(downloaded.download.sha256, /^[a-f0-9]{64}$/, "download returns a content hash");
        assert.equal(typeof downloaded.attachment.waveform, "string", "download returns a populated voice waveform");
        assert.ok(downloaded.attachment.waveform.length > 0, "downloaded voice waveform is non-empty");
        const audioBlock = lastToolContent.get("discord_download_attachment")?.find(block => block.type === "audio");
        assert.ok(audioBlock, "voice downloads include a native MCP audio content block");
        assert.equal(audioBlock.mimeType, "audio/mp4", "mislabelled Discord MP4 voice media receives an audio MIME type");
        assert.ok(audioBlock.data.length > downloaded.download.size, "the MCP audio block contains base64 media bytes");
        await access(downloaded.download.path);
        const savedBytes = await readFile(downloaded.download.path);
        assert.equal(savedBytes.byteLength, downloaded.download.size);
        assert.equal(createHash("sha256").update(savedBytes).digest("hex"), downloaded.download.sha256);

        if (otherDm) {
            const otherMessages = await callTool("discord_read_messages", { channel_id: otherDm.id, limit: 1 });
            assert.ok(Array.isArray(otherMessages), "a second visible DM can be read without an allowlist");
        }

        const preexistingDelete = await callTool("discord_delete_own_message", {
            channel_id: TEST_CHANNEL_ID,
            message_id: newest.id,
        }).then(() => null, error => error as Error);
        assert.match(preexistingDelete!.message, /not sent by Discord MCP/, "pre-existing messages cannot be deleted");

        const subscription = await callTool("discord_subscribe_channel", { channel_id: TEST_CHANNEL_ID });
        subscriptionId = subscription.id;
        const activeSubscriptions = await callTool("discord_list_subscriptions");
        assert.ok(activeSubscriptions.some((entry: any) => entry.id === subscriptionId), "the channel subscription is active");

        const waitForMessage = callTool("discord_wait_for_message", {
            subscription_id: subscriptionId,
            timeout_seconds: 15,
        });
        void waitForMessage.catch(() => undefined);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 250));

        marker = `Discord MCP live verification ${new Date().toISOString()}`;
        pendingSend = true;
        const sent = await callTool("discord_send_message", { channel_id: TEST_CHANNEL_ID, content: marker });
        assert.match(sent?.id ?? "", /^\d{17,20}$/u, "Send result must identify the created message; otherwise its outcome remains unknown");
        sentMessageId = sent.id;
        pendingSend = false;
        assert.equal(sent.content, marker, "send returns the exact live message");

        const subscriptionEvent = await waitForMessage;
        assert.equal(subscriptionEvent.timedOut, false, "subscription wait resolves before its timeout");
        assert.equal(subscriptionEvent.cancelled, false);
        assert.equal(subscriptionEvent.message.id, sentMessageId, "subscription delivered the newly created message");
        assert.equal(subscriptionEvent.message.content, marker);

        const unsubscribed = await callTool("discord_unsubscribe_channel", { subscription_id: subscriptionId });
        assert.equal(unsubscribed.unsubscribed, true);
        subscriptionId = undefined;

        const sentLookup = await callTool("discord_get_message", {
            channel_id: TEST_CHANNEL_ID,
            message_id: sentMessageId,
        });
        assert.equal(sentLookup.content, marker, "the sent message can be read back");

        deleteAttempted = true;
        const deleted = await callTool("discord_delete_own_message", {
            channel_id: TEST_CHANNEL_ID,
            message_id: sentMessageId,
        });
        assert.equal(deleted.deleted, true, "the bridge can delete its own sent message");
        sentMessageId = undefined;

        const repeatedDelete = await callTool("discord_delete_own_message", {
            channel_id: TEST_CHANNEL_ID,
            message_id: sent.id,
        }).then(() => null, error => error as Error);
        assert.match(repeatedDelete!.message, /not sent by Discord MCP/, "the ledger entry is removed after deletion");
        assert.equal(new URL(page.url()).pathname, routeBefore, "MCP activity does not navigate or replace the active Discord view");

        assert.equal(stderr, "", "the stdio server emitted no unexpected diagnostics");
        console.log(JSON.stringify({
            attachmentDownload: { contentType: downloaded.download.contentType, sha256Verified: true, size: downloaded.download.size },
            allChannelAccessVerified: Boolean(otherDm),
            bulkReadVerified: true,
            deletionBoundaryVerified: true,
            dmCount: dms.length,
            messageCountSampled: messages.length,
            messageSearchVerified: { latencyMs: searchLatencyMs, resultCount: searchResults.resultCount },
            serverWideSearchVerified: serverSearchProof,
            pluginEnabled: pluginState.enabled,
            receivedMessagesReadable: true,
            silentRouteVerified: true,
            serverChannelToolVerified: true,
            serverCount: servers.length,
            stdioToolsVerified: toolList.tools.length,
            subscriptionWaitVerified: true,
            voiceMetadata: { durationSeconds: voiceAttachment.durationSeconds, waveformCharacters: fetched.attachments[0].waveform.length },
            voiceFixtureDirection: voiceMessage.author?.id === EXPECTED_RECIPIENT_ID ? "received" : "outgoing",
        }, null, 2));
    } finally {
        await cleanupLiveTest({
            channelId: TEST_CHANNEL_ID, subscriptionId, sentMessageId, deleteAttempted, pendingSend, marker, callTool,
            restore: () => page ? page.evaluate(manageTestPlugin, { identity, token, phase: "restore" as const }) : Promise.resolve(),
            dispose: disposeRpc,
            kill: () => {
                if (mcp && mcp.exitCode === null && mcp.signalCode === null && !mcp.kill())
                    throw new Error("Test-owned MCP child termination was not confirmed; inspect the process manually");
            },
            disconnect: async () => { await browser.disconnect(); },
            warn: message => { console.error(message); process.exitCode = 1; },
        });
    }
}

void main();
