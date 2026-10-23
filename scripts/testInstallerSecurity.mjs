import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
    ensureCachedArtifact,
    EQUILOTL_ARTIFACTS,
    EQUILOTL_RELEASE,
    getArtifact,
    getInstallerArgs,
    prepareInstaller,
    runInstaller,
} from "./runInstaller.mjs";

function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function fixtureArtifact(bytes, overrides = {}) {
    return {
        assetId: 123456789,
        executable: false,
        filename: "installer-fixture.bin",
        sha256: digest(bytes),
        size: bytes.byteLength,
        ...overrides,
    };
}

function byteResponse(bytes, headers = {}) {
    return new Response(new Uint8Array(bytes), { headers });
}

async function assertNoTemporaryFiles(directory) {
    const names = await readdir(directory);
    assert.equal(names.some(name => name.endsWith(".tmp")), false, "installer temporary files must be cleaned");
}

function testReleasePin() {
    assert.deepEqual(EQUILOTL_RELEASE, {
        commit: "c6bfed9c941883fb0aa48cc1ab6031ed69334c2a",
        tag: "v2.2.6",
    });
    assert.equal(getArtifact("win32", "x64"), EQUILOTL_ARTIFACTS.win32);
    assert.equal(getArtifact("linux", "x64"), EQUILOTL_ARTIFACTS.linux);
    assert.equal(getArtifact("darwin", "x64"), EQUILOTL_ARTIFACTS.darwinX64);
    assert.equal(getArtifact("darwin", "arm64"), EQUILOTL_ARTIFACTS.darwinArm64);
    assert.throws(() => getArtifact("darwin", "riscv64"), /Unsupported macOS architecture/u);
    assert.throws(() => getArtifact("freebsd", "x64"), /Unsupported platform/u);

    const assetIds = new Set();
    for (const artifact of Object.values(EQUILOTL_ARTIFACTS)) {
        assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
        assert.ok(Number.isSafeInteger(artifact.assetId) && artifact.assetId > 0);
        assert.ok(Number.isSafeInteger(artifact.size) && artifact.size > 0);
        assetIds.add(artifact.assetId);
    }
    assert.equal(assetIds.size, Object.keys(EQUILOTL_ARTIFACTS).length);
    assert.deepEqual(getInstallerArgs(["node", "runInstaller.mjs", "--", "--repair"]), ["--repair"]);
    assert.deepEqual(getInstallerArgs(["node", "runInstaller.mjs"]), []);
}

async function testStandaloneLinuxPin() {
    const source = await readFile(new URL("../misc/install.sh", import.meta.url), "utf8");
    const pin = name => {
        const value = new RegExp(`^${name}='([^']+)'$`, "mu").exec(source)?.[1];
        assert.ok(value, `Missing standalone installer pin: ${name}`);
        return value;
    };
    const { linux } = EQUILOTL_ARTIFACTS;
    assert.equal(pin("INSTALLER_RELEASE"), EQUILOTL_RELEASE.tag);
    assert.equal(pin("INSTALLER_ASSET_ID"), String(linux.assetId));
    assert.equal(pin("INSTALLER_SIZE"), String(linux.size));
    assert.equal(pin("INSTALLER_SHA256"), linux.sha256);
    assert.equal(pin("INSTALLER_NAME"), linux.filename);
}

