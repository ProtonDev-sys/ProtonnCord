/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./settings.css";

import { Divider } from "@components/Divider";
import { Heading } from "@components/Heading";
import { resolveError } from "@components/settings/tabs/plugins/components/Common";
import { classNameFactory } from "@utils/css";
import { useAwaiter } from "@utils/react";
import { ActivityType } from "@vencord/discord-types/enums";
import { Button, Select, showToast, Text, TextInput, Toasts, useEffect, useRef, useState } from "@webpack/common";

import { RpcConfig, settings, TimestampMode } from ".";
import { applyRpcConfig, deletePreset, loadPresets, RPC_CONFIG_KEYS, RpcNumberKey, RpcStringKey, savePreset } from "./presets";

const cl = classNameFactory("vc-customRPC-settings-");

type TextOption = {
    label: string;
    disabled?: boolean;
    isValid?: (value: string) => true | string;
} & ({ settingsKey: RpcStringKey; numeric?: false; } | { settingsKey: RpcNumberKey; numeric: true; });

interface SelectOption<K extends "type" | "timestampMode"> {
    settingsKey: K;
    label: string;
    disabled?: boolean;
    options: { label: string; value: NonNullable<RpcConfig[K]>; default?: boolean; }[];
}

const makeValidator = (maxLength: number, isRequired = false) => (value: string) => {
    if (isRequired && !value) return "This field is required.";
    if (value.length > maxLength) return `Must be not longer than ${maxLength} characters.`;
    return true;
};

const maxLength128 = makeValidator(128);

function isAppIdValid(value: string) {
    if (!/^\d{16,21}$/.test(value)) return "Must be a valid Discord ID.";
    return true;
}

function isStreamLinkDisabled() {
    return settings.store.type !== ActivityType.STREAMING;
}

function isStreamLinkValid(value: string) {
    if (!isStreamLinkDisabled() && !/https?:\/\/(www\.)?(twitch\.tv|youtube\.com)\/\w+/.test(value)) return "Streaming link must be a valid URL.";
    if (value && value.length > 512) return "Streaming link must be not longer than 512 characters.";
    return true;
}

function isUrlValid(value: string) {
    if (value && !/^https?:\/\/.+/.test(value)) return "Must be a valid URL.";
    return true;
}

function isImageKeyValid(value: string) {
    if (/https?:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(value)) return "Don't use a Discord link. Use an Imgur image link instead.";
    if (/https?:\/\/(?!i\.)?imgur\.com\//.test(value)) return "Imgur link must be a direct link to the image (e.g. https://i.imgur.com/...). Right click the image and click 'Copy image address'";
    if (/https?:\/\/(?!media\.)?tenor\.com\//.test(value)) return "Tenor link must be a direct link to the image (e.g. https://media.tenor.com/...). Right click the GIF and click 'Copy image address'";
    return true;
}

function PairSetting(props: { data: [TextOption, TextOption]; }) {
    const [left, right] = props.data;

    return (
        <div className={cl("pair")}>
            <SingleSetting {...left} />
            <SingleSetting {...right} />
        </div>
    );
}

function SingleSetting({ settingsKey, label, disabled, isValid, numeric }: TextOption) {
    const value = settings.store[settingsKey];
    const [state, setState] = useState(String(value ?? ""));
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setState(String(value ?? ""));
        setError(null);
    }, [value]);

    function handleChange(newValue: string) {
        setState(newValue);
        const number = Number(newValue);
        const valid = numeric && newValue !== "" && (!/^\d+$/.test(newValue) || !Number.isSafeInteger(number)
            || ((settingsKey === "startTime" || settingsKey === "endTime") && number > 8.64e15))
            ? "Must be a nonnegative whole number within the supported range."
            : isValid?.(newValue) ?? true;
        setError(resolveError(valid));

        if (valid === true) Object.assign(settings.store, { [settingsKey]: numeric ? (newValue === "" ? undefined : number) : newValue });
    }

    return (
        <div className={cl("single", { disabled })}>
            <Heading tag="h5">{label}</Heading>
            <TextInput
                aria-label={label}
                aria-invalid={!!error}
                type="text"
                placeholder={"Enter a value"}
                value={state}
                onChange={handleChange}
                disabled={disabled}
            />
            {error && <Text className={cl("error")} variant="text-sm/normal">{error}</Text>}
        </div>
    );
}

