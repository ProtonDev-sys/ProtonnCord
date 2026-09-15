/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const UPDATER_BRANCHES = ["main", "staging", "nightly"] as const;
export type UpdaterBranch = typeof UPDATER_BRANCHES[number];

const updaterBranchSet = new Set<string>(UPDATER_BRANCHES);

export function isUpdaterBranch(value: unknown): value is UpdaterBranch {
    return typeof value === "string" && updaterBranchSet.has(value);
}

export function parseUpdaterBranch(value: unknown): UpdaterBranch {
    if (value === undefined) return "main";
    if (!isUpdaterBranch(value)) throw new Error("Unsupported Protonn Cord update branch");
    return value;
}

export function updaterReleaseEndpoint(branch: UpdaterBranch): string {
    return branch === "main" ? "/releases/latest" : `/releases/tags/${branch}`;
}

export interface UpdaterDiagnostics {
    backend: "disabled" | "git" | "http";
    branch: UpdaterBranch | null;
    builtHead: string;
    sourceRoot: string | null;
}
