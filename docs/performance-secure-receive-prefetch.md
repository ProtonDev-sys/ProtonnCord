# Receive-time encrypted-message prefetch

Secure Messaging can start authenticated decryption when the selected chat receives a decoded message event, without waiting for the message accessory's React effect. This is a scheduling optimization, not a new cipher or a synchronous wire-decryption path.

## Behavior

`MESSAGE_CREATE`, `MESSAGE_UPDATE`, and `LOAD_MESSAGES_SUCCESS` reuse the existing Flux handlers. Key-announcement review remains in place. Non-optimistic messages are eligible for prefetch only when the account matches the active Secure Messaging session, screen-capture protection is ready, and the chat-access gate permits access.

Prefetch is restricted to the selected non-guild channel. It resolves the current complete message from `MessageStore`, rather than treating a partial update payload as a complete message. Missing store records are skipped; normal rendering remains the fallback. This also makes receive and render requests use the same normalized author, edit timestamp, nonce, and attachment metadata in the existing cache key.

The receive handler never awaits decryption, changes Discord's message content, replaces the Gateway payload, or dispatches a plaintext message. Plaintext stays in the existing plugin cache and protected rendering path. There is no WebSocket, TLS, Gateway codec, or global dispatcher interception.

## Bounds and lifecycle

At most four speculative promises are admitted at once. Extra history rows are left to the existing render path rather than added to an unbounded prefetch queue. The existing shared task queue still limits native decryption concurrency to four.

Receive and render consumers share the same in-flight promise. Settled cache entries are not decrypted again. Clearing the decryption cache also clears speculative admission, and the existing cache generation prevents old results from repopulating a cleared cache. Receive-side grouping notifications check the operation generation, account, capture status, chat gate, and cache key before being issued.

Authentication, key trust, replay handling, retry policy, and the encryption protocol are unchanged. Ordinary encrypted files are not eagerly downloaded by this receive path. Detached message text still uses the existing text-only expansion path because it is needed to obtain the message text.

## Validation

Run the focused suite from a dependency-installed checkout:

```sh
pnpm exec tsx scripts/testSecureMessagingReceive.ts
```

The suite is also included in `pnpm testSecureMessagingPerformance`, which the repository's main test command already runs.

The focused tests exercise the production receive functions, decryption cache, metadata normalizer, and task queue. Native cryptography, attachment downloads, Discord stores, and chat/capture gates are mocked. Coverage includes immediate request admission, promise sharing, complete-store-record normalization, edits, optimistic events, history bounds, missing records, account transitions, cache invalidation, stale completion suppression, native rejection handling, blocked authentication statuses, and detached-text-only expansion.

Before merging, run the repository's type checks, lint, secure-messaging suites, and a desktop build, then verify create/edit/history events in a running Discord client. Compare receive-to-first-authenticated-render latency, including a cold history load and rapid channel switching. No live latency improvement or cryptographic speedup is claimed by the isolated tests.
