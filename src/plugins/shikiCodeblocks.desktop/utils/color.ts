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

export function hex2Rgb(hex: string) {
    hex = hex.slice(1);
    if (hex.length < 6) {
        let expanded = "";
        for (const char of hex) {
            expanded += char + char;
        }

        hex = expanded;
    }

    if (hex.length === 6) hex += "ff";
    if (hex.length > 6) hex = hex.slice(0, 6);
    const rgb: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
        rgb.push(parseInt(hex.slice(i, i + 2), 16));
    }

    return rgb;
}
