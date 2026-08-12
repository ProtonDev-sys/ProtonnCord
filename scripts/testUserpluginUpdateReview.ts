/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import {
    createUpdateReviewModel,
    createUpdateReviewPlan,
    getSafeUpdateSourceUrl,
    getUpdateReviewAction,
    isUpdateReviewPlanCurrent,
    MAX_DISPLAYED_UPDATE_COMMITS,
    parseUpdateCommits,
    runUpdateReview,
    type UpdateCommit
} from "../src/equicordplugins/userpluginInstaller.dev/updateReview";

const fullHash = "0123456789abcdef0123456789abcdef01234567";
const targetHash = "fedcba9876543210fedcba9876543210fedcba98";
const hostileAuthor = "Mallory////////install<img src=x onerror=alert(1)>\u202e";
const hostileSubject = "</p><script>document.title='install'</script> openLink:javascript:alert(1)";
const rawLog = `${hostileAuthor}\0${fullHash.slice(0, 8)}\0${fullHash}\0${hostileSubject}\0`;
const commits = parseUpdateCommits(rawLog);
const updatePlan = createUpdateReviewPlan(fullHash.toUpperCase(), targetHash);
assert.deepEqual(updatePlan, {
    localRevision: fullHash,
    targetRevision: targetHash,
    logRange: `${targetHash}...${fullHash}`
}, "the review must capture immutable local and target revisions");
assert.equal(isUpdateReviewPlanCurrent(updatePlan, fullHash), true);
assert.equal(isUpdateReviewPlanCurrent(updatePlan, targetHash), false,
    "a local ref change during review must invalidate approval");
assert.equal(isUpdateReviewPlanCurrent(updatePlan, "origin/HEAD"), false,
    "a mutable ref name must never satisfy an immutable review plan");
assert.throws(() => createUpdateReviewPlan(fullHash, "not-a-commit"), /invalid update revision/u);

const actualGitLog = execFileSync("git", [
    "log",
    "-z",
    "--max-count=2",
    "--format=%an%x00%h%x00%H%x00%s",
    "HEAD"
], { encoding: "utf8" });
assert.ok(parseUpdateCommits(actualGitLog).length > 0, "the production NUL-delimited git format must parse end to end");

assert.deepEqual(commits, [{
    author: hostileAuthor,
    shortHash: fullHash.slice(0, 8),
    fullHash,
    subject: hostileSubject
}], "NUL-delimited git metadata must preserve delimiter-like and markup text as data");

const review = createUpdateReviewModel({
    name: "<img src=x onerror=install()> install",
    description: "<script>openLink:javascript:alert(1)</script>",
    remote: "https://github.com/ProtonDev-sys/ProtonnCord"
}, commits);

assert.match(review.message, /<img src=x onerror=install\(\)> install/u);
assert.match(review.detail, /<script>openLink:javascript:alert\(1\)<\/script>/u);
assert.match(review.detail, /<script>document\.title='install'<\/script>/u);
assert.doesNotMatch(review.detail, /\u202e/u, "bidirectional control characters must not spoof review text");
assert.deepEqual(review.buttons, ["Cancel update", "Apply update", "Open source code"]);
assert.equal(getUpdateReviewAction(review, -1), "cancel", "closing the dialog must cancel");
assert.equal(getUpdateReviewAction(review, 0), "cancel");
assert.equal(getUpdateReviewAction(review, 1), "apply");
assert.equal(getUpdateReviewAction(review, 2), "openSource");
assert.equal(getUpdateReviewAction(review, 999), "cancel", "unknown responses must fail closed");

async function exerciseReview(responses: number[], openSourceError?: Error) {
    const openedUrls: string[] = [];
    const openErrors: unknown[] = [];
    let reviewCount = 0;
    const result = await runUpdateReview(review, {
        async showReview() {
            reviewCount++;
            return responses.shift() ?? -1;
        },
        async openSource(sourceUrl) {
            openedUrls.push(sourceUrl);
            if (openSourceError) throw openSourceError;
        },
        async showOpenSourceError(error) {
            openErrors.push(error);
        }
    });
    return { result, openedUrls, openErrors, reviewCount };
}

async function runControllerChecks() {
    assert.deepEqual(await exerciseReview([0]), { result: false, openedUrls: [], openErrors: [], reviewCount: 1 },
        "cancelling must not open a URL or approve an update");
    assert.deepEqual(await exerciseReview([1]), { result: true, openedUrls: [], openErrors: [], reviewCount: 1 },
        "only the Apply response may approve an update");
    assert.deepEqual(await exerciseReview([2, 0]), {
        result: false,
        openedUrls: ["https://github.com/ProtonDev-sys/ProtonnCord"],
        openErrors: [],
        reviewCount: 2
    }, "opening source must return to the review instead of applying the update");
    const openError = new Error("browser failed");
    assert.deepEqual(await exerciseReview([2, 0], openError), {
        result: false,
        openedUrls: ["https://github.com/ProtonDev-sys/ProtonnCord"],
        openErrors: [openError],
        reviewCount: 2
    }, "an external-open failure must remain in the review flow and fail closed");
}

