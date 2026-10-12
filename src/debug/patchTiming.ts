/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PatchReplacement } from "@utils/types";

export interface PatchTimingConfirmation {
    status: "outlier" | "slow" | "inconclusive";
    samplesMs: number[];
    reason?: string;
}

// The complete read-only snapshot can be removed from non-reporter builds.
const native = /* @__PURE__ */ (() => ({
    RegExp,
    regExpDescriptors: Object.getOwnPropertyDescriptors(RegExp.prototype),
    stringPrototype: String.prototype,
    replace: String.prototype.replace as (this: string, match: string | RegExp, replacement: string) => string
}))();
const flagProperties = { hasIndices: "d", global: "g", ignoreCase: "i", multiline: "m", dotAll: "s", unicode: "u", unicodeSets: "v", sticky: "y" };

/** Never repeat callbacks, user-defined regexp hooks, or mutated regexp prototypes. */
function replayMatcher(match: PatchReplacement["match"], initialLastIndex: unknown) {
    if (Object.getOwnPropertyDescriptor(native.stringPrototype, "replace")?.value !== native.replace) return;
    if (typeof match === "string") {
        if (Object.getPrototypeOf(native.stringPrototype) !== Object.prototype
            || Object.getOwnPropertyDescriptor(native.stringPrototype, Symbol.replace)
            || Object.getOwnPropertyDescriptor(Object.prototype, Symbol.replace)) return;
        return () => match;
    }

    // The intrinsic brand check rejects proxies without invoking their traps.
    const source = native.regExpDescriptors.source.get!.call(match);
    if (Object.getPrototypeOf(match) !== native.RegExp.prototype) return;
    const own = Object.getOwnPropertyDescriptors(match);
    const formatter = Object.getOwnPropertyDescriptor(match, "toString");
    if (Reflect.ownKeys(own).some(key => key !== "lastIndex" && key !== "toString")
        || formatter && typeof formatter.value !== "function"
        || !Number.isSafeInteger(initialLastIndex) || (initialLastIndex as number) < 0) return;
    for (const key of Reflect.ownKeys(native.regExpDescriptors)) {
        const original = Object.getOwnPropertyDescriptor(native.RegExp.prototype, key);
        const expected = Reflect.get(native.regExpDescriptors, key) as PropertyDescriptor;
        if (!original || original.value !== expected.value || original.get !== expected.get || original.set !== expected.set) return;
    }
    const flags = Object.entries(flagProperties).filter(([property]) => native.regExpDescriptors[property]?.get?.call(match)).map(([, flag]) => flag).join("");
    return () => {
        const copy = new native.RegExp(source, flags);
        // executePatch resets global matches; a sticky-only match retains its initial position.
        Object.defineProperty(copy, "lastIndex", { ...own.lastIndex, value: flags.includes("g") ? 0 : initialLastIndex });
        // Preserve canonicalizeMatch's inert formatter and regexp shape without invoking it.
        if (formatter) Object.defineProperty(copy, "toString", formatter);
        return copy;
    };
}

export function getPatchTimingLastIndex(match: PatchReplacement["match"]): unknown {
    if (typeof match === "string") return 0;
    try {
        native.regExpDescriptors.source.get!.call(match);
        return Object.getOwnPropertyDescriptor(match, "lastIndex")?.value;
    } catch { return undefined; }
}

/** Source-only confirmation with a run-wide work budget checked between synchronous replays. */
export function createPatchTimingConfirmer(now = () => performance.now()) {
    let confirmations = 0;
    let spentMs = 0;
    return (input: string, output: string, match: PatchReplacement["match"], replacement: PatchReplacement["replace"], initialMs: number, initialLastIndex: unknown): PatchTimingConfirmation => {
        const samplesMs: number[] = [];
        const inconclusive = (reason: string): PatchTimingConfirmation => ({ status: "inconclusive", samplesMs, reason });
        if (typeof input !== "string" || typeof output !== "string") return inconclusive("Source and output must be strings");
        if (!Number.isFinite(initialMs) || initialMs <= 10 || initialMs > 100) return inconclusive("Initial timing is outside the 10–100 ms confirmation window");
        if (typeof replacement !== "string") return inconclusive("Replacement callbacks are not replayed");
        if (confirmations >= 20 || spentMs >= 200) return inconclusive("Reporter timing confirmation budget exhausted");

        let makeMatcher: ReturnType<typeof replayMatcher>;
        try { makeMatcher = replayMatcher(match, initialLastIndex); }
        catch { return inconclusive("Matcher does not have repeatable native behavior"); }
        if (!makeMatcher) return inconclusive("Matcher does not have repeatable native behavior");

        confirmations++;
        let started = NaN;
        const complete = (status: PatchTimingConfirmation["status"], reason?: string): PatchTimingConfirmation => {
            let elapsed = NaN;
            try { elapsed = now() - started; } catch { }
            if (!Number.isFinite(elapsed) || elapsed < 0) {
                spentMs = Infinity;
                return inconclusive("Replay timing was unavailable");
            }
            spentMs += elapsed;
            if (spentMs > 200) return inconclusive("Reporter timing confirmation budget exhausted");
            return { status, samplesMs, ...(reason && { reason }) };
        };
        try {
            started = now();
            for (let attempt = 0; attempt < 2; attempt++) {
                if (spentMs + now() - started >= 200) return complete("inconclusive", "Reporter timing confirmation budget exhausted");
                const copy = makeMatcher();
                const start = now();
                const actual = native.replace.call(input, copy, replacement);
                const duration = now() - start;
                samplesMs.push(duration);
                if (!Number.isFinite(duration) || duration < 0) return complete("inconclusive", "Replay timing was invalid");
                if (actual !== output) return complete("inconclusive", "Replay output differed from the applied patch");
                if (duration > 10) return complete("slow", "Replay exceeded 10 ms");
            }
            return complete("outlier");
        } catch {
            return complete("inconclusive", "Replacement replay threw");
        }
    };
}
