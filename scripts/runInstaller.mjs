/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import "./checkNodeVersion.js";

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EQUILOTL_RELEASE = Object.freeze({
    commit: "c6bfed9c941883fb0aa48cc1ab6031ed69334c2a",
    tag: "v2.2.6",
});

const RELEASE_ASSET_URL = "https://api.github.com/repos/Equicord/Equilotl/releases/assets/";

// Review a new release, then update its asset IDs, exact sizes, and digests together.
export const EQUILOTL_ARTIFACTS = Object.freeze({
    darwinArm64: Object.freeze({
        assetId: 444851625,
        executable: false,
        filename: "Equilotl-darwin-arm64.zip",
        sha256: "0ad89ae8e8bf652a6e61329c3ae12e97b0380ff3ca563ad258a10c84a47ef716",
        size: 3_710_475,
    }),
    darwinX64: Object.freeze({
        assetId: 444851620,
        executable: false,
        filename: "Equilotl-darwin-x64.zip",
        sha256: "72ca0dbb2452299ed41b7517646a273e4b05c3f5e4e94df270b4e3fb2fc5fa75",
        size: 4_211_616,
    }),
    linux: Object.freeze({
        assetId: 444851621,
        executable: true,
        filename: "EquilotlCli-linux",
        sha256: "5179bff47736c9d0e2df8367798d7c743d221c403f6c9262f8571f34d3383ed1",
        size: 8_499_465,
    }),
    win32: Object.freeze({
        assetId: 444851633,
        executable: true,
        filename: "EquilotlCli.exe",
        sha256: "79932382d859747318f642c3e23297c7a0174398cc489e8fb4222cc2758c16e8",
        size: 8_881_152,
    }),
});

export const DOWNLOAD_TIMEOUT_MS = 60_000;

const INSTALLER_PATH_DARWIN = "Equilotl.app/Contents/MacOS/Equilotl";
const INSTALLER_APP_DARWIN = "Equilotl.app";
const BASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const INSTALLER_CACHE_DIR = join(BASE_DIR, "dist", "Installer", EQUILOTL_RELEASE.tag);

export function getArtifact(platform = process.platform, arch = process.arch) {
    switch (platform) {
        case "win32":
            return EQUILOTL_ARTIFACTS.win32;
        case "darwin":
            switch (arch) {
                case "x64":
                    return EQUILOTL_ARTIFACTS.darwinX64;
                case "arm64":
                    return EQUILOTL_ARTIFACTS.darwinArm64;
                default:
                    throw new Error("Unsupported macOS architecture: " + arch);
            }
        case "linux":
            return EQUILOTL_ARTIFACTS.linux;
        default:
            throw new Error("Unsupported platform: " + platform);
    }
}

function artifactUrl(artifact) {
    return RELEASE_ASSET_URL + artifact.assetId;
}

export async function verifyArtifact(path, artifact) {
    let stats;
    try {
        stats = await lstat(path);
    } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
    }

    if (!stats.isFile() || stats.size !== artifact.size) return false;

    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === artifact.sha256;
}

async function cancelBody(body, reason) {
    if (body) await body.cancel(reason).catch(() => undefined);
}

async function writeChunk(file, chunk) {
    let offset = 0;
    while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten === 0) throw new Error("Failed to write the installer download.");
        offset += bytesWritten;
    }
}

