/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface DiffPart {
    type: "added" | "removed" | "unchanged";
    text: string;
}

function tokenizeMessage(text: string): string[] {
    const tokens: string[] = [];
    let index = 0;

    while (index < text.length) {
        if (text[index] === "<" && (text[index + 1] === "@" || text[index + 1] === "#" ||
            (text[index + 1] === "a" && text[index + 2] === ":"))) {
            const endIndex = text.indexOf(">", index);
            if (endIndex !== -1) {
                tokens.push(text.slice(index, endIndex + 1));
                index = endIndex + 1;
                continue;
            }
        }

        // handle regular characters (including Unicode emojis)
        const char = String.fromCodePoint(text.codePointAt(index)!);
        tokens.push(char);
        index += char.length;
    }

    return tokens;
}

export function createWordDiff(oldText: string, newText: string): DiffPart[] {
    if (oldText === newText) return oldText ? [{ type: "unchanged", text: oldText }] : [];

    const adding = oldText.length < newText.length;
    const shorter = adding ? oldText : newText;
    const longer = adding ? newText : oldText;
    const type = adding ? "added" : "removed";

    if (longer.startsWith(shorter)) {
        const parts: DiffPart[] = [];
        if (shorter.length > 0) {
            parts.push({ type: "unchanged", text: shorter });
        }
        parts.push({ type, text: longer.slice(shorter.length) });
        return parts;
    }

    if (longer.endsWith(shorter)) {
        const parts: DiffPart[] = [{ type, text: longer.slice(0, longer.length - shorter.length) }];
        if (shorter.length > 0) {
            parts.push({ type: "unchanged", text: shorter });
        }
        return parts;
    }

    // For complex cases, fall back to LCS algorithm
    const oldChars = tokenizeMessage(oldText);
    const newChars = tokenizeMessage(newText);

    const dp = Array.from({ length: oldChars.length + 1 }, () => new Uint32Array(newChars.length + 1));

    for (let i = 1; i <= oldChars.length; i++) {
        for (let j = 1; j <= newChars.length; j++) {
            if (oldChars[i - 1] === newChars[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = oldChars.length;
    let j = newChars.length;

    const diffParts: DiffPart[] = [];

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
            diffParts.push({ type: "unchanged", text: oldChars[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] > dp[i - 1][j])) {
            diffParts.push({ type: "added", text: newChars[j - 1] });
            j--;
        } else if (i > 0) {
            diffParts.push({ type: "removed", text: oldChars[i - 1] });
            i--;
        }
    }

    const groupedParts: DiffPart[] = [];
    for (const part of diffParts.reverse()) {
        const lastPart = groupedParts[groupedParts.length - 1];
        if (lastPart && lastPart.type === part.type) {
            lastPart.text += part.text;
        } else {
            groupedParts.push(part);
        }
    }

    return groupedParts;
}

export function createMessageDiff(previousContent: string, currentContent: string): DiffPart[] {
    return createWordDiff(previousContent, currentContent);
}
