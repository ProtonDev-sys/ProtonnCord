import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
    canDeleteRecordedMessage,
    DISCORD_MCP_TOOL_NAMES,
    isDiscordSnowflake,
    normalizeMessageContent,
    normalizeMessageLimit,
    normalizeFolderName,
    normalizeGuildIds,
    normalizeSearchHas,
    normalizeSearchOffset,
    normalizeSearchQuery,
    normalizeSearchSortOrder,
    requireSnowflake,
    requireFolderId,
    sentMessageKey,
} from "../src/equicordplugins/discordMcp.desktop/policy";
import { deleteFolder, moveServers, reorderFolder, withField } from "../src/equicordplugins/discordMcp.desktop/folders";

assert.equal(isDiscordSnowflake("895063026686885909"), true);
assert.equal(isDiscordSnowflake("invalid"), false);
assert.equal(requireSnowflake("895063026686885909", "channel_id"), "895063026686885909");
assert.throws(() => requireSnowflake("invalid", "channel_id"), /snowflake/);
assert.equal(normalizeMessageLimit(undefined), 50);
assert.equal(normalizeMessageLimit(100), 100);
assert.throws(() => normalizeMessageLimit(101), /1 to 100/);
assert.equal(normalizeMessageContent("hello"), "hello");
assert.throws(() => normalizeMessageContent("  "), /non-empty/);
assert.throws(() => normalizeMessageContent("x".repeat(2001)), /2,000/);
assert.equal(normalizeSearchQuery("  release notes  "), "release notes");
assert.equal(normalizeSearchQuery(undefined), undefined);
assert.throws(() => normalizeSearchQuery(" "), /non-empty/);
assert.throws(() => normalizeSearchQuery("x".repeat(1025)), /1,024/);
assert.equal(normalizeSearchOffset(undefined), 0);
assert.equal(normalizeSearchOffset(5_000), 5_000);
assert.throws(() => normalizeSearchOffset(5_001), /0 to 5,000/);
assert.deepEqual(normalizeSearchHas(["image", "file", "image"]), ["image", "file"]);
assert.throws(() => normalizeSearchHas(["anything"]), /unsupported/);
assert.equal(normalizeSearchSortOrder(undefined), "desc");
assert.equal(normalizeSearchSortOrder("asc"), "asc");
assert.throws(() => normalizeSearchSortOrder("relevance"), /asc or desc/);
assert.equal(normalizeFolderName("  Games  "), "Games");
assert.throws(() => normalizeFolderName(" "), /1 to 100/);
assert.equal(requireFolderId("42"), "42");
assert.throws(() => requireFolderId("0"), /positive/);
assert.deepEqual(normalizeGuildIds(["895063026686885909"]), ["895063026686885909"]);
assert.throws(() => normalizeGuildIds([]), /1 to 1000/);
assert.throws(() => normalizeGuildIds(["895063026686885909", "895063026686885909"]), /duplicates/);

const folderWithMetadata = { id: { value: "42" }, name: { value: "Games" }, color: { value: 12 }, guildIds: ["1", "2"] };
const unknownField = Symbol("protobuf metadata");
Object.defineProperty(folderWithMetadata, unknownField, { value: "preserved", enumerable: false });
const layout = [{ guildIds: ["3"] }, folderWithMetadata, { guildIds: ["4"] }];
const moved = moveServers(layout, ["3"], "42");
assert.deepEqual(moved.map(folder => folder.guildIds), [["1", "2", "3"], ["4"]]);
assert.equal(Reflect.get(moved[0], unknownField), "preserved");
assert.deepEqual(layout[1].guildIds, ["1", "2"], "the source layout is not mutated");
const unfiled = moveServers(moved, ["1", "2", "3"], null);
assert.deepEqual(unfiled.map(folder => folder.guildIds), [["4"], ["1"], ["2"], ["3"]], "moving the last servers removes the empty folder");
assert.deepEqual(moveServers(moved, ["1"], null, id => ({ guildIds: [id], proto: true } as any)).at(-1), { guildIds: ["1"], proto: true });
assert.deepEqual(deleteFolder(moved, "42").map(folder => folder.guildIds), [["1"], ["2"], ["3"], ["4"]]);
assert.deepEqual(reorderFolder(layout, "42", 2, ["g:3", "f:42", "g:4"]).map(folder => folder.guildIds), [["3"], ["4"], ["1", "2"]]);
assert.deepEqual(reorderFolder([{ guildIds: ["hidden"] }, ...layout], "42", 2, ["g:3", "f:42", "g:4"]).map(folder => folder.guildIds), [["hidden"], ["3"], ["4"], ["1", "2"]], "hidden stored entries do not shift visible positions");
assert.equal(Reflect.get(withField(folderWithMetadata, "name", { value: "Renamed" }), unknownField), "preserved");

