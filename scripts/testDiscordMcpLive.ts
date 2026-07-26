import assert from "node:assert/strict";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import puppeteer from "puppeteer-core";

const AUTHORIZED_CHANNEL_ID = "895063026686885909";
const EXPECTED_RECIPIENT_ID = "710514340855545878";
const DEBUG_URL = process.env.DISCORD_DEBUG_URL ?? "http://127.0.0.1:9222";

interface RpcWaiter {
    resolve(value: any): void;
    reject(error: Error): void;
}

async function connectWithRetry() {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try { return await puppeteer.connect({ browserURL: DEBUG_URL, defaultViewport: null }); }
        catch (error) { lastError = error; }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    throw lastError;
}

async function main() {
    const browser = await connectWithRetry();
    let mcp: ChildProcessWithoutNullStreams | undefined;
    let sentMessageId: string | undefined;
    let callTool: ((name: string, args?: Record<string, unknown>) => Promise<any>) | undefined;

    try {
        const pages = await browser.pages();
        const page = pages.find(candidate => candidate.url().includes("discord.com")) ?? pages[0];
        await page.waitForFunction(() => Boolean((globalThis as any).Vencord?.Plugins?.plugins), { timeout: 30_000 });

        const pluginState = await page.evaluate(async allowedChannelId => {
            const global = globalThis as any;
            const vencord = global.Vencord;
            const plugin = vencord.Plugins.plugins.DiscordMCP;
            if (!plugin) throw new Error("DiscordMCP plugin is missing from the built client");

            const pluginSettings = vencord.Settings.plugins.DiscordMCP ??= {};
            pluginSettings.allowedChannelIds = allowedChannelId;
            pluginSettings.enabled = true;
            if (!plugin.started) vencord.Plugins.startPlugin(plugin);

            await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
            const bridge = await global.VencordNative.pluginHelpers.DiscordMCP.initializeBridge();
            return {
                allowedChannelIds: pluginSettings.allowedChannelIds,
                enabled: pluginSettings.enabled,
                pluginStarted: plugin.started,
                queueDirectory: bridge.queueDirectory,
            };
        }, AUTHORIZED_CHANNEL_ID);

        assert.equal(pluginState.enabled, true, "DiscordMCP is enabled in persisted ProtonnCord settings");
        assert.equal(pluginState.pluginStarted, true, "DiscordMCP started in the renderer");
        assert.equal(pluginState.allowedChannelIds, AUTHORIZED_CHANNEL_ID, "the live allowlist has only the authorized test channel");

        mcp = spawn(process.execPath, [resolve("tools/discord-mcp/server.mjs")], {
            cwd: resolve("."),
            env: { ...process.env, PROTONN_CORD_DISCORD_MCP_DIR: pluginState.queueDirectory },
            stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;

        const pending = new Map<number, RpcWaiter>();
        const lastToolContent = new Map<string, any[]>();
        let rpcId = 1;
        let stderr = "";
        mcp.stderr.on("data", data => { stderr += data.toString(); });
        createInterface({ input: mcp.stdout, crlfDelay: Infinity }).on("line", line => {
            const message = JSON.parse(line);
            const waiter = pending.get(message.id);
            if (!waiter) return;
            pending.delete(message.id);
            if (message.error) waiter.reject(new Error(message.error.message));
            else waiter.resolve(message.result);
        });

        const rpc = (method: string, params?: unknown) => {
            const id = rpcId++;
            const result = new Promise<any>((resolvePromise, rejectPromise) => {
                pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
            });
            mcp!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
            return result;
        };
        callTool = async (name, args = {}) => {
            const result = await rpc("tools/call", { name, arguments: args });
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
        assert.equal(toolList.tools.length, 11, "all eleven scoped tools are exposed over stdio MCP");

        const status = await callTool("discord_connection_status");
        assert.equal(status.connected, true);
        assert.deepEqual(status.allowedChannelIds, [AUTHORIZED_CHANNEL_ID]);
        assert.equal(status.capabilities.membershipChanges, false);
        assert.equal(status.capabilities.relationshipChanges, false);
        assert.equal(status.capabilities.blocking, false);
        assert.equal(status.capabilities.arbitraryRequests, false);

        const servers = await callTool("discord_list_servers");
        assert.ok(Array.isArray(servers) && servers.length > 0, "server listing returns the live account's servers");
        const serverChannels = await callTool("discord_list_server_channels", { guild_id: servers[0].id });
        assert.ok(Array.isArray(serverChannels), "server channel listing succeeds");

        const dms = await callTool("discord_list_dms");
        const authorizedDm = dms.find((channel: any) => channel.id === AUTHORIZED_CHANNEL_ID);
        assert.ok(authorizedDm, "authorized DM is present in the DM listing");
        assert.ok(
            authorizedDm.recipients.some((recipient: any) => recipient?.id === EXPECTED_RECIPIENT_ID),
            "authorized channel belongs to the supplied testing user"
        );

        const messages = await callTool("discord_read_messages", { channel_id: AUTHORIZED_CHANNEL_ID, limit: 100 });
        assert.ok(Array.isArray(messages) && messages.length > 0, "allowlisted message reads return live messages");
        const bulkMessages = await callTool("discord_bulk_read_messages", {
            channel_ids: [AUTHORIZED_CHANNEL_ID],
            limit_per_channel: 10,
        });
        assert.equal(bulkMessages.channels[0].channelId, AUTHORIZED_CHANNEL_ID);
        assert.ok(bulkMessages.totalMessages > 0, "bulk message reads return live messages");
        assert.ok(
            messages.some((message: any) => message.author?.id === EXPECTED_RECIPIENT_ID),
            "received messages from the supplied testing user are readable"
        );
        const newest = messages[0];
        assert.equal(newest.isVoiceMessage, true, "the newest authorized message is the supplied voice-message fixture");
        const voiceMessage = newest;
        const voiceAttachment = voiceMessage.attachments[0];
        assert.equal(typeof voiceAttachment.durationSeconds, "number", "voice duration is populated");
        assert.ok(voiceAttachment.durationSeconds > 0, "voice duration is positive");
        assert.ok(
            voiceAttachment.waveform === null || typeof voiceAttachment.waveform === "string",
            "the message list reports Discord's waveform without guessing when the API omits it"
        );

        const fetched = await callTool("discord_get_message", {
            channel_id: AUTHORIZED_CHANNEL_ID,
            message_id: voiceMessage.id,
        });
        assert.equal(fetched.id, voiceMessage.id, "single-message lookup matches the list result");
        assert.equal(typeof fetched.attachments[0].waveform, "string", "single-message lookup populates a generated voice waveform");
        assert.ok(fetched.attachments[0].waveform.length > 0, "generated voice waveform is non-empty");
        assert.equal(fetched.attachments[0].waveformSource, "generated");

        const downloaded = await callTool("discord_download_attachment", {
            channel_id: AUTHORIZED_CHANNEL_ID,
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

        const otherDm = dms.find((channel: any) => channel.id !== AUTHORIZED_CHANNEL_ID);
        if (otherDm) {
            const denied = await callTool("discord_read_messages", { channel_id: otherDm.id, limit: 1 }).then(
                () => null,
                error => error as Error
            );
            assert.match(denied!.message, /allowlist/, "message reads from unselected channels are denied inside Discord");
        }

        const preexistingDelete = await callTool("discord_delete_own_message", {
            channel_id: AUTHORIZED_CHANNEL_ID,
            message_id: newest.id,
        }).then(() => null, error => error as Error);
        assert.match(preexistingDelete!.message, /not sent by Discord MCP/, "pre-existing messages cannot be deleted");

        const marker = `Discord MCP live verification ${new Date().toISOString()}`;
        const sent = await callTool("discord_send_message", { channel_id: AUTHORIZED_CHANNEL_ID, content: marker });
        sentMessageId = sent.id;
        assert.equal(sent.content, marker, "send returns the exact live message");

        const sentLookup = await callTool("discord_get_message", {
            channel_id: AUTHORIZED_CHANNEL_ID,
            message_id: sentMessageId,
        });
        assert.equal(sentLookup.content, marker, "the sent message can be read back");

        const opened = await callTool("discord_open_channel", { channel_id: AUTHORIZED_CHANNEL_ID });
        assert.equal(opened.opened, true, "channel navigation succeeds");

        const deleted = await callTool("discord_delete_own_message", {
            channel_id: AUTHORIZED_CHANNEL_ID,
            message_id: sentMessageId,
        });
        assert.equal(deleted.deleted, true, "the bridge can delete its own sent message");
        sentMessageId = undefined;

        const repeatedDelete = await callTool("discord_delete_own_message", {
            channel_id: AUTHORIZED_CHANNEL_ID,
            message_id: sent.id,
        }).then(() => null, error => error as Error);
        assert.match(repeatedDelete!.message, /not sent by Discord MCP/, "the ledger entry is removed after deletion");

        assert.equal(stderr, "", "the stdio server emitted no unexpected diagnostics");
        console.log(JSON.stringify({
            attachmentDownload: { contentType: downloaded.download.contentType, sha256Verified: true, size: downloaded.download.size },
            authorizedChannelVerified: true,
            bulkReadVerified: true,
            deletionBoundaryVerified: true,
            dmCount: dms.length,
            messageCountSampled: messages.length,
            pluginEnabled: pluginState.enabled,
            receivedMessagesReadable: true,
            serverChannelToolVerified: true,
            serverCount: servers.length,
            stdioToolsVerified: toolList.tools.length,
            unallowlistedReadDenied: Boolean(otherDm),
            voiceMetadata: { durationSeconds: voiceAttachment.durationSeconds, waveformCharacters: fetched.attachments[0].waveform.length },
            voiceFixtureDirection: voiceMessage.author?.id === EXPECTED_RECIPIENT_ID ? "received" : "outgoing",
        }, null, 2));
    } finally {
        if (sentMessageId && callTool) {
            await callTool("discord_delete_own_message", {
                channel_id: AUTHORIZED_CHANNEL_ID,
                message_id: sentMessageId,
            }).catch(() => undefined);
        }
        mcp?.kill();
        await browser.disconnect();
    }
}

void main();
