# Discord MCP

This local stdio MCP server talks to the `DiscordMCP` ProtonnCord plugin through a private file queue. Discord remains the only process that accesses the authenticated account.

## Safety boundary

- Message reads, attachment downloads, sends, deletes, and bulk reads may use any channel visible to the authenticated Discord account.
- The server has no generic REST request, membership, relationship, block, role, or moderation tool.
- Sends disable parsed mentions. Replies do not ping.
- Deletes require both the bridge's persistent sent ledger and confirmation that the authenticated account authored the message.
- Attachments are resolved from a message in a visible channel, fetched only from Discord's attachment CDN, capped at 25 MB, and hashed. Images and voice messages are also returned as native MCP image/audio content blocks so sandboxed agents can consume them directly.
- Idle operation uses an event-driven local file watcher instead of a frequent timer. Reads and downloads do not navigate Discord, display UI, or mark channels read; only explicit send/delete calls change Discord state.

## Run

Enable `DiscordMCP` in ProtonnCord and keep Discord running, then configure an MCP client to run:

```text
node D:\Development\protonn-cord\ProtonnCord\tools\discord-mcp\server.mjs
```

For isolated testing, `PROTONN_CORD_DISCORD_MCP_DIR` may point at a temporary bridge directory.
