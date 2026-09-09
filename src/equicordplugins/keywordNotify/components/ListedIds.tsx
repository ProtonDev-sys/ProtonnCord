/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { DeleteIcon } from "@components/Icons";
import { TextInput } from "@webpack/common";

import { cl } from "..";

export function ListedIds({ listIds, setListIds }: { listIds: string[]; setListIds: (v: string[]) => void; }) {
    function onChange(e: string, index: number) {
        setListIds(listIds.map((value, i) => i === index ? e.trim() : value));
    }

    const elements = listIds.map((currentValue: string, index: number) => {
        return (
            <Flex key={index} flexDirection="row" style={{ marginBottom: "5px" }}>
                <div style={{ flexGrow: 1 }}>
                    <TextInput
                        placeholder="ID"
                        spellCheck={false}
                        value={currentValue}
                        onChange={e => onChange(e, index)} />
                </div>
                <Button
                    onClick={() => {
                        setListIds(listIds.filter((_, i) => i !== index));
                    }}
                    variant="none"
                    size="iconOnly"
                    className={cl("delete")}>
                    <DeleteIcon />
                </Button>
            </Flex>
        );
    });

    return <>{elements}</>;
}
