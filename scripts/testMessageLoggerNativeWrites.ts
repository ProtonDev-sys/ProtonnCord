/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    createImageCacheFile,
    getImageCachePath,
    normalizeAttachmentExtension,
    normalizeAttachmentId,
    parseImageCacheFilename
} from "../src/equicordplugins/messageLoggerEnhanced/native/cacheFile";

assert.equal(normalizeAttachmentId("123456789012345678"), "123456789012345678");
assert.equal(normalizeAttachmentId("0"), "0");
assert.equal(normalizeAttachmentId("18446744073709551615"), "18446744073709551615");
assert.equal(normalizeAttachmentExtension(".PNG"), "png");
assert.equal(normalizeAttachmentExtension("webm"), "webm");
assert.deepEqual(parseImageCacheFilename("123456789012345678.webp"), {
    attachmentId: "123456789012345678",
    extension: "webp"
});

for (const pathApi of [path.posix, path.win32]) {
    const root = pathApi === path.win32 ? "C:\\Users\\test\\savedImages" : "/home/test/savedImages";
    const filename = "895063026686885909.png";
    const target = pathApi.resolve(root, filename);
    assert.equal(pathApi.dirname(target), pathApi.resolve(root));
    assert.equal(pathApi.basename(target), filename);
    assert.equal(pathApi.relative(pathApi.resolve(root), target), filename);
    const escapedNames = pathApi === path.win32
        ? ["../escape.png", "..\\escape.png", "/absolute.png", "C:\\absolute.png", "\\\\server\\share.png"]
        : ["../escape.png", "/absolute.png"];
    for (const escapedName of escapedNames) {
        const escapedTarget = pathApi.resolve(root, escapedName);
        const isDirectChild = pathApi.dirname(escapedTarget) === pathApi.resolve(root) && pathApi.basename(escapedTarget) === escapedName;
        assert.equal(isDirectChild, false, `${pathApi === path.win32 ? "win32" : "posix"} must reject ${escapedName}`);
    }
}

const invalidIds: unknown[] = [
    null,
    undefined,
    895063026686885909n,
    "",
    ".",
    "..",
    "../escape",
    "..\\escape",
    "folder/file",
    "folder\\file",
    "image.png",
    "temporary_ID-1",
    "０１２３",
    "%2e%2e",
    " 123",
    "C:\\escape",
    "\\\\server\\share",
    "id\0png",
    "1".repeat(21),
    "18446744073709551616"
];
for (const attachmentId of invalidIds) {
    assert.throws(() => normalizeAttachmentId(attachmentId), /Invalid attachment ID/u, `${String(attachmentId)} must be rejected`);
}

const invalidExtensions = [
    "",
    ".",
    "..",
    "../png",
    "..\\png",
    "./../../escape",
    "tar.gz",
    "png/escape",
    "png\\escape",
    "%2e%2e",
    "png:stream",
    "a".repeat(17)
];
for (const extension of invalidExtensions) {
    assert.throws(() => normalizeAttachmentExtension(extension), /Invalid attachment extension/u,
        `${JSON.stringify(extension)} must be rejected`);
}

for (const filename of ["../escape.png", "..\\escape.png", "double.ext.png", ".hidden", "no-extension", "id.png/escape"]) {
    assert.equal(parseImageCacheFilename(filename), null, `${JSON.stringify(filename)} must not be indexed`);
}
assert.equal(parseImageCacheFilename("123.PNG"), null, "non-canonical cache extensions must not be indexed");

