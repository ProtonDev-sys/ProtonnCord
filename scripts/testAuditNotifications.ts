/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const code = transpileModule(readFileSync("src/api/Notifications/Notifications.tsx", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React },
    fileName: "Notifications.tsx"
}).outputText;

function fixture(failure?: "permission" | "native" | "persistence" | "unavailable") {
    const queued: (() => Promise<void>)[] = [];
    const errors: unknown[][] = [];
    let shown = 0;
    let persisted = 0;
    class NativeNotification {
        static permission = "default";
        static async requestPermission() {
            if (failure === "permission") throw new Error("permission request failed");
            return "granted";
        }
        constructor() {
            if (failure === "native") throw new Error("notification creation failed");
            shown++;
        }
    }
    const mocks: Record<string, object> = {
        "@api/Settings": { Settings: { notifications: { useNative: "always" } } },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/Queue": { Queue: class { push(task: () => Promise<void>) { queued.push(task); } } },
        "@webpack/common": { WindowStore: { isFocused: () => true } },
        "./NotificationComponent": {},
        "./notificationLog": {
            async persistNotification() {
                persisted++;
                if (failure === "persistence") throw new Error("storage full");
            }
        }
    };
    const api = runInNewContext(code + "\nexports;", {
        exports: {},
        Notification: failure === "unavailable" ? undefined : NativeNotification,
        window: { addEventListener() {} },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return { api, queued, errors, get shown() { return shown; }, get persisted() { return persisted; } };
}

test("native permission or creation failures fall back to the in-app queue", async () => {
    for (const failure of ["permission", "native"] as const) {
        const f = fixture(failure);
        await f.api.showNotification({ title: "fixture", body: "local data" });
        assert.equal(f.queued.length, 1);
        assert.equal(f.shown, 0);
        assert.equal(f.persisted, 1);
        assert.equal(f.errors.length, 1);
    }
});

test("notification persistence failures are observed without blocking display", async () => {
    const f = fixture("persistence");
    await f.api.showNotification({ title: "fixture", body: "local data" });
    await setImmediate();
    assert.equal(f.shown, 1);
    assert.equal(f.queued.length, 0);
    assert.equal(f.errors.length, 1);
});

test("unavailable native notifications return denied capability and use the queue", async () => {
    const f = fixture("unavailable");
    assert.equal(await f.api.requestPermission(), false);
    await f.api.showNotification({ title: "fixture", body: "local data" });
    assert.equal(f.queued.length, 1);
    assert.equal(f.errors.length, 0);
});
