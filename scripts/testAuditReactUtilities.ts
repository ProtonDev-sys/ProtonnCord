/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const code = transpileModule(readFileSync("src/utils/react.tsx", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText;

function fixture() {
    let cursor = 0;
    let now = 1000;
    let nextTimer = 0;
    const slots: any[] = [];
    const effects: (() => void)[] = [];
    const errors: unknown[][] = [];
    const timers = new Map<number, { callback(): void; delay: number; }>();
    const same = (left?: unknown[], right?: unknown[]) => !!left && !!right
        && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
    const common = {
        React: {},
        useState(initial: unknown) {
            const index = cursor++;
            slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
            return [slots[index].value, (value: unknown) => { slots[index].value = value; }];
        },
        useMemo(factory: () => unknown, deps: unknown[]) {
            const index = cursor++;
            if (!same(slots[index]?.deps, deps)) slots[index] = { value: factory(), deps };
            return slots[index].value;
        },
        useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
            const index = cursor++;
            if (same(slots[index]?.deps, deps)) return;
            const previous = slots[index];
            slots[index] = { deps };
            effects.push(() => {
                previous?.cleanup?.();
                slots[index].cleanup = effect();
            });
        }
    };
    const mocks: Record<string, unknown> = {
        "@webpack/common": common,
        "./Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "./misc": {}, "./lazyReact": {}
    };
    const api = runInNewContext(code + "\nexports;", {
        exports: {}, Promise,
        Date: class extends Date { static now() { return now; } },
        setInterval(callback: () => void, delay: number) {
            timers.set(++nextTimer, { callback, delay });
            return nextTimer;
        },
        clearInterval(id: number) { timers.delete(id); },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return {
        api, errors, timers,
        setNow(value: number) { now = value; },
        render<T>(hook: (api: any) => T): T {
            cursor = 0;
            const result = hook(api);
            while (effects.length) effects.shift()!();
            return result;
        },
        unmount() { for (const slot of slots) slot?.cleanup?.(); }
    };
}

test("awaiter converts synchronous factory errors to settled fallback state", async () => {
    const f = fixture();
    const failure = new Error("factory failed");
    let observed: unknown;
    const render = () => f.render(api => api.useAwaiter(() => { throw failure; }, {
        fallbackValue: "fallback", onError(error: unknown) { observed = error; }
    }));
    assert.equal(render()[2], true);
    await setImmediate();
    assert.deepEqual(Array.from(render()), ["fallback", failure, false]);
    assert.equal(observed, failure);
    f.unmount();
});

test("awaiter callback failures are reported without replacing successful data or rejecting unobserved", async () => {
    for (const succeeds of [false, true]) {
        const f = fixture();
        let failures = 0;
        const render = () => f.render(api => api.useAwaiter(
            () => succeeds ? Promise.resolve("result") : Promise.reject(new Error("request failed")),
            {
                fallbackValue: "fallback",
                onSuccess() { throw new Error("success observer failed"); },
                onError() { failures++; throw new Error("failure observer failed"); }
            }
        ));
        render();
        await setImmediate();
        const [value, error, pending] = render();
        assert.equal(value, succeeds ? "result" : "fallback");
        assert.equal(pending, false);
        assert.equal(error?.message, succeeds ? undefined : "request failed");
        assert.equal(failures, succeeds ? 0 : 1);
        assert.equal(f.errors.length, 1);
        f.unmount();
    }
});

test("awaiter ignores a previous request after dependency change and after unmount", async () => {
    const f = fixture();
    const resolvers: ((value: string) => void)[] = [];
    let dep = 0;
    let callbacks = 0;
    const render = () => f.render(api => api.useAwaiter(() => new Promise<string>(resolve => resolvers.push(resolve)), {
        fallbackValue: "fallback", deps: [dep], onSuccess() { callbacks++; }
    }));
    render();
    await setImmediate();
    dep++;
    render();
    await setImmediate();
    resolvers[0]("old");
    await setImmediate();
    assert.equal(render()[0], "fallback");
    f.unmount();
    resolvers[1]("unmounted");
    await setImmediate();
    assert.equal(callbacks, 0);
});

test("timer hooks replace changed intervals and clear them on unmount", () => {
    for (const name of ["useTimer", "useFixedTimer"]) {
        const f = fixture();
        let interval = 100;
        const render = () => f.render(api => api[name]({ interval }));
        render();
        const firstTimer = [...f.timers.keys()][0];
        f.setNow(1250);
        [...f.timers.values()][0].callback();
        assert.equal(render(), 250);
        interval = 50;
        render();
        assert.equal(f.timers.has(firstTimer), false);
        assert.equal(f.timers.size, 1);
        assert.equal([...f.timers.values()][0].delay, 50);
        f.setNow(1500);
        [...f.timers.values()][0].callback();
        assert.equal(render(), 500, "changing cadence must retain the start time");
        f.unmount();
        assert.equal(f.timers.size, 0);
    }
});

test("fixed timer immediately reflects a changed initial time", () => {
    const f = fixture();
    let initialTime = 0;
    const render = () => f.render(api => api.useFixedTimer({ initialTime }));
    assert.equal(render(), 1000);
    initialTime = 900;
    render();
    assert.equal(render(), 100);
    assert.equal(f.timers.size, 1);
    f.unmount();
});
