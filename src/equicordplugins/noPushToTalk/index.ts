import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "NoPushToTalk",
    description: "Bypasses the push-to-talk requirement for voice activity in channels that enforce it.",
    tags: ["Servers", "Voice"],
    authors: [EquicordDevs.omaw],
    patches: [
        {
            find: "PermissionVADStore",
            replacement: [
                {
                    match: /\|\|\i\.\i\.can\(\i\.\i\.USE_VAD,\i\)\|\|/,
                    replace: "||true||"
                },
                {
                    match: /shouldShowWarning\(\)\{return!\i\}/,
                    replace: "shouldShowWarning(){return false}"
                },
                {
                    match: /canUseVoiceActivity\(\)\{return \i\}/,
                    replace: "canUseVoiceActivity(){return true}"
                },
            ]
        }
    ],
});
