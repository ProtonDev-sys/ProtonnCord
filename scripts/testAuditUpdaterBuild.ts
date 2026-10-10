import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";

import { buildAndInstall } from "../src/main/updater/buildOperations";

function write(path: string, data: string) {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, data);
}

function writeBuild(output: string, contents: string) {
    for (const host of ["desktop", "equibop"]) {
        const main = host === "desktop" ? "patcher.js" : "main.js";
        for (const name of [main, "preload.js", "renderer.js", "renderer.css", "renderer.js.map"])
            write(join(output, host, name), `${contents}:${host}/${name}`);
        write(join(output, host, "package.json"), JSON.stringify({ name: "protonn-cord", main }));
        write(join(output, `${host}.asar`), `${contents}:${host}.asar`);
    }
}

function snapshot(directory: string): Record<string, string> {
    const result: Record<string, string> = {};
    function visit(path: string) {
        for (const entry of fs.readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const item = join(path, entry.name);
            if (entry.isDirectory()) {
                result[`${relative(directory, item)}${sep}`] = "directory";
                visit(item);
            } else {
                result[relative(directory, item)] = entry.isSymbolicLink() ? `symlink:${fs.readlinkSync(item)}` : fs.readFileSync(item, "utf8");
            }
        }
    }
    visit(directory);
    return result;
}

function fixture() {
    const root = fs.mkdtempSync(join(tmpdir(), "protonn-build-transaction-"));
    const dist = join(root, "dist with spaces");
    writeBuild(dist, "old");
    write(join(dist, "browser", "browser.js"), "unrelated browser build");
    write(join(dist, "desktop", "monacoWin-OLD.html"), "still needed by the running client");
    write(join(dist, "desktop", "custom-native.js"), "unrelated native file");
    return { root, dist, before: snapshot(dist) };
}

function verify() { return Promise.resolve(); }
function build(output: string) { writeBuild(output, "new"); return Promise.resolve(); }
const busy = () => Object.assign(new Error("fixture Windows file is busy"), { code: "EBUSY" });

