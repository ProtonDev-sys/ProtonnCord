/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MAX_DISPLAYED_UPDATE_COMMITS = 50;
export const MAX_UPDATE_LOG_BYTES = 512 * 1024;

const MAX_CAPTURED_UPDATE_COMMITS = MAX_DISPLAYED_UPDATE_COMMITS + 1;
const MAX_PLUGIN_NAME_LENGTH = 160;
const MAX_PLUGIN_DESCRIPTION_LENGTH = 2_000;
const MAX_COMMIT_AUTHOR_LENGTH = 160;
const MAX_COMMIT_SUBJECT_LENGTH = 500;
const MAX_REPOSITORY_URL_LENGTH = 2_048;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const REPOSITORY_SEGMENT = /^[a-zA-Z0-9.-]+$/u;
const REPOSITORY_OWNER = /^[a-zA-Z0-9-]+$/u;
const CUSTOM_GIT_HOST = /^git\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const FULL_GIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const PUBLIC_GIT_HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org"]);

export interface UpdateCommit {
    author: string;
    shortHash: string;
    fullHash: string;
    subject: string;
}

export interface UpdateReviewMetadata {
    name: string;
    description: string;
    remote: string;
}

export interface UpdateReviewPlan {
    localRevision: string;
    targetRevision: string;
    logRange: string;
}

export interface UpdateReviewModel {
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    sourceUrl: string | null;
    applyResponse: number;
    openSourceResponse: number | null;
}

export interface UpdateReviewPresenter {
    showReview(): Promise<number>;
    openSource(sourceUrl: string): Promise<void>;
    showOpenSourceError(error: unknown): Promise<void>;
}

export type UpdateReviewAction = "cancel" | "apply" | "openSource";

function requireFullGitHash(value: string): string {
    const hash = value.trim();
    if (!FULL_GIT_HASH.test(hash)) throw new Error("Git returned an invalid update revision");
    return hash.toLowerCase();
}

export function createUpdateReviewPlan(localRevision: string, targetRevision: string): UpdateReviewPlan {
    const local = requireFullGitHash(localRevision);
    const target = requireFullGitHash(targetRevision);
    return {
        localRevision: local,
        targetRevision: target,
        logRange: `${target}...${local}`
    };
}

export function isUpdateReviewPlanCurrent(plan: UpdateReviewPlan, currentRevision: string): boolean {
    try {
        return plan.localRevision === requireFullGitHash(currentRevision);
    } catch {
        return false;
    }
}

function cleanDisplayText(value: string, maximumLength: number, fallback: string): string {
    const cleaned = value.replace(UNSAFE_DISPLAY_CHARACTERS, "\ufffd").trim();
    if (!cleaned) return fallback;

    const characters = Array.from(cleaned);
    if (characters.length <= maximumLength) return cleaned;
    return `${characters.slice(0, maximumLength - 1).join("")}\u2026`;
}

function isValidRepositorySegment(value: string): boolean {
    return REPOSITORY_SEGMENT.test(value) && value !== "." && value !== "..";
}

export function getSafeUpdateSourceUrl(remote: string): string | null {
    if (!remote || remote.length > MAX_REPOSITORY_URL_LENGTH || remote.trim() !== remote) return null;

    let url: URL;
    try {
        url = new URL(remote);
    } catch {
        return null;
    }

    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;

    const hostname = url.hostname.toLowerCase();
    const pathSegments = url.pathname.split("/").filter(Boolean);
    if (hostname === "plugins.nin0.dev") {
        if (pathSegments.length !== 1 || !isValidRepositorySegment(pathSegments[0])) return null;
    } else {
        if (!PUBLIC_GIT_HOSTS.has(hostname) && !CUSTOM_GIT_HOST.test(hostname)) return null;
        if (pathSegments.length !== 2 || !REPOSITORY_OWNER.test(pathSegments[0]) || !isValidRepositorySegment(pathSegments[1])) return null;
        if (pathSegments[0] === "user-attachments") return null;
    }

    if (url.pathname.includes("//") || pathSegments.some(segment => segment.includes("%"))) return null;
    return url.href;
}

export function parseUpdateCommits(rawOutput: string): UpdateCommit[] {
    if (!rawOutput) return [];

    const fields = rawOutput.split("\0");
    if (fields.at(-1) === "") fields.pop();
    if (fields.length % 4 !== 0) throw new Error("Git returned malformed update metadata");
    if (fields.length / 4 > MAX_CAPTURED_UPDATE_COMMITS) throw new Error("Git returned too many update commits");

    const commits: UpdateCommit[] = [];
    for (let index = 0; index < fields.length; index += 4) {
        const [author, shortHash, fullHash, subject] = fields.slice(index, index + 4);
        if (!/^[0-9a-f]{4,64}$/iu.test(shortHash) || !FULL_GIT_HASH.test(fullHash) ||
            !fullHash.toLowerCase().startsWith(shortHash.toLowerCase())) {
            throw new Error("Git returned an invalid update commit hash");
        }
        commits.push({ author, shortHash, fullHash, subject });
    }

    return commits;
}

function formatUpdateCommits(commits: UpdateCommit[]): string {
    if (!commits.length) return "No commit summary was returned.";

    const lines = commits.slice(0, MAX_DISPLAYED_UPDATE_COMMITS).map(commit => {
        const author = cleanDisplayText(commit.author, MAX_COMMIT_AUTHOR_LENGTH, "Unknown author");
        const subject = cleanDisplayText(commit.subject, MAX_COMMIT_SUBJECT_LENGTH, "No subject");
        return `${author} (${commit.shortHash}) ~ ${subject}`;
    });
    if (commits.length > MAX_DISPLAYED_UPDATE_COMMITS) lines.push("Additional commits are not shown.");
    return lines.join("\n");
}

export function createUpdateReviewModel(metadata: UpdateReviewMetadata, commits: UpdateCommit[]): UpdateReviewModel {
    const name = cleanDisplayText(metadata.name, MAX_PLUGIN_NAME_LENGTH, "Unnamed plugin");
    const description = cleanDisplayText(metadata.description, MAX_PLUGIN_DESCRIPTION_LENGTH, "No description provided.");
    const sourceUrl = getSafeUpdateSourceUrl(metadata.remote);
    const buttons = ["Cancel update", "Apply update"];
    if (sourceUrl) buttons.push("Open source code");

    return {
        title: "Review userplugin update",
        message: `Update ${name}?`,
        detail: `Plugin description:\n${description}\n\nCommits to apply:\n${formatUpdateCommits(commits)}\n\nOnly apply updates from developers you trust.`,
        buttons,
        sourceUrl,
        applyResponse: 1,
        openSourceResponse: sourceUrl ? 2 : null
    };
}

export function getUpdateReviewAction(model: UpdateReviewModel, response: number): UpdateReviewAction {
    if (response === model.applyResponse) return "apply";
    if (model.openSourceResponse !== null && response === model.openSourceResponse) return "openSource";
    return "cancel";
}

export async function runUpdateReview(model: UpdateReviewModel, presenter: UpdateReviewPresenter): Promise<boolean> {
    while (true) {
        const action = getUpdateReviewAction(model, await presenter.showReview());
        if (action === "apply") return true;
        if (action === "cancel" || !model.sourceUrl) return false;

        try {
            await presenter.openSource(model.sourceUrl);
        } catch (error) {
            await presenter.showOpenSourceError(error);
        }
    }
}
