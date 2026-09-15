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

import { session } from "electron";
import { unzip, type Unzipped } from "fflate";
import { constants as fsConstants } from "fs";
import { access, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { DATA_DIR } from "./constants";
import { crxToZip } from "./crxToZip";
import { ensureSafePath } from "./ensureSafePath";
import { fetchBuffer } from "./http";

const extensionCacheDir = join(DATA_DIR, "ExtensionCache");

async function extract(data: Buffer, outDir: string) {
    const files = await new Promise<Unzipped>((resolve, reject) => {
        unzip(data, (error, files) => error ? reject(error) : resolve(files));
    });
    try {
        await mkdir(outDir, { recursive: true });
        for (const [name, contents] of Object.entries(files)) {
            // Signature stuff
            // 'Cannot load extension with file or directory name
            // _metadata. Filenames starting with "_" are reserved for use by the system.';
            if (name.startsWith("_metadata/")) continue;

            if (name.includes("\0")) throw new Error(`Invalid filename: "${name}"`);
            const path = ensureSafePath(outDir, name);
            if (!path) throw new Error(`Path traversal detected: "${name}"`);

            if (name.endsWith("/")) {
                await mkdir(path, { recursive: true });
            } else {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, contents);
            }
        }
    } catch (error) {
        await rm(outDir, { recursive: true, force: true });
        throw error;
    }
}

export async function installExt(id: string) {
    const extDir = ensureSafePath(extensionCacheDir, id);
    if (!extDir || extDir === extensionCacheDir) throw new Error("Invalid extension cache path");

    try {
        await access(extDir, fsConstants.F_OK);
    } catch (err) {
        const url = `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&x=id%3D${id}%26uc&prodversion=${process.versions.chrome}`;

        const buf = await fetchBuffer(url, {
            headers: {
                "User-Agent": `Electron ${process.versions.electron} ~ ProtonnCord (https://github.com/ProtonDev-sys/ProtonnCord)`
            }
        });

        await extract(crxToZip(buf), extDir);
    }

    if (session.defaultSession.extensions) {
        await session.defaultSession.extensions.loadExtension(extDir);
    } else {
        await session.defaultSession.loadExtension(extDir);
    }
}
