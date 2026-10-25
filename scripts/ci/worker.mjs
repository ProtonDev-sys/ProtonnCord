// SPDX-License-Identifier: GPL-3.0-or-later
// Installed controller: credentials stay with this user; builds use a separate account.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyWindowsPayload } from "./windows-payload.mjs";

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

export async function readBuildArtifact(source, name, maximum = 512 * 1024 * 1024) {
    if (await realpath(source) !== resolve(source)) throw new Error("Build artifact root cannot be a link");
    const handle = await open(join(source, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const actual = await realpath(`/proc/self/fd/${handle.fd}`);
        if (!actual.startsWith(resolve(source) + sep)) throw new Error("Artifact escapes the build checkout");
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > maximum) throw new Error(`Invalid artifact: ${name}`);
        const bytes = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const result = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!result.bytesRead) break;
            offset += result.bytesRead;
        }
        if (offset !== info.size) throw new Error("Artifact changed while copying");
        return bytes.subarray(0, offset);
    } finally { await handle.close(); }
}

export async function verifyArtifacts(root, manifest) {
    if (!manifest || !Object.keys(manifest).length) throw new Error("Missing protected artifact evidence");
    for (const [name, hash] of Object.entries(manifest)) {
        const path = resolve(root, name);
        if (!path.startsWith(resolve(root) + sep) || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid artifact manifest");
        const file = await lstat(path);
        if (!file.isFile() || file.isSymbolicLink() || digest(await readFile(path)) !== hash) throw new Error(`Validated artifact changed: ${name}`);
    }
}

async function snapshotArtifacts(source, destination, mobile, nativeSource) {
    const manifest = {};
    let total = 0;
    async function copy(name, origin = source, input = name) {
        const bytes = await readBuildArtifact(origin, input);
        total += bytes.length;
        if (total > 1024 * 1024 * 1024) throw new Error("Artifact snapshot exceeds its budget");
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
        for (const name of ["ProtonnCordSetup.exe", "ProtonnCordSetup.json", "ProtonnCordSetup.exe.sha256", "ProtonnCordSetup-LICENSE.txt", "windows.sha256", "windows-build.json", "bootstrap.cjs"])
            await copy(`dist/windows/${name}`, nativeSource, name);
        const metadata = JSON.parse(await readFile(join(destination, "dist/windows/ProtonnCordSetup.json"), "utf8"));
        const receipt = JSON.parse(await readFile(join(destination, "dist/windows/windows-build.json"), "utf8"));
        const executable = await readFile(join(destination, "dist/windows/ProtonnCordSetup.exe"));
        const payload = await readFile(join(destination, "dist/release/desktop.asar"));
        verifyWindowsPayload(executable, payload);
        const payloadHash = digest(payload);
        const expected = `${digest(executable)}  ProtonnCordSetup.exe\n`;
        if (metadata.commit !== (await readFile(join(destination, "dist/release-sha.txt"), "utf8")).trim()
            || metadata.updateBranch !== "nightly" || metadata.archiveSha256 !== payloadHash
            || receipt.commit !== metadata.commit || receipt.payloadSha256 !== payloadHash || receipt.installerSmoke !== "not-run"
            || executable.subarray(0, 2).toString() !== "MZ"
            || await readFile(join(destination, "dist/windows/ProtonnCordSetup.exe.sha256"), "utf8") !== expected)
            throw new Error("Private Windows artifact identity mismatch");
        const checksums = (await readFile(join(destination, "dist/windows/windows.sha256"), "utf8")).trim().split("\n");
        const expectedNames = ["ProtonnCordSetup.exe", "ProtonnCordSetup.exe.sha256", "ProtonnCordSetup.json", "ProtonnCordSetup-LICENSE.txt", "bootstrap.cjs"];
        const actualNames = checksums.map(entry => entry.slice(66));
        if (actualNames.length !== expectedNames.length || new Set(actualNames).size !== expectedNames.length || !expectedNames.every(name => actualNames.includes(name))) throw new Error("Windows output manifest is incomplete");
        for (const entry of checksums) {
            const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(entry);
            if (!match || match[2] === "windows.sha256" || digest(await readFile(join(destination, "dist/windows", match[2]))) !== match[1]) throw new Error("Private Windows output checksum mismatch");
        }
    }
    await verifyArtifacts(destination, manifest);
    return manifest;
}

async function windowsBuild(config, checkout, record, sha) {
    if (!config.windowsInbox || !config.windowsOutput) throw new Error("Windows release queue is not configured");
    const inbox = join(config.windowsInbox, record.runId);
    await mkdir(inbox, { recursive: true });
    const payload = await readBuildArtifact(checkout, "dist/desktop.asar", 128 * 1024 * 1024);
    await writeFile(join(inbox, "desktop.asar"), payload);
    await writeFile(join(inbox, "desktop.asar.sha256"), `${digest(payload)}  desktop.asar\n`);
    await save(join(inbox, "request.json"), { sha, runId: record.runId });
    const deadline = Date.now() + 30 * 60_000;
    let receipt;
    while (!(receipt = await readJson(join(inbox, "result.json"), null)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5_000));
    if (receipt?.sha !== sha || receipt?.success !== true) throw new Error(receipt?.error ?? "Windows installer build did not complete");
    return join(config.windowsOutput, record.runId);
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
        for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { if (output) output.write(data); else process.stdout.write(data); });
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
    const resolver = await realpath("/etc/resolv.conf");
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
        const needsPublication = job.publish && config.publish !== false && !record?.published;
        if ((record?.complete && !retry && !needsPublication) || (record?.failed && !retry)) continue;
        // Failed validation always gets fresh build and native output directories.
        if (!record?.validated) record = state.jobs[key] = { sha: job.sha, runId: String(Date.now()), number: String(state.nextNumber++), attempt: "1" };
        record.failed = false;
        record.published = false;
        record.complete = false;
        delete record.error;
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
        const build = (command, args, cwd = checkout) => {
            const sandbox = ["-n", "-u", config.buildUser, "bwrap", "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
                "--ro-bind", "/", "/", "--tmpfs", "/mnt", "--tmpfs", "/run", "--tmpfs", "/home", "--tmpfs", "/tmp", "--proc", "/proc", "--dev-bind", "/dev", "/dev",
                "--bind", config.buildHome, config.buildHome];
            // WSL links resolv.conf into /mnt; expose this one inert file only.
            if (resolver !== "/etc/resolv.conf") sandbox.push("--dir", dirname(resolver), "--ro-bind", resolver, resolver);
            if (env.ANDROID_HOME) sandbox.push("--ro-bind", env.ANDROID_HOME, env.ANDROID_HOME);
            sandbox.push("--cap-drop", "ALL", "--chdir", cwd, "--clearenv");
            for (const [key, value] of Object.entries(env)) sandbox.push("--setenv", key, value);
            return run("sudo", [...sandbox, command, ...args], { log });
        };
        const script = (name, mode) => build("bash", [join(controller, name), mode]);
        let phase = "ci";
        try {
            status(job, phase, "pending", "Validating on the local build PC");
            console.log(`Validating ${key}; log ${log}`);
            if (!record.validated) {
                if (!await stat(checkout).catch(() => null)) await build("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${REPOSITORY}.git`, checkout], workRoot);
                await build("git", ["-c", "credential.helper=", "fetch", "--no-tags", "origin", job.ref]);
                await build("git", ["checkout", "--force", "--detach", job.sha]);
                await script("desktop.sh", "validate");
                let nativeSource;
                if (job.channel === "nightly") {
                    // WSL recreates this device at startup; grant only the build account.
                    if (!/^[a-z_][a-z0-9_-]*$/u.test(config.buildUser)) throw new Error("Invalid build account");
                    await run("sudo", ["-n", "setfacl", "-m", `u:${config.buildUser}:rw`, "/dev/kvm"], { log });
                    await script("mobile.sh", "build");
                    nativeSource = await windowsBuild(config, checkout, record, job.sha);
                }
                // Fetch executable publication code independently of the build account.
                // Only validated inert artifacts cross into this private source snapshot.
                record.snapshot = join(stateRoot, `validated-${record.runId}`);
                const publicEnv = { HOME: process.env.HOME, PATH: env.PATH, CI: "true" };
                await run("git", ["-c", "credential.helper=", "clone", "--filter=blob:none", "--no-checkout", `https://github.com/${REPOSITORY}.git`, record.snapshot], { env: publicEnv, log });
                await run("git", ["-c", "credential.helper=", "fetch", "--no-tags", "origin", job.sha], { cwd: record.snapshot, env: publicEnv, log });
                await run("git", ["checkout", "--detach", job.sha], { cwd: record.snapshot, env: publicEnv, log });
                await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: record.snapshot, env: publicEnv, log });
                record.manifest = await snapshotArtifacts(checkout, record.snapshot, job.channel === "nightly", nativeSource);
                record.validated = true;
                await save(statePath, state);
            }
            if (dirname(record.snapshot ?? "") !== stateRoot) throw new Error("Invalid protected publication snapshot");
            await verifyArtifacts(record.snapshot, record.manifest);
            status(job, phase, "success", "Local build and behavioral checks passed");
            console.log(`${key}: validation passed`);
            if (job.publish && config.publish !== false) {
                phase = "release";
                status(job, phase, "pending", "Publishing validated artifacts from the build PC");
                if (canPublish(job, record, api(`branches/${job.channel}`).commit.sha)) {
                    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
                    const releaseEnv = { ...process.env, ...env, HOME: process.env.HOME, PROTONN_CI_RETRY: retry ? "1" : "0", GITHUB_TOKEN: token, GH_TOKEN: token };
                    await run("bash", [join(controller, "desktop.sh"), "release"], { cwd: record.snapshot, env: releaseEnv, log });
                    if (job.channel === "nightly") {
                        await run("bash", [join(controller, "mobile.sh"), "publish"], { cwd: record.snapshot, env: releaseEnv, log });
                        await run("node", ["scripts/publishWindowsInstaller.mjs"], { cwd: record.snapshot, env: releaseEnv, log });
                    }
                    if (api(`branches/${job.channel}`).commit.sha !== job.sha) throw new Error("Branch advanced during publication; promotion is blocked");
                    record.published = true;
                    status(job, phase, "success", "Validated release artifacts published");
                    console.log(`${key}: release published`);
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
