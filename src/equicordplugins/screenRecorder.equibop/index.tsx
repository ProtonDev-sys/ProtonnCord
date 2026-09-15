/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { ScreenshareIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Menu, UploadHandler } from "@webpack/common";

let recorder: MediaRecorder | undefined;
let recordingStream: MediaStream | undefined;
let generation = 0;
let acquiring = false;
const logger = new Logger("ScreenRecorder");

function releaseStream() {
    const stream = recordingStream;
    recordingStream = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
}

export default definePlugin({
    name: "ScreenRecorder",
    description: "Adds an option to record your screen and upload the recording to the channel",
    tags: ["Chat"],
    authors: [Devs.AutumnVN],
    contextMenus: {
        "channel-attach": startRecording
    },
    stop() {
        generation++;
        acquiring = false;
        const previous = recorder;
        recorder = undefined;
        removeContextMenuPatch("channel-attach", stopRecording);
        if (previous && previous.state !== "inactive") previous.stop();
        releaseStream();
    }
});

function startRecording(children) {
    children.push(
        <Menu.MenuItem
            id="start-recording"
            label={
                <div>
                    <ScreenshareIcon height={24} width={24} />
                    <div>Start Recording</div>
                </div>
            }
            action={async () => {
                if (acquiring || recorder) return;
                acquiring = true;
                const currentGeneration = generation;
                try {
                    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: { ideal: 60 } } });
                    if (generation !== currentGeneration) {
                        stream.getTracks().forEach(track => track.stop());
                        return;
                    }
                    recordingStream = stream;
                    recorder = new MediaRecorder(stream);
                    recorder.start();
                    removeContextMenuPatch("channel-attach", startRecording);
                    addContextMenuPatch("channel-attach", stopRecording);
                } catch (error) {
                    if (generation === currentGeneration) {
                        recorder = undefined;
                        releaseStream();
                    }
                    if ((error as Error)?.name !== "NotAllowedError") logger.error("Could not start screen recording", error);
                } finally {
                    if (generation === currentGeneration) acquiring = false;
                }
            }}
        />
    );
}

function stopRecording(children, props) {
    children.push(
        <Menu.MenuItem
            id="stop-recording"
            label={
                <div>
                    <ScreenshareIcon height={24} width={24} />
                    <div>Stop Recording</div>
                </div>
            }
            action={() => {
                const previous = recorder;
                if (!previous || previous.state === "inactive") return;
                recorder = undefined;
                const currentGeneration = generation;
                previous.addEventListener("dataavailable", e => {
                    if (generation !== currentGeneration || !e.data.size) return;
                    const file = new File([e.data], "recording.webm", { type: "video/webm" });
                    UploadHandler.promptToUpload([file], props.channel, 0);
                }, { once: true });
                previous.stop();
                releaseStream();
                removeContextMenuPatch("channel-attach", stopRecording);
                addContextMenuPatch("channel-attach", startRecording);
            }}
        />
    );
}
