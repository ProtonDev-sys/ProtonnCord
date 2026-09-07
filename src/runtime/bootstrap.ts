/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type Dispose = () => void;
export type PluginStage = "Init" | "DOMContentLoaded" | "WebpackReady";

export interface RendererService {
    dispose: Dispose;
    runInitial?(): void | Promise<unknown>;
}

export interface RuntimeHost {
    now(): number;
    isDomReady(): boolean;
    onDomReady(callback: () => void): Dispose;
    onPageHide(callback: () => void): Dispose;
    defer(callback: () => void): Dispose;
}

export interface RuntimeOptions {
    host: RuntimeHost;
    ready: Promise<unknown>;
    initializePlugins(): void;
    initializeStyles(): void;
    startPlugins(stage: PluginStage): void;
    onDomReady?(): void;
    services: ReadonlyArray<{ name: string; start(): RendererService; }>;
    onError(stage: string, error: unknown): void;
}

interface StageStatus {
    name: string;
    phase: "scheduled" | "running" | "complete" | "failed" | "cancelled";
    startedMs: number | null;
    durationMs: number | null;
    errors: number;
}

export interface RuntimeStatus {
    readonly started: boolean;
    readonly disposed: boolean;
    readonly elapsedMs: number;
    readonly stages: ReadonlyArray<Readonly<StageStatus>>;
}

/** A bounded idle turn for optional initial work, with cancellable browser fallback. */
export function scheduleIdleTask(
    callback: () => void,
    scheduler: Pick<Window, "setTimeout" | "clearTimeout"> & Partial<Pick<Window, "requestIdleCallback" | "cancelIdleCallback">>,
): Dispose {
    let finished = false;
    const run = () => {
        if (finished) return;
        finished = true;
        callback();
    };
    const idle = typeof scheduler.requestIdleCallback === "function" && typeof scheduler.cancelIdleCallback === "function";
    const handle = idle
        ? scheduler.requestIdleCallback!(run, { timeout: 2_000 })
        : scheduler.setTimeout(run, 0);
    return () => {
        if (finished) return;
        finished = true;
        if (idle) scheduler.cancelIdleCallback!(handle);
        else scheduler.clearTimeout(handle);
    };
}

/** Pure orchestration; timing covers individual startup tasks, not bundle parsing or whole-client launch. */
export function createRendererRuntime(options: RuntimeOptions) {
    const { host } = options;
    const createdAt = host.now();
    const stages = new Map<string, StageStatus>();
    const cleanups: Array<{ name: string; dispose: Dispose; }> = [];
    let started = false;
    let disposed = false;

    function report(name: string, error: unknown) {
        const stage = stages.get(name);
        if (stage) stage.errors++;
        options.onError(name, error);
    }

    function run(name: string, action: () => unknown) {
        if (disposed || (stages.has(name) && stages.get(name)!.phase !== "scheduled")) return;
        const stage: StageStatus = { name, phase: "running", startedMs: host.now() - createdAt, durationMs: null, errors: 0 };
        stages.set(name, stage);
        const finish = (phase: "complete" | "failed") => {
            stage.durationMs = host.now() - createdAt - stage.startedMs!;
            stage.phase = disposed ? "cancelled" : phase;
        };
        try {
            const result = action();
            if (result && typeof (result as Promise<unknown>).then === "function") {
                void Promise.resolve(result).then(() => finish("complete"), error => {
                    finish("failed");
                    report(name, error);
                });
            } else {
                finish("complete");
            }
        } catch (error) {
            finish("failed");
            report(name, error);
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        for (const stage of stages.values()) {
            if (stage.phase === "scheduled" || stage.phase === "running") stage.phase = "cancelled";
        }
        for (const cleanup of cleanups.splice(0).reverse()) {
            try {
                cleanup.dispose();
            } catch (error) {
                report(cleanup.name, error);
            }
        }
    }

    function domReady() {
        run("DOMContentLoaded", () => options.startPlugins("DOMContentLoaded"));
        if (options.onDomReady) run("domStyles", options.onDomReady);
    }

    function start() {
        if (started || disposed) return;
        started = true;
        cleanups.push({ name: "pagehide", dispose: host.onPageHide(dispose) });
        run("pluginManager", options.initializePlugins);
        run("styles", options.initializeStyles);
        run("Init", () => options.startPlugins("Init"));
        if (host.isDomReady()) domReady();
        else cleanups.push({ name: "DOMContentLoaded", dispose: host.onDomReady(domReady) });

        void options.ready.then(() => {
            if (disposed) return;
            run("WebpackReady", () => options.startPlugins("WebpackReady"));
            for (const service of options.services) {
                run(`${service.name}:setup`, () => {
                    const instance = service.start();
                    cleanups.push({ name: `${service.name}:setup`, dispose: instance.dispose });
                    if (instance.runInitial) {
                        stages.set(service.name, { name: service.name, phase: "scheduled", startedMs: null, durationMs: null, errors: 0 });
                        const cancel = host.defer(() => run(service.name, () => instance.runInitial!()));
                        cleanups.push({ name: service.name, dispose: cancel });
                    }
                });
            }
        }, error => run("WebpackReady", () => { throw error; }));
    }

    function getStatus(): RuntimeStatus {
        return Object.freeze({
            started,
            disposed,
            elapsedMs: host.now() - createdAt,
            stages: Object.freeze([...stages.values()].map(stage => Object.freeze({ ...stage }))),
        });
    }

    return { start, dispose, getStatus };
}
