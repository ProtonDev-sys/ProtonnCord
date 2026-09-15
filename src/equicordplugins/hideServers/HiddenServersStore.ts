/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { Guild } from "@vencord/discord-types";
import { proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher, GuildStore, SortedGuildStore } from "@webpack/common";

export const HiddenServersStore = proxyLazyWebpack(() => {
    const { Store } = Flux;

    const DB_KEY = "HideServers_servers";
    const SAVE_DEBOUNCE_MS = 250;

    class HiddenServersStore extends Store {
        public _hiddenGuilds: Set<string> = new Set();
        private loadGeneration = 0;
        private saveTimeout: ReturnType<typeof setTimeout> | undefined;
        private dirty = false;
        private saveQueue: Promise<unknown> = Promise.resolve();

        public get hiddenGuilds() { return this._hiddenGuilds; }

        public async load() {
            const generation = ++this.loadGeneration;
            await this.saveQueue;
            const data = await DataStore.get<Set<string> | string[]>(DB_KEY);
            if (generation !== this.loadGeneration) return;

            if (data instanceof Set) {
                this._hiddenGuilds = new Set(Array.from(data).filter(id => typeof id === "string"));
            } else if (Array.isArray(data)) {
                this._hiddenGuilds = new Set(data.filter(id => typeof id === "string"));
            } else {
                this._hiddenGuilds = new Set();
            }

            this.emitChange();
        }

        public unload() {
            this.loadGeneration++;
            this.flushSave();
            this._hiddenGuilds = new Set();
            this.emitChange();
        }

        public save() {
            this.dirty = true;
            if (this.saveTimeout) clearTimeout(this.saveTimeout);
            this.saveTimeout = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
        }

        private flushSave() {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = undefined;
            }

            if (!this.dirty) return;
            this.dirty = false;
            const snapshot = Array.from(this._hiddenGuilds);
            this.saveQueue = this.saveQueue.then(() => DataStore.set(DB_KEY, snapshot))
                .catch(error => new Logger("HideServers").error("Failed to save hidden servers", error));
        }

        private replaceHiddenGuilds(next: Set<string>) {
            this._hiddenGuilds = next;
            this.save();
            this.emitChange();
        }

        public addHiddenGuild(id: string) {
            if (this._hiddenGuilds.has(id)) return;

            const next = new Set(this._hiddenGuilds);
            next.add(id);
            this.replaceHiddenGuilds(next);
        }

        public removeHiddenGuild(id: string) {
            if (!this._hiddenGuilds.has(id)) return;

            const next = new Set(this._hiddenGuilds);
            next.delete(id);
            this.replaceHiddenGuilds(next);
        }

        public addHiddenFolder(id: string, guildIds: string[]) {
            const next = new Set(this._hiddenGuilds);
            next.add(`folder-${id}`);
            guildIds.forEach(gid => next.add(gid));
            this.replaceHiddenGuilds(next);
        }

        public removeHiddenFolder(id: string, guildIds: string[]) {
            const next = new Set(this._hiddenGuilds);
            next.delete(`folder-${id}`);
            guildIds.forEach(gid => next.delete(gid));
            this.replaceHiddenGuilds(next);
        }

        public clearHidden() {
            this.loadGeneration++;
            this.dirty = false;
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = undefined;
            }

            this._hiddenGuilds = new Set();
            this.saveQueue = this.saveQueue.then(() => DataStore.del(DB_KEY))
                .catch(error => new Logger("HideServers").error("Failed to clear hidden servers", error));
            this.emitChange();
        }

        public hiddenGuildsDetail(): Guild[] {
            const sortedGuildIds = SortedGuildStore.getFlattenedGuildIds() as string[];
            // otherwise the list is in order of increasing id number which is confusing
            return sortedGuildIds
                .filter(id => this._hiddenGuilds.has(id))
                .map(id => GuildStore.getGuild(id))
                .filter((guild): guild is Guild => Boolean(guild));
        }
    }

    return new HiddenServersStore(FluxDispatcher);
});
