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

import { PluginNative } from "@utils/types";
import { Button, MediaEngineStore, showToast, Toasts, useEffect, useRef, useState } from "@webpack/common";

import { settings, useBusyState, type VoiceRecorder } from "..";

const Native = VencordNative.pluginHelpers.VoiceMessages as PluginNative<typeof import("../native")>;
let recordingOwner: symbol | undefined;

export const VoiceRecorderDesktop: VoiceRecorder = ({ setAudioBlob, onRecordingChange }) => {
    const [recording, setRecording] = useState(false);
    const [busy, setBusy] = useBusyState();
    const recordingRef = useRef(false);
    const mounted = useRef(true);
    const owner = useRef(Symbol("voice-recording"));
    const voiceModule = useRef<any>(undefined);

    const releaseOwner = () => {
        if (recordingOwner === owner.current) recordingOwner = undefined;
    };

    const discardRecording = (filePath: string) => {
        releaseOwner();
        if (filePath) void Native.readRecording(filePath).catch(() => { });
    };

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            if (recordingRef.current) {
                recordingRef.current = false;
                try {
                    voiceModule.current?.stopLocalAudioRecording(discardRecording);
                } catch {
                    releaseOwner();
                }
            }
        };
    }, []);

    const changeRecording = (recording: boolean) => {
        setRecording(recording);
        onRecordingChange?.(recording);
    };

    function toggleRecording() {
        if (busy.current) return;
        if (!recordingRef.current && recordingOwner && recordingOwner !== owner.current) {
            showToast("Another voice recording is in progress", Toasts.Type.FAILURE);
            return;
        }
        setBusy(true);
        try {
            const discordVoice = voiceModule.current = DiscordNative.nativeModules.requireModule("discord_voice");
            if (!recordingRef.current) {
                recordingOwner = owner.current;
                discordVoice.startLocalAudioRecording(
                    {
                        echoCancellation: settings.store.echoCancellation,
                        noiseCancellation: settings.store.noiseSuppression,
                        deviceId: MediaEngineStore.getInputDeviceId(),
                    },
                    (success: boolean) => {
                        if (!mounted.current) {
                            if (success) {
                                try { discordVoice.stopLocalAudioRecording(discardRecording); }
                                catch { releaseOwner(); }
                            } else releaseOwner();
                            return;
                        }
                        setBusy(false);
                        recordingRef.current = success;
                        if (success) {
                            changeRecording(true);
                        } else {
                            releaseOwner();
                            showToast("Failed to start recording", Toasts.Type.FAILURE);
                        }
                    }
                );
            } else {
                recordingRef.current = false;
                discordVoice.stopLocalAudioRecording(async (filePath: string) => {
                    releaseOwner();
                    try {
                        const buf = filePath ? await Native.readRecording(filePath) : null;
                        if (!mounted.current) return;
                        if (buf) setAudioBlob(new Blob([new Uint8Array(buf)], { type: "audio/ogg; codecs=opus" }));
                        else showToast("Failed to finish recording", Toasts.Type.FAILURE);
                    } catch {
                        if (mounted.current) showToast("Failed to finish recording", Toasts.Type.FAILURE);
                    } finally {
                        if (mounted.current) {
                            changeRecording(false);
                            setBusy(false);
                        }
                    }
                });
            }
        } catch {
            releaseOwner();
            recordingRef.current = false;
            changeRecording(false);
            setBusy(false);
            showToast("Failed to change recording state", Toasts.Type.FAILURE);
        }
    }

    return (
        <Button disabled={busy.current} onClick={toggleRecording}>
            {recording ? "Stop" : "Start"} recording
        </Button>
    );
};
