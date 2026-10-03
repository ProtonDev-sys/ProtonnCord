/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

let protectionDepth = 0;
let originalDescriptor: PropertyDescriptor | undefined;

export async function protectWebpack<T>(webpack: any[], body: () => Promise<T>): Promise<T> {
    if (!protectionDepth) {
        originalDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "m");
        Object.defineProperty(Function.prototype, "m", {
            get() { throw "get require.m"; },
            set() { throw "set require.m"; },
            enumerable: true,
            configurable: true,
        });
    }
    protectionDepth++;

    try {
        return await body();
    } finally {
        if (!--protectionDepth) {
            if (originalDescriptor) Object.defineProperty(Function.prototype, "m", originalDescriptor);
            else Reflect.deleteProperty(Function.prototype, "m");
            originalDescriptor = undefined;
        }
    }
}

export function getLoadedChunks(wreq): { [chunkId: string | symbol]: 0 | undefined; } {
    const { o } = wreq;
    try {
        wreq.o = (a: any) => { throw a; };
        wreq.f.j();
    } catch (e: any) {
        return e;
    } finally {
        wreq.o = o;
    }
    throw new Error("getLoadedChunks failed");
}

export function getChunkPaths(wreq): { [chunkId: string]: string; } {
    const sym = Symbol("getChunkPaths");
    try {
        Object.defineProperty(Object.prototype, sym, {
            get() { throw this; },
            set() { },
            configurable: true,
        });
        wreq.u(sym);
    } catch (e: any) {
        return e;
    } finally {
        // @ts-ignore
        delete Object.prototype[sym];
    }
    throw new Error("getChunkPaths failed");
}

export async function forceLoadAll(wreq, on_chunk: (id: string) => void = () => { }) {
    const chunks = getChunkPaths(wreq);
    const loaded = getLoadedChunks(wreq);
    const ids = Object.keys(chunks).filter(id => loaded[id] !== 0);
    await Promise.all(ids.map(async id => {
        try {
            await wreq.e(id as any);
        } catch { }
        on_chunk(id);
    }));
}
