/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    guardedRestFailureResponse,
    type GuardedRestFailureResponse,
    settleGuardedRestFailure,
} from "../src/equicordplugins/secureMessaging.desktop/restGuardFailure";

interface SuccessfulRestResponse {
    body: Record<string, never>;
    hasErr: false;
    headers: Record<string, string>;
    ok: true;
    status: 200;
    text: string;
}

type RestResponse = GuardedRestFailureResponse | SuccessfulRestResponse;
type QueueOperation = (callback: (response: RestResponse) => void) => void;

async function runQueueOperation(operation: QueueOperation): Promise<RestResponse> {
    return new Promise(resolve => operation(resolve));
}

async function main(): Promise<void> {
    const failure = new Error("Secure Messaging blocked forwarding into or out of a protected conversation");
    const response = guardedRestFailureResponse(failure);
    assert.deepEqual(response, {
        body: { code: 0, message: failure.message },
        hasErr: true,
        headers: {},
        ok: false,
        status: 0,
        text: failure.message,
    });

    assert.throws(
        () => settleGuardedRestFailure(failure, []),
        error => error === failure,
        "promise-based REST callers must still receive the original rejection",
    );

    const completions: RestResponse[] = [];
    const blocked = await runQueueOperation(callback => {
        settleGuardedRestFailure(failure, [callback]);
    });
    completions.push(blocked);

    const successful = await runQueueOperation(callback => {
        queueMicrotask(() => callback({
            body: {},
            hasErr: false,
            headers: {},
            ok: true,
            status: 200,
            text: "",
        }));
    });
    completions.push(successful);

    assert.equal(completions.length, 2, "a blocked forward must complete before the next queued send runs");
    assert.equal(completions[0].hasErr, true);
    assert.equal(completions[1].ok, true, "the message queue must remain usable after a blocked forward");

    const pluginSource = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/index.tsx",
        import.meta.url,
    ), "utf8");
    assert.match(pluginSource, /import \{ settleGuardedRestFailure \} from "\.\/restGuardFailure";/u);
    assert.equal(
        pluginSource.match(/return settleGuardedRestFailure\(error, args\);/gu)?.length,
        4,
        "both POST and PATCH guards must settle callback failures before and after invoking Discord REST",
    );

    console.log("Secure Messaging REST guard queue recovery checks passed.");
}

void main();
