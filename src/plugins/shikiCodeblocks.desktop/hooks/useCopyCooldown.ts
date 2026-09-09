/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
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

import { copyToClipboard } from "@utils/clipboard";
import { Logger } from "@utils/Logger";
import { React } from "@webpack/common";

export function useCopyCooldown(cooldown: number) {
    const [copyCooldown, setCopyCooldown] = React.useState(false);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const active = React.useRef(true);

    React.useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
            if (timeoutRef.current === undefined) return;

            clearTimeout(timeoutRef.current);
            timeoutRef.current = undefined;
        };
    }, []);

    async function copy(text: string) {
        try {
            await copyToClipboard(text);
        } catch (error) {
            new Logger("ShikiCodeblocks").error("Failed to copy code", error);
            return;
        }
        if (!active.current) return;
        setCopyCooldown(true);

        if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current);

        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = undefined;
            setCopyCooldown(false);
        }, cooldown);
    }

    return [copyCooldown, copy] as const;
}
