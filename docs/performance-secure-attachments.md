# Encrypted attachment transfers, 4 September 2026

The native attachment fixture compares the same encrypted PNG, 256 KiB ZIP, and 1 MiB inert file named `.exe`. It runs the real native helper with synthetic identities, a disposable vault, and a mocked CDN that counts returned ciphertext bytes. No real messages, accounts, or executable programs are used.

| Opening the message | Before: complete bundle | After: previews only |
| --- | ---: | ---: |
| Requests | 3 | 1 |
| Ciphertext bytes transferred | 1,311,208 | 195 |
| Deferred ciphertext bytes | 0 | 1,311,013 |

The image is fetched and authenticated for its preview. Clicking the ZIP or EXE download control then fetches only that selected file and saves its exact authenticated bytes and original filename. A subsequent download can use the native authenticated cache without another request. Concurrent clicks share one active save in the renderer.

A second fixture places detached message text between two ordinary files. Reconstructing that text takes one request and 7,679 ciphertext bytes; neither ordinary file is fetched. A renderer fixture also verifies that a deferred 300 MiB ZIP does not consume the 256 MiB preview cache reservation beside a small image.

Expired CDN URLs previously added a request even when no attachment bytes were needed. The renderer fixture compares actual source from `3cebbfa41` with the current implementation, holding any refresh response pending:

| Opening an opaque legacy file message | Before | After |
| --- | ---: | ---: |
| URL-refresh REST requests | 1 | 0 |
| Attachment rows while refresh is pending | Loading | Ready |

Messages with manifests and only deferred files likewise require no URL refresh. Media previews and detached text refresh only their selected URLs; explicit downloads with manifests refresh only the clicked file. Legacy explicit downloads and detached-text expansion retain refreshes for the complete bundle. Every native input still includes all attachment references in their original order.

Run the expired-URL and refresh-selection checks:

```powershell
pnpm exec tsx --test --test-name-pattern 'expired URL refreshes|preview refresh|explicit downloads|detached text limits refresh' scripts/testSecureMessagingAttachmentCache.ts scripts/testSecureMessagingCaches.ts
```

Run the native transfer and authentication checks:

```powershell
pnpm testSecureMessagingNative
```

Run the manifest, upload metadata, cache, envelope fallback, and native download-control regressions:

```powershell
pnpm testSecureMessagingAttachments
```

These are deterministic transfer counts, not elapsed network time, browser responsiveness, or FPS measurements. The same suite rejects incorrect digests, roots, metadata, and AEAD tags without saving. New manifest formats require updated recipients; older opaque bundles remain manual downloads and retain complete-bundle authentication. Older detached text also requires its complete bundle. See the plugin README for format and envelope-budget compatibility.