const sent = new Set([sentMessageKey("895063026686885909", "123456789012345678")]);
assert.equal(canDeleteRecordedMessage(sent, "895063026686885909", "123456789012345678"), true);
assert.equal(canDeleteRecordedMessage(sent, "895063026686885909", "999999999999999999"), false, "unrecorded messages cannot be deleted");

async function main() {
const bridgeDirectory = await mkdtemp(join(tmpdir(), "discord-mcp-test-"));
assert.equal(dirname(resolve(bridgeDirectory)), resolve(tmpdir()), "cleanup must stay in the test temporary directory");
const requestsDirectory = join(bridgeDirectory, "requests");
const responsesDirectory = join(bridgeDirectory, "responses");
const fakeImagePath = join(bridgeDirectory, "test-image.png");
const fakeImage = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const secret = randomBytes(32).toString("base64url");
await Promise.all([mkdir(requestsDirectory), mkdir(responsesDirectory)]);
await writeFile(join(bridgeDirectory, "config.json"), JSON.stringify({ schemaVersion: 1, secret }));
await writeFile(fakeImagePath, fakeImage);

const child = spawn(process.execPath, [resolve("tools/discord-mcp/server.mjs")], {
    cwd: resolve("."),
    env: { ...process.env, PROTONN_CORD_DISCORD_MCP_DIR: bridgeDirectory },
    stdio: ["pipe", "pipe", "pipe"],
}) as ChildProcessWithoutNullStreams;

let nextRpcId = 1;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; }>();
const childClosed = new Promise<void>(resolvePromise => child.once("close", () => resolvePromise()));
const rejectPending = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
};
child.on("error", rejectPending);
child.on("exit", code => rejectPending(new Error(`Fixture server exited with code ${code}`)));
const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
stdout.on("line", line => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
});

