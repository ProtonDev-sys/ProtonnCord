/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { pathToFileURL } from "node:url";

export const SOAK_MS = 3 * 60 * 60 * 1000;
const CHECKS = ["test.yml", "build.yml"];

// Every decision uses runs for the exact branch and SHA, never a branch's last green run.
export async function promoteChannels(api, now = Date.now(), log = console.log) {
    const branch = name => api(`branches/${name}`);
    const runs = async (workflow, name, sha) => {
        const result = await api(`actions/workflows/${workflow}/runs?branch=${name}&head_sha=${sha}&per_page=100`);
        return result.workflow_runs
            .filter(run => run.head_branch === name && run.head_sha === sha && ["push", "workflow_dispatch"].includes(run.event))
            .sort((a, b) => b.id - a.id);
    };
    const dispatch = (workflow, name) => api(`actions/workflows/${workflow}/dispatches`, "POST", { ref: name });
    async function checks(name, sha, workflows, startMissing = false) {
        let ready = true;
        for (const workflow of workflows) {
            const [run] = await runs(workflow, name, sha);
            if (!run && startMissing) {
                // GITHUB_TOKEN merges do not trigger push workflows. Explicit dispatch does.
                await dispatch(workflow, name);
                log(`Dispatched ${workflow} for ${name} (${sha}).`);
            }
            if (!run || run.status !== "completed" || run.conclusion !== "success") {
                ready = false;
                log(`Waiting for ${name} ${workflow}: ${run?.conclusion ?? run?.status ?? "missing"}.`);
            }
        }
        return ready;
    }
    async function merge(name, sha) {
        // Use the inspected source SHA, rather than a moving branch name. Conflicts fail the run.
        const result = await api("merges", "POST", {
            base: name, head: sha, commit_message: `Promote ${sha} to ${name}`,
        });
        const current = await branch(name);
        if (result && current.commit.sha !== result.sha)
            throw new Error(`${name} advanced during promotion; retry against the new revision.`);
        log(`${name} is at ${current.commit.sha}.`);
        return current.commit.sha;
    }

    const nightly = (await branch("nightly")).commit.sha;
    const nightlyRuns = await runs("test.yml", "nightly", nightly);
    const push = nightlyRuns.find(run => run.event === "push");
    // GitHub's push-run creation time measures arrival on nightly, unlike a commit's author date.
    const arrived = Date.parse(push?.created_at ?? "");
    if (!Number.isFinite(arrived) || now - arrived < SOAK_MS) {
        log("Nightly has not completed its three-hour soak (or has no recorded push run).");
        return;
    }
    if (!await checks("nightly", nightly, [...CHECKS, "mobile.yml"])) return;
    if ((await branch("nightly")).commit.sha !== nightly) {
        log("Nightly advanced; leaving the new revision to soak.");
        return;
    }

    const staging = await merge("staging", nightly);
    if (!await checks("staging", staging, CHECKS, true)) return;
    if ((await branch("nightly")).commit.sha !== nightly || (await branch("staging")).commit.sha !== staging) {
        log("A source branch advanced; waiting for its own checks.");
        return;
    }
    const main = await merge("main", staging);
    await checks("main", main, [...CHECKS, "publish.yml"], true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const repository = process.env.GITHUB_REPOSITORY;
    if (repository !== "ProtonDev-sys/ProtonnCord" || !process.env.GH_TOKEN)
        throw new Error("Promotion requires the ProtonnCord repository and its Actions token.");
    const api = async (path, method = "GET", body) => {
        const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
            method,
            headers: {
                "Accept": "application/vnd.github+json",
                "Authorization": `Bearer ${process.env.GH_TOKEN}`,
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
        return response.status === 204 ? null : response.json();
    };
    await promoteChannels(api);
}
