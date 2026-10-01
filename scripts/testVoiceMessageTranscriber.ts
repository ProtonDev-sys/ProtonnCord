import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { gunzipSync, gzipSync, unzipSync, zipSync } from "fflate";

import { detectAudioMimeType, encodePhononAudio, isRecognizedAudioContainer, MAX_AUDIO_SAMPLES } from "../src/equicordplugins/voiceMessageTranscriber.desktop/audioValidation";
import { buildTargetLanguageOptions, getVoiceMessageMedia, resolveTargetLanguage, VOICE_MESSAGE_FLAG } from "../src/equicordplugins/voiceMessageTranscriber.desktop/options";
import { formatTimestampedTranscript, normalizeTranscriptionResult, parsePhononResult, PHONON_MODEL } from "../src/equicordplugins/voiceMessageTranscriber.desktop/transcriptionData";
import { generateWaveform } from "../src/plugins/voiceMessages/waveform";

{
    let now = 0;
    let nextTimer = 0;
    const timers = new Map<number, { callback: () => void; due: number; }>();
    const cacheExports: any = {};
    const code = transpileModule(readFileSync("src/equicordplugins/voiceMessageTranscriber.desktop/transcriptionData.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(code, {
        exports: cacheExports,
        Date: { now: () => now },
        setTimeout: (callback: () => void, delay: number) => { timers.set(++nextTimer, { callback, due: now + delay }); return nextTimer; },
        clearTimeout: (timer: number) => timers.delete(timer)
    });
    const cache = new cacheExports.IdleResultCache((value: string) => value.length);
    const advance = (milliseconds: number) => {
        now += milliseconds;
        for (const [timer, entry] of [...timers]) {
            if (entry.due <= now) { timers.delete(timer); entry.callback(); }
        }
    };
    let expired = 0;
    const unsubscribe = cache.subscribe("message", () => { expired++; });
    cache.set("message", "translated text");
    const release = cache.retain("message");
    advance(600_000);
    assert.equal(cache.get("message"), "translated text", "visible results remain available without polling");
    assert.equal(timers.size, 0, "visible-only caches need no timers");
    release();
    advance(299_999);
    assert.equal(cache.get("message"), "translated text");
    const releaseAgain = cache.retain("message");
    releaseAgain();
    advance(299_999);
    assert.equal(cache.get("message"), "translated text", "show/hide resets the inactivity deadline");
    advance(1);
    assert.equal(cache.get("message"), undefined);
    assert.equal(expired, 1, "expiry notifies mounted hidden views to release their state references");
    unsubscribe();
    for (let index = 0; index < 101; index++) cache.set(String(index), "text");
    assert.equal(cache.get("0"), undefined, "entry count is bounded");
    assert.equal(timers.size, 1, "all inactive entries share one expiry timer");
    cache.set("oversized", "x".repeat(1_000_001));
    assert.equal(cache.get("oversized"), undefined, "retained text has an aggregate memory bound");
    cache.clear();
    assert.equal(timers.size, 0, "stop removes expiry timers");
}

const attachment = {
    content_type: "audio/ogg",
    duration_secs: 3.5,
    filename: "voice-message.ogg",
    url: "https://cdn.discordapp.com/attachments/channel/message/voice-message.ogg",
    waveform: "AQID"
};

assert.deepEqual(
    getVoiceMessageMedia({ flags: VOICE_MESSAGE_FLAG, attachments: [attachment] }),
    { duration: attachment.duration_secs, needsPlaybackFallback: false, url: attachment.url, waveform: attachment.waveform },
    "received voice messages are eligible",
);
assert.deepEqual(
    getVoiceMessageMedia({ flags: VOICE_MESSAGE_FLAG, attachments: [attachment] }),
    { duration: attachment.duration_secs, needsPlaybackFallback: false, url: attachment.url, waveform: attachment.waveform },
    "voice messages authored by the current account can also be used as test fixtures",
);
assert.equal(
    getVoiceMessageMedia({ flags: 0, attachments: [attachment] }),
    null,
    "ordinary audio attachments are not mistaken for voice messages",
);
assert.deepEqual(
    getVoiceMessageMedia({
        flags: VOICE_MESSAGE_FLAG,
        attachments: [{ ...attachment, content_type: "video/mp4", waveform: undefined }]
    }),
    { duration: attachment.duration_secs, needsPlaybackFallback: true, url: attachment.url, waveform: undefined },
    "malformed voice-message metadata receives a playback fallback",
);

const options = buildTargetLanguageOptions({ auto: "Detect language", en: "English", fr: "French" });
assert.deepEqual(options, [{ value: "en", label: "English" }, { value: "fr", label: "French" }]);
assert.equal(resolveTargetLanguage("fr", options), "fr", "the configured target is retained");
assert.equal(resolveTargetLanguage("unsupported", options), "en", "English is the safe provider fallback");

