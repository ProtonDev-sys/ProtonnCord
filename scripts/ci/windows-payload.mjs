// SPDX-License-Identifier: GPL-3.0-or-later
// Inspect PE/CLR resource bytes without loading or executing the assembly.
export function verifyWindowsPayload(executable, payload) {
    const requireState = (condition, message) => { if (!condition) throw new Error(`Invalid Windows executable: ${message}`); };
    const bounded = (offset, length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length)
        && offset >= 0 && length > 0 && offset + length <= executable.length;
    requireState(Buffer.isBuffer(executable) && executable.length <= 128 * 1024 * 1024
        && executable.length >= 64 && executable.toString("ascii", 0, 2) === "MZ", "DOS header");
    requireState(Buffer.isBuffer(payload) && payload.length > 0, "missing expected payload");
    const pe = executable.readUInt32LE(0x3c);
    requireState(bounded(pe, 24) && executable.readUInt32LE(pe) === 0x00004550, "PE signature");
    const count = executable.readUInt16LE(pe + 6);
    const optional = pe + 24;
    const optionalSize = executable.readUInt16LE(pe + 20);
    requireState(count > 0 && count <= 96 && bounded(optional, optionalSize), "section headers");
    const magic = executable.readUInt16LE(optional);
    const directories = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
    requireState(directories && optionalSize >= directories + 15 * 8
        && executable.readUInt32LE(optional + directories - 4) >= 15, "CLR directory");
    const sections = optional + optionalSize;
    requireState(bounded(sections, count * 40), "section table bounds");
    function rva(value, size) {
        for (let index = 0; index < count; index++) {
            const section = sections + index * 40;
            const address = executable.readUInt32LE(section + 12);
            const rawSize = executable.readUInt32LE(section + 16);
            const raw = executable.readUInt32LE(section + 20);
            const delta = value - address;
            if (delta >= 0 && delta + size <= rawSize && bounded(raw + delta, size)) return raw + delta;
        }
        throw new Error("Invalid Windows executable: RVA escapes raw sections");
    }
    const cliRva = executable.readUInt32LE(optional + directories + 14 * 8);
    const cliSize = executable.readUInt32LE(optional + directories + 14 * 8 + 4);
    requireState(cliRva > 0 && cliSize >= 72, "CLR header bounds");
    const cli = rva(cliRva, cliSize);
    requireState(executable.readUInt32LE(cli) >= 72, "CLR header size");
    const metadataSize = executable.readUInt32LE(cli + 12);
    requireState(metadataSize >= 16, "metadata bounds");
    const metadata = rva(executable.readUInt32LE(cli + 8), metadataSize);
    requireState(executable.readUInt32LE(metadata) === 0x424a5342, "metadata signature");
    const resourceSize = executable.readUInt32LE(cli + 28);
    requireState(resourceSize >= payload.length + 4, "managed resource size");
    const resources = rva(executable.readUInt32LE(cli + 24), resourceSize);
    const bytes = executable.subarray(resources, resources + resourceSize);
    const offset = bytes.indexOf(payload);
    requireState(offset >= 4 && bytes.readUInt32LE(offset - 4) === payload.length,
        "embedded desktop payload differs from the validated ASAR");
}
