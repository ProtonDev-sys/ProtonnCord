// SPDX-License-Identifier: GPL-3.0-or-later
// Installed controller: credentials stay with this user; builds use a separate account.
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CHANNELS = ["main", "staging", "nightly"];
const REPOSITORY = "ProtonDev-sys/ProtonnCord";
const SHA = /^[a-f0-9]{40}$/u;
const SOAK_MS = 3 * 60 * 60_000;

export function selectJobs(heads, pulls, owner = REPOSITORY.split("/")[0]) {
    const jobs = CHANNELS.map(channel => ({ key: channel, channel, sha: heads[channel], ref: `refs/heads/${channel}`, publish: true }));
    for (const pr of pulls) {
        if (pr.user?.login !== owner || pr.head?.repo?.full_name !== REPOSITORY || !CHANNELS.includes(pr.base?.ref)) continue;
        if (!Number.isSafeInteger(pr.number) || pr.number < 1) continue;
        jobs.push({ key: `pr-${pr.number}`, channel: pr.base.ref, sha: pr.head.sha, ref: `refs/pull/${pr.number}/head`, publish: false });
    }
    return jobs.filter(job => SHA.test(job.sha ?? ""));
}

export function canPublish(job, record, currentSha) {
    return job.publish === true && CHANNELS.includes(job.key) && record?.validated === true
        && record.sha === job.sha && currentSha === job.sha;
}

function api(path, method = "GET", body) {
    const args = ["api", `repos/${REPOSITORY}/${path}`, "--method", method];
    if (body !== undefined) args.push("--input", "-");
    const value = execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 8 * 1024 * 1024 });
    return value.trim() ? JSON.parse(value) : null;
}

async function readJson(path, fallback) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function save(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(`${path}.tmp`, path);
}

async function run(command, args, { cwd, env, log, timeout = 90 * 60_000 } = {}) {
    await new Promise((accept, reject) => {
        const output = log ? createWriteStream(log, { flags: "a" }) : null;
        const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { process.stdout.write(data); output?.write(data); });
        const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeout);
        child.on("error", error => { clearTimeout(timer); output?.end(); reject(error); });
        child.on("exit", (code, signal) => {
            clearTimeout(timer); output?.end();
            if (code === 0) accept(); else reject(new Error(`${command} exited ${signal ?? code}`));
        });
    });
}