export async function downloadArtifact(artifact, directory, options = {}) {
    const fetcher = options.fetcher ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    const temporaryPath = join(
        directory,
        `.${artifact.filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const controller = new AbortController();
    let timedOut = false;
    let temporaryCreated = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Installer download timed out."));
    }, timeoutMs);

    try {
        const response = await fetcher(artifactUrl(artifact), {
            credentials: "omit",
            headers: {
                Accept: "application/octet-stream",
                "User-Agent": "ProtonnCord (https://github.com/ProtonDev-sys/ProtonnCord)",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            redirect: "follow",
            signal: controller.signal,
        });

        if (!response.ok) {
            await cancelBody(response.body);
            throw new Error(`Failed to download the installer: ${response.status} ${response.statusText}`);
        }
        if (!response.body) throw new Error("The installer download had no response body.");

        const contentLength = response.headers.get("Content-Length");
        if (contentLength !== null) {
            if (!/^\d+$/u.test(contentLength) || Number(contentLength) > artifact.size) {
                await cancelBody(response.body);
                throw new Error(`The installer download exceeded the ${artifact.size} byte limit.`);
            }
        }

        const file = await open(temporaryPath, "wx", 0o600);
        temporaryCreated = true;
        const reader = response.body.getReader();
        const abortReader = () => {
            void reader.cancel(controller.signal.reason).catch(() => undefined);
        };
        controller.signal.addEventListener("abort", abortReader, { once: true });

        try {
            const hash = createHash("sha256");
            let received = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                received += value.byteLength;
                if (received > artifact.size) {
                    throw new Error(`The installer download exceeded the ${artifact.size} byte limit.`);
                }
                hash.update(value);
                await writeChunk(file, value);
            }

            controller.signal.throwIfAborted();
            clearTimeout(timeout);
            if (received !== artifact.size) {
                throw new Error(`The installer download was ${received} bytes, expected ${artifact.size}.`);
            }
            if (hash.digest("hex") !== artifact.sha256) {
                throw new Error(`The downloaded ${artifact.filename} failed SHA-256 verification.`);
            }
            await file.sync();
        } catch (error) {
            await reader.cancel(error).catch(() => undefined);
            throw error;
        } finally {
            controller.signal.removeEventListener("abort", abortReader);
            reader.releaseLock();
            await file.close();
        }

        if (artifact.executable) await chmod(temporaryPath, 0o755);
        return temporaryPath;
    } catch (error) {
        if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
        if (timedOut) throw new Error("The installer download timed out.", { cause: error });
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

export async function ensureCachedArtifact(artifact, options = {}) {
    const cacheDirectory = options.cacheDirectory ?? INSTALLER_CACHE_DIR;
    const renameFile = options.renameFile ?? rename;
    await mkdir(cacheDirectory, { recursive: true });

    const outputPath = join(cacheDirectory, artifact.filename);
    if (await verifyArtifact(outputPath, artifact)) {
        if (artifact.executable) await chmod(outputPath, 0o755);
        console.log(`Using verified Equilotl ${EQUILOTL_RELEASE.tag} ${artifact.filename}.`);
        return outputPath;
    }

    console.log(`Downloading reviewed Equilotl ${EQUILOTL_RELEASE.tag} ${artifact.filename}.`);
    const temporaryPath = await downloadArtifact(artifact, cacheDirectory, options);
    try {
        await renameFile(temporaryPath, outputPath);
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw new Error("Could not activate the verified installer download.", { cause: error });
    }

    if (!await verifyArtifact(outputPath, artifact)) {
        throw new Error("The cached installer failed verification after activation.");
    }
    console.log("Finished downloading the verified installer.");
    return outputPath;
}

function extractDarwinArchive(archivePath, destination) {
    execFileSync("ditto", ["-x", "-k", archivePath, destination], { stdio: "inherit" });
}

function clearDarwinQuarantine(appPath) {
    try {
        execFileSync("xattr", ["-dr", "com.apple.quarantine", appPath], { stdio: "inherit" });
    } catch (error) {
        console.warn("Could not clear quarantine from the verified installer app:", error.message);
    }
}

export async function prepareDarwinInstaller(archivePath, options = {}) {
    const cacheDirectory = options.cacheDirectory ?? INSTALLER_CACHE_DIR;
    const extractArchive = options.extractArchive ?? extractDarwinArchive;
    const clearQuarantine = options.clearQuarantine ?? clearDarwinQuarantine;
    await mkdir(cacheDirectory, { recursive: true });
    const extractionDirectory = await mkdtemp(join(cacheDirectory, ".equilotl-extract-"));

    try {
        await extractArchive(archivePath, extractionDirectory);
        const appPath = join(extractionDirectory, INSTALLER_APP_DARWIN);
        const binaryPath = join(extractionDirectory, INSTALLER_PATH_DARWIN);
        const binaryStats = await lstat(binaryPath);
        if (!binaryStats.isFile()) throw new Error("The verified installer archive did not contain its executable.");

        const realExtractionDirectory = await realpath(extractionDirectory);
        const realBinaryPath = await realpath(binaryPath);
        const relativeBinaryPath = relative(realExtractionDirectory, realBinaryPath);
        if (
            relativeBinaryPath === ".."
            || relativeBinaryPath.startsWith(".." + sep)
            || isAbsolute(relativeBinaryPath)
        ) {
            throw new Error("The verified installer archive resolved outside its temporary directory.");
        }

        await clearQuarantine(appPath);
        return {
            binaryPath,
            cleanup: () => rm(extractionDirectory, { force: true, recursive: true }),
        };
    } catch (error) {
        await rm(extractionDirectory, { force: true, recursive: true }).catch(() => undefined);
        throw error;
    }
}

export async function prepareInstaller(options = {}) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const ensureArtifact = options.ensureArtifact ?? ensureCachedArtifact;
    const artifact = getArtifact(platform, arch);
    const artifactPath = await ensureArtifact(artifact, options);

    if (platform === "darwin") return prepareDarwinInstaller(artifactPath, options);
    return { binaryPath: artifactPath, cleanup: async () => undefined };
}

export function getInstallerArgs(argv = process.argv) {
    const argStart = argv.indexOf("--");
    return argStart === -1 ? [] : argv.slice(argStart + 1);
}

export async function runInstaller(options = {}) {
    const prepare = options.prepare ?? prepareInstaller;
    const execute = options.execute ?? execFileSync;
    const prepared = await prepare(options);

    console.log("Now running the verified installer.");
    try {
        execute(prepared.binaryPath, options.args ?? getInstallerArgs(), {
            stdio: "inherit",
            env: {
                ...process.env,
                EQUICORD_USER_DATA_DIR: BASE_DIR,
                EQUICORD_DIRECTORY: join(BASE_DIR, "dist", "desktop"),
                EQUICORD_DEV_INSTALL: "1",
            },
        });
    } finally {
        await prepared.cleanup();
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await runInstaller();
    } catch (error) {
        console.error("The installer could not run:", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
