# Discord MCP

This stdio server connects an MCP client to Protonn Cord's `DiscordMCP` plugin through a private file queue. Discord handles authenticated account requests; returned messages and files become available to the connected MCP client.

Enable `DiscordMCP` in Protonn Cord and keep Discord running, then configure an MCP client to run:

```text
node tools/discord-mcp/server.mjs
```

Run from the checkout or configure the client with an absolute script path. Enabling the plugin grants access to its supported operations across **all channels visible to the signed-in account**.

The tools list servers, channels and DMs; read individual messages or batches; search channels and servers; download attachments; send messages; and manage channel subscriptions. Search supports text, author, mention, media, pinned, message-boundary, sorting and pagination filters.

- Sends disable parsed mentions, and replies do not ping.
- Deletes require the bridge's persistent sent ledger and confirmation that the signed-in account authored the message.
- Downloads must come from a visible message and Discord's attachment CDN. Each is capped at 25 MiB and hashed; images and voice messages also include MCP image/audio content blocks.
- Reads, searches and downloads leave the active view and channel read state unchanged. There are no generic REST, membership, relationship, blocking, role or moderation tools.
- Subscriptions use Discord's `MESSAGE_CREATE` events without REST polling. The bridge allows 100 subscriptions, buffers 100 messages per subscription and supports waits of up to five minutes.

The queue uses a local file watcher while idle. Cancellation notifications are currently ignored: canceling a client request does not guarantee that an already submitted operation stops. Explicitly unsubscribing cancels that subscription's current wait.

For isolated tests, set `PROTONN_CORD_DISCORD_MCP_DIR` to a temporary bridge directory. An explicit directory is exclusive: missing or invalid configuration fails without falling back to another profile.