export async function tick(config, { retry = false, only = config.only } = {}) {
    const stateRoot = resolve(config.stateRoot);
    const workRoot = resolve(config.workRoot);
    const controller = dirname(fileURLToPath(import.meta.url));
    await mkdir(stateRoot, { recursive: true });
    const statePath = join(stateRoot, "state.json");
    const state = await readJson(statePath, { jobs: {}, observed: {}, nextNumber: 10000 });
    const heads = Object.fromEntries(CHANNELS.map(channel => [channel, api(`branches/${channel}`).commit.sha]));
    const pulls = api("pulls?state=open&per_page=100");
    const jobs = selectJobs(heads, pulls).filter(job => !only || job.key === only);
    for (const channel of CHANNELS) {
        if (state.observed[channel]?.sha !== heads[channel]) state.observed[channel] = { sha: heads[channel], since: Date.now() };
    }
    await save(statePath, state);
    const status = (job, phase, result, description) => api(`statuses/${job.sha}`, "POST", {
        state: result, context: `other-pc/${phase}/${job.key}`, description: description.slice(0, 140),
    });
    for (const job of jobs) {
        const key = `${job.key}-${job.sha}`;
        let record = state.jobs[key];
        if ((record?.complete && !retry) || (record?.failed && !retry)) continue;
        record ??= state.jobs[key] = { sha: job.sha, runId: String(Date.now()), number: String(state.nextNumber++), attempt: "1" };
        record.failed = false;
        await save(statePath, state);
        const checkout = join(workRoot, key);
        if (dirname(checkout) !== workRoot) throw new Error("Unsafe checkout path");
        const log = join(stateRoot, `${key}.log`);
        const env = {
            HOME: config.buildHome, PATH: config.buildPath ?? "/usr/local/bin:/usr/bin:/bin", CI: "true",
            PROTONN_CORD_BUILD_CHANNEL: job.channel, GITHUB_REPOSITORY: REPOSITORY,
            GITHUB_REF_NAME: job.channel, GITHUB_SHA: job.sha, GITHUB_RUN_ID: record.runId,
            GITHUB_RUN_NUMBER: record.number, GITHUB_RUN_ATTEMPT: record.attempt,
            PROTONN_CI_RELEASE: job.publish ? "1" : "0",
            ...(config.buildEnv ?? {}),
        };
        // No inherited HOME, SSH agent, GitHub token, or repository credential helper.
        const build = (command, args, cwd = checkout) => run("sudo", ["-n", "-u", config.buildUser, "env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), command, ...args], { cwd, log });
        const script = (name, mode) => build("bash", [join(controller, name), mode]);
        let phase = "ci";
        try {
            status(job, phase, "pending", "Validating on the local build PC");
            if (!record.validated) {
                if (!await stat(checkout).catch(() => null)) await build("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${REPOSITORY}.git`, checkout], workRoot);
                await build("git", ["-c", "credential.helper=", "fetch", "--no-tags", "origin", job.ref]);
                await build("git", ["checkout", "--force", "--detach", job.sha]);
                await script("desktop.sh", "validate");
                if (job.channel === "nightly") await script("mobile.sh", "build");
                record.validated = true;
                await save(statePath, state);
            }
            status(job, phase, "success", "Local build and behavioral checks passed");
            if (job.publish && config.publish !== false) {
                phase = "release";
                status(job, phase, "pending", "Publishing validated artifacts from the build PC");
                if (canPublish(job, record, api(`branches/${job.channel}`).commit.sha)) {
                    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
                    const releaseEnv = { ...process.env, ...env, HOME: process.env.HOME, GITHUB_TOKEN: token, GH_TOKEN: token };
                    await run("bash", [join(controller, "desktop.sh"), "release"], { cwd: checkout, env: releaseEnv, log });
                    if (job.channel === "nightly") {
                        await run("bash", [join(controller, "mobile.sh"), "publish"], { cwd: checkout, env: releaseEnv, log });
                        if (!config.windowsInbox || !config.windowsOutput) throw new Error("Windows release queue is not configured");
                        const inbox = join(config.windowsInbox, record.runId);
                        await mkdir(inbox, { recursive: true });
                        await copyFile(join(checkout, "dist/desktop.asar"), join(inbox, "desktop.asar"));
                        const { createHash } = await import("node:crypto");
                        const asarHash = createHash("sha256").update(await readFile(join(inbox, "desktop.asar"))).digest("hex");
                        await writeFile(join(inbox, "desktop.asar.sha256"), `${asarHash}  desktop.asar\n`);
                        await save(join(inbox, "request.json"), { sha: job.sha, runId: record.runId });
                        const result = join(inbox, "result.json");
                        const deadline = Date.now() + 30 * 60_000;
                        let receipt;
                        while (!(receipt = await readJson(result, null)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5_000));
                        if (receipt?.sha !== job.sha || receipt?.success !== true) throw new Error(receipt?.error ?? "Windows installer build did not complete");
                        await mkdir(join(checkout, "dist/windows"), { recursive: true });
                        for (const name of ["ProtonnCordSetup.exe", "ProtonnCordSetup.json", "ProtonnCordSetup.exe.sha256", "ProtonnCordSetup-LICENSE.txt"])
                            await copyFile(join(config.windowsOutput, record.runId, name), join(checkout, "dist/windows", name));
                        await run("node", ["scripts/publishWindowsInstaller.mjs"], { cwd: checkout, env: releaseEnv, log });
                    }
                    record.published = true;
                    status(job, phase, "success", "Validated release artifacts published");
                } else status(job, phase, "error", "Branch advanced; stale build was not published");
            }
            record.complete = true;
        } catch (error) {
            record.failed = true;
            record.error = error.message;
            status(job, phase, "failure", error.message);
            console.error(`${key}: ${error.message}; log ${log}`);
        }
        await save(statePath, state);
    }
    // Local first-observed time replaces the retired Actions push-run timestamp.
    if (config.promote !== false && config.publish !== false) {
        const nightly = api("branches/nightly").commit.sha;
        const observed = state.observed.nightly;
        const green = (channel, sha) => state.jobs[`${channel}-${sha}`]?.published === true;
        if (observed?.sha === nightly && Date.now() - observed.since >= SOAK_MS && green("nightly", nightly)) {
            const staging = api("merges", "POST", { base: "staging", head: nightly, commit_message: `Promote ${nightly} to staging` });
            const stagingSha = api("branches/staging").commit.sha;
            if ((!staging || staging.sha === stagingSha) && green("staging", stagingSha) && api("branches/nightly").commit.sha === nightly)
                api("merges", "POST", { base: "main", head: stagingSha, commit_message: `Promote ${stagingSha} to main` });
        }
    }
    return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const configPath = process.env.PROTONN_CI_CONFIG;
    if (!configPath) throw new Error("Set PROTONN_CI_CONFIG to the private host configuration");
    const config = await readJson(configPath, null);
    if (!config?.stateRoot || !config.workRoot || !config.buildUser || !config.buildHome) throw new Error("Incomplete CI host configuration");
    const only = process.argv.find(argument => argument.startsWith("--only="))?.slice(7);
    await tick(config, { retry: process.argv.includes("--retry"), only });
}
