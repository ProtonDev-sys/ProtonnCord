// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { publishInstaller } from "./publishInstaller.mjs";
import { createGithubApi } from "./releaseUpdateChannel.mjs";

export async function publishAndroidInstaller({ directory = "mobile/build", env = process.env, api } = {}) {
    const requireState = (condition, message) => { if (!condition) throw new Error(message); };
    const number = value => typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value);
    const repository = "ProtonDev-sys/ProtonnCord";
    const sha = env.GITHUB_SHA;
    requireState(env.GITHUB_REPOSITORY === repository && env.GITHUB_REF_NAME === "nightly"
        && /^[a-f0-9]{40}$/u.test(sha ?? "") && number(env.GITHUB_RUN_ID)
        && number(env.GITHUB_RUN_NUMBER) && number(env.GITHUB_RUN_ATTEMPT),
    "Android publication requires an exact nightly workflow identity.");
    requireState(/^[a-f0-9]{64}$/u.test(env.ANDROID_SIGNER_SHA256 ?? ""), "Configure the expected production ANDROID_SIGNER_SHA256.");
    const boundedFile = async (path, maximum) => {
        const stat = await lstat(path);
        requireState(stat.isFile() && stat.size > 0 && stat.size <= maximum, `Invalid Android artifact: ${path}`);
        const data = await readFile(path);
        requireState(data.length === stat.size, `Android artifact changed while reading: ${path}`);
        return data;
    };
    const json = async path => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedFile(path, 1024 * 1024)));
    const name = "ProtonnCord.apk";
    const receipt = await json(join(directory, "standalone/build-receipt.json"));
    const smoke = await json(join(directory, "reports/android-client/result.json"));
    const built = receipt.release;
    requireState(receipt.format === 1 && receipt.abi === "universal" && receipt.packageName === "com.discord"
        && receipt.sourceCommit === sha && receipt.signerSha256 === env.ANDROID_SIGNER_SHA256,
    "The APK source, package or production signing certificate does not match this release.");
    requireState(built?.repository === repository && built.runId === env.GITHUB_RUN_ID
        && built.runNumber === env.GITHUB_RUN_NUMBER && number(built.attempt)
        && BigInt(built.attempt) <= BigInt(env.GITHUB_RUN_ATTEMPT), "The APK belongs to a different workflow build.");
    requireState(smoke.status === "passed" && smoke.firstLaunch?.status === "passed"
        && smoke.firstLaunch.verifiedBeforeTestWrites === true && smoke.restart?.status === "passed"
        && smoke.restart.cacheRemovedBeforeLaunch === true && smoke.restart.cacheRestored === true
        && smoke.restart.statePreserved === true && smoke.javaScriptStarted === true && smoke.loginScreen === true
        && smoke.smoke?.signedOut === true && isDeepStrictEqual(smoke.apkReceipt, receipt),
    "The exact APK must pass first-launch and state-preserving restart checks before publication.");
    const data = await boundedFile(join(directory, `standalone/${name}`), 512 * 1024 * 1024);
    const checksum = createHash("sha256").update(data).digest("hex");
    requireState(data.subarray(0, 4).toString("hex") === "504b0304"
        && isDeepStrictEqual(receipt.outputs, { [name]: checksum }), "The tested APK bytes changed after verification.");
    // A publish-only retry keeps the identity of the signed and exercised artifact.
    const tag = `android-${built.runId}-${built.attempt}`;
    const body = `Install **${name}** on Android 9 or newer (ARM64 or x86_64). The runtime and Secure Messaging plugin are included.\n\n`
        + "This uses Discord's package name with a separate signing key; an existing differently signed Discord installation must be removed first.\n\n"
        + `[Source and license](https://github.com/${repository}/tree/${sha})\n\n`
        + `APK SHA-256: \`${checksum}\`\n\nSigning certificate SHA-256: \`${receipt.signerSha256}\`\n`;
    await publishInstaller({ api: api ?? createGithubApi(env.GITHUB_TOKEN, fetch, { timeoutMs: 180_000 }),
        repository, sha, tag, name, data, checksum, title: "ProtonnCord — Android nightly", body, platform: "Android" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) publishAndroidInstaller().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