function SelectSetting<K extends "type" | "timestampMode">({ settingsKey, label, options, disabled }: SelectOption<K>) {
    const value = settings.store[settingsKey] ?? options.find(option => option.default)?.value;
    return (
        <div className={cl("single", { disabled })}>
            <Heading tag="h5">{label}</Heading>
            <Select
                placeholder={"Select an option"}
                options={options}
                maxVisibleItems={5}
                closeOnSelect={true}
                select={v => Object.assign(settings.store, { [settingsKey]: v })}
                isSelected={v => v === value}
                serialize={v => String(v)}
                isDisabled={disabled}
            />
        </div>
    );
}

function PresetSettings({ onLoad }: { onLoad(): void; }) {
    const [revision, setRevision] = useState(0);
    const [presets, loadError, pending] = useAwaiter(loadPresets, { fallbackValue: [], deps: [revision] });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const saving = useRef(false);
    const [presetName, setPresetName] = useState("");
    const [selectedPreset, setSelectedPreset] = useState("");
    const unavailable = pending || busy || !!loadError;

    async function act(action: "save" | "load" | "delete") {
        if (unavailable || saving.current) return;
        const name = action === "save" ? presetName.trim() : selectedPreset;
        if (!name) return;
        saving.current = true;
        setBusy(true);
        setError(null);
        try {
            if (action === "save") await savePreset(name, settings.store);
            else if (action === "delete") await deletePreset(name);
            else {
                const preset = presets.find(preset => preset.name === name);
                if (!preset) return;
                applyRpcConfig(settings.store, preset.config);
                onLoad();
            }
            setSelectedPreset(action === "delete" ? "" : name);
            if (action !== "load") setRevision(value => value + 1);
            showToast(`${action === "save" ? "Saved" : action === "delete" ? "Deleted" : "Loaded"} preset ${name}.`, Toasts.Type.SUCCESS);
        } catch (error) {
            setError(error instanceof Error ? error.message : "Could not update presets. Please try again.");
        } finally {
            saving.current = false;
            setBusy(false);
        }
    }

    return (
        <div className={cl("presets")}>
            <Heading tag="h5">Presets</Heading>
            <div className={cl("preset-create")}>
                <TextInput
                    aria-label="Preset name"
                    type="text"
                    placeholder="Preset name"
                    value={presetName}
                    onChange={setPresetName}
                />
                <Button disabled={unavailable || !presetName.trim()} onClick={() => act("save")}>Save</Button>
            </div>
            {presets.length ? (
                <div className={cl("preset-actions")}>
                    <Select
                        isDisabled={unavailable}
                        placeholder="Select a preset"
                        options={presets.map(preset => ({ label: preset.name, value: preset.name }))}
                        closeOnSelect={true}
                        select={setSelectedPreset}
                        isSelected={value => value === selectedPreset}
                        serialize={String}
                    />
                    <Button disabled={unavailable || !selectedPreset} onClick={() => act("load")}>Load</Button>
                    <Button color={Button.Colors.RED} disabled={unavailable || !selectedPreset} onClick={() => act("delete")}>Delete</Button>
                </div>
            ) : (
                <Text variant="text-sm/normal">{pending ? "Loading presets…" : loadError ? "Could not load saved presets." : "No saved presets yet."}</Text>
            )}
            {(error || loadError) && <Text role="alert" className={cl("error")} variant="text-sm/normal">{error || "Could not read saved presets. Your saved data has been kept."}</Text>}
            {loadError && <Button disabled={busy || pending} onClick={() => setRevision(value => value + 1)}>Retry</Button>}
        </div>
    );
}

