import assert from "node:assert/strict";

import {
    normalizeGuildIconFile,
    normalizeStoredGuildIcon,
    normalizeStoredGuildIcons,
} from "../src/equicordplugins/clientsideGuildIcons/iconStorage";

async function main(): Promise<void> {
    const pngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const migratedIcon = await normalizeStoredGuildIcon(pngDataUrl);

    assert(migratedIcon instanceof Blob, "legacy image data URLs migrate to Blob storage");
    assert.equal(migratedIcon.type, "image/png", "the image MIME type is preserved");
    assert(migratedIcon.size < pngDataUrl.length, "binary storage is smaller than base64 storage");

    const storedBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    assert.equal(await normalizeStoredGuildIcon(storedBlob), storedBlob, "existing Blob storage is reused");
    assert.equal(await normalizeStoredGuildIcon("https://example.com/icon.png"), null, "remote URLs are not accepted as local icon data");

    const migrated = await normalizeStoredGuildIcons({ guild: pngDataUrl, invalid: "not-an-image" });
    assert.equal(Object.keys(migrated.icons).length, 1, "invalid stored icons are removed");
    assert.equal(migrated.needsWrite, true, "legacy or invalid data requests a canonical rewrite");

    const canonical = await normalizeStoredGuildIcons({ guild: storedBlob });
    assert.deepEqual(canonical.icons, { guild: storedBlob }, "canonical Blob records are preserved");
    assert.equal(canonical.needsWrite, false, "canonical Blob records do not trigger redundant writes");

    const untypedFile = new File([storedBlob], "icon.PNG");
    const recovered = await normalizeStoredGuildIcons({ guild: untypedFile });
    assert(recovered.icons.guild instanceof Blob, "previously accepted image files without a MIME type survive restart");
    assert.equal(recovered.icons.guild.type, "image/png");
    assert.deepEqual(await recovered.icons.guild.arrayBuffer(), await untypedFile.arrayBuffer(), "recovering the MIME type preserves image bytes");
    assert.equal(recovered.needsWrite, true, "recovered files are rewritten with a persistent image MIME type");
    assert.equal((await normalizeStoredGuildIcons(recovered.icons)).needsWrite, false, "recovered icon storage is canonical on the next restart");
    assert.equal(await normalizeStoredGuildIcon(new Blob([storedBlob])), null, "unnamed untyped blobs cannot be recovered by guessing");
    assert.equal(await normalizeStoredGuildIcon(new File([storedBlob], "icon.txt")), null, "recovery does not accept extensions outside the upload contract");

    for (const [extension, mimeType] of Object.entries({ apng: "image/apng", avif: "image/avif", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" })) {
        for (const type of ["", "application/octet-stream"]) {
            const uploaded = normalizeGuildIconFile(new File([storedBlob], `icon.${extension}`, { type }));
            assert(uploaded instanceof Blob, `${extension} uploads retain the supported filename fallback`);
            assert.equal(uploaded.type, mimeType);
            const restored = await normalizeStoredGuildIcons({ guild: uploaded });
            assert.equal(restored.icons.guild, uploaded, "uploaded icons are already canonical when loaded again");
            assert.equal(restored.needsWrite, false);
        }
    }
    const typedFile = new File([storedBlob], "icon", { type: "image/png" });
    assert.equal(normalizeGuildIconFile(typedFile), typedFile, "known image MIME types do not require an extension");
    assert.equal(normalizeGuildIconFile(new File([storedBlob], "icon.txt")), null, "uploads still reject unrecognized files");

    console.log("clientsideGuildIcons storage checks passed");
}

void main();
