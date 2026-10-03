/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { Devs } from "@utils/constants";
import { identity } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher, Select, Slider, useEffect, useState } from "@webpack/common";
const configModule = findByPropsLazy("getOutputVolume");

const settings = definePluginSettings({
    title1: {
        type: OptionType.COMPONENT,
        component: () => <BaseText weight="bold" style={{ fontSize: "1.27rem" }}>Appearance</BaseText>,
        description: ""
    },
    uncollapseSettingsByDefault: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Automatically uncollapse voice settings by default"
    },
    title2: {
        type: OptionType.COMPONENT,
        component: () => <BaseText weight="bold" style={{ fontSize: "1.27rem" }}>Settings to show</BaseText>,
        description: ""
    },
    outputVolume: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show an output volume slider"
    },
    inputVolume: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show an input volume slider"
    },
    outputDevice: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show an output device selector"
    },
    inputDevice: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show an input device selector"
    },
    camera: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Show a camera selector"
    },
    title3: {
        type: OptionType.COMPONENT,
        component: () => <BaseText weight="bold" style={{ fontSize: "1.27rem" }}>Headers to show</BaseText>,
        description: ""
    },
    showOutputVolumeHeader: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show header above output volume slider"
    },
    showInputVolumeHeader: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show header above input volume slider"
    },
    showOutputDeviceHeader: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Show header above output device selector"
    },
    showInputDeviceHeader: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Show header above input device selector"
    },
    showVideoDeviceHeader: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Show header above camera selector"
    },
});

const volumeEvents = { Output: "AUDIO_SET_OUTPUT_VOLUME", Input: "AUDIO_SET_INPUT_VOLUME" } as const;
const deviceConfig = {
    Output: { event: "AUDIO_SET_OUTPUT_DEVICE", title: "Output device", icon: "🔊" },
    Input: { event: "AUDIO_SET_INPUT_DEVICE", title: "Input device", icon: "🎤" },
    Video: { event: "MEDIA_ENGINE_SET_VIDEO_DEVICE", title: "Camera", icon: "📷" }
} as const;

function VolumeComponent({ kind }: { kind: keyof typeof volumeEvents; }) {
    const [volume, setVolume] = useState(configModule[`get${kind}Volume`]());
    const event = volumeEvents[kind];

    useEffect(() => {
        const listener = () => setVolume(configModule[`get${kind}Volume`]());
        FluxDispatcher.subscribe(event, listener);
        return () => FluxDispatcher.unsubscribe(event, listener);
    }, [kind]);

    return <>
        {settings.store[`show${kind}VolumeHeader`] && <Heading>{kind} volume</Heading>}
        <Slider
            maxValue={kind === "Output" ? 200 : 100}
            minValue={0}
            onValueRender={kind === "Output" ? value => `${value.toFixed(0)}%` : undefined}
            initialValue={volume}
            asValueChanges={value => FluxDispatcher.dispatch({ type: event, volume: value })}
        />
    </>;
}

function DeviceComponent({ kind }: { kind: keyof typeof deviceConfig; }) {
    const [deviceId, setDeviceId] = useState(configModule[`get${kind}DeviceId`]());
    const { event, title, icon } = deviceConfig[kind];
    const showHeader = settings.store[`show${kind}DeviceHeader`];
    const devices: Record<string, { id: string; name: string; }> = configModule[`get${kind}Devices`]();

    useEffect(() => {
        const listener = () => setDeviceId(configModule[`get${kind}DeviceId`]());
        FluxDispatcher.subscribe(event, listener);
        return () => FluxDispatcher.unsubscribe(event, listener);
    }, [kind]);

    const controls = <>
        {showHeader && <Heading>{title}</Heading>}
        <Select
            options={Object.values(devices).map(device => ({
                value: device.id,
                label: showHeader ? device.name : `${icon} ${device.name}`
            }))}
            serialize={identity}
            isSelected={value => value === deviceId}
            select={id => FluxDispatcher.dispatch({ type: event, id })}
        />
    </>;
    return kind === "Output" ? controls : <div style={{ marginTop: "10px" }}>{controls}</div>;
}

function VoiceSettings() {
    const [showSettings, setShowSettings] = useState(settings.store.uncollapseSettingsByDefault);
    return <div style={{ marginTop: "20px" }}>
        <div style={{ marginBottom: "10px" }}>
            <Link className="vc-panelsettings-underline-on-hover" style={{ color: "var(--text-default)" }} onClick={() => { setShowSettings(!showSettings); }}>{!showSettings ? "► Settings" : "▼ Hide"}</Link>
        </div>

        {
            showSettings && <>
                {settings.store.outputVolume && <VolumeComponent kind="Output" />}
                {settings.store.inputVolume && <VolumeComponent kind="Input" />}
                {settings.store.outputDevice && <DeviceComponent kind="Output" />}
                {settings.store.inputDevice && <DeviceComponent kind="Input" />}
                {settings.store.camera && <DeviceComponent kind="Video" />}
            </>
        }
    </div>;
}

export default definePlugin({
    name: "VCPanelSettings",
    description: "Control voice settings right from the voice panel",
    tags: ["Utility", "Voice"],
    authors: [Devs.nin0dev],
    settings,
    renderVoiceSettings() { return <VoiceSettings />; },
    patches: [
        {
            find: "}getAccessibilityLabel(){",
            replacement: {
                match: /this.renderVoiceStates\(\),\i/,
                replace: "$&,$self.renderVoiceSettings()"
            }
        }
    ]
});