function rpc(method: string, params?: unknown): Promise<any> {
    const id = nextRpcId++;
    return new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            rejectPromise(new Error(`Fixture request timed out: ${method}`));
        }, 10_000);
        pending.set(id, {
            resolve(value) { clearTimeout(timeout); resolvePromise(value); },
            reject(error) { clearTimeout(timeout); rejectPromise(error); },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
}

let workerRunning = true;
let folderCapabilities = true;
const observedRequests: any[] = [];
const fakeWorker = (async () => {
    while (workerRunning) {
        for (const name of await readdir(requestsDirectory)) {
            if (!name.endsWith(".json")) continue;
            const path = join(requestsDirectory, name);
            const claimed = `${path}.claimed`;
            try {
                await rename(path, claimed);
                const request = JSON.parse(await readFile(claimed, "utf8"));
                observedRequests.push(request);
                assert.equal(request.secret, secret, "queue requests authenticate with the private bridge secret");
                const result = request.tool === "connection_status"
                    ? { connected: true, channelAccess: "all_accessible_channels", capabilities: { serverFolders: folderCapabilities, serverActivity: folderCapabilities } }
                    : request.tool === "download_attachment"
                        ? {
                            attachment: { filename: "test-image.png", contentType: "image/png" },
                            download: { path: fakeImagePath, contentType: "image/png", size: fakeImage.byteLength },
                        }
                        : { echoedTool: request.tool };
                const response = {
                    id: request.id,
                    ok: true,
                    result,
                };
                await writeFile(join(responsesDirectory, `${request.id}.json`), JSON.stringify(response));
            } catch (error: any) {
                if (error?.code !== "ENOENT") throw error;
            } finally {
                await rm(claimed, { force: true });
            }
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
})();

try {
    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(initialized.serverInfo.name, "discord-mcp");

    const listed = await rpc("tools/list");
    const names = listed.tools.map((tool: any) => tool.name);
    assert.deepEqual(names, DISCORD_MCP_TOOL_NAMES.map(name => `discord_${name}`), "all fixed Discord tools are advertised");
    assert.equal(names.some((name: string) => /member|friend|relationship|block|role|moder|request|rest/i.test(name)), false, "no user-management, moderation, or arbitrary request tool exists");
    for (const tool of listed.tools) assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects unknown arguments`);
    const searchTool = listed.tools.find((tool: any) => tool.name === "discord_search_messages");
    assert.ok(searchTool, "headless message search is exposed");
    assert.deepEqual(searchTool.inputSchema.anyOf, [{ required: ["channel_id"] }, { required: ["guild_id"] }]);
    const moveTool = listed.tools.find((tool: any) => tool.name === "discord_move_servers");
    assert.deepEqual(moveTool.inputSchema.required, ["guild_ids", "folder_id"]);
    const createFolderTool = listed.tools.find((tool: any) => tool.name === "discord_create_server_folder");
    assert.deepEqual(createFolderTool.inputSchema.required, ["name", "guild_ids"]);
    assert.ok(listed.tools.some((tool: any) => tool.name === "discord_list_server_activity"));

    const status = await rpc("tools/call", { name: "discord_connection_status", arguments: {} });
    assert.equal(status.structuredContent.connected, true);
    assert.equal(status.structuredContent.channelAccess, "all_accessible_channels");
    assert.equal(observedRequests[0].tool, "connection_status", "public tool names map to the fixed bridge operation");
    const folders = await rpc("tools/call", { name: "discord_list_server_folders", arguments: {} });
    assert.equal(folders.structuredContent.echoedTool, "list_server_folders");
    const move = await rpc("tools/call", { name: "discord_move_servers", arguments: { guild_ids: ["895063026686885909"], folder_id: null } });
    assert.equal(move.structuredContent.echoedTool, "move_servers");
    folderCapabilities = false;
    const stale = await rpc("tools/call", { name: "discord_list_server_activity", arguments: {} });
    assert.equal(stale.isError, true, "an older running plugin fails clearly before an unsupported bridge request");
    assert.match(stale.content[0].text, /older than this MCP server/);
    folderCapabilities = true;

    const imageDownload = await rpc("tools/call", {
        name: "discord_download_attachment",
        arguments: {
            channel_id: "895063026686885909",
            message_id: "123456789012345678",
            attachment_id: "234567890123456789",
        },
    });
    const imageBlock = imageDownload.content.find((block: any) => block.type === "image");
    assert.ok(imageBlock, "image downloads are delivered as native MCP image content");
    assert.equal(imageBlock.mimeType, "image/png");
    assert.equal(Buffer.from(imageBlock.data, "base64").byteLength, fakeImage.byteLength);

    const unknown = await rpc("tools/call", { name: "discord_arbitrary_request", arguments: {} }).then(
        () => null,
        error => error
    );
    assert.match(unknown.message, /Unknown tool/);
} finally {
    workerRunning = false;
    child.kill();
    await childClosed;
    stdout.close();
    await fakeWorker;
    await rm(bridgeDirectory, { force: true, recursive: true });
}

console.log("discord-mcp policy and protocol checks passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
