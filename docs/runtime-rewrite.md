# Runtime rewrite

This branch replaces the runtime infrastructure while retaining the existing feature implementations and saved-data formats. The comparison baseline is commit `6c6222b1c`; the frozen compatibility inventory is in `plugin-catalog-baseline.json`.

## Architecture

- The renderer entry delegates startup to `src/runtime`. Plugin stages remain explicit; cloud and updater listeners attach when webpack is ready, and optional initial work runs in a bounded idle turn. Services dispose their listeners and timers when the page closes. Runtime status contains detached diagnostic snapshots.
- Plugin startup owns a resource collection for each start/stop cycle. Declarative API registrations sit beside their inverse operations, so failed starts and repeated toggles release commands, menus, buttons, handlers, and styles. Late asynchronous failures cannot tear down a newer run.
- The build generates plugin metadata without executing source modules. Settings defaults, plugin search, dependency lists, and catalog notices can use that metadata. Definitions load when needed and retain their original object identity. Dynamic metadata, migrations, and startup side effects use conservative eager loading.
- Native plugin IPC names remain stable. Method discovery happens at build time; handlers load reviewed implementations on first use. Startup hooks remain eager, including MessageLoggerEnhanced and SongSpotlight, whose exported modules also perform initialization. Unknown natives default to eager loading, and direct imports share the same module instance.
- Settings return stable proxies and notify subscribers synchronously. Removed array entries release cached references. A separate persistence queue combines same-turn snapshots, serializes writes, and flushes before application restarts or reloads. Browser and desktop listeners return independent disposers.
- Webpack lookup subscriptions reuse shallow export reads between delivered callbacks. A delivered callback invalidates the cache so later waiters observe any changes it makes. Nothing is cached across module dispatches.

The retained catalog contains **399 plugins and 1,352 statically identified setting keys**. Unknown saved fields, dynamic settings, IndexedDB identities, and the Secure Messaging protocol/vault formats remain governed by `rewrite-acceptance.md`.

## Measured work

| Workload | Baseline | Rewrite |
| --- | ---: | ---: |
| Nested settings reads: proxy allocations across seven rounds of 100,000 reads | 2,100,001 | 4 |
| Nested settings reads: median time for one 100,000-read round | 130.87 ms | 111.50 ms |
| Native modules initialized by the IPC registry at startup | 22 | 5 |
| Shallow module lookup: getter reads with 512 unmatched waiters and 128 exports | 65,536 | 128 |
| Same lookup workload: export enumerations | 512 | 1 |

Settings measurements compare both implementations in the same VM harness using `pnpm exec tsx scripts/benchmarkSettingsStore.ts`. Timing varies by machine and load; the allocation assertion is deterministic. The lookup fixture retains the same 66,048 filter calls and resets its cache after a callback runs. Native figures describe direct registry initialization; enabled plugins can subsequently request deferred modules.

The normal desktop manifest contains 388 platform-eligible entries: 97 can load on demand and 291 remain eager. Enabled plugins and transitive imports can load members of the deferred group; this classification is not a measurement of a particular user's startup.

These measurements do not establish whole-client CPU, heap, startup, or FPS gains. Runtime stage diagnostics begin after entry initialization and exclude bundle parsing; asynchronous service timings can include network waits.

## Validation

The broad `pnpm test` gate passes, including the catalog contract, manifest and lifecycle tests, settings/storage/browser tests, updater checks, Secure Messaging suites, TypeScript, formatting, and generated plugin metadata. Patch lint reports zero errors and 193 existing warnings. Additional focused checks cover stream audio, clientside guild icons, promise timeouts, voice transcription, and the Discord MCP protocol.

Desktop, Equibop, standalone, browser-extension, and userscript builds retain their output contracts. Standalone validation uses `--outdir` so it cannot replace the installed build. Both ASAR packages contain the expected renderer/preload assets and main entry points. The local preview uses `--disable-updater` with the normal data profile; it does not use development settings or alter the saved auto-update preference.

Live checks are a separate smoke test, not coverage of every plugin or a new cryptographic audit. Only destinations explicitly authorized for the session may receive test messages. Keep a copy of the previous loader and local settings before switching installations, and verify the preview's build hash, startup stages, saved settings, and message cleanup.
