export type ZustandDefinition<T> = (set: (state: Partial<T>) => void, get: () => T) => T;

export interface ZustandStore<T> {
    (): T;
    getState(): T;
}

export interface PersistedZustandStore<T> extends ZustandStore<T> {
    persist: {
        rehydrate(): Promise<void>;
    };
}
