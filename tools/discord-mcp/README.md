# Discord MCP

This local stdio MCP server talks to ProtonnCord's `DiscordMCP` plugin through a private file queue. Discord remains the process that accesses the authenticated account. Enable the plugin and keep Discord running, then configure an MCP client to run `node tools/discord-mcp/server.mjs` from this checkout (or use its absolute path).

The tool list is fixed. It offers server and channel metadata, scoped message reads and searches, subscriptions, attachment downloads, plain-text sends without parsed mentions, and deletion only of messages recorded as sent by this bridge. It has no generic REST, membership, role, relationship, or moderation operation.

## Organizing servers

Call `discord_list_server_folders` and `discord_list_server_activity` first. Folder IDs are strings. Create a folder with `discord_create_server_folder` and at least one server, then pass its ID to `discord_move_servers`; pass `null` as `folder_id` to unfile servers. Discord removes a folder when its last server moves out. `discord_rename_server_folder` changes its name. `discord_reorder_server_folder` uses the zero-based visible positions from the listing, so the final position places a folder at the bottom. `discord_delete_server_folder` preserves every server as an unfiled entry at the deleted folder's position. Folder changes use Discord's own user-settings action.

The activity tool reports ServerReview visit and emoji, sticker, and soundboard history. It classifies unused servers only while ServerReview tracking is active. Saved history without active tracking is labelled `saved_only`, and missing history is labelled `none`; both return `unknown` classifications.

Both the stdio server and ProtonnCord plugin must be updated. A working local bridge does not repair an unrelated MCP client's tunnel or plugin registration; check that connection separately with `discord_connection_status`.

Stopping the plugin cancels requests it has claimed but not started. Started operations finish with their actual result; failed local response writes retain that result for retry without repeating the operation. After a process interruption, an unacknowledged claim reports an unknown outcome and is never replayed automatically. Check for completed side effects before retrying it.

`discord_send_message` keeps the returned message fields and succeeds after a confirmed send even if local deletion tracking fails to save. In that case, `trackingWarning` explains that tracking is retried during polling or plugin restart without sending again. Until it is saved, tracking survives only in the running process; quitting Discord can leave `discord_delete_own_message` unable to authorize deletion. Do not resend a confirmed message to repair tracking.

`discord_delete_own_message` likewise preserves `deleted: true` after a confirmed deletion if tracking fails to save. Its optional `trackingWarning` reports that only local tracking will be retried; the Discord deletion must not be repeated.

For isolated testing, `PROTONN_CORD_DISCORD_MCP_DIR` may point at a temporary bridge directory.
