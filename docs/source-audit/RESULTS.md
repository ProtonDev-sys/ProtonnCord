# Complete source audit — 9 September 2026

This is the initial audit snapshot. See [nightly PR validation](PR-VALIDATION.md) for the subsequently integrated mobile changes, expanded checks and current acceptance limits.

The every-file review is complete. All **1,746 original tracked files** and **61 added implementation, test and tooling files** have a review record tied to their current SHA-256. The final coverage checker reports no missing files, duplicate reviews, invalid records or stale hashes. The original inventory paths also match Git commit `441b6a60c1e2e8242e54478d00247e2a6384661d`.

This work continues the earlier runtime rewrite with a complete repository review and targeted implementation changes. **616 original files changed**; 1,130 were retained after code, asset or generated-data review. Existing license notices and compatibility exports remain available.

| Area | Original files reviewed |
| --- | ---: |
| Shared code, native code, browser, builds, types, tests and documentation | 539 / 539 |
| Vencord plugin files | 426 / 426 |
| Equicord plugin files | 781 / 781 |
| Total | **1,746 / 1,746** |

The source catalog still contains **399 plugins and 1,352 saved-setting identifiers**. The desktop manifest retains 388 eligible entries, with 95 definitions deferred and 293 conservatively loaded eagerly. The compatibility baseline was preserved.

## Main changes

- **Saved preferences and imports:** isolated mutable defaults, preserved existing data during development-directory and plugin migrations, made sticker-pack changes atomic, and fixed an import race that could report success while disk and memory disagreed. Cloud downloads recheck local edits and account/backend context through delayed preparation and commit boundaries.
- **Plugin and UI lifetimes:** paired registrations with cleanup, contained observer failures, discarded stale asynchronous results, released media capture tracks, and corrected timers, pending dialogs and callbacks that could outlive their owner. Settings controls gained appropriate button semantics and keyboard behavior.
- **Settings, themes and navigation:** corrected delayed setting commits and reset defaults, preserved theme selections across failures and temporary pauses, and fixed stale metadata, searches and navigation results. Existing plugin identities, favorites and unknown saved fields remain governed by the compatibility checks.
- **Updates and native integration:** preserved selected-branch identity across check/install/rebuild operations, contained failed updates, corrected native window selection and development-data initialization, and retained installation-local storage behavior.
- **Builds and tooling:** fixed reproducible timestamps, literal CSS handling, watched userscript CSS loss, asynchronous archive completion and stable catalog output. The standalone Linux installer now verifies a pinned artifact while keeping its standalone operation. Explicit local bridge directories fail closed, temporary request files are cleaned, and test cleanup preserves unrelated downloads, directories and drafts.
- **Documentation and declarations:** corrected shared component/runtime declarations, removed duplicated developer-catalog parsing, updated fork-specific contribution guidance, and replaced inaccurate privacy claims with source-grounded data-handling documentation.

A second review pass independently found and reproduced the watched-CSS regression, the standalone installer compatibility regression, and two delayed settings/import races. Those findings were fixed and covered before the final handoff.

## Validation

| Check | Result |
| --- | --- |
| `node scripts/checkSourceAudit.mjs --require-complete` | Passed: all original and new implementation/test files covered; current hashes match |
| `pnpm test` | Passed, exit 0; 427 audit regressions and 999 reported Node test executions across its runner groups, plus standalone assertion scripts |
| `pnpm testWebAuthnLargeBlob` | Passed separately after fixing installed-browser discovery; fresh localhost Chrome fixture with virtual PRF and large-blob authenticators |
| `pnpm buildStandalone` and `pnpm build` | Passed for desktop and Equibop outputs |
| `pnpm buildWeb` | Passed for browser, Chromium extension, Firefox extension and userscript |
| `pnpm generateTypes` and the generated package's strict consumer test | Passed |
| Final TypeScript and updater repository checks | Passed |
| Lint/style/locale/patch checks | Zero errors; patch lint retains 193 advisory warnings |

The initial broad gate skipped WebAuthn because its discovery checked Linux paths only. Windows/macOS discovery and launch-failure cleanup were corrected, and the previously skipped fixture then passed. Physical security-key behavior remains outside this virtual-authenticator test.

Both ASARs contain the expected main entry, renderer, CSS, preload and package metadata. Both extension archives contain their versioned manifest and renderer assets. The userscript's embedded CSS matches its emitted CSS exactly. A real local esbuild watch fixture verifies that CSS survives both initial and later rebuilds.

Existing utility work-count comparisons reproduced successfully. Every one of the 19,440 generated locale mappings matches its runtime hash. Historical elapsed-time tables remain labeled as historical; this audit establishes no new whole-client CPU, memory, startup or FPS claim.

## Scope and retained limits

The source review covers the frozen repository and added implementation/test files. Installed dependencies, Git internals and generated build outputs are outside that inventory; build artifacts received separate packaging checks. Generated data and assets were validated according to their format and use. A filename search or linter result did not count as a semantic code review.

The installed official client and real user preferences were left untouched. No signed-in Discord session, real message send/delete, live voice/capture operation, installer execution or publishing was used for this audit. Tests use local fixtures, mocked services, disposable repositories, temporary storage and the isolated WebAuthn browser page.

Live Discord compatibility still requires a smoke test before deployment. Its private module signatures, UI selectors and external integrations cannot be certified by these fixtures. Linux/macOS installation and physical hardware were not exercised on this Windows workstation. Encryption protocol tests are implementation evidence, not an independent cryptographic certification.

Per-file records also retain concrete limitations. Examples include account scoping and in-flight work in existing scheduled-message/reconnect features, legacy runtime-patching and reporter assumptions, and sequential multi-category backup application with partial-save reporting. Those records distinguish retained behavior from fixes and from live verification. The review does not claim every possible defect was removed.

## Review material

- [Method and coverage command](README.md)
- [Frozen inventory](inventory.json)
- [Per-file review records](reviews/)
- [Machine-readable validation summary](validation/summary.json)
- [Packaged artifact checks](validation/artifacts-20260909.json)

Detailed `.log` files remain in the local validation directory and are Git-ignored. Repository review uses the committed summaries and pull-request CI results.

Changes are saved in the isolated `audit/protonncord-complete` checkout. They have not been installed or published.
