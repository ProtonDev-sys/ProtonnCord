/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export class VariableWithCallbacks<T> {
    #value: T;
    #nextId = 0;
    #callbacks: {
        id: number;
        callback: (value: T, id: number) => void;
    }[] = [];

    constructor(value: T) {
        this.#value = value;
    }

    value(newValue?: T): T {
        if (newValue !== undefined) {
            this.#value = newValue;
            for (const c of [...this.#callbacks]) c.callback(this.#value, c.id);
        }
        return this.#value;
    }

    registerCallback(callback: (value: T, id: number) => void): number {
        const id = ++this.#nextId;
        this.#callbacks.push({
            id,
            callback
        });
        return id;
    }

    deregisterCallback(id: number) {
        const index = this.#callbacks.findIndex(callback => callback.id === id);
        if (index !== -1) this.#callbacks.splice(index, 1);
    }
}
