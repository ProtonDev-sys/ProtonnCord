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

import { Button, MediaEngineStore, showToast, Toasts, useEffect, useRef, useState } from "@webpack/common";

import { settings, type VoiceRecorder } from "..";

export const VoiceRecorderWeb: VoiceRecorder = ({ setAudioBlob, onRecordingChange }) => {
    const [recording, setRecording] = useState(false);
    const [paused, setPaused] = useState(false);
    const [busy, setBusy] = useState(false);
    const recorderRef = useRef<MediaRecorder | undefined>(undefined);
    const busyRef = useRef(false);
    const generation = useRef(0);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            generation.current++;
            const recorder = recorderRef.current;
            recorderRef.current = undefined;
            if (recorder) {
                try {
                    if (recorder.state !== "inactive") recorder.stop();
                } catch {
                    // Track cleanup still releases the microphone if the recorder has already failed.
                } finally {
                    recorder.stream.getTracks().forEach(track => track.stop());
                }
            }
        };
    }, []);

    const changeRecording = (recording: boolean) => {
        setRecording(recording);
        onRecordingChange?.(recording);
    };

    async function toggleRecording() {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        const currentGeneration = generation.current;
        const currentRecorder = recorderRef.current;
        if (currentRecorder) {
            try {
                currentRecorder.stop();
            } catch {
                currentRecorder.stream.getTracks().forEach(track => track.stop());
                recorderRef.current = undefined;
                changeRecording(false);
                busyRef.current = false;
                setBusy(false);
                showToast("Failed to finish recording", Toasts.Type.FAILURE);
            }
            return;
        }

        let mediaStream: MediaStream | undefined;
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: settings.store.echoCancellation,
                    noiseSuppression: settings.store.noiseSuppression,
                    deviceId: MediaEngineStore.getInputDeviceId()
                }
            });
            if (!mounted.current || generation.current !== currentGeneration) {
                mediaStream.getTracks().forEach(track => track.stop());
                return;
            }

            const chunks: Blob[] = [];
            const mimeType = "audio/ogg; codecs=opus";
            const recorder = new MediaRecorder(mediaStream, MediaRecorder.isTypeSupported(mimeType) ? { mimeType } : undefined);
            recorderRef.current = recorder;
            const handleDataAvailable = (e: BlobEvent) => chunks.push(e.data);
            const finish = (failed: boolean) => {
                recorder.removeEventListener("dataavailable", handleDataAvailable);
                recorder.removeEventListener("stop", handleStop);
                recorder.removeEventListener("error", handleError);
                recorder.stream.getTracks().forEach(track => track.stop());
                if (!mounted.current || recorderRef.current !== recorder) return;
                recorderRef.current = undefined;
                changeRecording(false);
                setPaused(false);
                busyRef.current = false;
                setBusy(false);
                if (failed) showToast("Failed to finish recording", Toasts.Type.FAILURE);
                else setAudioBlob(new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" }));
            };
            const handleStop = () => finish(false);
            const handleError = () => finish(true);
            recorder.addEventListener("dataavailable", handleDataAvailable);
            recorder.addEventListener("stop", handleStop, { once: true });
            recorder.addEventListener("error", handleError, { once: true });
            recorder.start();
            setPaused(false);
            changeRecording(true);
        } catch {
            mediaStream?.getTracks().forEach(track => track.stop());
            if (mounted.current && generation.current === currentGeneration) {
                recorderRef.current = undefined;
                changeRecording(false);
                showToast("Failed to start recording", Toasts.Type.FAILURE);
            }
        } finally {
            if (mounted.current && generation.current === currentGeneration) {
                busyRef.current = false;
                setBusy(false);
            }
        }
    }

    return (
        <>
            <Button disabled={busy} onClick={toggleRecording}>
                {recording ? "Stop" : "Start"} recording
            </Button>

            <Button
                disabled={!recording || busy}
                onClick={() => {
                    const recorder = recorderRef.current;
                    if (!recorder || recorder.state === "inactive") return;
                    try {
                        if (recorder.state === "paused") {
                            recorder.resume();
                            setPaused(false);
                        } else {
                            recorder.pause();
                            setPaused(true);
                        }
                    } catch {
                        showToast("Failed to pause or resume recording", Toasts.Type.FAILURE);
                    }
                }}
            >
                {paused ? "Resume" : "Pause"} recording
            </Button>
        </>
    );
};