async function testStandaloneLinuxPayload(root) {
    const bash = process.env.AUDIT_BASH ?? (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");
    const available = spawnSync(bash, ["--noprofile", "--norc", "-c", "command -v jq"], { encoding: "utf8" });
    if (process.platform === "win32" && (available.error || available.status !== 0)) {
        console.log("Standalone Linux behavior checks skipped: bash and jq are required (set AUDIT_BASH/PATH).");
        return;
    }
    assert.ifError(available.error);
    assert.equal(available.status, 0, "Standalone Linux behavior checks require jq");
    const source = await readFile(new URL("../misc/install.sh", import.meta.url), "utf8");
    const installer = Buffer.from(`#!/bin/bash
set -eu
[[ "$EQUICORD_DEV_INSTALL" == 1 && "$EQUICORD_DIRECTORY" == "$EQUICORD_USER_DATA_DIR/desktop.asar" ]]
printf 'executed' > "$SHELL_FIXTURE/installer-ran"
printf '%s\\0' "$@" > "$SHELL_FIXTURE/installer-args"
if [[ -f "$EQUICORD_DIRECTORY" ]]; then
    cp -- "$EQUICORD_DIRECTORY" "$SHELL_FIXTURE/installer-archive"
fi
[[ "\${FAIL_INSTALLER:-}" != 1 ]] || exit 42
`);
    const payload = Buffer.from("inert Protonn Cord archive fixture\n");
    const previous = Buffer.from("previous working archive");
    const release = (tag = "latest") => ({
        tag_name: tag, draft: false, prerelease: tag !== "latest",
        assets: [{
            id: 987654321, name: "desktop.asar", state: "uploaded", size: payload.length,
            digest: `sha256:${digest(payload)}`,
            browser_download_url: `https://github.com/ProtonDev-sys/ProtonnCord/releases/download/${tag}/desktop.asar`,
        }],
    });
    const shellPath = path => path.replaceAll("\\", "/").replace(/^([a-z]):/iu, (_match, drive) => `/${drive.toLowerCase()}`);
    // All network/privilege calls are inert functions. Replace the reviewed pin
    // and root guard so the same offline behavior also runs in root-owned CI.
    const fixtureSource = source
        .replace(/^INSTALLER_SIZE='[^']+'$/mu, `INSTALLER_SIZE='${installer.length}'`)
        .replace(/^INSTALLER_SHA256='[^']+'$/mu, `INSTALLER_SHA256='${digest(installer)}'`)
        .replace('if [[ "$EUID" -eq 0 ]]; then', "if false; then");
    const harness = `
command() {
    if [[ "\${NO_JQ:-}" == 1 && "$1" == -v && "\${2:-}" == jq ]]; then return 1; fi
    builtin command "$@"
}
jq() {
    printf '%s\\0' "$@" >> "$SHELL_FIXTURE/jq.calls"
    [[ "\${NO_JQ:-}" != 1 ]] || return 127
    command jq ${process.platform === "win32" ? "--binary " : ""}"$@"
}
curl() {
    printf '%s\\0' "$@" >> "$SHELL_FIXTURE/curl.calls"
    local output='' url="\${!#}" stage='' fixture=''
    while (( $# )); do
        if [[ "$1" == --output ]]; then output=$2; shift; fi
        shift
    done
    case "$url" in
        https://api.github.com/repos/Equicord/Equilotl/releases/assets/444851621) stage=installer; fixture=installer.bin ;;
        https://api.github.com/repos/ProtonDev-sys/ProtonnCord/releases/tags/latest|https://api.github.com/repos/ProtonDev-sys/ProtonnCord/releases/tags/nightly|https://api.github.com/repos/ProtonDev-sys/ProtonnCord/releases/tags/staging) stage=metadata; fixture=release.json ;;
        https://api.github.com/repos/ProtonDev-sys/ProtonnCord/releases/assets/987654321) stage=payload; fixture=payload.bin ;;
        *) printf 'Unexpected download: %s\\n' "$url" >&2; return 99 ;;
    esac
    [[ "\${FAIL_DOWNLOAD:-}" != all && "\${FAIL_DOWNLOAD:-}" != "$stage" ]] || return 22
    cp -- "$SHELL_FIXTURE/$fixture" "$output"
}
mv() {
    case "\${@: -2:1}" in
        */previous.asar) [[ "\${FAIL_ROLLBACK:-}" != 1 ]] || return 1 ;;
        */desktop.asar) [[ "\${FAIL_ACTIVATION:-}" != 1 ]] || return 1 ;;
    esac
    command mv "$@"
}
cp() {
    if [[ "\${FAIL_BACKUP:-}" == 1 && "\${!#}" == */previous.asar ]]; then
        printf 'incomplete backup' > "\${!#}"
        return 1
    fi
    command cp "$@"
}
sudo() {
    printf '%s\\0' "$@" > "$SHELL_FIXTURE/privileged-args"
    [[ "\${DENY_PRIVILEGE:-}" != 1 ]] || return 77
    if [[ -n "\${PRIVILEGE_SIGNAL:-}" ]]; then kill -s "$PRIVILEGE_SIGNAL" "$$"; fi
    [[ "$1" == -- ]] || return 98
    shift
    "$@"
}
`;
    const scenarios = [
        { name: "verified stable payload", success: true, branch: "main" },
        { name: "initial install", success: true, noArchive: true, noSettings: true },
        { name: "nightly channel", success: true, branch: "nightly" },
        { name: "staging channel", success: true, branch: "staging" },
        { name: "unknown saved channel", branch: "unsupported" },
        { name: "invalid settings JSON", settings: "{" },
        ...["--help", "-h", "--h", "-help", "--help=true", "--version", "-version"].map(argument => ({
            name: `offline ${argument}`, success: true, informational: true, args: [argument],
            cachedInstaller: true, failDownload: "all", noJq: true, dataDirectory: "relative/unused", settings: "{",
        })),
        { name: "help false still provisions", success: true, args: ["--help", "--help=false", "--install"] },
        ...["--uninstall", "-uninstall", "--uninstall=true"].map(argument => ({
            name: `offline ${argument}`, success: true, uninstall: true, args: [argument],
            cachedInstaller: true, failDownload: "all", noJq: true,
        })),
        { name: "uninstall without archive", success: true, uninstall: true, args: ["--uninstall"], noArchive: true, noJq: true },
        { name: "uninstall false still provisions", success: true, args: ["--uninstall=false", "--install"] },
        { name: "denied elevation restores archive", denyPrivilege: true, elevated: true, status: 77 },
        { name: "failed CLI restores archive", failInstaller: true, elevated: true, executed: true, status: 42 },
        { name: "denied initial elevation retains archive", denyPrivilege: true, noArchive: true, elevated: true, status: 77, retainPayload: true },
        { name: "failed initial CLI retains archive", failInstaller: true, noArchive: true, elevated: true, executed: true, status: 42, retainPayload: true },
        ...[["HUP", 129], ["INT", 130], ["TERM", 143]].map(([signal, status]) => ({
            name: `${signal} restores archive`, signal, status, elevated: true,
        })),
        { name: "failed rollback retains recovery copy", failInstaller: true, failRollback: true, elevated: true, executed: true, status: 42, retainPayload: true },
        { name: "failed activation restores archive", failActivation: true },
        { name: "failed backup preserves archive", failBackup: true },
        { name: "same-size corrupt payload", payload: Buffer.alloc(payload.length, 65) },
        { name: "truncated payload", payload: payload.subarray(1) },
        { name: "oversized payload", payload: Buffer.concat([payload, Buffer.from("extra")]) },
        { name: "failed payload download", failDownload: "payload" },
        { name: "failed metadata download", failDownload: "metadata" },
        { name: "corrupt installer", installer: Buffer.alloc(installer.length, 65) },
        { name: "invalid metadata JSON", metadata: "{" },
        { name: "missing digest", mutate: metadata => { delete metadata.assets[0].digest; } },
        { name: "oversized metadata size", mutate: metadata => { metadata.assets[0].size = 67108865; } },
        { name: "noninteger size", mutate: metadata => { metadata.assets[0].size = 1.5; } },
        { name: "untrusted asset path", mutate: metadata => { metadata.assets[0].name = "../desktop.asar"; } },
        { name: "foreign asset URL", mutate: metadata => { metadata.assets[0].browser_download_url = "https://github.com/Equicord/Equicord/releases/download/latest/desktop.asar"; } },
        { name: "malformed asset ID", mutate: metadata => { metadata.assets[0].id = "../../outside"; } },
        { name: "duplicate archive", mutate: metadata => { metadata.assets.push({ ...metadata.assets[0] }); } },
        { name: "draft release", mutate: metadata => { metadata.draft = true; } },
        { name: "prerelease", mutate: metadata => { metadata.prerelease = true; } },
        { name: "wrong channel", mutate: metadata => { metadata.tag_name = "nightly"; } },
        { name: "relative data directory", dataDirectory: "relative/path" },
    ];
    for (const [index, scenario] of scenarios.entries()) {
        const directory = join(root, `shell fixture ${index}`);
        const home = join(directory, "home");
        const dataDirectory = join(home, ".config", "ProtonnCord");
        const settingsDirectory = join(dataDirectory, "settings");
        await mkdir(settingsDirectory, { recursive: true });
        const settings = scenario.settings ?? JSON.stringify({
            plugins: { unknown: { enabled: true } }, saved: "preserve", updateBranch: scenario.branch,
        });
        if (!scenario.noSettings) await writeFile(join(settingsDirectory, "settings.json"), settings);
        await writeFile(join(settingsDirectory, "quickCss.css"), "/* preserved */");
        if (!scenario.noArchive) await writeFile(join(dataDirectory, "desktop.asar"), previous);
        await writeFile(join(directory, "installer.bin"), scenario.installer ?? installer);
        await writeFile(join(directory, "payload.bin"), scenario.payload ?? payload);
        const metadata = release(["nightly", "staging"].includes(scenario.branch) ? scenario.branch : "latest");
        scenario.mutate?.(metadata);
        await writeFile(join(directory, "release.json"), scenario.metadata ?? JSON.stringify(metadata));
        const cacheDirectory = join(directory, "cache", "protonncord", "installer", EQUILOTL_RELEASE.tag);
        if (scenario.cachedInstaller) {
            await mkdir(cacheDirectory, { recursive: true });
            await writeFile(join(cacheDirectory, EQUILOTL_ARTIFACTS.linux.filename), installer);
        }
        const installerArgs = [...(scenario.args ?? ["--install"]), "--location", "/a Discord/location"];
        const result = spawnSync(bash, ["--noprofile", "--norc", "-s", "--", ...installerArgs], {
            input: harness + fixtureSource, encoding: "utf8", timeout: 15000,
            env: {
                ...process.env, HOME: shellPath(home), SHELL_FIXTURE: shellPath(directory),
                XDG_CACHE_HOME: shellPath(join(directory, "cache")), XDG_CONFIG_HOME: "",
                DISCORD_USER_DATA_DIR: "", EQUICORD_USER_DATA_DIR: "", PROTONN_CORD_USER_DATA_DIR: scenario.dataDirectory ?? "",
                EQUICORD_DIRECTORY: "/untrusted/inherited.asar", EQUICORD_DEV_INSTALL: "0",
                FAIL_DOWNLOAD: scenario.failDownload ?? "",
                NO_JQ: scenario.noJq ? "1" : "", DENY_PRIVILEGE: scenario.denyPrivilege ? "1" : "",
                FAIL_INSTALLER: scenario.failInstaller ? "1" : "", PRIVILEGE_SIGNAL: scenario.signal ?? "",
                FAIL_ROLLBACK: scenario.failRollback ? "1" : "", FAIL_ACTIVATION: scenario.failActivation ? "1" : "",
                FAIL_BACKUP: scenario.failBackup ? "1" : "",
            },
        });
        assert.ifError(result.error);
        assert.equal(result.status === 0, scenario.success === true, `${scenario.name}: ${result.stderr}`);
        if (scenario.status) assert.equal(result.status, scenario.status, scenario.name);
        const privileged = join(directory, "privileged-args");
        assert.equal(existsSync(privileged), (scenario.success === true && !scenario.informational) || scenario.elevated === true, `${scenario.name}: elevation gate`);
        assert.equal(existsSync(join(directory, "installer-ran")), scenario.success === true || scenario.executed === true, `${scenario.name}: execution gate`);
        const expectedArchive = scenario.retainPayload || (scenario.success && !scenario.uninstall && !scenario.informational) ? payload : scenario.noArchive ? null : previous;
        if (expectedArchive) assert.deepEqual(await readFile(join(dataDirectory, "desktop.asar")), expectedArchive, scenario.name);
        else assert.equal(existsSync(join(dataDirectory, "desktop.asar")), false, scenario.name);
        if (!scenario.noSettings) assert.equal(await readFile(join(settingsDirectory, "settings.json"), "utf8"), settings);
        else assert.equal(existsSync(join(settingsDirectory, "settings.json")), false, "installer must not create settings");
        assert.equal(await readFile(join(settingsDirectory, "quickCss.css"), "utf8"), "/* preserved */");
        const staging = (await readdir(dataDirectory)).filter(name => name.startsWith(".install."));
        if (scenario.failRollback) {
            assert.equal(staging.length, 1, "failed rollback must retain its recovery directory");
            assert.deepEqual(await readdir(join(dataDirectory, staging[0])), ["previous.asar"]);
            assert.deepEqual(await readFile(join(dataDirectory, staging[0], "previous.asar")), previous);
            assert.ok(result.stderr.includes(`${shellPath(dataDirectory)}/${staging[0]}/previous.asar`), "report the recovery path");
        } else {
            assert.deepEqual(staging, [], `${scenario.name}: payload staging must be cleaned`);
        }
        assert.equal((await readdir(cacheDirectory)).some(name => name.startsWith(".install.")), false, "installer staging must be cleaned");
        if (existsSync(privileged)) {
            const args = (await readFile(privileged, "utf8")).split("\0").slice(0, -1);
            assert.deepEqual(args.slice(0, 5), [
                "--", "/usr/bin/env", "EQUICORD_DEV_INSTALL=1",
                `EQUICORD_DIRECTORY=${shellPath(dataDirectory)}/desktop.asar`, `EQUICORD_USER_DATA_DIR=${shellPath(dataDirectory)}`,
            ]);
            assert.match(args[5], /\/\.install\.[^/]+\/EquilotlCli-linux$/u);
            assert.deepEqual(args.slice(6), installerArgs, "arguments must survive as separate values");
        }
        const downloads = existsSync(join(directory, "curl.calls")) ? (await readFile(join(directory, "curl.calls"), "utf8")).split("\0") : [];
        if (scenario.uninstall || scenario.informational) {
            assert.equal(downloads.some(arg => arg.includes("/ProtonnCord/")), false, `${scenario.name}: must not request Protonn metadata or payload`);
            assert.equal(existsSync(join(directory, "jq.calls")), false, `${scenario.name}: must not require jq`);
            if (scenario.cachedInstaller) assert.deepEqual(downloads, [], `${scenario.name}: must work completely offline`);
        } else if (scenario.success) {
            const tag = ["nightly", "staging"].includes(scenario.branch) ? scenario.branch : "latest";
            assert.ok(downloads.includes(`https://api.github.com/repos/ProtonDev-sys/ProtonnCord/releases/tags/${tag}`), scenario.name);
            assert.ok(downloads.includes("https://api.github.com/repos/ProtonDev-sys/ProtonnCord/releases/assets/987654321"));
            assert.ok(downloads.includes(String(payload.length)), "payload download must have the expected size limit");
        }
        if (existsSync(join(directory, "installer-ran"))) {
            assert.deepEqual((await readFile(join(directory, "installer-args"), "utf8")).split("\0").slice(0, -1), installerArgs);
        }
        if (scenario.informational) {
            assert.equal(existsSync(join(directory, "installer-archive")), false, "informational CLI must not access the installed archive");
        } else if (scenario.executed || (scenario.success && !scenario.noArchive) || (scenario.success && !scenario.uninstall)) {
            assert.deepEqual(await readFile(join(directory, "installer-archive")), scenario.uninstall ? previous : payload, "CLI must see the selected archive before rollback");
        }
    }
    console.log(`Standalone Linux payload checks passed (${scenarios.length} offline scenarios)`);
}

async function testVerifiedCache(root) {
    const cacheDirectory = join(root, "verified-cache");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, reviewed);

    let fetchCalls = 0;
    const result = await ensureCachedArtifact(artifact, {
        cacheDirectory,
        fetcher: async () => {
            fetchCalls++;
            throw new Error("A verified cache must not perform a download.");
        },
    });
    assert.equal(result, outputPath);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(await readFile(outputPath), reviewed);
}

