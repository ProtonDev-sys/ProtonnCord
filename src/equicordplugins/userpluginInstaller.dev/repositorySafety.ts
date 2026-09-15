/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { lstat, realpath } from "fs/promises";
import path from "path";

const SAFE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const SELF_HOSTED_GIT = /^git\.(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;

export interface UserpluginRepository {
    href: string;
    owner: string;
    repo: string;
    source: string;
}

function isAllowedGitHost(hostname: string): boolean {
    return hostname === "github.com"
        || hostname === "gitlab.com"
        || hostname === "codeberg.org"
        || SELF_HOSTED_GIT.test(hostname);
}

/** Parse the repository URL in the trusted native process. */
export function parseUserpluginRepositoryUrl(value: string): UserpluginRepository | null {
    if (typeof value !== "string" || value.length > 512 || value.includes("%")) return null;

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }

    if (url.protocol !== "https:"
        || url.username
        || url.password
        || url.port
        || url.search
        || url.hash)
        return null;

    const parts = url.pathname.split("/").filter(Boolean);
    let owner: string;
    let repo: string;

    if (url.hostname === "plugins.nin0.dev") {
        if (parts.length !== 1) return null;
        owner = "nin0";
        repo = parts[0];
    } else {
        if (!isAllowedGitHost(url.hostname) || parts.length !== 2 || parts[0] === "user-attachments") return null;
        [owner, repo] = parts;
    }

    if (repo.endsWith(".git")) repo = repo.slice(0, -4);
    if (!SAFE_OWNER.test(owner) || !SAFE_REPOSITORY.test(repo) || repo === "." || repo === "..") return null;

    return { href: url.href, owner, repo, source: url.hostname };
}

/** Resolve a repository name to exactly one direct child of the userplugins root. */
export function resolveUserpluginDirectory(
    root: string,
    repo: string,
    pathApi: Pick<typeof path, "dirname" | "resolve"> = path
): string {
    if (!SAFE_REPOSITORY.test(repo) || repo === "." || repo === "..") throw new Error("Invalid repository name");

    const resolvedRoot = pathApi.resolve(root);
    const destination = pathApi.resolve(resolvedRoot, repo);
    if (destination === resolvedRoot || pathApi.dirname(destination) !== resolvedRoot)
        throw new Error("Repository path escapes the userplugins directory");

    return destination;
}

export async function assertSafeExistingUserpluginDirectory(root: string, destination: string): Promise<string> {
    const stats = await lstat(destination);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Refusing to use a linked plugin directory");

    const [canonicalRoot, canonicalDestination] = await Promise.all([realpath(root), realpath(destination)]);
    if (path.dirname(canonicalDestination) !== canonicalRoot)
        throw new Error("Plugin directory escapes the userplugins root");

    return canonicalDestination;
}
