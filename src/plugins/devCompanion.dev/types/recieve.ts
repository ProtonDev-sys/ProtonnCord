/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// should be the same types as ./server/types/send.ts in the companion
export type SearchData =
    | {
        extractType: "id";
        idOrSearch: number;
    }
    | (
        | {
            extractType: "search";
            /**
             * stringified regex
             */
            idOrSearch: string;
            findType: "regex";
        }
        | {
            extractType: "search";
            idOrSearch: string;
            findType: "string";
        }
    );

export type FindOrSearchData =
    | (SearchData & {
        usePatched: boolean | null;
    })
    | ({
        extractType: "find";
    } & _PrefixKeys<_CapitalizeKeys<FindData>, "find">);

export type AnyFindType =
    `find${"Component" | "ByProps" | "CssClasses" | "Store" | "ByCode" | "ModuleId" | "ComponentByCode" | ""}${"Lazy" | ""}`;

export type StringNode = {
    type: "string";
    value: string;
};

export type RegexNode = {
    type: "regex";
    value: {
        pattern: string;
        flags: string;
    };
};

export type FindNode = StringNode | RegexNode;

export type FindData = {
    type: AnyFindType;
    args: FindNode[];
};

export type IncomingMessage = DisablePlugin | RawId | DiffPatch | Reload | ExtractModule | TestPatch | TestFind | AllModules | I18nLookup | Version;
export type FullIncomingMessage = IncomingMessage & { nonce: number; };

export type DisablePlugin = {
    type: "disable";
    data: {
        enabled: boolean;
        pluginName: string;
    };
};

export type I18nLookup = {
    type: "i18n";
    data: {
        hashedKey: string;
    };
};

/**
 * @deprecated use {@link ExtractModule} instead
 */
export type RawId = {
    /**
     * @deprecated use {@link ExtractModule} instead
     */
    type: "rawId";
    data: {
        id: number;
    };
};

export type DiffPatch = {
    type: "diff";
    data: SearchData;
};

export type Reload = {
    type: "reload";
    data: null;
};

export type ExtractModule = {
    type: "extract";
    // FIXME: update client code so you can just pass FindData here
    data: FindOrSearchData;
};

export type Version = {
    type: "version";
    data: {
        // major minor patch
        server_version: [number, number, number];
    };
};

export type TestPatch = {
    type: "testPatch";
    data: (
        | {
            findType: "string";
            find: string;
        }
        | {
            findType: "regex";
            /**
             * stringified regex
             */
            find: string;
        }
    ) & {
        replacement: {
            match: StringNode | RegexNode;
            replace: StringNode | RegexNode;
        }[];
    };
};

export type TestFind = {
    type: "testFind";
    data: FindData;
};

export type AllModules = {
    type: "allModules";
    data: null;
};

const FIND_TYPES = new Set<AnyFindType>([
    "find",
    "findLazy",
    "findComponent",
    "findComponentLazy",
    "findByProps",
    "findByPropsLazy",
    "findCssClasses",
    "findCssClassesLazy",
    "findStore",
    "findStoreLazy",
    "findByCode",
    "findByCodeLazy",
    "findModuleId",
    "findModuleIdLazy",
    "findComponentByCode",
    "findComponentByCodeLazy",
]);

const MAX_FIND_ARGUMENTS = 32;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_REPLACEMENTS = 64;
const MAX_SEARCH_LENGTH = 16 * 1024;
const REGEX_FLAGS_PATTERN = /^[dgimsuvy]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function isBoundedString(value: unknown, maximumLength: number, allowEmpty = false): value is string {
    return typeof value === "string" && value.length <= maximumLength && (allowEmpty || value.length > 0);
}

function isSafeUnsignedInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFindType(value: unknown): value is AnyFindType {
    return typeof value === "string" && FIND_TYPES.has(value as AnyFindType);
}

function isRegexFlags(value: unknown): value is string {
    return typeof value === "string"
        && REGEX_FLAGS_PATTERN.test(value)
        && new Set(value).size === value.length;
}

function isFindNode(value: unknown): value is FindNode {
    if (!isRecord(value) || !hasExactKeys(value, ["type", "value"])) return false;

    if (value.type === "string") return isBoundedString(value.value, MAX_SEARCH_LENGTH);
    if (value.type !== "regex" || !isRecord(value.value) || !hasExactKeys(value.value, ["pattern", "flags"])) return false;
    return isBoundedString(value.value.pattern, MAX_SEARCH_LENGTH) && isRegexFlags(value.value.flags);
}

