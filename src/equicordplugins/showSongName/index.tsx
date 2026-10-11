import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "ShowSongName",
    description: "Shows song name instead of artist for Spotify activity",
    tags: ["Activity"],
    authors: [Devs.prism],

    patches: [
        {
            find: '.join(", ");return{text:',
            replacement: {
                match: /(?<=.join\(", "\);return\{text:)\i/,
                replace: "arguments[0]?.details??$&"
            }
        }
    ]
});
