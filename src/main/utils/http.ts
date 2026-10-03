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

type Url = string | URL;

export async function checkedFetch(url: Url, options?: RequestInit) {
    try {
        var res = await fetch(url, options);
    } catch (err) {
        if (err instanceof Error && err.cause) {
            err = err.cause;
        }

        throw new Error(`${options?.method ?? "GET"} ${url} failed: ${err}`);
    }

    if (res.ok) {
        return res;
    }

    let message = `${options?.method ?? "GET"} ${url}: ${res.status} ${res.statusText}`;
    try {
        const reason = await res.text();
        message += `\n${reason}`;
    } catch { }

    throw new Error(message);
}

export async function fetchBuffer(url: Url, options: RequestInit, limits: { maxBytes: number; timeoutMs: number; }) {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Extension download timed out")), limits.timeoutMs);
    try {
        if (signal.aborted) throw signal.reason;
        const download = fetch(url, { ...options, signal }).then(res => {
            if (signal.aborted) {
                res.body?.cancel().catch(() => undefined);
                throw signal.reason;
            }
            return res;
        });
        const res = await Promise.race([download, aborted]);
        if (!res.body) throw new Error("Extension download has no body");
        reader = res.body.getReader();
        if (!res.ok) throw new Error(`Extension download failed: ${res.status} ${res.statusText}`);
        const declaredSize = Number(res.headers.get("content-length"));
        if (declaredSize > limits.maxBytes) throw new Error("Extension download exceeds byte limit");
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
            const chunk = await Promise.race([reader.read(), aborted]);
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > limits.maxBytes) throw new Error("Extension download exceeds byte limit");
            chunks.push(chunk.value);
        }
        complete = true;
        return Buffer.concat(chunks, size);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (!complete) {
            controller.abort();
            reader?.cancel().catch(() => undefined);
        }
        reader?.releaseLock();
    }
}
