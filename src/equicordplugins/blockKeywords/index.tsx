/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Card } from "@components/Card";
import { HeadingTertiary } from "@components/Heading";
import { ErrorBoundary } from "@components/index";
import { Margins } from "@components/margins";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { React, TextInput } from "@webpack/common";

let blockedKeywords: Array<RegExp> = [];
const MAX_PATTERNS = 128;
const MAX_PATTERN_LENGTH = 512;
const cl = classNameFactory("vc-block-keywords-");

function splitPatterns(input: string): string[] {
    return input
        .replace(/\[([^\]]*)\]/g, m => m.replace(/,/g, "\x00")) // protect commas in [...]
        .replace(/\{(\d+,?\d*|,\d+)\}/g, m => m.replace(",", "\x00")) // protect commas in {n,m}
        .split(",")
        .map(s => s.replace(/\x00/g, ",").trim())
        .filter(Boolean);
}

function compileKeyword(pattern: string, index: number, useRegex: boolean, caseSensitive: boolean) {
    if (index >= MAX_PATTERNS) throw new Error(`Only the first ${MAX_PATTERNS} patterns are checked; this saved pattern is inactive.`);
    if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`Patterns longer than ${MAX_PATTERN_LENGTH} characters are inactive.`);
    if (useRegex) {
        let inClass = false;
        for (let offset = 0; offset < pattern.length; offset++) {
            const character = pattern[offset];
            if (character === "\\") {
                const escaped = pattern[++offset];
                if (!escaped || !"dDsSwWbBfnrtv\\.^$*+?()[]{}|/-".includes(escaped))
                    throw new Error("Only character-class, boundary, control-character and punctuation escapes are supported.");
            } else if (character === "[") {
                if (inClass) throw new Error("Nested character classes are not supported.");
                inClass = true;
            } else if (character === "]") {
                if (!inClass) throw new Error("Escape a literal closing bracket.");
                inClass = false;
            } else if (!inClass && "(){}*+?|".includes(character)) {
                throw new Error("Only fixed-width regexes are supported: literals, classes, dots, anchors and boundaries. Groups, repetition and alternatives are inactive; saved patterns are unchanged.");
            }
        }
        if (inClass) throw new Error("Unclosed character class.");
    }
    const source = useRegex ? pattern : `\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`;
    return new RegExp(source, caseSensitive ? "" : "i");
}

function RegexHelper() {
    const [testInput, setTestInput] = React.useState("");
    const { blockedWords, caseSensitive, useRegex } = settings.use(["blockedWords", "caseSensitive", "useRegex"]);

    const results = React.useMemo(() => {
        return splitPatterns(blockedWords)
            .map((pattern, index) => {
                try {
                    const regex = compileKeyword(pattern, index, useRegex, caseSensitive);
                    return { pattern, matches: regex.test(testInput) };
                } catch (e: unknown) {
                    return { pattern, matches: false, error: e instanceof Error ? e.message : String(e) };
                }
            });
    }, [testInput, blockedWords, caseSensitive, useRegex]);

    return (
        <Card className={cl("regex")}>
            <HeadingTertiary className={Margins.bottom8}>Keyword Helper</HeadingTertiary>
            <TextInput
                type="text"
                placeholder="Input to test..."
                value={testInput}
                onChange={setTestInput}
                maxLength={null}
            />
            {results.length === 0 ?
                <Card
                    key="vc-no-patterns-regex"
                    variant="warning"
                    className={classes(cl("card"), Margins.top8)}
                >
                    <code>No patterns configured</code>
                </Card> : (
                    results.map(({ pattern, matches, error }, i) => (
                        <Card
                            key={`vc-pattern-card-${i}`}
                            variant={error ? "danger" : matches ? "success" : "primary"}
                            className={classes(cl("card"), Margins.top8)}
                        >
                            <code>{pattern}</code>
                            {error && <span className={cl("error")}>{error}</span>}
                        </Card>
                    )))}
        </Card>
    );
}

const settings = definePluginSettings({
    blockedWords: {
        type: OptionType.STRING,
        description: "Comma-separated list of words to block",
        default: "",
        restartNeeded: true
    },
    useRegex: {
        type: OptionType.BOOLEAN,
        description: "Use fixed-width regexes: literals, classes, dots, anchors and boundaries. Groups, repetition and alternatives are unsupported; check Keyword Helper for inactive patterns.",
        default: false,
        restartNeeded: true
    },
    regexHelper: {
        type: OptionType.COMPONENT,
        description: "Test active patterns and inspect errors. Maximum 128 patterns, 512 characters each; unsupported saved patterns are preserved but inactive.",
        component: () => <ErrorBoundary noop><RegexHelper /></ErrorBoundary>,
    },
    caseSensitive: {
        type: OptionType.BOOLEAN,
        description: "Whether to use a case sensitive search or not",
        default: false,
        restartNeeded: true
    },
    ignoreBlockedMessages: {
        description: "Completely ignores (recent) new messages bar",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true,
    },
});

export function containsBlockedKeywords(message: Message) {
    if (!blockedKeywords) return false;

    // test a nullable string against all keywords
    const testField = (text: string | null | undefined) => text != null && blockedKeywords.some(regex => regex.test(text));

    return blockedKeywords.some(regex =>
        regex.test(message.content)) || message.embeds.some(embed =>
            testField(embed.rawDescription) || testField(embed.rawTitle));
}

export default definePlugin({
    name: "BlockKeywords",
    description: "Blocks messages containing specific user-defined keywords, as if the user sending them was blocked.",
    tags: ["Appearance", "Customisation", "Privacy"],
    authors: [EquicordDevs.catcraft, EquicordDevs.secp192k1],
    patches: [
        {
            find: "_channelMessages={}",
            predicate: () => settings.store.blockedWords !== "",
            replacement: {
                match: /static commit\((\i)\)\{/g,
                replace: "$&$1=$self.blockMessagesWithKeywords($1);"
            }
        },
        {
            find: '"MessageStore"',
            predicate: () => settings.store.ignoreBlockedMessages && settings.store.blockedWords !== "",
            replacement: [
                {
                    match: /(?<=MESSAGE_CREATE:function\((\i)\){)/,
                    replace: (_, props) => `if($self.containsBlockedKeywords(${props}.message))return;`
                }
            ]
        },
        {
            find: '"ReadStateStore"',
            predicate: () => settings.store.ignoreBlockedMessages && settings.store.blockedWords !== "",
            replacement: [
                {
                    match: /(?<=MESSAGE_CREATE:function\((\i)\){)/,
                    replace: (_, props) => `if($self.containsBlockedKeywords(${props}.message))return;`
                }
            ]
        },
    ],

    settings,
    containsBlockedKeywords,

    start() {
        blockedKeywords = [];
        const blockedWordsList = splitPatterns(settings.store.blockedWords);

        if (blockedWordsList.length === 0) return;

        for (const [index, word] of blockedWordsList.entries()) {
            try {
                blockedKeywords.push(compileKeyword(word, index, settings.store.useRegex, settings.store.caseSensitive));
            } catch (error) {
                console.error("[BlockKeywords] Ignoring an invalid regular expression:", error);
            }
        }
    },

    stop() {
        blockedKeywords = [];
    },

    blockMessagesWithKeywords(messageList) {
        return messageList.reset(messageList.map(
            message => message.set("blocked", message.blocked || this.containsBlockedKeywords(message))
        ));
    }
});
