/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { languages } from "@equicordplugins/translatePlus/misc/languages";
import { cl, Translation } from "@equicordplugins/translatePlus/misc/types";
import { Message } from "@vencord/discord-types";
import { Parser, useEffect, useState } from "@webpack/common";

import { Icon } from "./icon";
import { translate } from "./translator";

const setters = new Map<string, (translation: Translation | undefined) => void>();
const requests = new Map<string, object>();

export function Accessory({ message }: { message: Message; }) {
    const [translation, setTranslation] = useState<Translation | undefined>(undefined);

    useEffect(() => {
        setTranslation(undefined);
        if ((message as any).vencordEmbeddedBy) return;

        setters.set(message.id, setTranslation);

        return () => {
            if (setters.get(message.id) === setTranslation) {
                setters.delete(message.id);
                requests.delete(message.id);
            }
        };
    }, [message.id, message.content]);

    if (!translation) return null;

    return (
        <div className={cl("accessory")}>
            <Icon height={16} width={16} />
            {Parser.parse(translation.text)}
            {" "}
            (translated from {languages[translation.src] ?? translation.src} - <button onClick={() => setTranslation(undefined)} className={cl("dismiss")}>Dismiss</button>)
        </div>
    );
}

export async function handleTranslate(message: Message) {
    if (!message.content) return;

    const setTranslation = setters.get(message.id);
    if (!setTranslation) return;
    const request = {};
    requests.set(message.id, request);
    const isCurrent = () => requests.get(message.id) === request && setters.get(message.id) === setTranslation;

    try {
        const translation = await translate(message.content);
        if (isCurrent()) setTranslation(translation);
    } catch (error) {
        console.error("[TranslatePlus] Failed to translate message:", error);
        if (isCurrent()) {
            setTranslation({ src: "en", text: "Translation failed due to an error." });
        }
    } finally {
        if (requests.get(message.id) === request) requests.delete(message.id);
    }
}
