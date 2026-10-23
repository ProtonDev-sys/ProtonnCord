import "./style.css";

import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin from "@utils/types";
import { MediaEngineStore, Menu } from "@webpack/common";

import { CustomRange } from "./CustomRange";
import { MIN_FPS, MIN_RESOLUTION, settings } from "./settings";

export const cl = classNameFactory("vc-limitlessScreenshare-");

type CustomPresetListProps = {
    onChange: (value: number) => void,
    initialValue: number,
    group: string,
    id: string,
    list: {
        label: string;
        value: number;
    }[];
};

const CustomPresetList = ({ onChange, initialValue, group, id, list }: CustomPresetListProps) => {
    return list.map(({ label, value }, index) =>
        <Menu.MenuRadioItem
            key={index}
            group={`${group}`}
            id={`${id}-${value}`}
            action={() => onChange(value)}
            checked={initialValue === value}
            label={label}>
        </Menu.MenuRadioItem>
    );
};

export default definePlugin({
    name: "LimitlessScreenshare",
    description: "Adds a slider for screenshare resolution and fps.",
    authors: [EquicordDevs.KawaiianPizza],
    tags: ["Utility", "Voice"],
    settings,
    patches: [
        {
            find: '"canStreamWithSettings"',
            replacement: {
                match: /(?=if\(\i===\i\.\i.PRESET_AUTO\))/,
                replace: "return !0;"
            }
        },
        {
            find: '"stream-option-notify"',
            replacement: [
                {
                    match: /(?<=#{intl::IG5n0X::raw}\),children:).{0,150}checked:(\i)===.{0,80}action:\(\)=>(\(function.{0,150}resolution:\i\}\)\}\)).{0,5}\i\)\}\)/,
                    replace: "[...$self.OptionsRange($2,$1,true)]"
                },
                {
                    match: /(?<=#{intl::SkkeIt::raw}\),children:).{0,90}checked:(\i)===.{0,200}action:\(\)=>(\(function.{0,500}fps:\i\}\)\}\)).{0,5}\i\)\)/,
                    replace: "[...$self.OptionsRange($2,$1,false)]"
                },
            ]
        },
        {
            find: '"stream-settings-audio-enable"',
            replacement: [
                {
                    match: /\i\.\i\.map\((?=\i=>\{.{0,250}?group:"stream-settings-fps")/,
                    replace: "$self.SettingsRange(false,"
                },
                {
                    match: /\i\.\i\.map\((?=\i=>\{.{0,250}?group:"stream-settings-resolution")/,
                    replace: "$self.SettingsRange(true,"
                },
            ]
        }
    ],
    OptionsRange(changeStream: (value: number) => void, initialValue: number, isResolution: boolean, streamSettings = false) {
        const { maxFPS, maxResolution, roundResolution, resolutions, fpss } = settings.store;
        const scale = isResolution && roundResolution ? 10 : 1;
        const kind = isResolution ? "resolution" : streamSettings ? "fps" : "frame-rate";
        const id = `stream-${streamSettings ? "settings" : "option"}-${kind}`;
        const group = streamSettings ? id : kind;

        return [
            CustomRange({
                onChange: value => changeStream(value * scale),
                initialValue: initialValue / scale,
                minMax: isResolution ? [Math.ceil(MIN_RESOLUTION / scale), maxResolution / scale] : [MIN_FPS, maxFPS],
                group,
                id,
                suffix: isResolution ? roundResolution ? "0p" : "p" : streamSettings ? " FPS" : "fps"
            }),
            ...CustomPresetList({
                onChange: changeStream,
                initialValue,
                group,
                id,
                list: isResolution ? resolutions : fpss
            })
        ];
    },
    SettingsRange(isResolution: boolean, renderOption: (option: { value: number; }) => { props: { action(): void; }; }) {
        const quality = MediaEngineStore.getState().goLiveSource?.quality;
        const initialValue = isResolution ? quality?.resolution ?? 720 : quality?.frameRate ?? 30;
        // Reuse the native option's action so eligibility and related quality changes stay in its scope.
        return this.OptionsRange(value => renderOption({ value }).props.action(), initialValue, isResolution, true);
    },
});