function isFindNodes(value: unknown): value is FindNode[] {
    return Array.isArray(value) && value.length > 0 && value.length <= MAX_FIND_ARGUMENTS && value.every(isFindNode);
}

function isSearchData(value: unknown, requireUsePatched: boolean): value is SearchData & { usePatched?: boolean | null; } {
    if (!isRecord(value)) return false;

    const expectedKeys = value.extractType === "id"
        ? ["extractType", "idOrSearch"]
        : ["extractType", "idOrSearch", "findType"];
    if (requireUsePatched) expectedKeys.push("usePatched");
    if (!hasExactKeys(value, expectedKeys)) return false;
    if (requireUsePatched && value.usePatched !== null && typeof value.usePatched !== "boolean") return false;

    if (value.extractType === "id") return isSafeUnsignedInteger(value.idOrSearch);
    return value.extractType === "search"
        && (value.findType === "regex" || value.findType === "string")
        && isBoundedString(value.idOrSearch, MAX_SEARCH_LENGTH);
}

function isFindOrSearchData(value: unknown): value is FindOrSearchData {
    if (!isRecord(value)) return false;
    if (value.extractType !== "find") return isSearchData(value, true);
    return hasExactKeys(value, ["extractType", "findType", "findArgs"])
        && isFindType(value.findType)
        && isFindNodes(value.findArgs);
}

function isFindData(value: unknown): value is FindData {
    return isRecord(value)
        && hasExactKeys(value, ["type", "args"])
        && isFindType(value.type)
        && isFindNodes(value.args);
}

function isPatchData(value: unknown): value is TestPatch["data"] {
    if (!isRecord(value) || !hasExactKeys(value, ["findType", "find", "replacement"])) return false;
    if ((value.findType !== "regex" && value.findType !== "string")
        || !isBoundedString(value.find, MAX_SEARCH_LENGTH)
        || !Array.isArray(value.replacement)
        || value.replacement.length === 0
        || value.replacement.length > MAX_REPLACEMENTS)
        return false;

    return value.replacement.every(replacement =>
        isRecord(replacement)
        && hasExactKeys(replacement, ["match", "replace"])
        && isFindNode(replacement.match)
        && isFindNode(replacement.replace)
    );
}

function isVersionTuple(value: unknown): value is [number, number, number] {
    return Array.isArray(value)
        && value.length === 3
        && value.every(part => isSafeUnsignedInteger(part) && part <= 0xffff);
}

/**
 * Treat the authenticated transport as untrusted input until every command has
 * passed an exact, bounded runtime schema check.
 */
export function parseIncomingMessage(value: unknown): FullIncomingMessage | null {
    if (!isRecord(value)
        || !hasExactKeys(value, ["nonce", "type", "data"])
        || !isSafeUnsignedInteger(value.nonce)
        || typeof value.type !== "string")
        return null;

    let valid = false;
    switch (value.type) {
        case "disable":
            valid = isRecord(value.data)
                && hasExactKeys(value.data, ["enabled", "pluginName"])
                && typeof value.data.enabled === "boolean"
                && isBoundedString(value.data.pluginName, MAX_IDENTIFIER_LENGTH);
            break;
        case "rawId":
            valid = isRecord(value.data)
                && hasExactKeys(value.data, ["id"])
                && isSafeUnsignedInteger(value.data.id);
            break;
        case "diff":
            valid = isSearchData(value.data, false);
            break;
        case "reload":
        case "allModules":
            valid = value.data === null;
            break;
        case "extract":
            valid = isFindOrSearchData(value.data);
            break;
        case "testPatch":
            valid = isPatchData(value.data);
            break;
        case "testFind":
            valid = isFindData(value.data);
            break;
        case "i18n":
            valid = isRecord(value.data)
                && hasExactKeys(value.data, ["hashedKey"])
                && isBoundedString(value.data.hashedKey, MAX_IDENTIFIER_LENGTH);
            break;
        case "version":
            valid = isRecord(value.data)
                && hasExactKeys(value.data, ["server_version"])
                && isVersionTuple(value.data.server_version);
            break;
    }

    return valid ? value as FullIncomingMessage : null;
}

type _PrefixKeys<
    T extends Record<string, any>,
    P extends string,
> = string extends P
    ? never
    : {
        [K in keyof T as K extends string ? `${P}${K}` : never]: T[K];
    };

type _CapitalizeKeys<T extends Record<string, any>> = {
    [K in keyof T as K extends string ? Capitalize<K> : never]: T[K];
};
