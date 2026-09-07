/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Resources belong to one start/stop cycle, including a partially completed start. */
export class PluginResources {
    private cleanups: Array<() => unknown> = [];

    add(cleanup: () => unknown) {
        this.cleanups.push(cleanup);
    }

    register(setup: () => unknown, cleanup: () => unknown) {
        setup();
        this.add(cleanup);
    }

    /** Release every resource once, even when another cleanup fails. */
    dispose(onError: (error: unknown) => void): boolean {
        const { cleanups } = this;
        this.cleanups = [];
        let success = true;

        for (let i = cleanups.length - 1; i >= 0; i--) {
            try {
                cleanups[i]();
            } catch (error) {
                success = false;
                onError(error);
            }
        }

        return success;
    }
}
