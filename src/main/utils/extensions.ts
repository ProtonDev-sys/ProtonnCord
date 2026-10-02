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
import { unzip, type Unzipped, unzipSync } from "fflate";
import { constants as fsConstants } from "fs";
import { access, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { DATA_DIR } from "./constants";
import { crxToZip } from "./crxToZip";
import { ensureSafePath } from "./ensureSafePath";
import { fetchBuffer } from "./http";

const extensionCacheDir = join(DATA_DIR, "ExtensionCache");
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const INSTALL_TIMEOUT_MS = 60000;

async function extract(data: Buffer, outDir: string) {
    try {
        const sizes = new Map<string, number>();
        let declaredTotal = 0;
        let compressedTotal = 0;
        unzipSync(data, { filter(file) {
            declaredTotal += file.originalSize;
            compressedTotal += file.size;
            if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0
                || !Number.isSafeInteger(file.size) || file.size < 0 || compressedTotal > data.byteLength
                || (file.compression !== 0 && file.compression !== 8)
                || (file.compression === 0 && file.size !== file.originalSize)
                || file.originalSize > MAX_ENTRY_BYTES || declaredTotal > MAX_EXTRACTED_BYTES
                || sizes.size >= MAX_ENTRIES || sizes.has(file.name))
                throw new Error("Extension archive exceeds declared limits or has duplicate entries");
            if (file.name.includes("\0") || !ensureSafePath(outDir, file.name))
                throw new Error("Invalid extension archive path");
            sizes.set(file.name, file.originalSize);
            return false;
        } });
        const files = await new Promise<Unzipped>((resolve, reject) => {
            const timer = setTimeout(() => {
                terminate();
                reject(new Error("Extension extraction timed out"));
            }, INSTALL_TIMEOUT_MS);
            let terminate: () => void = () => undefined;
            try {
                terminate = unzip(data, (error, files) => {
                    clearTimeout(timer);
                    error ? reject(error) : resolve(files);
                });
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        });
        if (Object.keys(files).length !== sizes.size)
            throw new Error("Extension archive entry count changed during extraction");
        let actualTotal = 0;
        for (const [name, contents] of Object.entries(files)) {
            actualTotal += contents.byteLength;
            if (contents.byteLength > MAX_ENTRY_BYTES || actualTotal > MAX_EXTRACTED_BYTES
                || contents.byteLength !== sizes.get(name))
                throw new Error("Extension archive exceeds extracted limits or declared size");
        }
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
        }, { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: INSTALL_TIMEOUT_MS });

        await extract(crxToZip(buf), extDir);
    }

    if (session.defaultSession.extensions) {
        await session.defaultSession.extensions.loadExtension(extDir);
    } else {
        await session.defaultSession.loadExtension(extDir);
    }
}
