/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync(new URL("./testSecureMessagingLive.ts", import.meta.url), "utf8");
const parsed = createSourceFile("live.ts", source, ScriptTarget.Latest, true);
const names = ["deleteOwnTestMessages", "isDownloadFilenameVariant", "sendThroughActualComposer", "verifyEncryptedImageModal"];
const extracted = names.map(name => {
    const declaration = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, `Missing live harness function ${name}`);
    return declaration.getText(parsed);
}).join("\n");
const compiled = transpileModule(extracted, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

function fixture(context: Record<string, unknown> = {}) {
    return runInNewContext(`${compiled}\n({ ${names.join(", ")} })`, {
        TEST_CHANNEL_ID: "fixture-channel",
        PAGE_MESSAGE_REGISTRY: "fixtureRegistry",
        PAGE_COMPOSER_PROOF: "fixtureComposer",
        PROOF_PNG_FILENAME: "encrypted-proof-pixel-1-2.png",
        setTimeout: (callback: () => void) => { queueMicrotask(callback); return 0; },
        Error, extname, join, ...context,
    }) as {
        deleteOwnTestMessages(page: object, ids: string[]): Promise<boolean>;
        sendThroughActualComposer(page: object, plaintext: string): Promise<unknown>;
        verifyEncryptedImageModal(page: object, message: object, downloads: Set<string>): Promise<{
            imageClickDidNotDownload: boolean;
            modalOpened: boolean;
        }>;
    };
}

test("failed proof deletion stays unresolved outside the latest history window", async () => {
    let deletes = 0;
    const api = fixture({
        Vencord: { Webpack: { Common: {
            Constants: { Endpoints: { MESSAGE: (_channel: string, id: string) => id, MESSAGES: () => "history" } },
            RestAPI: {
                async del() { deletes++; throw new Error("fixture deletion denied"); },
                async get() { return { body: Array.from({ length: 100 }, (_, index) => ({ id: `newer-${index}` })) }; },
            },
        } } },
    });
    const page = { evaluate: (callback: (argument: unknown) => unknown, argument: unknown) => callback(argument) };
    await assert.rejects(api.deleteOwnTestMessages(page, ["older-proof"]), /older-proof: fixture deletion denied/);
    assert.equal(deletes, 3);
});

test("a later successful deletion can settle an earlier failed cleanup attempt", async () => {
    let deletes = 0;
    const api = fixture({
        Vencord: { Webpack: { Common: {
            Constants: { Endpoints: { MESSAGE: (_channel: string, id: string) => id, MESSAGES: () => "history" } },
            RestAPI: {
                async del() { if (++deletes === 1) throw new Error("fixture temporary failure"); },
                async get() { return { body: [] }; },
            },
        } } },
    });
    const page = { evaluate: (callback: (argument: unknown) => unknown, argument: unknown) => callback(argument) };
    assert.equal(await api.deleteOwnTestMessages(page, ["older-proof"]), true);
    assert.equal(deletes, 2);
});

for (const ownDownload of [false, true]) {
    test(`image modal cleanup ignores unrelated downloads${ownDownload ? " beside its own proof file" : ""}`, async () => {
        let reads = 0;
        let evaluations = 0;
        const directory = join("fixture", "Downloads");
        const ownFilename = "encrypted-proof-pixel-1-2 (1).png";
        const api = fixture({ readdir: async () => ++reads === 1 ? ["existing.pdf"]
            : ["existing.pdf", "concurrent-unrelated.pdf", ...(ownDownload ? [ownFilename] : [])] });
        const page = {
            async evaluate() {
                if (++evaluations === 1) return directory;
                if (evaluations === 2) return { source: "blob:fixture", x: 1, y: 1 };
                return true;
            },
            async waitForFunction() {},
            mouse: { async click() {} },
            keyboard: { async press() {} },
        };
        const downloads = new Set<string>();
        const result = await api.verifyEncryptedImageModal(page, { channelId: "fixture", id: "proof" }, downloads);
        assert.deepEqual([...downloads], ownDownload ? [join(directory, ownFilename)] : []);
        assert.equal(result.imageClickDidNotDownload, !ownDownload);
        assert.equal(result.modalOpened, true);
    });
}

for (const draft of ["existing draft", " \n "]) {
    test(`the composer preserves an existing ${draft.trim() ? "text" : "whitespace"} draft`, async () => {
        const actions: string[] = [];
        let evaluations = 0;
        const api = fixture();
        const page = {
            async evaluate() { evaluations++; },
            async waitForSelector() {
                return {
                    async evaluate(callback: (element: { textContent: string; }) => boolean) { return callback({ textContent: draft }); },
                    async click() { actions.push("click"); },
                };
            },
            keyboard: {
                async down(key: string) { actions.push(key); },
                async up(key: string) { actions.push(key); },
                async press(key: string) { actions.push(key); },
                async type(value: string) { actions.push(value); },
            },
        };
        await assert.rejects(api.sendThroughActualComposer(page, "fixture new message"), /Refusing to replace an existing message draft/);
        assert.deepEqual(actions, []);
        assert.equal(evaluations, 2, "the temporary REST observer is restored after draft rejection");
    });
}