const transcript = normalizeTranscriptionResult({
    text: " Hello there. ",
    chunks: [
        { timestamp: [0, 1.8], text: " Hello" },
        { timestamp: [1.8, null], text: " there." },
        { timestamp: ["bad", 2], text: "ignored" }
    ]
});
assert.equal(transcript.text, "Hello there.");
assert.equal(transcript.chunks.length, 2, "malformed timestamp chunks are discarded");
assert.equal(formatTimestampedTranscript(transcript), "[00:00 - 00:01] Hello\n[00:01 - end] there.");

assert.equal(isRecognizedAudioContainer(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0])), true, "OGG voice messages are accepted without relying on Content-Type");
assert.equal(detectAudioMimeType(new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])), "audio/mp4", "mislabelled MP4 audio receives a playable MIME type");
assert.equal(isRecognizedAudioContainer(new TextEncoder().encode("<html>nope</html>")), false, "non-audio CDN responses are rejected");

const samples = Float32Array.from({ length: 16_000 }, (_, index) => Math.sin(2 * Math.PI * 440 * index / 16_000) * (index / 16_000));
const waveform = Uint8Array.from(globalThis.atob(generateWaveform(samples, 16_000)), character => character.charCodeAt(0));
assert.equal(waveform.length, 32, "short audio uses Discord's minimum waveform resolution");
assert.ok(waveform.some(value => value > 0), "generated waveforms contain audible amplitude");
assert.ok(new Set(waveform).size > 1, "generated waveforms preserve changing amplitude instead of rendering flat");

const wav = encodePhononAudio(new Float32Array([-2, -1, 0, 1, 2]));
const wavView = new DataView(wav.buffer);
assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
assert.equal(wavView.getUint32(4, true), wav.length - 8);
assert.equal(wavView.getUint32(24, true), 16_000);
assert.equal(wavView.getUint16(22, true), 1);
assert.equal(wavView.getUint32(40, true), 10);
assert.equal(wavView.getInt16(44, true), -32768);
assert.equal(wavView.getInt16(48, true), 0);
assert.equal(wavView.getInt16(52, true), 32767);
assert.throws(() => encodePhononAudio(new Float32Array()), /ten minutes/);
assert.throws(() => encodePhononAudio(new Float32Array(MAX_AUDIO_SAMPLES + 1)), /ten minutes/);
assert.throws(() => encodePhononAudio(new Float32Array([NaN])), /invalid samples/);
assert.throws(() => encodePhononAudio(new Float32Array([Infinity])), /invalid samples/);
assert.throws(() => encodePhononAudio([0] as unknown as Float32Array), /16 kHz/);
const phononResult = { model: PHONON_MODEL, text: " Hello. ", segments: [{ start: 0, end: 1, text: "Hello." }], truncated: false };
assert.deepEqual(parsePhononResult(JSON.stringify(phononResult)), { text: "Hello.", chunks: [{ text: "Hello.", timestamp: [0, 1] }] });
assert.throws(() => parsePhononResult(JSON.stringify({ ...phononResult, model: "whisper" })), /Phonon-2/);
assert.throws(() => parsePhononResult(JSON.stringify({ ...phononResult, truncated: true })), /incomplete/);
assert.throws(() => parsePhononResult(JSON.stringify({ ...phononResult, truncated: undefined })), /incomplete/);
assert.throws(() => parsePhononResult("not json"));

