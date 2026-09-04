# Rendering performance measurements, 4 September 2026

This change removes repeated work in custom notifications, Timezones message headers, and Secure Messaging mention checks. It adds no dependencies. The measurements below compare actual source from nightly commit `21ee734fd3380f075bffadcdf7f61205dcf3260a` with the implementation in this PR.

These are isolated code-path measurements on synthetic data. They do not measure Discord FPS, total CPU use, startup time, DOM layout, or encryption/decryption latency.

## Results

### Custom notifications

The actual notification component runs with deterministic timers and mocked React hooks/animation. A five-second notification now uses one dismissal timer and a native transform animation instead of a 10 ms interval that updates component state and progress-bar width.

| Workload and metric | Before | After |
| --- | ---: | ---: |
| Five-second notification: timer callbacks | 500 | 1 |
| Five-second notification: state updates | 499 | 0 |
| Five-second notification: component invocations in the fixture | 500 | 1 |
| Seven-second hover pause: timer callbacks | 500 | 1 |
| Seven-second hover pause: state updates, including hover transitions | 501 | 2 |
| Seven-second hover pause: component invocations in the fixture | 502 | 3 |

Dismissal stays at 5,000 ms normally and 12,000 ms with a seven-second hover pause. The browser still performs animation work; the counts describe JavaScript callbacks and the hook fixture, not measured browser CPU savings.

### Timezones

Each batch invokes the actual timestamp component for 100 message headers across New York, London, Tokyo, Sydney, and Kolkata. Four timestamps span the US daylight-saving transitions. React and Discord imports are mocked; native `Intl.DateTimeFormat` performs the formatting.

| Metric per 100 message headers | Before | After |
| --- | ---: | ---: |
| Steady-state median | 16.9460 ms | 4.4923 ms |
| Steady-state p95 | 20.0456 ms | 16.0219 ms |
| Formatter constructions, first batch | 400 | 115 |
| Formatter constructions, subsequent batches | 400 | 100 |

The median falls by 73.5% in this workload. The p95 includes substantial local timing variation and improves less than the median. Five warmup batches precede 31 measured batches per implementation, with before/after order alternating between samples. First-batch construction counts use fresh module instances; the single cold timing printed by the script is not treated as a statistical result.

Only formatters for explicit timezones are reused. Cache keys include the current locale and all formatting options. The cache clears on a miss once it holds 128 entries, so unusually diverse workloads may rebuild formatters more often. System-timezone probes and calls requesting the default timezone remain uncached. Dates, user timezone data, and formatted strings are not cached.

### Secure Messaging mention checks

Each batch checks 100 valid, distinct encrypted messages generated locally with two selected recipients plus the sender. Plaintext supplied to the helper represents the post-decryption path. Fixture generation and encryption occur outside timing; decryption is not part of this benchmark. Each implementation gets 20 warmup batches and 101 measured batches, with alternating before/after order.

| Workload, per 100 lookups | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| No mention, before decryption | 6.2717 ms | 0.0078 ms | 8.4237 ms | 0.0147 ms |
| No mention, plaintext available | 6.2218 ms | 0.0350 ms | 9.2717 ms | 0.0605 ms |
| Current-user mention, before decryption | 6.7131 ms | 6.6646 ms | 9.4661 ms | 9.1990 ms |
| Current-user mention, plaintext available | 7.1427 ms | 6.9278 ms | 10.5857 ms | 10.1127 ms |
| Other-user mention, before decryption | 6.7452 ms | 0.0086 ms | 9.3373 ms | 0.0150 ms |
| Other-user mention, plaintext available | 6.6906 ms | 0.0491 ms | 8.9334 ms | 0.0806 ms |

The no-mention post-decryption path uses 99.4% less time in this workload. Small differences in candidate-mention timings should be treated as noise: those messages still receive full envelope validation. Canonical PCEM3 metadata must contain the literal current-user mention token, so its absence can skip envelope parsing. The authenticated plaintext fallback remains unchanged, including for older envelopes.

## Reproduction

Measured sequentially on Windows x64, Node.js v24.14.0, an AMD Ryzen 7 9800X3D with 16 logical CPUs and 31 GiB reported system memory. Other agent test and benchmark processes were stopped before collecting the results. This was a normal workstation, not a dedicated performance runner.

From the repository root with dependencies installed and the baseline commit available:

```powershell
pnpm exec tsx scripts/testNotificationPerformance.ts --baseline=21ee734fd3380f075bffadcdf7f61205dcf3260a
pnpm exec tsx scripts/benchmarkTimezones.ts --baseline=21ee734fd3380f075bffadcdf7f61205dcf3260a
pnpm exec tsx scripts/benchmarkSecureMessagingMentions.ts --baseline=21ee734fd3380f075bffadcdf7f61205dcf3260a
```

Both sides use the same transpilation and module mocks. The scripts verify outputs outside the timed regions. Run them sequentially; timing results vary by machine and background load.

`pnpm testRenderPerformance`, also included in `pnpm test`, runs correctness and work-count assertions without timing thresholds. Coverage includes notification pause/timeout/cleanup behavior; locale, 12/24-hour format, daylight-saving and OS timezone changes; cache eviction; canonical mention validation; malformed inputs; and legacy/plaintext fallbacks. No live messages or user account data are used.
