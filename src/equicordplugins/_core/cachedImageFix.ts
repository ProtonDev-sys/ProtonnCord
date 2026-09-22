/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";

interface CachedImage {
    url: string;
    loaded: boolean;
    width: number;
    height: number;
}

export default definePlugin({
    name: "CachedImageFix",
    description: "Fixes media staying blank when its image finishes loading before the chat preview subscribes.",
    authors: [EquicordDevs.creations],
    required: true,
    patches: [{
        find: "ImageLoaderUtils.getSrcWithWidthAndHeight",
        replacement: {
            // Discord replaces completed entries without their pending callbacks, but
            // this cache-hit branch iterates those callbacks instead of notifying its caller.
            match: /if\(null!=(\i)&&\1\.loaded\)return null!=(\i)&&\i\.\i\.awaitOnline\(\)\.then\(\(\)=>\{null!=\1&&null!=\1\.callbacks&&\1\.callbacks\.forEach\(\i=>\{null!=\1\?\i\(!1,\1\):\i\(!0,\{url:\i,loaded:!0\}\)\}\)\}\),\i\.\i;/,
            replace: "if(null!=$1&&$1.loaded)return $self.notifyCachedImage($1,$2);",
        },
    }],

    notifyCachedImage(image: CachedImage, callback?: (error: boolean, image: CachedImage) => void) {
        let cancelled = false;
        // Keep completion asynchronous so callers can register their cancellation handle.
        // An image that is already loaded does not need to wait for a network connection.
        if (callback) queueMicrotask(() => {
            if (!cancelled) callback(false, image);
        });
        return () => { cancelled = true; };
    },
});