async function testVerifiedReplacement(root) {
    const cacheDirectory = join(root, "verified-replacement");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, Buffer.from("tampered"));

    let fetchCalls = 0;
    await ensureCachedArtifact(artifact, {
        cacheDirectory,
        fetcher: async (url, init) => {
            fetchCalls++;
            assert.equal(url, `https://api.github.com/repos/Equicord/Equilotl/releases/assets/${artifact.assetId}`);
            assert.doesNotMatch(url, /latest/iu);
            assert.equal(init.credentials, "omit");
            assert.equal(init.redirect, "follow");
            assert.ok(init.signal instanceof AbortSignal);
            assert.equal(new Headers(init.headers).get("Accept"), "application/octet-stream");
            return byteResponse(reviewed, { "Content-Length": String(reviewed.byteLength) });
        },
    });

    assert.equal(fetchCalls, 1);
    assert.deepEqual(await readFile(outputPath), reviewed);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testDigestFailurePreservesCache(root) {
    const cacheDirectory = join(root, "digest-failure");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);

    await assert.rejects(
        ensureCachedArtifact(artifact, {
            cacheDirectory,
            fetcher: async () => byteResponse(Buffer.from("attacker")),
        }),
        /failed SHA-256 verification/iu,
    );
    assert.deepEqual(await readFile(outputPath), previous, "an unverified download must not replace the cache");
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testStreamingLimitPreservesCache(root) {
    const cacheDirectory = join(root, "streaming-limit");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);
    let cancelled = false;

    await assert.rejects(
        ensureCachedArtifact(artifact, {
            cacheDirectory,
            fetcher: async () => new Response(new ReadableStream({
                cancel() {
                    cancelled = true;
                },
                pull(controller) {
                    controller.enqueue(new Uint8Array(reviewed.byteLength + 1));
                },
            })),
        }),
        /exceeded the 8 byte limit/iu,
    );
    assert.equal(cancelled, true, "an oversized response stream must be cancelled");
    assert.deepEqual(await readFile(outputPath), previous);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testTimeoutPreservesCache(root) {
    const cacheDirectory = join(root, "timeout");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);

    const fetcher = (_url, init) => new Promise((_resolve, reject) => {
        const rejectOnAbort = () => reject(init.signal.reason);
        if (init.signal.aborted) rejectOnAbort();
        else init.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    await assert.rejects(
        ensureCachedArtifact(artifact, { cacheDirectory, fetcher, timeoutMs: 5 }),
        /download timed out/iu,
    );
    assert.deepEqual(await readFile(outputPath), previous);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testBodyTimeoutPreservesCache(root) {
    const cacheDirectory = join(root, "body-timeout");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);
    let cancelled = false;

    await assert.rejects(
        ensureCachedArtifact(artifact, {
            cacheDirectory,
            fetcher: async () => new Response(new ReadableStream({
                cancel() {
                    cancelled = true;
                },
            })),
            timeoutMs: 5,
        }),
        /download timed out/iu,
    );
    assert.equal(cancelled, true, "a stalled response body must be cancelled at the deadline");
    assert.deepEqual(await readFile(outputPath), previous);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testActivationFailurePreservesCache(root) {
    const cacheDirectory = join(root, "activation-failure");
    await mkdir(cacheDirectory);
    const reviewed = Buffer.from("reviewed");
    const previous = Buffer.from("previous");
    const artifact = fixtureArtifact(reviewed);
    const outputPath = join(cacheDirectory, artifact.filename);
    await writeFile(outputPath, previous);

    await assert.rejects(
        ensureCachedArtifact(artifact, {
            cacheDirectory,
            fetcher: async () => byteResponse(reviewed),
            renameFile: async () => {
                throw new Error("simulated atomic rename failure");
            },
        }),
        /Could not activate the verified installer download/iu,
    );
    assert.deepEqual(await readFile(outputPath), previous);
    await assertNoTemporaryFiles(cacheDirectory);
}

async function testVerificationPrecedesExtraction(root) {
    const cacheDirectory = join(root, "darwin");
    await mkdir(cacheDirectory);
    const archivePath = join(cacheDirectory, "reviewed.zip");
    await writeFile(archivePath, "reviewed archive fixture");
    const order = [];

    const prepared = await prepareInstaller({
        arch: "arm64",
        cacheDirectory,
        clearQuarantine: async appPath => {
            order.push("quarantine");
            assert.equal(appPath.endsWith("Equilotl.app"), true);
        },
        ensureArtifact: async artifact => {
            order.push("verify");
            assert.equal(artifact, EQUILOTL_ARTIFACTS.darwinArm64);
            return archivePath;
        },
        extractArchive: async (_archive, destination) => {
            order.push("extract");
            const executableDirectory = join(destination, "Equilotl.app", "Contents", "MacOS");
            await mkdir(executableDirectory, { recursive: true });
            await writeFile(join(executableDirectory, "Equilotl"), "verified executable fixture");
        },
        platform: "darwin",
    });
    assert.deepEqual(order, ["verify", "extract", "quarantine"]);
    assert.equal(existsSync(prepared.binaryPath), true);
    await prepared.cleanup();
    assert.equal(existsSync(prepared.binaryPath), false, "the extracted app must be temporary");

    let extractionCalls = 0;
    await assert.rejects(
        prepareInstaller({
            arch: "x64",
            cacheDirectory,
            ensureArtifact: async () => {
                throw new Error("simulated verification failure");
            },
            extractArchive: async () => {
                extractionCalls++;
            },
            platform: "darwin",
        }),
        /simulated verification failure/iu,
    );
    assert.equal(extractionCalls, 0, "an unverified archive must never be extracted");
}

async function testExecutionGateAndCleanup() {
    let executeCalls = 0;
    await assert.rejects(
        runInstaller({
            execute: () => {
                executeCalls++;
            },
            prepare: async () => {
                throw new Error("simulated verification failure");
            },
        }),
        /simulated verification failure/iu,
    );
    assert.equal(executeCalls, 0, "verification failures must prevent execution");

    let cleaned = false;
    await assert.rejects(
        runInstaller({
            execute: () => {
                throw new Error("simulated installer failure");
            },
            prepare: async () => ({
                binaryPath: "verified-fixture",
                cleanup: async () => {
                    cleaned = true;
                },
            }),
        }),
        /simulated installer failure/iu,
    );
    assert.equal(cleaned, true, "temporary extraction must be cleaned after execution failures");
}

async function main() {
    testReleasePin();
    await testStandaloneLinuxPin();
    const root = await mkdtemp(join(tmpdir(), "protonn-cord-installer-security-"));
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), "cleanup must stay in the test temporary directory");
    try {
        await testStandaloneLinuxPayload(root);
        await testVerifiedCache(root);
        await testVerifiedReplacement(root);
        await testDigestFailurePreservesCache(root);
        await testStreamingLimitPreservesCache(root);
        await testTimeoutPreservesCache(root);
        await testBodyTimeoutPreservesCache(root);
        await testActivationFailurePreservesCache(root);
        await testVerificationPrecedesExtraction(root);
        await testExecutionGateAndCleanup();
    } finally {
        await rm(root, { force: true, recursive: true });
    }
    console.log("Installer authenticity and recovery checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
