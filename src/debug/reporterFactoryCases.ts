/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Exact source-only exceptions for reporter-forced initialization. The paired
// original/prepared factories and host prerequisites are covered in
// scripts/testAuditReporterFactoryPreflight.ts; source drift is never accepted.
export const REPORTER_SOURCE_ONLY_FACTORIES = [
    {
        "id": "33006",
        "reason": "native-capability-unavailable",
        "capability": "DiscordNative",
        "originalSha256": "c01d865e01da5023c7db7aa6ff691fa4722f4e0e5ef768b7611893203d40861c",
        "patchedSha256": "66133ee097aabaa4be7a31095cc6e6a4fc8fda00ea4cd7c44eaaa8e8c0b1a4b9"
    },
    {
        "id": "438834",
        "reason": "host-module-unavailable",
        "missingDependency": "796734",
        "originalSha256": "e45c8316646cc0b5cc3041d6bbccba17da4d340cf18147342e91ef9633b3910e",
        "patchedSha256": "c547c7e9339ee63feffd3e45c9b39f5ec9c1d0d0471fe3048c23f09d60cd9e9d"
    },
    {
        "id": "342218",
        "reason": "host-module-unavailable",
        "missingDependency": "957316",
        "originalSha256": "9efeb4fcfe55de4d39a8ba779f0ca7b95fe36bc92231b9f98764715a8878e58f",
        "patchedSha256": "7f76a197c69af395da949829f9a66b8228c8803d3b53af18235067999d4e5abf"
    }
] as const;
