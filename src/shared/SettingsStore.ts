/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { LiteralUnion } from "type-fest";

export const SYM_IS_PROXY = Symbol("SettingsStore.isProxy");
export const SYM_GET_RAW_TARGET = Symbol("SettingsStore.getRawTarget");

type ResolvePropDeep<T, P> = P extends `${infer Prefix}.*`
    ? Prefix extends keyof T ? T[Prefix][keyof T[Prefix]] : any
    : P extends `${infer Prefix}.${infer Rest}`
        ? Prefix extends keyof T ? ResolvePropDeep<T[Prefix], Rest> : any
        : P extends keyof T ? T[P] : any;

interface SettingsStoreOptions {
    /** Prevent replacing the root; individual settings remain mutable. */
    readOnly?: boolean;
    getDefaultValue?: (data: { target: any; key: string; root: any; path: string; }) => any;
}

type ChangeListener = (value: any, path: string) => void;

function unwrap<V>(value: V): V {
    return value && typeof value === "object" && value[SYM_IS_PROXY] ? value[SYM_GET_RAW_TARGET] : value;
}

function atPath(root: object, keys: readonly string[]): unknown {
    let value: unknown = root;
    for (const key of keys) {
        if (value === null || typeof value !== "object") return undefined;
        value = value[key];
    }
    return value;
}

/** Mutable settings with stable nested references and synchronous path notifications. */
export class SettingsStore<T extends object> implements SettingsStoreOptions {
    public store: T;
    public plain: T;
    public readOnly: boolean;
    public getDefaultValue?: SettingsStoreOptions["getDefaultValue"];

    private readonly pathListeners = new Map<string, Set<ChangeListener>>();
    private readonly prefixListeners = new Map<string, Set<ChangeListener>>();
    private readonly globalListeners = new Set<(data: T, path: string) => void>();
    private proxies = new WeakMap<object, Map<string, object>>();

    public constructor(plain: T, options: SettingsStoreOptions = {}) {
        this.plain = plain;
        this.readOnly = options.readOnly ?? false;
        this.getDefaultValue = options.getDefaultValue;
        this.store = this.makeProxy(plain, plain, "", []);
    }

    private makeProxy<V extends object>(target: V, root: T, path: string, keys: string[]): V {
        let byPath = this.proxies.get(target);
        const existing = byPath?.get(path);
        if (existing) return existing as V;
        if (!byPath) this.proxies.set(target, byPath = new Map());

        const childPath = (key: string) => path ? `${path}.${key}` : key;
        const attached = () => root === this.plain && atPath(root, keys) === target;
        const children = new Map<string, { raw: object; proxy: object; }>();
        const proxy = new Proxy(target, {
            get: (object, key, receiver) => {
                if (key === SYM_IS_PROXY) return true;
                if (key === SYM_GET_RAW_TARGET) return object;
                let value = Reflect.get(object, key, receiver);
                if (typeof key !== "string") return value;
                if (!(key in object) && this.getDefaultValue)
                    value = this.getDefaultValue({ target: object, key, root, path });
                if (value === null || typeof value !== "object") return value;
                const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
                if (descriptor && !descriptor.configurable && "value" in descriptor && !descriptor.writable)
                    return value;
                const cached = children.get(key);
                if (cached?.raw === value) return cached.proxy;
                const raw = unwrap(value);
                if (!Array.isArray(raw)) {
                    const prototype = Object.getPrototypeOf(raw);
                    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return value;
                }
                const nested = this.makeProxy(raw, root, childPath(key), [...keys, key]);
                children.set(key, { raw, proxy: nested });
                return nested;
            },
            set: (object, key, value) => {
                const raw = unwrap(value);
                if (Object.is(Reflect.get(object, key), raw)) return true;
                if (!Reflect.set(object, key, raw)) return false;
                // Assigning array length deletes indices without invoking deleteProperty.
                if (key === "length" && Array.isArray(object)) children.clear();
                if (typeof key === "string") children.delete(key);
                if (typeof key === "string" && attached()) this.notify(childPath(key), raw);
                return true;
            },
            deleteProperty: (object, key) => {
                const existed = Object.hasOwn(object, key);
                if (!Reflect.deleteProperty(object, key)) return false;
                if (typeof key === "string") children.delete(key);
                if (existed && typeof key === "string" && attached()) this.notify(childPath(key), undefined);
                return true;
            }
        });
        byPath.set(path, proxy);
        return proxy;
    }

    private notifyPrefixes(path: string, value: unknown) {
        let end = path.indexOf(".");
        while (end !== -1) {
            this.prefixListeners.get(path.slice(0, end))?.forEach(listener => listener(value, path));
            end = path.indexOf(".", end + 1);
        }
        this.prefixListeners.get(path)?.forEach(listener => listener(value, path));
    }

    private notify(path: string, value: unknown) {
        const keys = path.split(".");
        if (keys[0] === "plugins" && keys.length > 3) {
            const settingPath = keys.slice(0, 3).join(".");
            const settingValue = atPath(this.plain, keys.slice(0, 3));
            this.globalListeners.forEach(listener => listener(this.plain, settingPath));
            this.pathListeners.get(settingPath)?.forEach(listener => listener(settingValue, settingPath));
        } else {
            this.globalListeners.forEach(listener => listener(this.plain, path));
        }
        this.pathListeners.get(path)?.forEach(listener => listener(value, path));
        this.notifyPrefixes(path, value);
    }

    /** Replace the root after persistence. Previously returned proxies become detached. */
    public setData(value: T, pathToNotify?: string | readonly string[]) {
        if (this.readOnly) throw new Error("SettingsStore is read-only");
        this.plain = value;
        this.proxies = new WeakMap();
        this.store = this.makeProxy(value, value, "", []);
        const paths = typeof pathToNotify === "string" ? [pathToNotify] : pathToNotify ?? [];
        for (const path of new Set(paths)) {
            if (!path) continue;
            let current: unknown = value;
            for (const key of path.split(".")) {
                if (current === null || typeof current !== "object") {
                    current = undefined;
                    break;
                }
                current = current[key];
            }
            this.pathListeners.get(path)?.forEach(listener => listener(current, path));
            this.notifyPrefixes(path, current);
        }
        this.markAsChanged();
    }

    public addGlobalChangeListener(listener: (data: T, path: string) => void) {
        this.globalListeners.add(listener);
    }

    public removeGlobalChangeListener(listener: (data: T, path: string) => void) {
        this.globalListeners.delete(listener);
    }

    public addChangeListener<P extends LiteralUnion<keyof T, string>>(path: P, listener: (value: ResolvePropDeep<T, P>) => void) {
        const key = path as string;
        let listeners = this.pathListeners.get(key);
        if (!listeners) this.pathListeners.set(key, listeners = new Set());
        listeners.add(listener);
    }

    public removeChangeListener(path: LiteralUnion<keyof T, string>, listener: (value: any) => void) {
        const key = path as string;
        const listeners = this.pathListeners.get(key);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.pathListeners.delete(key);
    }

    public addPrefixChangeListener<P extends string>(prefix: P, listener: (value: ResolvePropDeep<T, P>, path: string) => void) {
        let listeners = this.prefixListeners.get(prefix);
        if (!listeners) this.prefixListeners.set(prefix, listeners = new Set());
        listeners.add(listener);
    }

    public removePrefixChangeListener(prefix: string, listener: ChangeListener) {
        const listeners = this.prefixListeners.get(prefix);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.prefixListeners.delete(prefix);
    }

    public markAsChanged() {
        this.globalListeners.forEach(listener => listener(this.plain, ""));
    }
}
