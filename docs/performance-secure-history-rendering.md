# Secure history markdown work, 4 September 2026

Grouping updates rerender the encrypted accessories in a channel. Previously, each rerender parsed unchanged visible plaintext again. The accessory now memoizes that parsed output until the visible text changes or becomes hidden. Authentication, grouping notifications, and decryption scheduling retain their existing behavior.

The same synthetic fixture executes the actual accessory and render-batching functions from `cbd83c03` and the working tree. A burst queues all decrypt results before flushing; a staggered run flushes each result before the next arrives.

| Loaded rows | Delivery | Parser calls before | Parser calls after |
| --- | --- | ---: | ---: |
| 50 | Burst | 172 | 50 |
| 50 | Staggered | 1,325 | 50 |
| 100 | Burst | 440 | 100 |
| 100 | Staggered | 5,150 | 100 |

These are deterministic invocation counts. The fixture mocks React commits, cache publication, and the markdown parser; it does not measure browser timings, CPU usage, or FPS. Grouping callback and accessory render counts remain unchanged, so this change specifically removes repeated parsing work.

Run the comparison from the repository root with dependencies installed and the baseline commit available:

```powershell
pnpm exec tsx scripts/testSecureMessagingPlaintextRendering.ts --benchmark
```

Run the five regression checks with:

```powershell
pnpm exec tsx scripts/testSecureMessagingPlaintextRendering.ts
```

The checks cover burst and staggered history, changed plaintext, screenshot hiding, blocked authentication, optimistic content, and hidden embed-only rows. They use synthetic content and require no application interaction or network access.
