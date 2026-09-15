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

import { dispatchTheme } from "@plugins/shikiCodeblocks.desktop/hooks/useTheme";
import type { ShikiSpec } from "@plugins/shikiCodeblocks.desktop/types";
import { shikiOnigasmSrc, shikiWorkerSrc } from "@utils/dependencies";
import { WorkerClient } from "@vap/core/ipc";
import type { IShikiTheme, IThemedToken } from "@vap/shiki";

import { getGrammar, languages, loadLanguages, resolveLang } from "./languages";
import { themes } from "./themes";

const themeUrls = Object.values(themes);

let resolveClient: (client: WorkerClient<ShikiSpec>) => void;
let rejectClient: (reason: Error) => void;
let generation = 0;
let themeGeneration = 0;
let initialization: Promise<void> | undefined;
const pendingThemes = new Map<string, Promise<void>>();
const pendingLanguages = new Map<string, Promise<void>>();

function createClientPromise() {
    const promise = new Promise<WorkerClient<ShikiSpec>>((resolve, reject) => {
        resolveClient = resolve;
        rejectClient = reject;
    });
    void promise.catch(() => {});
    return promise;
}

function withDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        operation,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Shiki operation timed out")), shiki.timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

function assertCurrent(client: WorkerClient<ShikiSpec>) {
    if (client !== shiki.client) throw new Error("Shiki session ended");
}

export const shiki = {
    client: null as WorkerClient<ShikiSpec> | null,
    currentTheme: null as IShikiTheme | null,
    currentThemeUrl: null as string | null,
    timeoutMs: 10000,
    languages,
    themes,
    loadedThemes: new Set<string>(),
    loadedLangs: new Set<string>(),
    clientPromise: createClientPromise(),

    init: (initThemeUrl: string | undefined): Promise<void> => {
        if (initialization) return initialization;
        const currentGeneration = ++generation;
        initialization = (async () => {
            const response = await fetch(shikiWorkerSrc, { signal: AbortSignal.timeout(shiki.timeoutMs) });
            if (!response.ok) throw new Error(`Shiki worker request failed: ${response.status}`);
            const workerBlob = await response.blob();
            if (generation !== currentGeneration) return;

            const client = shiki.client = new WorkerClient<ShikiSpec>(
                "shiki-client", "shiki-host", workerBlob, { name: "ShikiWorker" }
            );
            await withDeadline(client.init());
            assertCurrent(client);
            const themeUrl = initThemeUrl || themeUrls[0];
            await loadLanguages();
            assertCurrent(client);
            await withDeadline(client.run("setOnigasm", { wasm: shikiOnigasmSrc }));
            assertCurrent(client);
            await withDeadline(client.run("setHighlighter", { theme: themeUrl, langs: [] }));
            assertCurrent(client);
            shiki.loadedThemes.add(themeUrl);
            await shiki._setTheme(themeUrl, themeGeneration);
            assertCurrent(client);
            resolveClient(client);
        })().catch(error => {
            if (generation === currentGeneration) shiki.destroy();
            throw error;
        });
        return initialization;
    },
    _setTheme: async (themeUrl: string, request = ++themeGeneration) => {
        const { client } = shiki;
        if (!client) return;
        const { themeData } = await withDeadline(client.run("getTheme", { theme: themeUrl }));
        assertCurrent(client);
        if (request !== themeGeneration) return;
        const theme = JSON.parse(themeData);
        if (!theme || typeof theme !== "object" || Array.isArray(theme)) throw new Error("Invalid Shiki theme");
        shiki.currentThemeUrl = themeUrl;
        shiki.currentTheme = theme;
        dispatchTheme({ id: themeUrl, theme });
    },
    loadTheme: async (themeUrl: string) => {
        const client = await shiki.clientPromise;
        assertCurrent(client);
        if (shiki.loadedThemes.has(themeUrl)) return;
        if (pendingThemes.has(themeUrl)) return pendingThemes.get(themeUrl);
        const pending = withDeadline(client.run("loadTheme", { theme: themeUrl })).then(() => {
            assertCurrent(client);
            shiki.loadedThemes.add(themeUrl);
        }).finally(() => {
            if (pendingThemes.get(themeUrl) === pending) pendingThemes.delete(themeUrl);
        });
        pendingThemes.set(themeUrl, pending);
        return pending;
    },
    setTheme: async (themeUrl: string) => {
        const request = ++themeGeneration;
        const client = await shiki.clientPromise;
        assertCurrent(client);
        themeUrl ||= themeUrls[0];
        if (!shiki.loadedThemes.has(themeUrl)) await shiki.loadTheme(themeUrl);
        assertCurrent(client);
        if (request !== themeGeneration) return;
        await shiki._setTheme(themeUrl, request);
    },
    loadLang: async (langId: string) => {
        const client = await shiki.clientPromise;
        assertCurrent(client);
        const lang = resolveLang(langId);
        if (!lang || shiki.loadedLangs.has(lang.id)) return;
        if (pendingLanguages.has(lang.id)) return pendingLanguages.get(lang.id);
        const pending = (async () => {
            const grammar = lang.grammar ?? await getGrammar(lang);
            assertCurrent(client);
            await withDeadline(client.run("loadLanguage", { lang: { ...lang, grammar } }));
            assertCurrent(client);
            shiki.loadedLangs.add(lang.id);
        })().finally(() => {
            if (pendingLanguages.get(lang.id) === pending) pendingLanguages.delete(lang.id);
        });
        pendingLanguages.set(lang.id, pending);
        return pending;
    },
    tokenizeCode: async (code: string, langId: string): Promise<IThemedToken[][]> => {
        const client = await shiki.clientPromise;
        assertCurrent(client);
        const lang = resolveLang(langId);
        if (!lang) return [];
        if (!shiki.loadedLangs.has(lang.id)) await shiki.loadLang(lang.id);
        assertCurrent(client);
        return withDeadline(client.run("codeToThemedTokens", {
            code, lang: lang.id, theme: shiki.currentThemeUrl ?? themeUrls[0],
        }));
    },
    destroy() {
        generation++;
        themeGeneration++;
        rejectClient(new Error("Shiki session ended"));
        shiki.clientPromise = createClientPromise();
        initialization = undefined;
        shiki.currentTheme = null;
        shiki.currentThemeUrl = null;
        shiki.loadedThemes.clear();
        shiki.loadedLangs.clear();
        pendingThemes.clear();
        pendingLanguages.clear();
        const { client } = shiki;
        shiki.client = null;
        client?.destroy();
        dispatchTheme({ id: null, theme: null });
    }
};
