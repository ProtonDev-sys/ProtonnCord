/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    extractSecureEmbedUrls,
    isSecureInlineMediaEmbedType,
    secureEmbedOnlyUrl,
    shouldHideSecureEmbedOnlyPlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/embedUrls";

const visibleUrl = "https://example.com/visible";
const hiddenUrl = "https://example.com/hidden";

const suppressedCases: Array<[string, string]> = [
    ["angle brackets", `<${hiddenUrl}>`],
    ["masked suppressed links", `[hidden](<${hiddenUrl}>)`],
    ["inline code", `\`${hiddenUrl}\``],
    ["double backtick code with an embedded backtick", `\`\`sample \` ${hiddenUrl}\`\``],
    ["fenced code with a language", `\`\`\`text\n${hiddenUrl}\n\`\`\``],
    ["longer code fences containing shorter runs", `\`\`\`\`text\n\`\`\`\n${hiddenUrl}\n\`\`\`\``],
    ["unclosed code fails closed", `\`\`\`text\n${hiddenUrl}`],
];

for (const [label, plaintext] of suppressedCases) {
    test(`does not unfurl URLs in ${label}`, () => {
        assert.deepEqual(extractSecureEmbedUrls(plaintext), []);
        assert.equal(secureEmbedOnlyUrl(plaintext), null);
        assert.equal(shouldHideSecureEmbedOnlyPlaintext(plaintext, "present"), false);
    });
}

for (const [label, plaintext] of suppressedCases.slice(0, -1)) {
    test(`continues finding visible URLs after ${label}`, () => {
        assert.deepEqual(extractSecureEmbedUrls(`${plaintext} ${visibleUrl}`), [visibleUrl]);
    });
}

test("suppressed URLs do not consume the URL limit", () => {
    const suppressed = Array.from({ length: 12 }, (_, index) => `<${hiddenUrl}/${index}>`).join(" ");
    assert.deepEqual(extractSecureEmbedUrls(`${suppressed} ${visibleUrl}`), [visibleUrl]);
});

test("an explicitly visible occurrence remains eligible after a suppressed occurrence", () => {
    assert.deepEqual(extractSecureEmbedUrls(`<${visibleUrl}> ${visibleUrl}`), [visibleUrl]);
});

test("escaped backticks do not open a code span", () => {
    assert.deepEqual(extractSecureEmbedUrls(`\\\` ${visibleUrl}`), [visibleUrl]);
    assert.deepEqual(extractSecureEmbedUrls(`\\\\\`${hiddenUrl}\` ${visibleUrl}`), [visibleUrl]);
});

test("a backslash inside inline code does not escape its closing delimiter", () => {
    assert.deepEqual(extractSecureEmbedUrls(`\`${hiddenUrl} \\\` ${visibleUrl}`), [visibleUrl]);
});

const balancedUrls = [
    "https://example.com/Function_(mathematics)",
    "https://example.com/nested_(one_(two))",
    "https://example.com/items[0]",
    "https://example.com/items{one}",
    "https://[2001:db8::1]",
];

for (const url of balancedUrls) {
    test(`preserves balanced URL delimiters in ${url}`, () => {
        const normalized = new URL(url).toString();
        assert.deepEqual(extractSecureEmbedUrls(url), [normalized]);
        assert.equal(secureEmbedOnlyUrl(url), normalized);
        assert.equal(shouldHideSecureEmbedOnlyPlaintext(url, "pending"), false);
        assert.equal(shouldHideSecureEmbedOnlyPlaintext(url, "absent"), false);
        assert.equal(shouldHideSecureEmbedOnlyPlaintext(url, "present"), true);
    });
}

test("strips prose punctuation without losing a balanced closing parenthesis", () => {
    const url = balancedUrls[0];
    assert.deepEqual(extractSecureEmbedUrls(`See (${url}).`), [url]);
    assert.deepEqual(extractSecureEmbedUrls(`See (${url}.)`), [url]);
    assert.deepEqual(extractSecureEmbedUrls(`[label](${url})`), [url]);
});

test("does not hide extra prose or unmatched URL punctuation", () => {
    for (const plaintext of [`${visibleUrl})`, `${visibleUrl}.`, `See ${visibleUrl}`]) {
        assert.equal(secureEmbedOnlyUrl(plaintext), null);
        assert.equal(shouldHideSecureEmbedOnlyPlaintext(plaintext, "present"), false);
    }
});

test("retains URL validation, normalization and deduplication", () => {
    assert.deepEqual(extractSecureEmbedUrls("HTTPS://EXAMPLE.COM https://example.com/"), ["https://example.com/"]);
    assert.deepEqual(extractSecureEmbedUrls("https://user:password@example.com/ https://user@example.com/ https://"), []);
    assert.deepEqual(extractSecureEmbedUrls(`https://example.com/${"a".repeat(2_048)}`), []);
    assert.deepEqual(extractSecureEmbedUrls("ftp://example.com/file javascript:alert(1)"), []);
    assert.deepEqual(extractSecureEmbedUrls(""), []);
});

test("keeps the ten URL limit and resets scanning state between calls", () => {
    const urls = Array.from({ length: 12 }, (_, index) => `${visibleUrl}/${index}`);
    assert.deepEqual(extractSecureEmbedUrls(urls.join(" ")), urls.slice(0, 10));
    assert.deepEqual(extractSecureEmbedUrls(urls.join(" ")), urls.slice(0, 10));
    extractSecureEmbedUrls(`\`${hiddenUrl}`);
    assert.deepEqual(extractSecureEmbedUrls(visibleUrl), [visibleUrl]);
});

test("retains the inline media type allowlist", () => {
    for (const type of ["gifv", "image", "video"]) assert.equal(isSecureInlineMediaEmbedType(type), true);
    for (const type of ["link", "article", "rich", ""]) assert.equal(isSecureInlineMediaEmbedType(type), false);
});

for (const backslashes of [1, 2, 3, 4]) {
    for (const delimiterLength of [1, 2, 3]) {
        test(`${backslashes} preceding backslashes preserve the remaining ${delimiterLength}-backtick code delimiter`, () => {
            const delimiter = "`".repeat(delimiterLength);
            const opening = "\\".repeat(backslashes) + "`".repeat(delimiterLength + backslashes % 2);
            const plaintext = `${opening}${hiddenUrl}${delimiter} ${visibleUrl}`;
            assert.deepEqual(extractSecureEmbedUrls(plaintext), [visibleUrl]);
        });
    }
}
