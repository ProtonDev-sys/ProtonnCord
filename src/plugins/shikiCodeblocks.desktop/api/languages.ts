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

import { ILanguageRegistration } from "@vap/shiki";

import { SHIKI_REPO, SHIKI_REPO_COMMIT } from "./themes";

export const JSON_REPO = "Vencord/ShikiPluginAssets";
export const JSON_REPO_COMMIT = "75d69df9fdf596a31eef8b7f6f891231a6feab44";
export const JSON_URL = `https://cdn.jsdelivr.net/gh/${JSON_REPO}@${JSON_REPO_COMMIT}/grammars.json`;
export const shikiRepoGrammar = (name: string) => `https://cdn.jsdelivr.net/gh/${SHIKI_REPO}@${SHIKI_REPO_COMMIT}/packages/tm-grammars/grammars/${name}.json`;

export interface Language {
    name: string;
    id: string;
    devicon?: string;
    grammarUrl: string,
    grammar?: ILanguageRegistration["grammar"];
    scopeName: string;
    aliases?: string[];
    custom?: boolean;
}
export interface LanguageJson {
    name: string;
    displayName: string;
    scopeName: string;
    devicon?: string;
    aliases?: string[];
}

export const languages: Record<string, Language> = {};

let loadLanguagesPromise: Promise<void> | undefined;
const grammarPromises = new Map<string, Promise<NonNullable<ILanguageRegistration["grammar"]>>>();

export const loadLanguages = async () => {
    if (loadLanguagesPromise) return loadLanguagesPromise;

    loadLanguagesPromise = (async () => {
        if (Object.keys(languages).length > 0) return;

        const langsJson: LanguageJson[] = await fetch(JSON_URL).then(res => res.ok ? res.json() : []);
        const loadedLanguages = Object.fromEntries(
            langsJson.map(lang => {
                const { name, displayName, ...rest } = lang;
                return [name, {
                    ...rest,
                    id: name,
                    name: displayName,
                    grammarUrl: shikiRepoGrammar(name),
                }];
            })
        );
        Object.assign(languages, loadedLanguages);
    })().catch(error => {
        loadLanguagesPromise = undefined;
        throw error;
    });

    return loadLanguagesPromise;
};

export const getGrammar = (lang: Language): Promise<NonNullable<ILanguageRegistration["grammar"]>> => {
    if (lang.grammar) return Promise.resolve(lang.grammar);

    const cachedPromise = grammarPromises.get(lang.id);
    if (cachedPromise) return cachedPromise;

    const grammarPromise = fetch(lang.grammarUrl)
        .then(res => res.json())
        .then(grammar => {
            lang.grammar = grammar;
            grammarPromises.delete(lang.id);
            return grammar;
        })
        .catch(error => {
            grammarPromises.delete(lang.id);
            throw error;
        });

    grammarPromises.set(lang.id, grammarPromise);
    return grammarPromise;
};

const aliasCache = new Map<string, Language>();
export function resolveLang(idOrAlias: string) {
    if (Object.prototype.hasOwnProperty.call(languages, idOrAlias)) return languages[idOrAlias];
    if (aliasCache.has(idOrAlias)) return aliasCache.get(idOrAlias)!;

    const lang = Object.values(languages).find(lang => lang.aliases?.includes(idOrAlias));

    if (!lang) return null;

    aliasCache.set(idOrAlias, lang);
    return lang;
}
