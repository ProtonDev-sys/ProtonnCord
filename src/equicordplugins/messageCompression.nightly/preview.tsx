/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { TextArea, useMemo, UserStore, useState } from "@webpack/common";

import { encodeCompressedMessage, MAX_DECOMPRESSED_BYTES, MAX_WIRE_LENGTH } from "./codec";

const sample = "I finally had a chance to try the new build this evening. The settings page feels much easier to navigate, and I like that the search remembers what I was looking for. One thing I noticed is that the window opens a little too wide on my laptop, so the buttons near the bottom disappear until I resize it. I'll try the same steps on my desktop tomorrow and let you know whether it happens there too.";

export function CompressionPreview({ canCompress }: { canCompress: (text: string) => boolean; }) {
    const [text, setText] = useState(sample);
    const result = useMemo(() => {
        const originalBytes = new TextEncoder().encode(text).length;
        const candidate = canCompress(text) ? encodeCompressedMessage(text) : null;
        return { originalBytes, candidate };
    }, [text, canCompress]);
    const { originalBytes, candidate } = result;
    const nativeLimit = UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;

    return <section aria-label="Compression preview">
        <BaseText>Try compression</BaseText>
        <BaseText>Paste ordinary text below to measure it locally. This preview does not send a message.</BaseText>
        <TextArea
            aria-label="Text to compress"
            value={text}
            onChange={setText}
            rows={7}
            maxLength={MAX_DECOMPRESSED_BYTES}
        />
        <BaseText>
            {candidate
                ? `${originalBytes.toLocaleString()} → ${candidate.encodedBytes.toLocaleString()} bytes · ${(100 * (1 - candidate.encodedBytes / originalBytes)).toFixed(1)}% saved · ${candidate.codec}. Exact reconstruction verified.`
                : text.length > nativeLimit
                    ? `${originalBytes.toLocaleString()} bytes. This text cannot fit in one message; sending would keep your draft.`
                    : `${originalBytes.toLocaleString()} bytes. This text would be sent unchanged.`}
        </BaseText>
        <BaseText>Sizes include the complete encoded message. Compression needs a smaller result within {MAX_WIRE_LENGTH.toLocaleString()} characters and at most 64 KiB of original text. Links and mentions keep normal sending.</BaseText>
        {candidate && <details>
            <summary>View the transmitted text</summary>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" }}>{candidate.content}</pre>
        </details>}
    </section>;
}
