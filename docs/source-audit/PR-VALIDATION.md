# Nightly PR validation

The audit branch incorporates nightly `17701a7da93e354e28e5fd3fdfb146449e56045b`, including its Android and phone-pairing work. The original 1,746-file inventory remains frozen; added files have separate review records. The complete review gate passes in both the working checkout and a fresh LF checkout of the committed branch.

The combined-branch review corrected phone-pairing data loss, unsafe cross-device edit counters, failed mobile vault saves, attachment metadata exposure and resource cleanup. Phone-only contacts and bounded retired-key history survive pairing. Changed peer keys keep conversation review requirements. Desktop rejects phone-origin edits instead of posting an older counter that recipients would reject.

## Completed local checks

| Check | Result |
| --- | --- |
| Full desktop gate | Passed; 444 audit cases and 1,016 reported Node test executions; no skipped tests |
| Supplemental desktop checks | Eight additional scripts: 39 cases passed; both remaining local synthetic benchmarks passed |
| WebAuthn | Fresh headless Chrome virtual PRF and large-blob tests passed within the full gate |
| Mobile interoperability | 42 cases across 11 TypeScript test files passed against this desktop implementation |
| Android native | Four Kotlin wire tests passed; debug/release compilation and DEX/plugin ZIP packaging passed |
| Desktop/Equibop builds | Production and isolated standalone builds passed |
| Browser builds | Normal and standalone browser, userscript and Chromium/Firefox extension builds passed |
| Public API types | Generation and strict consumer-package test passed |
| Mobile runtime | Exact pinned Revenge runtime compiled with Deno 2.7.4; unresolved-import/missing-global checks clean |
| Static checks | Desktop and mobile type/lint checks passed; 193 desktop patch warnings and 3 mobile advisory warnings remain |

Mobile used Bun 1.3.4 with the frozen lock, Gradle 9.6.1, JDK 21/25 and the installed Android SDKs. The Maven API artifact matched the build output of a clean checkout at the pinned native API revision `9a1426d0a3df000beb4174d0071d4d80e8be42fc`. Runtime source was checked out separately at `6f22fe1d5843160320a4a06644e816bb11f0c929`. No release-version preparation, installation, identity export or publishing workflow was run locally.

The [per-file test matrix](validation/pr-test-matrix.json) lists every desktop test/benchmark script and mobile test file. It accounts for **151 passed desktop files and four live runners pending acceptance**. Counts are test executions, not a claim that every possible input or every live plugin integration was exercised. [Artifact checks](validation/pr-artifacts.json) verify expected ASAR entries, the mobile ZIP's JS/JAR/manifest and native DEX, and the compiled runtime.

## Acceptance still pending

The four live desktop runners need a signed-in client and their documented profile/branch/destination conditions. They were inspected but not executed. Physical Android UI, USB permission, OneKey PIN/confirmation, and real desktop rendering/send/edit/history behavior remain unverified on this build. The PR is kept in draft while those acceptance items are outstanding. CI status is recorded on the pull request separately from these local results.

Local detailed logs are Git-ignored under `validation/`. The [initial audit report](RESULTS.md) records the earlier snapshot; this document and the test matrix describe the combined nightly candidate.
