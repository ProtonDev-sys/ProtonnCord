/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { DATA_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent } from "electron";
import { gunzipSync, unzipSync } from "fflate";

import { encodePhononAudio, isRecognizedAudioContainer } from "./audioValidation";
import { parsePhononResult } from "./transcriptionData";

const execute = promisify(execFile);
const transcriptionJobs = new Map<number, { id: string; controller: AbortController; }>();
const UV_VERSION = "0.12.21";
const RUNTIME_VERSION = "fermion-0.2.4-python312-v1";
const uvDownloads: Record<string, { name: string; sha256: string; }> = {
    "win32-x64": { name: "uv-x86_64-pc-windows-msvc.zip", sha256: "5d223efa0bf00208c3853246af09420419dfbd352536aa6bb8163d6170e23890" },
    "linux-x64": { name: "uv-x86_64-unknown-linux-gnu.tar.gz", sha256: "23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0" },
    "linux-arm64": { name: "uv-aarch64-unknown-linux-gnu.tar.gz", sha256: "030b69227b40af8c1981b7301793dc66e71ed3c796ea8688209dd268bd91ec51" },
    "darwin-arm64": { name: "uv-aarch64-apple-darwin.tar.gz", sha256: "b88bda573e566ef9bced66b155fe0408626fbbc053aee1c30ba686f0728c9447" }
};
let runtimeInstallation: Promise<string> | undefined;

function runtimeDirectory() {
    return join(DATA_DIR, "VoiceMessageTranscriber", RUNTIME_VERSION);
}

function runtimeEnvironment() {
    const root = runtimeDirectory();
    return {
        ...process.env,
        PYTHONHOME: "",
        PYTHONPATH: "",
        UV_CACHE_DIR: join(root, "uv-cache"),
        UV_PYTHON_INSTALL_DIR: join(root, "python"),
        FERMION_CACHE_DIR: join(root, "models"),
        HF_HOME: join(root, "huggingface")
    };
}

function extractUv(archive: Uint8Array, name: string): Uint8Array {
    if (name.endsWith(".zip")) {
        const files = unzipSync(archive, { filter: file => file.name === "uv.exe" && file.originalSize <= 100 * 1024 * 1024 });
        if (!files["uv.exe"]?.length) throw new Error("Runtime archive has no uv executable");
        return files["uv.exe"];
    }
    const bytes = gunzipSync(archive);
    const expectedName = `${name.slice(0, -7)}/uv`;
    for (let offset = 0; offset + 512 <= bytes.length;) {
        const header = bytes.subarray(offset, offset + 512);
        const filename = new TextDecoder().decode(header.subarray(0, 100)).split("\0")[0];
        const sizeText = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0/g, "").trim();
        if (!/^[0-7]+$/.test(sizeText)) break;
        const size = parseInt(sizeText, 8);
        const start = offset + 512;
        if (!Number.isSafeInteger(size) || size < 0 || start + size > bytes.length) throw new Error("Invalid runtime archive");
        if (filename === expectedName && (header[156] === 0 || header[156] === 48)) return bytes.slice(start, start + size);
        offset = start + Math.ceil(size / 512) * 512;
    }
    throw new Error("Runtime archive has no uv executable");
}

