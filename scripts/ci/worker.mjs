// SPDX-License-Identifier: GPL-3.0-or-later
// Installed controller: credentials stay with this user; builds use a separate account.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
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

export function canPromote(record) {
    return record?.validated === true && record.published === true && record.complete === true && record.failed !== true;
}

const digest = data => createHash("sha256").update(data).digest("hex");

export async function verifyArtifacts(root, manifest) {
    if (!manifest || !Object.keys(manifest).length) throw new Error("Missing protected artifact evidence");
    for (const [name, hash] of Object.entries(manifest)) {
        const path = resolve(root, name);
        if (!path.startsWith(resolve(root) + sep) || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid artifact manifest");
        const file = await lstat(path);
        if (!file.isFile() || file.isSymbolicLink() || digest(await readFile(path)) !== hash) throw new Error(`Validated artifact changed: ${name}`);
    }
}

async function snapshotArtifacts(source, destination, mobile) {
    const manifest = {};
    let total = 0;
    const sourceRoot = await realpath(source);
    async function copy(name) {
        const from = join(source, name);
        if (!(await realpath(from)).startsWith(sourceRoot + sep)) throw new Error("Artifact escapes the build checkout");
        const info = await lstat(from);
        if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 512 * 1024 * 1024) throw new Error(`Invalid artifact: ${name}`);
        total += info.size;
        if (total > 1024 * 1024 * 1024) throw new Error("Artifact snapshot exceeds its budget");
        const bytes = await readFile(from);
        if (bytes.length !== info.size) throw new Error("Artifact changed while copying");
        await mkdir(dirname(join(destination, name)), { recursive: true, mode: 0o700 });
        await writeFile(join(destination, name), bytes, { mode: 0o600 });
        manifest[name] = digest(bytes);
    }
    async function directory(name) {
        const info = await lstat(join(source, name));
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid artifact directory");
        const files = await readdir(join(source, name));
        if (!files.length || files.length > 100) throw new Error("Invalid artifact count");
        for (const file of files) {
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(file)) throw new Error("Unsafe artifact name");
            await copy(`${name}/${file}`);
        }
    }
    await directory("dist/release");
    for (const name of ["extension-chrome.zip", "extension-firefox.zip", "extension-sources.zip", "archives.sha256", "release-sha.txt"]) await copy(`dist/${name}`);
    if (mobile) {
        await directory("mobile/build/dist");
        for (const name of ["ProtonnCord.apk", "build-receipt.json"]) await copy(`mobile/build/standalone/${name}`);
        await copy("mobile/build/reports/android-client/result.json");
        for (const name of ["ProtonnCordSetup.exe", "ProtonnCordSetup.json", "ProtonnCordSetup.exe.sha256", "ProtonnCordSetup-LICENSE.txt"]) await copy(`dist/windows/${name}`);
    }
    await verifyArtifacts(destination, manifest);
    return manifest;
}

