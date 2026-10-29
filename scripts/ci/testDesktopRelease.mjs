// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("release retains the Equibop package manifest without publishing the desktop manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-desktop-"));
    const dist = join(root, "dist");
    try {
        await mkdir(dist);
        for (const host of ["browser", "desktop", "equibop"]) await mkdir(join(dist, host));
        await writeFile(join(dist, "desktop", "package.json"), "desktop");
        await writeFile(join(dist, "equibop", "package.json"), "equibop");
        await writeFile(join(dist, "equibop", "main.js"), "main");
        const shell = await readFile(new URL("./desktop.sh", import.meta.url), "utf8");
        const collector = shell.match(/node --input-type=module <<'JS'\r?\n([\s\S]*?)\r?\nJS/u)?.[1];
        assert.ok(collector, "release collector must be present in the installed script");
        execFileSync(process.execPath, ["--input-type=module", "-e", collector], {
            cwd: root,
            env: { ...process.env, PROTONN_CORD_BUILD_CHANNEL: "nightly" },
        });
        assert.equal(await readFile(join(dist, "release", "equibopPackage.json"), "utf8"), "equibop");
        assert.equal(await readFile(join(dist, "release", "equibopMain.js"), "utf8"), "main");
        await assert.rejects(readFile(join(dist, "release", "package.json")), { code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
});
