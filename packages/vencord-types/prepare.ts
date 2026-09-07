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

import { copyFileSync, moveSync, readdirSync, rmSync } from "fs-extra";
import { join } from "path";

readdirSync(join(__dirname, "src"))
    .forEach(child => moveSync(join(__dirname, "src", child), join(__dirname, child), { overwrite: true }));

for (const file of ["preload.d.ts", "userplugins", "src", "browser", "scripts"]) {
    rmSync(join(__dirname, file), { recursive: true, force: true });
}

copyFileSync(join(__dirname, "..", "..", "src", "modules.d.ts"), join(__dirname, "modules.d.ts"));
copyFileSync(join(__dirname, "..", "..", "LICENSE"), join(__dirname, "LICENSE"));