test("successful source build publishes staged outputs and preserves unrelated and previous hashed files", async () => {
    const { root, dist } = fixture();
    try {
        const initialMode = fs.statSync(join(dist, "desktop")).mode;
        let verified = false;
        await buildAndInstall({
            distDirectory: dist,
            files: fs,
            async build(output) {
                assert.ok(output.startsWith(`${dist}${sep}.protonn-build-`));
                assert.notEqual(output, dist);
                await build(output);
                write(join(output, "desktop", "assets", "monacoWin-NEW.html"), "new asset");
                write(join(output, "desktop", "assets", "preview image-É.html"), "named userplugin asset");
                assert.equal(fs.readFileSync(join(dist, "desktop", "renderer.js"), "utf8"), "old:desktop/renderer.js");
            },
            async verifySource() {
                verified = true;
                assert.equal(fs.readFileSync(join(dist, "desktop.asar"), "utf8"), "old:desktop.asar");
            }
        });
        assert.ok(verified);
        assert.equal(fs.readFileSync(join(dist, "desktop", "renderer.js"), "utf8"), "new:desktop/renderer.js");
        assert.equal(fs.readFileSync(join(dist, "equibop.asar"), "utf8"), "new:equibop.asar");
        assert.equal(fs.readFileSync(join(dist, "browser", "browser.js"), "utf8"), "unrelated browser build");
        assert.equal(fs.readFileSync(join(dist, "desktop", "monacoWin-OLD.html"), "utf8"), "still needed by the running client");
        assert.equal(fs.readFileSync(join(dist, "desktop", "custom-native.js"), "utf8"), "unrelated native file");
        assert.equal(fs.readFileSync(join(dist, "desktop", "assets", "monacoWin-NEW.html"), "utf8"), "new asset");
        assert.equal(fs.readFileSync(join(dist, "desktop", "assets", "preview image-É.html"), "utf8"), "named userplugin asset");
        assert.equal(fs.statSync(join(dist, "desktop")).mode, initialMode);
        assert.ok(fs.readdirSync(dist).every(name => !name.startsWith(".protonn-build-")));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("compile failures and source changes cannot overwrite the running source build", async () => {
    for (const changedSource of [false, true]) {
        const { root, dist, before } = fixture();
        try {
            await assert.rejects(buildAndInstall({
                distDirectory: dist,
                files: fs,
                async build(output) {
                    await build(output);
                    if (!changedSource) throw new Error("fixture compile failed after producing partial outputs");
                },
                async verifySource() { throw new Error("fixture checkout changed during compilation"); }
            }), changedSource ? /checkout changed/u : /compile failed/u);
            assert.deepEqual(snapshot(dist), before);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("missing, empty, malformed and cross-platform conflicting outputs fail before installation", async () => {
    const corruptions = [
        (output: string) => fs.rmSync(join(output, "desktop", "preload.js")),
        (output: string) => fs.writeFileSync(join(output, "desktop.asar"), ""),
        (output: string) => fs.writeFileSync(join(output, "desktop", "package.json"), '{"main":"missing.js"}'),
        (output: string) => write(join(output, "unexpected.txt"), "wrong root output"),
        (output: string) => write(join(output, "desktop", "CON.js"), "unsafe Windows filename"),
        (output: string) => {
            write(join(output, "desktop", "renderer.JS"), "case collision");
            if (!fs.readdirSync(join(output, "desktop")).includes("renderer.JS"))
                throw new Error("The fixture filesystem cannot create case-distinct filenames");
        },
    ];
    for (const corrupt of corruptions) {
        const { root, dist, before } = fixture();
        try {
            let verified = false;
            await assert.rejects(buildAndInstall({
                distDirectory: dist, files: fs,
                async build(output) { await build(output); corrupt(output); },
                async verifySource() { verified = true; }
            }));
            assert.equal(verified, false, "invalid outputs must fail before source verification and publication");
            assert.deepEqual(snapshot(dist), before);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("backup copy failures leave every installed output intact and remove staging", async () => {
    const { root, dist, before } = fixture();
    try {
        let copied = 0;
        await assert.rejects(buildAndInstall({
            distDirectory: dist, build, verifySource: verify,
            files: {
                ...fs,
                copyFileSync(...args) {
                    if (++copied === 3) throw Object.assign(new Error("fixture disk full while backing up"), { code: "ENOSPC" });
                    return fs.copyFileSync(...args);
                }
            }
        }), /disk full/u);
        assert.equal(copied, 3);
        assert.deepEqual(snapshot(dist), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Windows busy-file failures restore earlier replacements and remove newly generated files", async () => {
    for (const failedInstall of [1, 5, 15]) {
        const { root, dist, before } = fixture();
        try {
            let installs = 0;
            await assert.rejects(buildAndInstall({
                distDirectory: dist, verifySource: verify,
                async build(output) { await build(output); write(join(output, "desktop", "assets", "NEW.html"), "new asset"); },
                files: {
                    ...fs,
                    renameSync(source, destination) {
                        if (String(source).includes(`${sep}output${sep}`) && ++installs === failedInstall) throw busy();
                        return fs.renameSync(source, destination);
                    }
                }
            }), /file is busy/u);
            assert.equal(installs, failedInstall);
            assert.deepEqual(snapshot(dist), before);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test("failed rollback preserves identifiable originals and gives an actionable recovery path", async () => {
    const { root, dist } = fixture();
    try {
        let installs = 0;
        await assert.rejects(buildAndInstall({
            distDirectory: dist, build, verifySource: verify,
            files: {
                ...fs,
                renameSync(source, destination) {
                    if (String(source).includes(`${sep}backup${sep}`)) throw busy();
                    if (++installs === 3) throw busy();
                    return fs.renameSync(source, destination);
                }
            }
        }), /could not be fully restored.*Close Discord.*recovery files are in/u);
        const staging = fs.readdirSync(dist).find(name => name.startsWith(".protonn-build-"));
        assert.ok(staging);
        const backup = join(dist, staging, "backup");
        assert.equal(fs.readFileSync(join(dist, "desktop", "patcher.js"), "utf8"), "new:desktop/patcher.js");
        assert.equal(fs.readFileSync(join(backup, "desktop", "patcher.js"), "utf8"), "old:desktop/patcher.js");
        const manifest = JSON.parse(fs.readFileSync(join(backup, "manifest.json"), "utf8")) as { path: string; existed: boolean; }[];
        assert.ok(manifest.some(entry => entry.path === join("desktop", "patcher.js") && entry.existed));
        assert.equal(fs.readFileSync(join(dist, "browser", "browser.js"), "utf8"), "unrelated browser build");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("symlinked output files and destination directories cannot redirect installation", { skip: process.platform === "win32" }, async () => {
    for (const symlinkDestination of [false, true]) {
        const { root, dist } = fixture();
        try {
            const outside = join(root, "outside");
            write(join(outside, "renderer.js"), "outside content");
            if (symlinkDestination) {
                fs.rmSync(join(dist, "equibop"), { recursive: true });
                fs.symlinkSync(outside, join(dist, "equibop"), "dir");
            }
            const before = snapshot(dist);
            await assert.rejects(buildAndInstall({
                distDirectory: dist, files: fs, verifySource: verify,
                async build(output) {
                    await build(output);
                    if (!symlinkDestination) {
                        fs.rmSync(join(output, "desktop", "renderer.js"));
                        fs.symlinkSync(join(outside, "renderer.js"), join(output, "desktop", "renderer.js"));
                    }
                }
            }), /symbolic link|regular directory/u);
            assert.deepEqual(snapshot(dist), before);
            assert.equal(fs.readFileSync(join(outside, "renderer.js"), "utf8"), "outside content");
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});
