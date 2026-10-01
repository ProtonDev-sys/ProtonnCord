/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button, TextButton } from "@components/Button";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Span } from "@components/Span";
import { getLanguages, translateText, TranslationValue } from "@plugins/translate/utils";
import { DEFAULT_WAVEFORM, VoiceMessage } from "@plugins/voiceMessages";
import { generateWaveform } from "@plugins/voiceMessages/waveform";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message, RenderModalProps } from "@vencord/discord-types";
import { lodash, Modal, openModal, ScrollerAuto, SearchableSelect, useCallback, useEffect, useMemo, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";

import { detectAudioMimeType } from "./audioValidation";
import { buildTargetLanguageOptions, getVoiceMessageMedia, LanguageOption, resolveTargetLanguage } from "./options";
import { formatTimestampedTranscript, IdleResultCache, normalizeTranscriptionResult, TranscriptionResult } from "./transcriptionData";
import { cl, decodeAudio, terminateTranscriptionWorkers, TranscriptionWorker } from "./utils";

const Native = VencordNative.pluginHelpers.VoiceMessageTranscriber as PluginNative<typeof import("./native")>;
const MAX_PREPARED_AUDIO_CACHE_ENTRIES = 3;
let generation = 0;

function clearTranscriptionState() {
    generation++;
    terminateTranscriptionWorkers();
    preparedAudioCache.clear();
    resultCache.clear();
}

type ProcessingStatus = "idle" | "downloading_audio" | "processing_audio" | "transcribing" | "translating" | "complete";
type CopyTarget = "transcript" | "translation" | null;

interface CachedResult {
    targetLanguage?: string;
    targetLanguageLabel?: string;
    transcript: TranscriptionResult;
    translation?: TranslationValue;
}

const resultCache = new IdleResultCache<CachedResult>(value => value.transcript.text.length
    + value.transcript.chunks.reduce((size, chunk) => size + chunk.text.length, 0)
    + (value.translation?.text.length ?? 0));
interface PreparedAudio {
    blob: Blob;
    samples: Float32Array;
    waveform: string;
}

const preparedAudioCache = new Map<string, Promise<PreparedAudio>>();

function prepareAudio(src: string): Promise<PreparedAudio> {
    const cached = preparedAudioCache.get(src);
    if (cached) return cached;
    if (preparedAudioCache.size >= MAX_PREPARED_AUDIO_CACHE_ENTRIES)
        return Promise.reject(new Error("Audio preparation is busy; please retry shortly"));

    const pending = Native.fetchAudio(src)
        .then(async bytes => {
            const blob = new Blob([bytes as any], { type: detectAudioMimeType(bytes) ?? "application/octet-stream" });
            const samples = await decodeAudio(blob);
            return {
                blob,
                samples,
                waveform: generateWaveform(samples, 16_000)
            };
        })
        .finally(() => {
            if (preparedAudioCache.get(src) === pending) preparedAudioCache.delete(src);
        });

    preparedAudioCache.set(src, pending);
    return pending;
}

function cacheResult(messageId: string, result: CachedResult): void {
    resultCache.set(messageId, result);
}

const settings = definePluginSettings({
    autoTranscribe: {
        type: OptionType.BOOLEAN,
        description: "Automatically transcribe voice messages when they appear in chat",
        default: false,
        restartNeeded: false
    },
    engine: {
        type: OptionType.COMPONENT,
        component: () => (
            <BaseText>
                Phonon-2 only (English speech). First use automatically downloads Python, the speech runtime,
                and the model into private app storage. This can take several minutes and more space than the model alone.
                Audio stays on this device; no manual Python or model installation is needed.
            </BaseText>
        )
    },
    audioLanguage: {
        type: OptionType.STRING,
        description: "Legacy speech-language preference (unused by Phonon-2)",
        default: "auto",
        hidden: true
    },
    selectedModel: {
        type: OptionType.STRING,
        description: "Legacy speech-model preference (unused by Phonon-2)",
        default: "FermionResearch/Phonon-2",
        hidden: true
    },
    quantized: {
        type: OptionType.BOOLEAN,
        description: "Legacy quantization preference (unused by Phonon-2)",
        default: true,
        hidden: true
    },
    targetLanguage: {
        type: OptionType.STRING,
        description: "Last language selected for voice-message translation",
        default: "en",
        hidden: true
    },
    delete: {
        type: OptionType.COMPONENT,
        component: () => {
            const [size, setSize] = useState(0);
            const [deleteKeys, setDeleteKeys] = useState<string[]>([]);

            useEffect(() => {
                DataStore.entries().then(entries => {
                    let totalSize = 0;
                    const keys: string[] = [];

                    entries.forEach(([key, value]) => {
                        if (typeof key === "string" && key.startsWith("VoiceMessageTranscriber_") && lodash.isArrayBuffer(value)) {
                            keys.push(key);
                            totalSize += value.byteLength;
                        }
                    });

                    setSize(totalSize);
                    setDeleteKeys(keys);
                });
            }, []);

            return (
                <Button
                    variant="dangerPrimary"
                    onClick={() => {
                        DataStore.delMany(deleteKeys).then(() => {
                            setSize(0);
                            setDeleteKeys([]);
                        });
                    }}
                >
                    Delete legacy Whisper downloads ({(size / 1024 / 1024).toFixed(2)} MB)
                </Button>
            );
        }
    }
});

interface LanguageSelectionModalProps {
    modalProps: RenderModalProps;
    onSelect(language: LanguageOption): void;
}

function LanguageSelectionModal({ modalProps, onSelect }: LanguageSelectionModalProps) {
    const options = buildTargetLanguageOptions(getLanguages());
    const initialValue = resolveTargetLanguage(settings.store.targetLanguage, options);
    const [language, setLanguage] = useState(initialValue);

    const select = () => {
        const selected = options.find(option => option.value === language);
        if (!selected) return;

        settings.store.targetLanguage = selected.value;
        modalProps.onClose();
        onSelect(selected);
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Translate voice message"
            actions={[{
                text: "Transcribe & Translate",
                variant: "primary",
                onClick: select
            }]}
        >
            <Flex flexDirection="column" gap={12} style={{ padding: 16 }}>
                <BaseText size="sm" weight="semibold">Target language</BaseText>
                <SearchableSelect
                    options={options}
                    value={language}
                    onChange={setLanguage}
                />
                <BaseText size="xs" color="text-muted">
                    Speech recognition runs on your device. Translation sends only the resulting transcript text to the provider configured by the Translate plugin.
                </BaseText>
            </Flex>
        </Modal>
    );
}

function chooseTargetLanguage(onSelect: (language: LanguageOption) => void): void {
    openModal(modalProps => <LanguageSelectionModal modalProps={modalProps} onSelect={onSelect} />);
}

interface VoiceMessageTranscriptionAccessoryProps {
    duration?: number;
    messageId: string;
    needsPlaybackFallback: boolean;
    src: string;
    waveform?: string;
}

function VoiceMessageTranscriptionAccessory({ duration, messageId, needsPlaybackFallback, src, waveform }: VoiceMessageTranscriptionAccessoryProps) {
    const { autoTranscribe } = settings.use(["autoTranscribe"]);
    const initial = resultCache.get(messageId);
    const [status, setStatus] = useState<ProcessingStatus>(initial ? "complete" : "idle");
    const [transcript, setTranscript] = useState<TranscriptionResult | null>(initial?.transcript ?? null);
    const [partialTranscript, setPartialTranscript] = useState("");
    const [translation, setTranslation] = useState<TranslationValue | null>(initial?.translation ?? null);
    const [targetLanguage, setTargetLanguage] = useState(initial?.targetLanguage);
    const [targetLanguageLabel, setTargetLanguageLabel] = useState(initial?.targetLanguageLabel);
    const [pendingLanguageLabel, setPendingLanguageLabel] = useState<string>();
    const [showTimestamps, setShowTimestamps] = useState(false);
    const [hidden, setHidden] = useState(false);
    const [inView, setInView] = useState(typeof IntersectionObserver === "undefined");
    const [documentVisible, setDocumentVisible] = useState(typeof document === "undefined" || document.visibilityState !== "hidden");
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<CopyTarget>(null);
    const [playbackSrc, setPlaybackSrc] = useState(src);
    const [resolvedWaveform, setResolvedWaveform] = useState(waveform || DEFAULT_WAVEFORM);
    const workerRef = useRef<TranscriptionWorker | null>(null);
    const jobIdRef = useRef(0);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const autoStartedRef = useRef(false);

    const stopWorker = useCallback(() => {
        setPartialTranscript("");
        workerRef.current?.terminate();
        workerRef.current = null;
    }, []);

    const translateTranscript = useCallback(async (value: TranscriptionResult, language: LanguageOption, jobId: number) => {
        const currentGeneration = generation;
        setStatus("translating");
        setError(null);
        setPendingLanguageLabel(language.label);

        try {
            const cached = resultCache.get(messageId);
            const translated = cached?.transcript.text === value.text && cached.targetLanguage === language.value && cached.translation
                ? cached.translation : await translateText(value.text, "auto", language.value);
            if (jobIdRef.current !== jobId || currentGeneration !== generation) return;

            setTranslation(translated);
            setTargetLanguage(language.value);
            setTargetLanguageLabel(language.label);
            setStatus("complete");
            cacheResult(messageId, {
                transcript: value,
                translation: translated,
                targetLanguage: language.value,
                targetLanguageLabel: language.label
            });
        } catch (caught) {
            if (jobIdRef.current !== jobId || currentGeneration !== generation) return;
            setError(`Translation failed: ${caught instanceof Error ? caught.message : String(caught)}`);
            setStatus("complete");
        }
    }, [messageId]);

    const startTranscription = useCallback((language?: LanguageOption) => {
        const cached = resultCache.get(messageId);
        setHidden(false);
        if (cached) {
            setTranscript(cached.transcript);
            setTranslation(cached.translation ?? null);
            setTargetLanguage(cached.targetLanguage);
            setTargetLanguageLabel(cached.targetLanguageLabel);
            setStatus("complete");
            setError(null);
            if (language) void translateTranscript(cached.transcript, language, ++jobIdRef.current);
            return;
        }
        const currentGeneration = generation;
        const jobId = ++jobIdRef.current;
        stopWorker();
        setStatus("downloading_audio");
        setError(null);
        setTranslation(null);

        void (async () => {
            try {
                const prepared = await prepareAudio(src);
                if (jobIdRef.current !== jobId || currentGeneration !== generation) return;
                setStatus("processing_audio");
                const audio = prepared.samples;

                workerRef.current = new TranscriptionWorker(
                    nextStatus => {
                        if (jobIdRef.current === jobId && currentGeneration === generation) setStatus(nextStatus as ProcessingStatus);
                    },
                    output => {
                        if (jobIdRef.current !== jobId || currentGeneration !== generation) return;
                        const value = normalizeTranscriptionResult(output);
                        stopWorker();

                        if (!value.text) {
                            setError("No speech was detected in this voice message.");
                            setStatus("idle");
                            return;
                        }

                        setTranscript(value);
                        cacheResult(messageId, { transcript: value });

                        if (language) {
                            void translateTranscript(value, language, jobId);
                        } else {
                            setStatus("complete");
                        }
                    },
                    caught => {
                        if (jobIdRef.current !== jobId || currentGeneration !== generation) return;
                        stopWorker();
                        setError(caught instanceof Error ? caught.message : String(caught));
                        setStatus("idle");
                    },
                    text => {
                        if (jobIdRef.current === jobId && currentGeneration === generation) setPartialTranscript(text);
                    }
                );

                workerRef.current.run(audio);
            } catch (caught) {
                if (jobIdRef.current !== jobId || currentGeneration !== generation) return;
                stopWorker();
                setError(caught instanceof Error ? caught.message : String(caught));
                setStatus("idle");
            }
        })();
    }, [messageId, src, stopWorker, translateTranscript]);

    const startTranslation = useCallback((language: LanguageOption) => {
        setHidden(false);
        if (!transcript) {
            startTranscription(language);
            return;
        }

        const jobId = ++jobIdRef.current;
        void translateTranscript(transcript, language, jobId);
    }, [startTranscription, transcript, translateTranscript]);

    const cancel = useCallback(() => {
        ++jobIdRef.current;
        stopWorker();
        setStatus(transcript ? "complete" : "idle");
    }, [stopWorker, transcript]);

    const copy = useCallback((target: Exclude<CopyTarget, null>, text: string) => {
        copyToClipboard(text);
        setCopied(target);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
            copyTimerRef.current = null;
            setCopied(null);
        }, 2000);
    }, []);

    useEffect(() => () => {
        ++jobIdRef.current;
        stopWorker();
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    }, [stopWorker]);

    useEffect(() => resultCache.subscribe(messageId, () => {
        ++jobIdRef.current;
        stopWorker();
        setTranscript(null);
        setTranslation(null);
        setTargetLanguage(undefined);
        setTargetLanguageLabel(undefined);
        setError(null);
        setStatus("idle");
        setHidden(false);
    }), [messageId, stopWorker]);

    useEffect(() => {
        if (transcript && !hidden && inView && documentVisible) return resultCache.retain(messageId);
    }, [messageId, transcript, hidden, inView, documentVisible]);

    useEffect(() => {
        if (typeof document === "undefined") return;
        const update = () => setDocumentVisible(document.visibilityState !== "hidden");
        document.addEventListener("visibilitychange", update);
        const observer = typeof IntersectionObserver === "undefined" ? undefined
            : new IntersectionObserver(entries => setInView(entries.some(entry => entry.isIntersecting)));
        if (containerRef.current) observer?.observe(containerRef.current);
        return () => {
            document.removeEventListener("visibilitychange", update);
            observer?.disconnect();
        };
    }, []);

    useEffect(() => {
        setPlaybackSrc(src);
        setResolvedWaveform(waveform || DEFAULT_WAVEFORM);
        if (!needsPlaybackFallback || waveform) return;

        let active = true;
        let objectUrl: string | undefined;
        void prepareAudio(src).then(prepared => {
            if (!active) return;
            objectUrl = URL.createObjectURL(prepared.blob);
            setPlaybackSrc(objectUrl);
            setResolvedWaveform(prepared.waveform);
        }).catch(() => { });

        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [needsPlaybackFallback, src, waveform]);

    useEffect(() => {
        if (!autoTranscribe || transcript || autoStartedRef.current || !inView || !documentVisible) return;
        autoStartedRef.current = true;
        startTranscription();
    }, [autoTranscribe, startTranscription, transcript, inView, documentVisible]);

    const timestampedTranscript = useMemo(() => showTimestamps && transcript ? formatTimestampedTranscript(transcript) : "", [showTimestamps, transcript]);
    const transcriptText = showTimestamps && timestampedTranscript ? timestampedTranscript : transcript?.text ?? "";
    const busy = status !== "idle" && status !== "complete";

    if ((!transcript || hidden) && !busy) {
        return (
            <div ref={containerRef} className={cl("accessory")}>
                {needsPlaybackFallback && (
                    <div className={cl("playback-fallback")}>
                        <VoiceMessage key={playbackSrc} duration={duration} src={playbackSrc} waveform={resolvedWaveform} />
                    </div>
                )}
                <Flex gap={8} alignItems="center" flexWrap="wrap">
                    <Button size="xs" onClick={() => startTranscription()}>{transcript ? "Show transcript" : "Transcribe"}</Button>
                    <Button size="xs" variant="secondary" onClick={() => chooseTargetLanguage(startTranslation)}>Translate…</Button>
                    <Span size="xs" color="text-muted">Voice message · on-device speech recognition</Span>
                </Flex>
                {error && <BaseText className={cl("error")} size="xs">{error}</BaseText>}
            </div>
        );
    }

    return (
        <div ref={containerRef} className={cl("accessory")}>
            {needsPlaybackFallback && (
                <div className={cl("playback-fallback")}>
                    <VoiceMessage key={playbackSrc} duration={duration} src={playbackSrc} waveform={resolvedWaveform} />
                </div>
            )}
            {busy && (
                <Flex gap={8} alignItems="center" className={cl("status")}>
                    <Span size="sm" color="text-muted">
                        {status === "downloading_audio" && "Downloading voice message…"}
                        {status === "processing_audio" && "Preparing audio…"}
                        {status === "transcribing" && "Transcribing with Phonon-2 (first use installs the runtime and model; words appear as decoding progresses)…"}
                        {status === "translating" && `Translating to ${pendingLanguageLabel ?? "selected language"}…`}
                    </Span>
                    <TextButton variant="secondary" onClick={cancel}>Cancel</TextButton>
                </Flex>
            )}

            {busy && partialTranscript && (
                <section>
                    <Heading tag="h5">Transcript preview</Heading>
                    <ScrollerAuto className={cl("result")}>
                        <BaseText>{partialTranscript}</BaseText>
                    </ScrollerAuto>
                </section>
            )}

            {transcript && (
                <Flex flexDirection="column" gap={10}>
                    <section>
                        <Flex alignItems="center" justifyContent="space-between" gap={8}>
                            <Heading tag="h5">Transcript</Heading>
                            <TextButton variant="secondary" onClick={() => copy("transcript", transcriptText)}>
                                {copied === "transcript" ? "Copied" : "Copy"}
                            </TextButton>
                        </Flex>
                        <ScrollerAuto className={cl("result")}>
                            <BaseText>{transcriptText}</BaseText>
                        </ScrollerAuto>
                        {!!transcript.chunks.length && (
                            <TextButton variant="secondary" onClick={() => setShowTimestamps(value => !value)}>
                                {showTimestamps ? "Hide timestamps" : "Show timestamps"}
                            </TextButton>
                        )}
                    </section>

                    {translation && (
                        <section className={cl("translation")}>
                            <Flex alignItems="center" justifyContent="space-between" gap={8}>
                                <Heading tag="h5">{targetLanguageLabel ?? targetLanguage ?? "Translation"}</Heading>
                                <TextButton variant="secondary" onClick={() => copy("translation", translation.text)}>
                                    {copied === "translation" ? "Copied" : "Copy"}
                                </TextButton>
                            </Flex>
                            <ScrollerAuto className={cl("result")}>
                                <BaseText>{translation.text}</BaseText>
                            </ScrollerAuto>
                            <Span size="xs" color="text-muted">Detected source: {translation.sourceLanguage}</Span>
                        </section>
                    )}

                    {error && <BaseText className={cl("error")} size="xs">{error}</BaseText>}

                    {!busy && (
                        <Flex gap={10} alignItems="center" flexWrap="wrap">
                            <Button size="xs" variant="secondary" onClick={() => chooseTargetLanguage(startTranslation)}>
                                {translation ? "Change translation…" : "Translate…"}
                            </Button>
                            <TextButton
                                variant="secondary"
                                onClick={() => {
                                    setHidden(true);
                                    setError(null);
                                    setStatus("idle");
                                }}
                            >
                                Hide
                            </TextButton>
                        </Flex>
                    )}
                </Flex>
            )}
        </div>
    );
}

function VoiceMessageAccessory({ message }: { message: Message; }) {
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const media = getVoiceMessageMedia(message);
    if (!media) return null;

    return (
        <VoiceMessageTranscriptionAccessory
            key={`${userId}:${message.id}:${media.url}`}
            messageId={message.id}
            duration={media.duration}
            needsPlaybackFallback={media.needsPlaybackFallback}
            src={media.url}
            waveform={media.waveform}
        />
    );
}

export default definePlugin({
    name: "VoiceMessageTranscriber",
    authors: [Devs.TheSun],
    description: "Transcribes English Discord voice messages on-device with Phonon-2 and optionally translates the transcript.",
    tags: ["Chat", "Media", "Utility", "Voice"],
    dependencies: ["MessageAccessoriesAPI", "VoiceMessages"],
    settings,
    renderMessageAccessory: props => <VoiceMessageAccessory message={props.message} />,
    flux: { CONNECTION_OPEN: clearTranscriptionState },
    stop: clearTranscriptionState
});
