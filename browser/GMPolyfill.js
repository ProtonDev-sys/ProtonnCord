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

function parseHeaders(headers) {
    const result = new Headers();
    if (!headers)
        return result;

    const headersArr = headers.trim().split("\n");
    for (var i = 0; i < headersArr.length; i++) {
        var row = headersArr[i];
        var index = row.indexOf(":")
            , key = row.slice(0, index).trim().toLowerCase()
            , value = row.slice(index + 1).trim();

        result.append(key, value);
    }
    return result;
}

function GM_fetch(url, opt) {
    return new Promise((resolve, reject) => {
        // https://www.tampermonkey.net/documentation.php?ext=dhdg#GM_xmlhttpRequest
        const options = { ...opt };
        const signal = options.signal;
        delete options.signal;
        let request;
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            callback(value);
        };
        const onAbort = () => {
            finish(reject, signal.reason ?? new DOMException("The request was aborted", "AbortError"));
            try { request?.abort(); } catch { }
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        options.url = url;
        options.data = options.body;
        options.responseType = "blob";
        options.onload = resp => {
            if (settled) return;
            try {
                var blob = resp.response;
                resp.blob = () => Promise.resolve(blob);
                resp.arrayBuffer = () => blob.arrayBuffer();
                resp.text = () => blob.text();
                resp.json = async () => JSON.parse(await blob.text());
                resp.headers = parseHeaders(resp.responseHeaders);
                resp.ok = resp.status >= 200 && resp.status < 300;
                finish(resolve, resp);
            } catch (error) {
                finish(reject, error);
            }
        };
        options.ontimeout = () => finish(reject, "fetch timeout");
        options.onerror = () => finish(reject, "fetch error");
        options.onabort = () => finish(reject, "fetch abort");
        try {
            request = GM_xmlhttpRequest(options);
            if (signal?.aborted) request?.abort();
        } catch (error) {
            finish(reject, error);
        }
    });
}
export const fetch = GM_fetch;