function RPCFields() {
    const { type = ActivityType.PLAYING, timestampMode = TimestampMode.NONE } = settings.use(RPC_CONFIG_KEYS);

    return (
        <>
            <SelectSetting
                settingsKey="type"
                label="Activity Type"
                options={[
                    {
                        label: "Playing",
                        value: ActivityType.PLAYING,
                        default: true
                    },
                    {
                        label: "Streaming",
                        value: ActivityType.STREAMING
                    },
                    {
                        label: "Listening",
                        value: ActivityType.LISTENING
                    },
                    {
                        label: "Watching",
                        value: ActivityType.WATCHING
                    },
                    {
                        label: "Competing",
                        value: ActivityType.COMPETING
                    }
                ]}
            />

            <PairSetting data={[
                { settingsKey: "appID", label: "Application ID", isValid: isAppIdValid },
                { settingsKey: "appName", label: "Application Name", isValid: makeValidator(128, true) },
            ]} />

            <PairSetting data={[
                { settingsKey: "details", label: "Detail (line 1)", isValid: maxLength128 },
                { settingsKey: "detailsURL", label: "Detail URL", isValid: isUrlValid },
            ]} />

            <PairSetting data={[
                { settingsKey: "state", label: "State (line 2)", isValid: maxLength128 },
                { settingsKey: "stateURL", label: "State URL", isValid: isUrlValid },
            ]} />

            <SingleSetting
                settingsKey="streamLink"
                label="Stream Link (Twitch or YouTube, only if activity type is Streaming)"
                disabled={type !== ActivityType.STREAMING}
                isValid={isStreamLinkValid}
            />

            <PairSetting data={[
                {
                    settingsKey: "partySize",
                    label: "Party Size",
                    numeric: true,
                    disabled: type !== ActivityType.PLAYING,
                },
                {
                    settingsKey: "partyMaxSize",
                    label: "Maximum Party Size",
                    numeric: true,
                    disabled: type !== ActivityType.PLAYING,
                },
            ]} />

            <Divider />

            <PairSetting data={[
                { settingsKey: "imageBig", label: "Large Image URL/Key", isValid: isImageKeyValid },
                { settingsKey: "imageBigTooltip", label: "Large Image Text", isValid: maxLength128 },
            ]} />
            <SingleSetting settingsKey="imageBigURL" label="Large Image clickable URL" isValid={isUrlValid} />

            <PairSetting data={[
                { settingsKey: "imageSmall", label: "Small Image URL/Key", isValid: isImageKeyValid },
                { settingsKey: "imageSmallTooltip", label: "Small Image Text", isValid: maxLength128 },
            ]} />
            <SingleSetting settingsKey="imageSmallURL" label="Small Image clickable URL" isValid={isUrlValid} />

            <Divider />

            <PairSetting data={[
                { settingsKey: "buttonOneText", label: "Button1 Text", isValid: makeValidator(31) },
                { settingsKey: "buttonOneURL", label: "Button1 URL", isValid: isUrlValid },
            ]} />
            <PairSetting data={[
                { settingsKey: "buttonTwoText", label: "Button2 Text", isValid: makeValidator(31) },
                { settingsKey: "buttonTwoURL", label: "Button2 URL", isValid: isUrlValid },
            ]} />

            <Divider />

            <SelectSetting
                settingsKey="timestampMode"
                label="Timestamp Mode"
                options={[
                    {
                        label: "None",
                        value: TimestampMode.NONE,
                        default: true
                    },
                    {
                        label: "Since discord open",
                        value: TimestampMode.NOW
                    },
                    {
                        label: "Same as your current time (not reset after 24h)",
                        value: TimestampMode.TIME
                    },
                    {
                        label: "Custom",
                        value: TimestampMode.CUSTOM
                    }
                ]}
            />

            <PairSetting data={[
                {
                    settingsKey: "startTime",
                    label: "Start Timestamp (in milliseconds)",
                    numeric: true,
                    disabled: timestampMode !== TimestampMode.CUSTOM,
                },
                {
                    settingsKey: "endTime",
                    label: "End Timestamp (in milliseconds)",
                    numeric: true,
                    disabled: timestampMode !== TimestampMode.CUSTOM,
                },
            ]} />
        </>
    );
}

export function RPCSettings() {
    const [formVersion, setFormVersion] = useState(0);

    return (
        <div className={cl("root")}>
            <PresetSettings onLoad={() => setFormVersion(version => version + 1)} />
            <Divider />
            <RPCFields key={formVersion} />
        </div>
    );
}