async function windowsBuild(config, checkout, record, sha) {
    if (!config.windowsInbox || !config.windowsOutput) throw new Error("Windows release queue is not configured");
    const inbox = join(config.windowsInbox, record.runId);
    await mkdir(inbox, { recursive: true });
    const payload = await readFile(join(checkout, "dist/desktop.asar"));
    await writeFile(join(inbox, "desktop.asar"), payload);
    await writeFile(join(inbox, "desktop.asar.sha256"), `${digest(payload)}  desktop.asar\n`);
    await save(join(inbox, "request.json"), { sha, runId: record.runId });
    const deadline = Date.now() + 30 * 60_000;
    let receipt;
    while (!(receipt = await readJson(join(inbox, "result.json"), null)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5_000));
    if (receipt?.sha !== sha || receipt?.success !== true) throw new Error(receipt?.error ?? "Windows installer build did not complete");
    await mkdir(join(checkout, "dist/windows"), { recursive: true });
    for (const name of ["ProtonnCordSetup.exe", "ProtonnCordSetup.json", "ProtonnCordSetup.exe.sha256", "ProtonnCordSetup-LICENSE.txt"])
        await copyFile(join(config.windowsOutput, record.runId, name), join(checkout, "dist/windows", name));
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
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    if ((await stat(stateRoot)).mode & 0o077) throw new Error("Controller state must be private (mode 700)");
    if (Object.keys(config.buildEnv ?? {}).some(name => /^(?:GH_|GITHUB_|HOME$|PATH$|CI$)/u.test(name))) throw new Error("Build environment overrides controller identity or credentials");
    const statePath = join(stateRoot, "state.json");
    const state = await readJson(statePath, { jobs: {}, observed: {}, nextNumber: 10000 });
    const heads = Object.fromEntries(CHANNELS.map(channel => [channel, api(`branches/${channel}`).commit.sha]));
    const pulls = api("pulls?state=open&per_page=100");
    const jobs = selectJobs(heads, pulls).filter(job => !only || job.key === only);
    for (const channel of CHANNELS) {
        if (state.observed[channel]?.sha !== heads[channel]) state.observed[channel] = { sha: heads[channel], since: Date.now() };
    }
    await save(statePath, state);
    const status = (job, phase, result, description) => {
        try { api(`statuses/${job.sha}`, "POST", { state: result, context: `other-pc/${phase}/${job.key}`, description: description.slice(0, 140) }); }
        catch { console.error(`Cannot report ${phase}/${job.key} status; durable local evidence is retained.`); }
    };
    for (const job of jobs) {
        const key = `${job.key}-${job.sha}`;
        let record = state.jobs[key];
        if ((record?.complete && !retry) || (record?.failed && !retry)) continue;
        // Failed validation always gets fresh build and native output directories.
        if (!record || (!record.validated && retry)) record = state.jobs[key] = { sha: job.sha, runId: String(Date.now()), number: String(state.nextNumber++), attempt: "1" };
        record.failed = false;
        record.published = false;
        record.complete = false;
        await save(statePath, state);
        const checkout = join(workRoot, `${key}-${record.runId}`);
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
                if (job.channel === "nightly") {
                    await script("mobile.sh", "build");
                    await windowsBuild(config, checkout, record, job.sha);
                }
                // Fetch executable publication code independently of the build account.
                // Only validated inert artifacts cross into this private source snapshot.
                record.snapshot = join(stateRoot, `validated-${record.runId}`);
                const publicEnv = { HOME: process.env.HOME, PATH: env.PATH, CI: "true" };
                await run("git", ["-c", "credential.helper=", "clone", "--filter=blob:none", "--no-checkout", `https://github.com/${REPOSITORY}.git`, record.snapshot], { env: publicEnv, log });
                await run("git", ["-c", "credential.helper=", "fetch", "--no-tags", "origin", job.sha], { cwd: record.snapshot, env: publicEnv, log });
                await run("git", ["checkout", "--detach", job.sha], { cwd: record.snapshot, env: publicEnv, log });
                await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: record.snapshot, env: publicEnv, log });
                record.manifest = await snapshotArtifacts(checkout, record.snapshot, job.channel === "nightly");
                record.validated = true;
                await save(statePath, state);
            }
            if (dirname(record.snapshot ?? "") !== stateRoot) throw new Error("Invalid protected publication snapshot");
            await verifyArtifacts(record.snapshot, record.manifest);
            status(job, phase, "success", "Local build and behavioral checks passed");
            if (job.publish && config.publish !== false) {
                phase = "release";
                status(job, phase, "pending", "Publishing validated artifacts from the build PC");
                if (canPublish(job, record, api(`branches/${job.channel}`).commit.sha)) {
                    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
                    const releaseEnv = { ...process.env, ...env, HOME: process.env.HOME, GITHUB_TOKEN: token, GH_TOKEN: token };
                    await run("bash", [join(controller, "desktop.sh"), "release"], { cwd: record.snapshot, env: releaseEnv, log });
                    if (job.channel === "nightly") {
                        await run("bash", [join(controller, "mobile.sh"), "publish"], { cwd: record.snapshot, env: releaseEnv, log });
                        await run("node", ["scripts/publishWindowsInstaller.mjs"], { cwd: record.snapshot, env: releaseEnv, log });
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
        const green = (channel, sha) => canPromote(state.jobs[`${channel}-${sha}`]);
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