async function runFileChecks() {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "protonncord-message-cache-"));
    const resolvedTemporaryRoot = `${path.resolve(tmpdir())}${path.sep}`;
    assert.ok(path.resolve(cacheRoot).startsWith(resolvedTemporaryRoot), "the test cache must remain inside the system temp directory");

    try {
        const imagePath = getImageCachePath(cacheRoot, "123456789012345678", ".png");
        assert.equal(path.dirname(imagePath), path.resolve(cacheRoot));
        assert.equal(path.basename(imagePath), "123456789012345678.png");

        const original = Uint8Array.from([1, 2, 3, 4]);
        assert.equal(await createImageCacheFile(cacheRoot, "123456789012345678", "png", original), imagePath);
        assert.deepEqual(await readFile(imagePath), Buffer.from(original));

        await assert.rejects(
            createImageCacheFile(cacheRoot, "123456789012345678", "png", Uint8Array.from([9, 9, 9])),
            (error: NodeJS.ErrnoException) => error.code === "EEXIST",
            "an existing cache entry must never be overwritten"
        );
        assert.deepEqual(await readFile(imagePath), Buffer.from(original));

        const linkedTarget = path.join(cacheRoot, "protected.bin");
        const linkedCachePath = getImageCachePath(cacheRoot, "987654321098765432", "png");
        await writeFile(linkedTarget, Buffer.from("protected"));
        await link(linkedTarget, linkedCachePath);
        await assert.rejects(
            createImageCacheFile(cacheRoot, "987654321098765432", "png", Uint8Array.from([0])),
            (error: NodeJS.ErrnoException) => error.code === "EEXIST",
            "exclusive creation must not follow or overwrite an existing filesystem entry"
        );
        assert.equal(await readFile(linkedTarget, "utf8"), "protected");

        const raceResults = await Promise.allSettled([
            createImageCacheFile(cacheRoot, "345678901234567890", "png", Uint8Array.from([1, 1, 1])),
            createImageCacheFile(cacheRoot, "345678901234567890", "png", Uint8Array.from([2, 2, 2]))
        ]);
        assert.equal(raceResults.filter(result => result.status === "fulfilled").length, 1,
            "exclusive creation must allow exactly one concurrent writer");
        assert.equal(raceResults.filter(result => result.status === "rejected").length, 1);
        const racedContent = await readFile(getImageCachePath(cacheRoot, "345678901234567890", "png"));
        assert.ok(racedContent.equals(Buffer.from([1, 1, 1])) || racedContent.equals(Buffer.from([2, 2, 2])),
            "the winning cache write must remain complete");

        const canonicalRoot = path.join(cacheRoot, "canonical");
        const aliasRoot = path.join(cacheRoot, "alias");
        await mkdir(canonicalRoot);
        await symlink(canonicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
        const canonicalPath = await createImageCacheFile(aliasRoot, "456789012345678901", "png", Uint8Array.from([4, 5, 6]));
        assert.equal(path.dirname(canonicalPath), await realpath(canonicalRoot),
            "writes through a cache-root link must resolve to the canonical root");
        assert.deepEqual(await readFile(canonicalPath), Buffer.from([4, 5, 6]));

        await assert.rejects(
            createImageCacheFile(cacheRoot, "../outside", "png", Uint8Array.from([1])),
            /Invalid attachment ID/u
        );
        assert.equal(existsSync(path.resolve(cacheRoot, "..", "outside.png")), false,
            "parent traversal must not create a file outside the cache root");
        await assert.rejects(
            createImageCacheFile(cacheRoot, "234567890123456789", "png", "not bytes" as unknown as Uint8Array),
            /Invalid image cache content/u
        );
    } finally {
        await rm(cacheRoot, { recursive: true, force: true });
    }
}

const nativeSource = readFileSync("src/equicordplugins/messageLoggerEnhanced/native/index.ts", "utf8");
assert.doesNotMatch(nativeSource, /export async function writeImageNative/u,
    "the unused renderer-controlled filename write bridge must stay removed");
assert.doesNotMatch(readFileSync("src/equicordplugins/messageLoggerEnhanced/utils/misc.ts", "utf8"), /writeImageNative/u,
    "renderer native stubs must not preserve the removed write capability");
assert.match(nativeSource, /createImageCacheFile\(imageCacheDir, attachmentId, cleanExt/u,
    "attachment downloads must use the contained exclusive-write helper");
assert.match(nativeSource, /if \(!file\.isFile\(\)\) continue/u,
    "cache indexing must ignore directories and symbolic links");

runFileChecks().then(() => {
    console.log("message logger native write containment checks passed");
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