async function testNativeTranscription() {
    const nativeExports: Record<string, (...args: any[]) => any> = {};
    const calls: Array<{ command: string; args: string[]; options: any; }> = [];
    const removed: string[] = [];
    let written: Uint8Array | undefined;
    let runtimeReady = true;
    let fetchCount = 0;
    let publishedReady = 0;
    let previewStream: (EventEmitter & { setEncoding: (encoding: string) => void; }) | undefined;
    const archive = zipSync({ "uv.exe": new Uint8Array([1, 2, 3]) });
    let downloadedArchive = archive;
    const archiveHash = createHash("sha256").update(archive).digest("hex");
    let execute = async (_command: string, _args: string[], _options: any) => ({ stdout: JSON.stringify(phononResult) });
    const nativeCode = transpileModule(readFileSync("src/equicordplugins/voiceMessageTranscriber.desktop/native.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(`${nativeCode}\nuvDownloads["win32-x64"].sha256 = "${archiveHash}"; exports.installRuntime = installRuntime; exports.extractUv = extractUv;`, {
        exports: nativeExports,
        AbortController,
        AbortSignal,
        Buffer,
        TextDecoder,
        process: { platform: "win32", arch: "x64", env: {} },
        fetch: async () => {
            fetchCount++;
            return new Response(downloadedArchive);
        },
        require: (name: string) => {
            if (name === "node:crypto") return { createHash };
            if (name === "fflate") return { gunzipSync, unzipSync };
            if (name === "@main/utils/constants") return { DATA_DIR: "test-data" };
            if (name === "node:child_process") return { execFile: () => undefined };
            if (name === "node:util") return { promisify: () => (command: string, args: string[], options: any) => {
                calls.push({ command, args, options });
                return Object.assign(execute(command, args, options), { child: { stdout: previewStream } });
            } };
            if (name === "node:fs/promises") return {
                access: async () => undefined,
                chmod: async () => undefined,
                mkdir: async () => undefined,
                readFile: async () => {
                    if (!runtimeReady) throw Object.assign(new Error("missing"), { code: "ENOENT" });
                    return "fermion-0.2.4-python312-v1";
                },
                rename: async (_source: string, destination: string) => {
                    if (destination.endsWith("ready")) publishedReady++;
                },
                mkdtemp: async () => "private-test-directory",
                writeFile: async (_filename: string, bytes: Uint8Array, options: any) => {
                    options.signal.throwIfAborted();
                    if (_filename.endsWith("audio.wav")) written = bytes;
                },
                rm: async (directory: string) => { removed.push(directory); }
            };
            if (name === "node:os") return { tmpdir: () => "test-temp" };
            if (name === "node:path") return { join };
            if (name === "./audioValidation") return { encodePhononAudio, isRecognizedAudioContainer };
            if (name === "./transcriptionData") return { parsePhononResult };
            throw new Error(`Unexpected native dependency: ${name}`);
        }
    });
    const sender = Object.assign(new EventEmitter(), { id: 7 });
    const event = { sender };
    assert.deepEqual(await nativeExports.transcribe(event, "test-job", new Float32Array([0])), parsePhononResult(JSON.stringify(phononResult)));
    const executable = join("test-data", "VoiceMessageTranscriber", "fermion-0.2.4-python312-v1", "venv", "Scripts", "fermion.exe");
    assert.equal(calls[0].command, join(executable, "..", "python.exe"));
    assert.equal(fetchCount, 0, "ready installations do not download again");
    assert.deepEqual(Array.from(calls[0].args), ["-u", join("private-test-directory", "stream.py"), join("private-test-directory", "audio.wav")]);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.timeout, 600_000);
    assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
    assert.equal(written?.byteLength, 46);
    assert.equal(removed.length, 1);
    assert.equal(sender.listenerCount("destroyed"), 0);
    await assert.rejects(nativeExports.transcribe(event, "../bad", new Float32Array([0])), /Invalid transcription/);
    assert.equal(calls.length, 1, "invalid jobs never launch a subprocess");

    execute = async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    await assert.rejects(nativeExports.transcribe(event, "missing-runtime", new Float32Array([0])), /setup or transcription failed/);
    assert.equal(removed.length, 2, "failed subprocesses remove temporary audio");

    execute = async (_command, _args, options) => {
        await assert.rejects(nativeExports.transcribe(event, "competing", new Float32Array([0])), /already running/);
        nativeExports.cancelTranscription({ sender: { id: 8 } }, "cancel-job");
        assert.equal(options.signal.aborted, false, "another renderer cannot cancel this job");
        nativeExports.cancelTranscription(event, "wrong-job");
        assert.equal(options.signal.aborted, false, "stale cancellation cannot abort a new job");
        nativeExports.cancelTranscription(event, "cancel-job");
        assert.equal(options.signal.aborted, true);
        options.signal.throwIfAborted();
        return { stdout: "" };
    };
    await assert.rejects(nativeExports.transcribe(event, "cancel-job", new Float32Array([0])), /cancelled/);
    assert.equal(removed.length, 3, "cancelled jobs remove temporary audio");

    execute = async (_command, _args, options) => {
        sender.emit("destroyed");
        assert.equal(options.signal.aborted, true);
        options.signal.throwIfAborted();
        return { stdout: "" };
    };
    await assert.rejects(nativeExports.transcribe(event, "closed-renderer", new Float32Array([0])), /cancelled/);
    assert.equal(removed.length, 4);
    assert.equal(sender.listenerCount("destroyed"), 0);
    execute = async () => ({ stdout: JSON.stringify(phononResult) });
    await nativeExports.transcribe(event, "retry", new Float32Array([0]));
    assert.equal(removed.length, 5, "a subsequent job can run after failure or cancellation");

    previewStream = Object.assign(new EventEmitter(), { setEncoding: (encoding: string) => assert.equal(encoding, "utf8") });
    let finishStreaming!: (result: { stdout: string; }) => void;
    execute = () => new Promise(resolve => { finishStreaming = resolve; });
    const streaming = nativeExports.transcribe(event, "streaming", new Float32Array([0]));
    for (let attempts = 0; attempts < 20 && !previewStream.listenerCount("data"); attempts++) await Promise.resolve();
    assert.equal(previewStream.listenerCount("data"), 1);
    previewStream.emit("data", '{"type":"partial","delta":"Hello');
    assert.equal(nativeExports.getTranscriptionProgress(event, "streaming"), "", "incomplete records never leak into the preview");
    previewStream.emit("data", '"}\n{"type":"partial","delta":" world"}\n');
    assert.equal(nativeExports.getTranscriptionProgress(event, "streaming"), "Hello world", "words are available before the process completes");
    assert.equal(nativeExports.getTranscriptionProgress({ sender: { id: 8 } }, "streaming"), null);
    assert.equal(nativeExports.getTranscriptionProgress(event, "stale-job"), null);
    finishStreaming({ stdout: '{"type":"partial","delta":"Hello world"}\n' + JSON.stringify(phononResult) + '\n' });
    assert.deepEqual(await streaming, parsePhononResult(JSON.stringify(phononResult)), "final result supersedes the preview");
    assert.equal(previewStream.listenerCount("data"), 0);
    assert.equal(nativeExports.getTranscriptionProgress(event, "streaming"), null, "completed jobs release preview memory");

    const invalidStreaming = nativeExports.transcribe(event, "invalid-preview", new Float32Array([0]));
    for (let attempts = 0; attempts < 20 && !previewStream.listenerCount("data"); attempts++) await Promise.resolve();
    previewStream.emit("data", JSON.stringify({ type: "partial", delta: "x".repeat(65537) }) + '\n');
    assert.equal(calls.at(-1)!.options.signal.aborted, true, "oversized previews abort inference");
    assert.equal(nativeExports.getTranscriptionProgress(event, "invalid-preview"), null);
    finishStreaming({ stdout: JSON.stringify(phononResult) });
    await assert.rejects(invalidStreaming, /setup or transcription failed/);
    assert.equal(previewStream.listenerCount("data"), 0);
    previewStream = undefined;
    execute = async () => ({ stdout: "" });

    runtimeReady = false;
    const beforeInstall = calls.length;
    await nativeExports.installRuntime(new AbortController().signal);
    assert.equal(fetchCount, 1);
    const setup = calls.slice(beforeInstall);
    assert.equal(setup.length, 4, "first use installs Python, CPU torch, speech dependencies, and the model");
    assert.ok(setup[0].args.includes("--managed-python"));
    assert.ok(setup[0].args.includes("--allow-existing"));
    assert.ok(setup[1].args.includes("https://download.pytorch.org/whl/cpu"));
    assert.ok(setup[2].args.includes("fermion-research==0.2.4"));
    assert.deepEqual(Array.from(setup[3].args), ["transcribe", "phonon-2", "unused.wav", "--download-only"]);
    assert.equal(publishedReady, 1, "ready marker is published only after the model download succeeds");
    assert.deepEqual(nativeExports.extractUv(archive, "uv.zip"), new Uint8Array([1, 2, 3]));
    assert.throws(() => nativeExports.extractUv(zipSync({ "../uv.exe": new Uint8Array([1]) }), "uv.zip"), /no uv executable/);
    const tar = new Uint8Array(1536);
    tar.set(new TextEncoder().encode("uv-fixture/uv"));
    tar.set(new TextEncoder().encode("00000000003\0"), 124);
    tar[156] = 48;
    tar.set([1, 2, 3], 512);
    assert.deepEqual(nativeExports.extractUv(gzipSync(tar), "uv-fixture.tar.gz"), new Uint8Array([1, 2, 3]));
    tar[156] = 50;
    assert.throws(() => nativeExports.extractUv(gzipSync(tar), "uv-fixture.tar.gz"), /no uv executable/, "symlinks are never extracted");
    downloadedArchive = new Uint8Array([1, 2, 3]);
    const beforeBadDownload = calls.length;
    await assert.rejects(nativeExports.installRuntime(new AbortController().signal), /checksum verification failed/);
    assert.equal(calls.length, beforeBadDownload, "unverified installers are never executed");
    downloadedArchive = archive;

    execute = async () => { throw new Error("setup interrupted"); };
    await assert.rejects(nativeExports.installRuntime(new AbortController().signal), /setup interrupted/);
    assert.equal(publishedReady, 1, "interrupted installation is never marked ready");
    execute = async () => ({ stdout: "" });
    await nativeExports.installRuntime(new AbortController().signal);
    assert.equal(publishedReady, 2, "partial installations can be retried");

}

void testNativeTranscription().then(() => {
    console.log("voice-message transcription checks passed");
}, error => {
    console.error(error);
    process.exitCode = 1;
});
