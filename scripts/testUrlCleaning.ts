/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture() {
    const requests: { signal?: AbortSignal; result: ReturnType<typeof Promise.withResolvers<Response>>; }[] = [];
    const errors: unknown[] = [];
    const mocks: Record<string, object> = {
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    };
    const code = transpileModule(readFileSync("src/plugins/clearURLs/index.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const plugin = runInNewContext(code + "\nexports.default;", {
        exports: {}, URL, AbortController,
        fetch: (_url: string, { signal }: { signal?: AbortSignal; } = {}) => {
            const result = Promise.withResolvers<Response>(); requests.push({ signal, result }); return result.promise;
        },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    async function load(data: unknown) {
        const pending = plugin.createRules();
        requests.at(-1)?.result.resolve(Response.json(data));
        await pending;
    }
    return { plugin, requests, errors, load };
}

const catalog = { providers: { fixture: {
    urlPattern: "^https?://example\\.com/",
    rules: ["ref|utm_source"],
    rawRules: ["/ref=[^/?#]*"],
    exceptions: ["^https?://example\\.com/keep(?:\\?|$)"]
} } };

test("ClearURLs matches whole parameter names, removes duplicate fields and preserves exceptions", async () => {
    const { plugin, load } = fixture();
    await load(catalog);
    assert.equal(plugin.replacer("https://example.com/item?my_ref=keep&ref=one&ref=two&utm_source=three&source_extra=keep"), "https://example.com/item?my_ref=keep&source_extra=keep");
    assert.equal(plugin.replacer("https://example.com/item?reference=keep&my_utm_source=keep"), "https://example.com/item?reference=keep&my_utm_source=keep");
    assert.equal(plugin.replacer("https://example.com/keep?ref=keep"), "https://example.com/keep?ref=keep");
});

test("ClearURLs applies raw rules without query parameters and preserves unchanged URL text", async () => {
    const { plugin, load } = fixture();
    await load(catalog);
    assert.equal(plugin.replacer("https://example.com/item/ref=one/ref=two"), "https://example.com/item");
    for (const url of ["HTTPS://EXAMPLE.COM:443/item?q=a%20b", "https://unrelated.example:443?q=a%20b", "invalid url"])
        assert.equal(plugin.replacer(url), url);
    const message = { content: "See <HTTPS://EXAMPLE.COM/item?ref=one> and https://example.com/item/ref=two. Plain text." };
    plugin.cleanMessage(message);
    assert.equal(message.content, "See <https://example.com/item> and https://example.com/item. Plain text.");
});

test("ClearURLs retains the previous catalog when downloads or provider compilation fail", async () => {
    const { plugin, load, requests, errors } = fixture();
    await load(catalog);
    const current = plugin.rules;
    for (const invalid of [null, [], {}, { providers: [] }, { providers: { fixture: null } },
        { providers: { fixture: { urlPattern: "example", rules: "ref" } } },
        { providers: { fixture: { urlPattern: "example", rawRules: [42] } } },
        { providers: { good: catalog.providers.fixture, bad: { urlPattern: "[" } } }]) {
        await load(invalid);
        assert.equal(plugin.rules, current);
    }
    const failure = plugin.createRules();
    requests.at(-1)?.result.resolve(new Response("Unavailable", { status: 503 }));
    await failure;
    assert.equal(plugin.rules, current);
    const rejected = plugin.createRules();
    requests.at(-1)?.result.reject(new Error("Offline"));
    await rejected;
    assert.equal(plugin.rules, current);
    assert.equal(errors.length, 10);
    await load({ providers: { replacement: { urlPattern: "replacement" } } });
    assert.notEqual(plugin.rules, current);
});

test("ClearURLs cannot install a stopped or superseded request", async () => {
    const { plugin, requests } = fixture();
    const old = plugin.createRules();
    plugin.stop();
    assert.equal(requests[0].signal?.aborted, true);
    requests[0].result.resolve(Response.json(catalog));
    await old;
    assert.equal(plugin.rules.length, 0);
    const obsolete = plugin.createRules();
    const latest = plugin.createRules();
    assert.equal(requests[1].signal?.aborted, true);
    requests[2].result.resolve(Response.json(catalog));
    await latest;
    const current = plugin.rules;
    requests[1].result.resolve(Response.json({ providers: {} }));
    await obsolete;
    assert.equal(plugin.rules, current);
});

test("ClearURLs preserves input when a raw rule produces an invalid destination", async () => {
    const { plugin, load } = fixture();
    await load({ providers: { fixture: { urlPattern: "example", rawRules: ["https://"] } } });
    assert.equal(plugin.replacer("https://example.com/item"), "https://example.com/item");
});
