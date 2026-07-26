# Discord MCP

This local stdio MCP server talks to the `DiscordMCP` ProtonnCord plugin through a private file queue. Discord remains the only process that accesses the authenticated account.

## Safety boundary

- Message reads, attachment downloads, sends, deletes, and navigation require a channel ID present in the plugin allowlist.
- The server has no generic REST request, membership, relationship, block, role, or moderation tool.
- Sends disable parsed mentions. Replies do not ping.
- Deletes require both the bridge's persistent sent ledger and confirmation that the authenticated account authored the message.
- Attachments are resolved from an allowlisted message, fetched only from Discord's attachment CDN, capped at 25 MB, and hashed. Images and voice messages are also returned as native MCP image/audio content blocks so sandboxed agents can consume them directly.

## Run

Enable `DiscordMCP` in ProtonnCord and keep Discord running, then configure an MCP client to run:

```text
node D:\Development\protonn-cord\ProtonnCord\tools\discord-mcp\server.mjs
```

For isolated testing, `PROTONN_CORD_DISCORD_MCP_DIR` may point at a temporary bridge directory.
