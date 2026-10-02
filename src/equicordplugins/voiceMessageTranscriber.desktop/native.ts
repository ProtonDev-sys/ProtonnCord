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

const phononStreamingScript = String.raw`
import ast
import inspect
import json
import sys
import textwrap
import time
import types

from fermion._speech import backends, fetch
from fermion.transcribe import _resolve

repo, key, pin, local_dir = _resolve("phonon-2")
engine = backends.resolve("Phonon-2 word previews")
speech = backends.load(engine, local_dir if local_dir is not None else fetch.ensure(repo, key, pin),
                       profile=key, backend=pin["backend"], quiet=True)
completed = []
pieces = []
last_text = ""
last_emit = 0.0

def emit(text, force=False):
    global last_text, last_emit
    now = time.monotonic()
    if text and text != last_text and (force or now - last_emit >= 0.075):
        if not text.startswith(last_text):
            raise RuntimeError("Phonon-2 preview changed a completed word")
        print(json.dumps({"type": "partial", "delta": text[len(last_text):]}, ensure_ascii=False), flush=True)
        last_text, last_emit = text, now

def preview(piece):
    pieces.append(piece.replace("\u2581", " "))
    text = "".join(pieces).lstrip()
    if " " in text:
        emit(" ".join(completed + [text.rsplit(" ", 1)[0]]).strip())

def instrument(function, target, expression):
    tree = ast.parse(textwrap.dedent(inspect.getsource(function)))
    matches = 0
    class InsertPreview(ast.NodeTransformer):
        def visit_Expr(self, node):
            nonlocal matches
            self.generic_visit(node)
            if (isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute)
                    and isinstance(node.value.func.value, ast.Name)
                    and node.value.func.value.id == target and node.value.func.attr == "append"):
                matches += 1
                return [node, ast.parse(expression).body[0]]
            return node
    tree = InsertPreview().visit(tree)
    if matches != 1:
        raise RuntimeError("Unsupported pinned Phonon-2 decoder")
    namespace = dict(function.__globals__, _preview=preview)
    exec(compile(ast.fix_missing_locations(tree), "phonon_word_preview", "exec"), namespace)
    return namespace[function.__name__]

if engine == "cpu":
    from fermion._speech.engine_phonon2_cpu import Phonon2CpuSpeechModel
    speech._ctdt = None
    speech._decode_single = types.MethodType(instrument(Phonon2CpuSpeechModel._decode_single, "ids",
        "if tok < len(self._vocab) and not _special(self._vocab[tok]): _preview(self._vocab[tok])"), speech)
else:
    from fermion._speech._engine_phonon2.fast_decode import _decode_fast, install_fast_tdt
    if not hasattr(speech.model, "_fast_step"):
        install_fast_tdt(speech.model)
    speech.model.decode = types.MethodType(instrument(_decode_fast, "hyp", "_preview(hyp[-1].text)"), speech.model)

decode = speech._decode_single
def decode_window(audio, repetition_penalty):
    pieces.clear()
    text, generated, budget = decode(audio, repetition_penalty)
    if text.strip():
        completed.append(text.strip())
        emit(" ".join(completed), force=True)
    return text, generated, budget
speech._decode_single = decode_window
result = speech.transcribe_detailed(sys.argv[1])
print(json.dumps({"model": repo, "text": result.text, "segments": result.segments,
                  "truncated": result.truncated}, ensure_ascii=False), flush=True)
`;
const transcriptionJobs = new Map<number, { id: string; controller: AbortController; text: string; }>();
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
    const job = { id, controller, text: "" };
    transcriptionJobs.set(owner, job);
    const cancel = () => controller.abort();
    event.sender.once("destroyed", cancel);
    let directory: string | undefined;
    let streamError: unknown;
    try {
        const executable = await ensureRuntime(controller.signal);
        controller.signal.throwIfAborted();
        directory = await mkdtemp(join(tmpdir(), "protonn-phonon-"));
        const filename = join(directory, "audio.wav");
        await writeFile(filename, wav, { mode: 0o600, signal: controller.signal });
        const script = join(directory, "stream.py");
        await writeFile(script, phononStreamingScript, { mode: 0o600, signal: controller.signal });
        const python = join(executable, "..", process.platform === "win32" ? "python.exe" : "python");
        let pendingLine = "";
        const pending = execute(python, ["-u", script, filename], {
            windowsHide: true,
            shell: false,
            signal: controller.signal,
            timeout: 600_000,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
            env: runtimeEnvironment()
        });
        const output = pending.child?.stdout;
        output?.setEncoding("utf8");
        const receive = (chunk: string) => {
            if (controller.signal.aborted) return;
            try {
                pendingLine += chunk;
                if (pendingLine.length > 1024 * 1024) throw new Error("Transcription output exceeds its limit");
                let newline: number;
                while ((newline = pendingLine.indexOf("\n")) !== -1) {
                    const line = pendingLine.slice(0, newline).trim();
                    pendingLine = pendingLine.slice(newline + 1);
                    if (!line) continue;
                    const record = JSON.parse(line);
                    if (record.type !== "partial") continue;
                    if (typeof record.delta !== "string" || job.text.length + record.delta.length > 64 * 1024)
                        throw new Error("Invalid transcription preview");
                    job.text += record.delta;
                }
            } catch (error) {
                streamError = error;
                controller.abort();
            }
        };
        output?.on("data", receive);
        let stdout: string;
        try {
            ({ stdout } = await pending);
        } finally {
            output?.removeListener("data", receive);
        }
        if (streamError) throw streamError;
        return parsePhononResult(stdout.trim().split("\n").at(-1)!);
    } catch (error) {
        if (controller.signal.aborted && !streamError) throw new Error("Transcription cancelled");
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

export function getTranscriptionProgress(event: IpcMainInvokeEvent, id: string): string | null {
    const job = transcriptionJobs.get(event.sender.id);
    return job?.id === id && !job.controller.signal.aborted ? job.text : null;
}

export function cancelTranscription(event: IpcMainInvokeEvent, id: string) {
    const job = transcriptionJobs.get(event.sender.id);
    if (job?.id === id) job.controller.abort();
}

// we love CORS
const audioFetches = new Map<number, Map<string, AbortController>>();

export function cancelAudioFetch(event: IpcMainInvokeEvent, id: string) {
    audioFetches.get(event.sender.id)?.get(id)?.abort();
}

export async function fetchAudio(event: IpcMainInvokeEvent, url: string, id?: string): Promise<Uint8Array> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || (parsed.hostname !== "cdn.discordapp.com" && parsed.hostname !== "media.discordapp.net"))
        throw new Error("Blocked an untrusted voice-message URL");

    if (id !== undefined && (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)))
        throw new Error("Invalid audio request ID");
    const controller = new AbortController();
    const owner = id === undefined ? undefined : event.sender.id;
    let requests: Map<string, AbortController> | undefined;
    const cancel = () => controller.abort();
    if (owner !== undefined) {
        requests = audioFetches.get(owner);
        if (!requests) audioFetches.set(owner, requests = new Map());
        if (requests.has(id!)) throw new Error("Audio request ID already in use");
        requests.set(id!, controller);
        event.sender.once("destroyed", cancel);
    }
    try {
        const res = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), redirect: "error", credentials: "omit", cache: "no-store" });
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error(`Voice message download failed (${res.status})`);
        }

        const contentLength = Number(res.headers.get("Content-Length"));
        if (Number.isFinite(contentLength) && contentLength > 25 * 1024 * 1024) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error("Voice message exceeds the 25 MB transcription limit");
        }

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
    } finally {
        if (owner !== undefined) {
            event.sender.removeListener("destroyed", cancel);
            requests!.delete(id!);
            if (!requests!.size) audioFetches.delete(owner);
        }
    }
}
