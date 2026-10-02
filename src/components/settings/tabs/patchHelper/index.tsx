/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Button } from "@components/Button";
import { CodeBlock } from "@components/CodeBlock";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { Span } from "@components/Span";
import { copyWithToast } from "@utils/discord";
import { Margins } from "@utils/margins";
import { stripIndent } from "@utils/text";
import { ReplaceFn } from "@utils/types";
import { search } from "@webpack";
import { React, TextInput, useEffect, useMemo, useState } from "@webpack/common";

import { FullPatchInput } from "./FullPatchInput";
import { PatchPreview } from "./PatchPreview";
import { ReplacementInput } from "./ReplacementInput";

function PatchHelper() {
    const [find, setFind] = useState("");
    const [match, setMatch] = useState("");
    const [replacement, setReplacement] = useState<string | ReplaceFn>("");

    const [parsedFind, setParsedFind] = useState<string | RegExp>("");

    const [findError, setFindError] = useState<string>();
    const [matchError, setMatchError] = useState<string>();
    const [replacementError, setReplacementError] = useState<string>();

    const [module, setModule] = useState<[string, Function]>();

    useEffect(() => {
        setModule(void 0);
        if (!parsedFind) return;

        const timeout = setTimeout(() => {
            const candidates = search(parsedFind);
            const keys = Object.keys(candidates);

            if (keys.length === 0)
                setFindError("No match. Perhaps that module is lazy loaded?");
            else if (keys.length !== 1)
                setFindError("Multiple matches. Please refine your filter");
            else {
                setFindError(void 0);
                setModule([keys[0], candidates[keys[0]]]);
            }
        }, 300);

        return () => clearTimeout(timeout);
    }, [parsedFind]);

    const code = useMemo(() => {
        const find = parsedFind instanceof RegExp ? parsedFind.toString() : JSON.stringify(parsedFind);
        const replace = typeof replacement === "function" ? replacement.toString() : JSON.stringify(replacement);

        return stripIndent`
            {
                find: ${find},
                replacement: {
                    match: /${match.replace(/(?<!\\)\//g, "\\/")}/,
                    replace: ${replace}
                }
            }
        `;
    }, [parsedFind, match, replacement]);

    function onFindChange(v: string) {
        setFind(v);

        try {
            let parsedFind = v as string | RegExp;
            if (/^\/.+?\/$/.test(v)) parsedFind = new RegExp(v.slice(1, -1));

            setFindError(void 0);
            setParsedFind(parsedFind);
        } catch (e: any) {
            setParsedFind("");
            setFindError((e as Error).message);
        }
    }

    function onMatchChange(v: string) {
        setMatch(v);

        try {
            new RegExp(v);
            setMatchError(void 0);
        } catch (e: any) {
            setMatchError((e as Error).message);
        }
    }

    return (
        <SettingsTab>
            <Heading className={Margins.top16}>Patch Helper</Heading>
            <Paragraph className={Margins.bottom16}>
                A developer tool to help you create patches for Protonn Cord plugins.
            </Paragraph>

            <Heading className="">Full Patch</Heading>
            <Paragraph className={Margins.bottom8}>Paste your full JSON patch here to fill out the fields</Paragraph>
            <FullPatchInput
                setFind={onFindChange}
                setParsedFind={setParsedFind}
                setMatch={onMatchChange}
                setReplacement={value => setReplacement(() => value)}
            />

            <div className={Margins.top20}>
                <Heading className="">Find</Heading>
                <TextInput
                    type="text"
                    value={find}
                    onChange={onFindChange}
                    error={findError}
                />
            </div>
            <div className={Margins.top20}>
                <Heading className="">Match</Heading>
                <TextInput
                    type="text"
                    value={match}
                    onChange={onMatchChange}
                    error={matchError}
                />
            </div>

            <div className={Margins.top20}>
                <ReplacementInput
                    replacement={replacement}
                    setReplacement={setReplacement}
                    replacementError={replacementError}
                />
            </div>

            {module && (
                <>
                    <Divider className={Margins.top16 + " " + Margins.bottom16} />
                    <Span size="md" weight="medium" color="text-strong">Preview</Span>
                    <PatchPreview
                        module={module}
                        match={match}
                        replacement={replacement}
                        setReplacementError={setReplacementError}
                    />
                </>
            )}

            {!!(find && match && replacement) && (
                <>
                    <Divider className={Margins.top16 + " " + Margins.bottom16} />
                    <Span size="md" weight="medium" color="text-strong">Generated Code</Span>
                    <div style={{ width: "100%", marginTop: 8 }}>
                        <CodeBlock lang="js" content={code} />
                    </div>
                    <Flex className={Margins.top8} gap="8px">
                        <Button size="small" onClick={() => copyWithToast(code)}>
                            Copy to Clipboard
                        </Button>
                        <Button size="small" onClick={() => copyWithToast("```ts\n" + code + "\n```")}>
                            Copy as Codeblock
                        </Button>
                    </Flex>
                </>
            )}
        </SettingsTab>
    );
}

export default !IS_STANDALONE ? wrapTab(PatchHelper, "PatchHelper") : null;
