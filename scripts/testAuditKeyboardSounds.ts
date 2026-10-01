import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

function loadPlugin() {
    const players: Array<{ volume: number; deleted: boolean; restarts: number; }> = [];
    const handlers = new Map<string, (event?: unknown) => void>();
    const events = {
        addEventListener: (name: string, handler: (event?: unknown) => void) => handlers.set(name, handler),
        removeEventListener: (name: string) => handlers.delete(name)
    };
    const settings = { store: { volume: 100, soundPack: "operagx" }, definitions: {} as Record<string, any> };
    const plugin = loadTestModule("src/equicordplugins/keyboardSounds/index.ts", {
        "@api/AudioPlayer": {
            createAudioPlayer(_url: string, options: { volume: number; }) {
                const player = {
                    volume: options.volume, deleted: false, restarts: 0,
                    delete() { this.deleted = true; },
                    restart() { this.restarts++; }
                };
                players.push(player);
                return player;
            }
        },
        "@api/Settings": {
            definePluginSettings(definitions: Record<string, any>) {
                settings.definitions = definitions;
                return settings;
            }
        },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "./packs": { ignoredKeys: [], packs: { operagx: { others: ["first", "second"] }, osu: { others: ["third"] } } }
    }, { document: events, window: events }).default;
    return { plugin, settings, players, handlers };
}

test("KeyboardSounds changes volume without recreating or interrupting persistent players", () => {
    const { plugin, settings, players, handlers } = loadPlugin();
    plugin.start();
    const original = [...players];
    assert.equal(original.length, 6);
    handlers.get("keydown")!({ code: "KeyA", key: "a" });
    assert.equal(original.reduce((count, player) => count + player.restarts, 0), 1);
    settings.definitions.volume.onChange(25);
    settings.definitions.volume.onChange(0);
    assert.equal(players.length, original.length);
    assert.ok(original.every(player => !player.deleted && player.volume === 0));
    assert.equal(original.reduce((count, player) => count + player.restarts, 0), 1);
    plugin.stop();
    assert.ok(original.every(player => player.deleted));
    assert.equal(handlers.size, 0);
});

test("KeyboardSounds rebuilds on pack changes and does not allocate while stopped", () => {
    const { plugin, settings, players } = loadPlugin();
    settings.definitions.volume.onChange(40);
    assert.equal(players.length, 0);
    plugin.start();
    const original = [...players];
    settings.store.volume = 40;
    settings.store.soundPack = "osu";
    settings.definitions.soundPack.onChange("osu");
    assert.ok(original.every(player => player.deleted));
    assert.equal(players.length, 9);
    assert.ok(players.slice(6).every(player => player.volume === 40));
    plugin.stop();
    settings.definitions.volume.onChange(75);
    settings.definitions.soundPack.onChange("operagx");
    assert.equal(players.length, 9);
    assert.ok(players.every(player => player.deleted));
});