async function installRuntime(signal: AbortSignal): Promise<string> {
    const download = uvDownloads[`${process.platform}-${process.arch}`];
    if (!download) throw new Error("Phonon-2 supports Windows x64, Linux x64/ARM64, and Apple silicon on this client");
    const root = runtimeDirectory();
    const executable = join(root, "venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "fermion.exe" : "fermion");
    const ready = join(root, "ready");
    try {
        if (await readFile(ready, "utf8") === RUNTIME_VERSION) {
            await access(executable);
            return executable;
        }
    } catch { }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const uv = join(root, process.platform === "win32" ? "uv.exe" : "uv");
    const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${download.name}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)])
    });
    if (!response.ok || !response.body) throw new Error("Could not download the Phonon-2 runtime installer");
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 64 * 1024 * 1024) throw new Error("Runtime download exceeds its size limit");
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    const archive = Buffer.concat(chunks);
    if (createHash("sha256").update(archive).digest("hex") !== download.sha256)
        throw new Error("Phonon-2 runtime installer checksum verification failed");
    signal.throwIfAborted();
    await writeFile(`${uv}.download`, extractUv(archive, download.name), { mode: 0o700, signal });
    await rename(`${uv}.download`, uv);
    if (process.platform !== "win32") await chmod(uv, 0o700);
    const options = { windowsHide: true, shell: false, signal, timeout: 1_800_000, killSignal: "SIGKILL" as const, maxBuffer: 1024 * 1024, env: runtimeEnvironment() };
    const venv = join(root, "venv");
    const python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    await execute(uv, ["venv", "--python", "3.12", "--managed-python", "--allow-existing", venv], options);
    if (process.platform !== "darwin")
        await execute(uv, ["pip", "install", "--python", python, "--index-url", "https://download.pytorch.org/whl/cpu", "torch==2.8.0"], options);
    const packages = ["fermion-research==0.2.4", "safetensors", "soundfile", "scipy", "zstandard"];
    if (process.platform === "darwin") packages.push("mlx", "mlx-audio", "mlx-lm");
    await execute(uv, ["pip", "install", "--python", python, "--index-url", "https://pypi.org/simple", ...packages], options);
    await execute(executable, ["transcribe", "phonon-2", "unused.wav", "--download-only"], options);
    await writeFile(`${ready}.pending`, RUNTIME_VERSION, { mode: 0o600, signal });
    await rename(`${ready}.pending`, ready);
    return executable;
}

function ensureRuntime(signal: AbortSignal): Promise<string> {
    if (!runtimeInstallation) {
        runtimeInstallation = installRuntime(signal).catch(error => {
            runtimeInstallation = undefined;
            throw error;
        });
    }
    return runtimeInstallation;
}

export async function transcribe(event: IpcMainInvokeEvent, id: string, audio: Float32Array) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid transcription job ID");
    const owner = event.sender.id;
    if (transcriptionJobs.has(owner)) throw new Error("A transcription is already running; please try again shortly");
    const wav = encodePhononAudio(audio);
    const controller = new AbortController();
    transcriptionJobs.set(owner, { id, controller });
    const cancel = () => controller.abort();
    event.sender.once("destroyed", cancel);
    let directory: string | undefined;
    try {
        const executable = await ensureRuntime(controller.signal);
        controller.signal.throwIfAborted();
        directory = await mkdtemp(join(tmpdir(), "protonn-phonon-"));
        const filename = join(directory, "audio.wav");
        await writeFile(filename, wav, { mode: 0o600, signal: controller.signal });
        const { stdout } = await execute(executable, ["transcribe", "phonon-2", filename, "--json"], {
            windowsHide: true,
            shell: false,
            signal: controller.signal,
            timeout: 600_000,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
            env: runtimeEnvironment()
        });
        return parsePhononResult(stdout);
    } catch (error) {
        if (controller.signal.aborted) throw new Error("Transcription cancelled");
        if ((error as NodeJS.ErrnoException).code === "ENOENT") runtimeInstallation = undefined;
        throw new Error("Phonon-2 setup or transcription failed. Check your connection and available disk space, then retry. Unsupported devices or missing system libraries may require an OS update.");
    } finally {
        event.sender.removeListener("destroyed", cancel);
        try {
            if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
            transcriptionJobs.delete(owner);
        }
    }
}

export function cancelTranscription(event: IpcMainInvokeEvent, id: string) {
    const job = transcriptionJobs.get(event.sender.id);
    if (job?.id === id) job.controller.abort();
}

// we love CORS
export async function fetchAudio(_: IpcMainInvokeEvent, url: string): Promise<Uint8Array> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || (parsed.hostname !== "cdn.discordapp.com" && parsed.hostname !== "media.discordapp.net"))
        throw new Error("Blocked an untrusted voice-message URL");

    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);

    const contentLength = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > 25 * 1024 * 1024)
        throw new Error("Voice message exceeds the 25 MB transcription limit");

    if (!res.body) throw new Error("Voice message response has no body");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 25 * 1024 * 1024) throw new Error("Voice message exceeds the 25 MB transcription limit");
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    const audio = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
    if (!isRecognizedAudioContainer(audio))
        throw new Error("Discord returned an unsupported or invalid audio file");

    return audio;
}
