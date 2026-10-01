import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

function loadPlugin() {
    const settings = { store: {} as Record<string, unknown>, definitions: {} as Record<string, any> };
    const plugin = loadTestModule("src/equicordplugins/customStatusTimeouts/index.tsx", {
        "@api/Settings": {
            definePluginSettings(definitions: Record<string, any>) {
                settings.definitions = definitions;
                settings.store = Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [key, definition.default]));
                return settings;
            }
        },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} }
    }, {}).default;
    return { plugin, settings };
}

test("CustomStatusTimeouts rejects overflowing and out-of-range custom expiry dates", () => {
    const { plugin, settings } = loadPlugin();
    for (const key of ["extraSeconds", "extraMinutes", "extraHours", "extraDays"]) {
        settings.store[key] = "1e308, 1e20, Infinity, NaN, -1, 0";
    }
    const options = plugin.buildTimeouts([]);
    assert.equal(options.length, 5);
    for (const option of options) {
        assert.ok(Number.isFinite(option.duration));
        assert.ok(Number.isFinite(new Date(Date.now() + option.duration).getTime()));
    }
});

test("CustomStatusTimeouts preserves valid fractions, native entries and cache invalidation", () => {
    const { plugin, settings } = loadPlugin();
    settings.store.extraSeconds = "0.5, 1, 1";
    settings.store.extraMinutes = settings.store.extraHours = settings.store.extraDays = "";
    const forever = { label: () => "Forever" };
    const native = { duration: 9000, label: () => "Native" };
    const existing = [native, forever];
    const options = plugin.buildTimeouts(existing);
    assert.equal(options[0], forever);
    assert.ok(options.includes(native));
    assert.deepEqual(existing, [native, forever]);
    assert.deepEqual(Array.from(options.slice(1, 3), (option: any) => option.duration), [500, 1000]);
    settings.store.extraSeconds = "2";
    settings.definitions.extraSeconds.onChange();
    assert.equal(plugin.buildTimeouts([])[0].duration, 2000);
    settings.store.extraSeconds = "3";
    plugin.stop();
    assert.equal(plugin.buildTimeouts([])[0].duration, 3000);
    settings.store.showForeverOnTop = false;
    assert.equal(plugin.buildTimeouts(existing).at(-1), forever);
});