const validSourceUrls = [
    "https://github.com/owner/repository",
    "https://gitlab.com/owner/repository.git",
    "https://codeberg.org/owner/repository/",
    "https://git.nin0.dev/userplugins/repository",
    "https://plugins.nin0.dev/repository"
];
for (const sourceUrl of validSourceUrls) {
    assert.equal(getSafeUpdateSourceUrl(sourceUrl), new URL(sourceUrl).href, `${sourceUrl} must remain reviewable`);
}

const unsafeSourceUrls = [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///C:/Windows/System32/calc.exe",
    "http://github.com/owner/repository",
    "https://attacker@github.com/owner/repository",
    "https://github.com:444/owner/repository",
    "https://github.com.evil.test/owner/repository",
    "https://localhost/owner/repository",
    "https://127.0.0.1/owner/repository",
    "https://github.com/user-attachments/repository",
    "https://github.com/owner/repository/extra",
    "https://github.com/owner/repository?install=true",
    "https://github.com/owner/repository#install",
    "https://github.com/owner/%2e%2e",
    "https://plugins.nin0.dev/owner/repository",
    " https://github.com/owner/repository",
    "https://github.com/owner/repository\n"
];
for (const sourceUrl of unsafeSourceUrls) {
    assert.equal(getSafeUpdateSourceUrl(sourceUrl), null, `${sourceUrl} must not become an external action`);
    const unsafeReview = createUpdateReviewModel({ name: "Plugin", description: "Description", remote: sourceUrl }, commits);
    assert.deepEqual(unsafeReview.buttons, ["Cancel update", "Apply update"]);
    assert.equal(getUpdateReviewAction(unsafeReview, 2), "cancel");
}

assert.throws(
    () => parseUpdateCommits(`author\0abc1234\0${"f".repeat(40)}\0subject\0`),
    /invalid update commit hash/u,
    "the short hash must identify the supplied full hash"
);
assert.throws(
    () => parseUpdateCommits("author\0abc1234\0missing-subject"),
    /malformed update metadata/u
);

const manyCommits: UpdateCommit[] = Array.from({ length: MAX_DISPLAYED_UPDATE_COMMITS + 1 }, (_, index) => {
    const hash = index.toString(16).padStart(40, "0");
    return { author: `author-${index}`, shortHash: hash.slice(0, 8), fullHash: hash, subject: `subject-${index}` };
});
const boundedReview = createUpdateReviewModel({
    name: `Plugin-${"n".repeat(1_000)}`,
    description: `Description-${"d".repeat(10_000)}`,
    remote: ""
}, manyCommits);
assert.match(boundedReview.detail, /subject-49/u);
assert.doesNotMatch(boundedReview.detail, /subject-50/u);
assert.match(boundedReview.detail, /Additional commits are not shown\./u);
assert.ok(boundedReview.message.length < 200, "plugin names must be bounded");
assert.ok(boundedReview.detail.length < 40_000, "the native dialog content must be bounded");

const nativeSource = readFileSync("src/equicordplugins/userpluginInstaller.dev/native.ts", "utf8");
assert.doesNotMatch(nativeSource, /updateValidateContent|generateUpdatePluginContent|formatCommitMessages/u);
const reviewStart = nativeSource.indexOf("async function reviewPluginUpdate");
const reviewEnd = nativeSource.indexOf("export async function getUserplugins");
assert.ok(reviewStart >= 0 && reviewEnd > reviewStart, "the production review implementation must exist");
const reviewSource = nativeSource.slice(reviewStart, reviewEnd);
assert.doesNotMatch(reviewSource, /loadURL|page-title-updated|WebContentsView|nodeIntegration|openLink:/u,
    "updates must not render attacker-controlled HTML or use document titles as commands");
assert.match(reviewSource, /defaultId: 0/u, "the native review must default to cancellation");
assert.match(reviewSource, /cancelId: 0/u, "Escape and window-close actions must cancel");

const updateStart = nativeSource.indexOf("export async function updatePlugin");
const updateEnd = nativeSource.indexOf("export async function openGitPathModal");
const updateSource = nativeSource.slice(updateStart, updateEnd);
const approvalIndex = updateSource.indexOf("if (!await reviewPluginUpdate");
const currentRevisionIndex = updateSource.indexOf("isUpdateReviewPlanCurrent");
const rebaseIndex = updateSource.indexOf("[\"rebase\", reviewPlan.targetRevision]");
assert.ok(approvalIndex >= 0 && rebaseIndex > approvalIndex, "the update may rebase only after explicit approval");
assert.ok(currentRevisionIndex > approvalIndex && rebaseIndex > currentRevisionIndex,
    "the local revision must remain unchanged between review and rebase");
assert.doesNotMatch(updateSource, /git rebase origin\/HEAD/u,
    "the rebase target must be the immutable revision that was reviewed");
assert.equal(existsSync("src/equicordplugins/userpluginInstaller.dev/misc/updateValidate.txt"), false,
    "the executable update-review document must stay removed");

runControllerChecks().then(() => {
    console.log("userplugin update review security checks passed");
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
