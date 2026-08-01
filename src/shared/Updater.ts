/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface UpdaterDiagnostics {
    backend: "disabled" | "git" | "http";
    branch: string | null;
    builtHead: string;
    sourceRoot: string | null;
}
