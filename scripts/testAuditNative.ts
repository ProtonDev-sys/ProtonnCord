/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { constants as FsConstants, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load<T>(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown>): T {
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, ...globals,
        require(name: string) {
            assert.ok(Object.hasOwn(mocks, name), `Unexpected native import: ${name}`);
            return mocks[name];
        },
    });
}

function migrationFixture(initial: Record<string, string>, env: Record<string, string> = {}, dev = true) {
    const files = new Map(Object.entries(initial));
    const writes: string[] = [];
    const constants = load<typeof import("../src/main/utils/constants")>("src/main/utils/constants.ts", {
        path: { join },
        fs: {
            constants: FsConstants,
            existsSync: (path: string) => files.has(path),
            readFileSync: (path: string) => files.get(path),
            mkdirSync() {},
            copyFileSync(source: string, destination: string, flags: number) {
                assert.equal(flags, FsConstants.COPYFILE_EXCL);
                assert.equal(files.has(destination), false, "migration cannot replace an existing preference file");
                files.set(destination, files.get(source)!);
                writes.push(destination);
            },
            writeFileSync(path: string, content: string) { files.set(path, content); writes.push(path); },
        },
        electron: { app: { getPath: () => join("profile", "Discord"),
            relaunch: () => assert.fail("Migration must not restart the client"), exit: () => assert.fail("Migration must not exit the client") } },
    }, { IS_DEV: dev, process: { env, argv: [] }, console,
        setTimeout: () => assert.fail("Preference seeding must finish before settings stores load") });
    return { constants, files, writes };
}

test("development seeding finishes before settings load and preserves existing development preferences", () => {
    const prod = join("profile", "ProtonnCord", "settings");
    const dev = join("profile", "ProtonnCord", "dev", "settings");
    const f = migrationFixture({
        [join(prod, "settings.json")]: "production settings",
        [join(prod, "quickCss.css")]: "production css",
        [join(dev, "settings.json")]: "existing development settings",
    });
    assert.equal(f.files.get(f.constants.SETTINGS_FILE), "existing development settings");
    assert.equal(f.files.get(f.constants.QUICK_CSS_PATH), "production css");
    assert.equal(f.files.get(f.constants.DEV_MIGRATED), "migrated");
});

test("explicit data directories, production mode and completed migrations receive no automatic copies", () => {
    for (const key of ["PROTONN_CORD_USER_DATA_DIR", "EQUICORD_USER_DATA_DIR"]) {
        const f = migrationFixture({}, { [key]: join("isolated", "data") });
        assert.equal(f.constants.DATA_DIR, join("isolated", "data"));
        assert.deepEqual(f.writes, []);
    }
    assert.deepEqual(migrationFixture({}, {}, false).writes, []);
    const marker = join("profile", "ProtonnCord", "dev", "settings", "migration");
    assert.deepEqual(migrationFixture({ [marker]: "migrated" }).writes, []);
});

test("tray patching is idempotent, keeps caller templates intact and routes actions to the Discord window", () => {
    const deliveries: string[] = [];
    const window = (url: string) => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, getURL: () => url, send: (event: string) => { deliveries.push(`${url}:${event}`); } },
    });
    const editor = window("data:text/html,editor");
    const discord = window("https://canary.discord.com/channels/@me");
    const handlers = new Map<string, (event: unknown, value: boolean) => void>();
    const Menu = { buildFromTemplate: (template: any[]) => template };
    const api = load<typeof import("../src/main/trayMenu")>("src/main/trayMenu.ts", {
        "@shared/IpcEvents": { IpcEvents: { SET_TRAY_UPDATE_STATE: "state", TRAY_CHECK_UPDATES: "check", TRAY_REPAIR: "repair" } },
        "@shared/vencordUserAgent": { gitHashShort: "fixture" },
        "file://about.html?minify": { default: "" }, "file://../../browser/icon.png?base64": { default: "" }, "./utils/constants": {},
        electron: { Menu, ipcMain: { on: (event: string, callback: (event: unknown, value: boolean) => void) => handlers.set(event, callback) },
            BrowserWindow: { getFocusedWindow: () => editor, getAllWindows: () => [editor, discord] }, shell: {} },
    }, { URL });
    api.patchTrayMenu();
    const patched = Menu.buildFromTemplate;
    api.patchTrayMenu();
    assert.equal(Menu.buildFromTemplate, patched);
    const original = [{ label: "Show Discord" }, { label: "Quit" }];
    const menu = Menu.buildFromTemplate(original);
    assert.equal(original.length, 2);
    menu.find(item => item.label === "Protonn Cord").submenu.find((item: any) => item.label === "Repair Protonn Cord").click();
    assert.deepEqual(deliveries, ["https://canary.discord.com/channels/@me:repair"]);
    handlers.get("state")!({}, true);
    assert.equal(Menu.buildFromTemplate(original).find(item => item.label === "Protonn Cord").submenu[1].label, "Update Protonn Cord");
});
