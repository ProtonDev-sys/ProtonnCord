import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordReactionPickerSource, discordStreamSettingsSources, discordVideoTileSources, discordVoiceBackgroundSources } from "./fixtures/discordVoiceMedia";
import { loadTestModule } from "./utils/loadTestModule";

const jsx = (type: unknown, props: any) => ({ type, props });
const React = { createElement: (type: unknown, props: any) => jsx(type, props) };
const settings = { store: { voiceBackground: true, maxFPS: 120, maxResolution: 1080, roundResolution: true,
    resolutions: [{ label: "Source", value: 0 }, { label: "720p", value: 720 }], fpss: [{ label: "30fps", value: 30 }] } };

function loadPlugin(file: string, imports: Record<string, unknown> = {}) {
    return loadTestModule(file, {
        "@api/Settings": { definePluginSettings: () => settings },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        ...imports
    }, { React }).default;
}

function applyPatch(source: string, patch: any, path = "plugin") {
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    return replacements.reduce((current: string, replacement: any) => {
        const next = current.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, path));
        assert.notEqual(next, current, `Captured Discord code must match ${replacement.match}`);
        return next;
    }, source);
}

function host(source: string, modules: Record<number, any>, globals: Record<string, unknown>) {
    const exports: Record<string, any> = {};
    const requireHost = Object.assign((id: number) => modules[id] ?? {}, {
        n: (value: unknown) => () => value,
        d(target: object, getters: Record<string, () => unknown>) {
            for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
        }
    });
    runInNewContext(`(${source})`, globals)({}, exports, requireHost);
    return exports;
}

function backgrounds() {
    const usrbg = loadPlugin("src/plugins/usrbg/index.tsx", { "@components/Button": {} });
    usrbg.data = { endpoint: "https://images.example", bucket: "banners", prefix: "", users: { user: "etag" } };
    const full = loadPlugin("src/equicordplugins/fullVcPfp/index.tsx", {
        "@utils/misc": { getUserAvatarUrl: () => "https://images.example/avatar.png" },
        "@webpack/common": {
            UserStore: { getUser: () => ({ id: "user" }) },
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice" }) },
            ChannelStore: { getChannel: () => ({ guild_id: "guild" }) },
            ChannelRTCStore: { getSpeakingParticipants: () => [{ user: { id: "user" }, speaking: false }] }
        }
    });
    return { usrbg, full };
}

test("voice backgrounds compose on current ref props without mutating Discord's frozen props or styles", () => {
    for (const fixture of discordVideoTileSources) {
        for (const order of [["usrbg"], ["full"], ["usrbg", "full"], ["full", "usrbg"]]) {
            const plugins = backgrounds();
            let source = fixture;
            for (const name of order) source = applyPatch(source, name === "usrbg" ? plugins.usrbg.patches[1] : plugins.full.patches[0], `plugins.${name}`);
            const render = host(source, { 477900: { jsx }, 503698: (...values: unknown[]) => values, 195500: {} }, { plugins }).A;
            const style = Object.freeze({ opacity: 0.8, height: 120 });
            const ref = { current: "tile" };
            const children = { type: "video" };
            const props = Object.freeze({ style, ref, children, className: "tile_fixture", participantUserId: "user" });
            const rendered = render(props);
            assert.equal(rendered.props.ref, ref);
            assert.equal(rendered.props.children, children);
            assert.equal(rendered.props["data-selenium-video-tile"], "user");
            assert.equal(rendered.props.style.height, 120);
            assert.equal(rendered.props.style.opacity, 0.8);
            assert.equal(Boolean(rendered.props.style.backgroundImage), order.includes("usrbg"));
            assert.equal(Boolean(rendered.props.style["--full-res-avatar"]), order.includes("full"));
            assert.equal(props.style, style);
            assert.deepEqual(Object.keys(style), ["opacity", "height"]);
        }
    }
});

test("USRBG finds current voice backgrounds and preserves Discord's fallback for users without a banner", () => {
    const plugin = backgrounds().usrbg;
    for (const fixture of discordVoiceBackgroundSources) {
        assert.ok(fixture.includes(plugin.patches[2].find));
        const source = applyPatch(fixture, plugin.patches[2]);
        const render = host(source, {
            477900: { jsx }, 582128: { useEffect() {} }, 503698: () => "background",
            661531: { A: { unsafe_rawColors: { PRIMARY_800: { css: "fallback" } } } },
            97808: { eu: "image" }, 654107: { Ay: () => "sampled-color" }, 543699: { tM: () => "dark" },
            999291: { Ay: () => null }, 920601: { A: () => ({ profileThemeStyle: {}, profileThemeClassName: "theme" }) },
            945810: { mj: () => ({ useConfig: () => ({ enabled: false }) }) },
            652215: { NJ8: { DARK: "dark" } }, 996988: { d: { VIDEO_TILE_BACKGROUND: "video" } }
        }, { plugin }).A;
        const existing = { opacity: 0.5 };
        assert.equal(render({ src: "image.png", userId: "user", style: existing }).props.style, null);
        const fallback = render({ src: "image.png", userId: "other", style: existing });
        assert.equal(fallback.props.style.backgroundColor, "sampled-color");
        assert.equal(fallback.props.style.opacity, 0.5);
        assert.equal(render({ src: null, userId: "user" }), null);
    }
});

test("screen-share sliders and presets retain the native permission, quality and already-selected guards", () => {
    const quality = { resolution: 720, frameRate: 30 };
    const plugin = loadPlugin("src/equicordplugins/limitlessScreenshare/index.tsx", {
        "@webpack/common": { MediaEngineStore: { getState: () => ({ goLiveSource: { quality } }) }, Menu: { MenuRadioItem: "preset" } },
        "./CustomRange": { CustomRange: (props: unknown) => jsx("slider", props) },
        "./settings": { settings, MIN_FPS: 1, MIN_RESOLUTION: 3 }
    });
    for (const fixture of discordStreamSettingsSources) {
        const source = applyPatch(fixture, plugin.patches[2]);
        for (const allowed of [false, true]) for (const maximized of [false, true]) {
            const calls: any[] = [];
            const checks: any[] = [];
            const user = { id: "user" };
            const channel = { id: "voice" };
            let prompts = 0;
            const render = runInNewContext(`(${source})`, {
                plugin, i: { jsx, jsxs: jsx, Fragment: "fragment" }, r: { useCallback: (fn: Function) => fn },
                a: { cf: (_stores: unknown, get: () => unknown) => get(), bG: (_stores: unknown, get: () => unknown) => get() },
                E: { A: { getState: () => ({ preset: "custom", resolution: quality.resolution, fps: quality.frameRate, soundshareEnabled: true }) } },
                A: { Ay: { getGoLiveSource: () => ({ desktopSource: { id: "screen:1" } }) } },
                R: { default: { getCurrentUser: () => user } }, C: { A: { getGuild: () => ({ premiumTier: 2 }) } },
                T: { p: () => ({ location: { page: "fixture" } }) }, O: { Ay: { getVoiceChannelId: () => "voice" } },
                N: { A: { getChannel: () => channel } }, d: { default: { setGoLiveSource: (value: unknown) => calls.push(value) } },
                D: { x: { STREAM: "stream" } }, I: { openModalLazy: () => { prompts++; } },
                L: { ZSU: { RADIO_ITEM: "radio" }, AnalyticsObjectTypes: { RESOLUTION: "resolution" }, BRT: { POPOUT: "popout" } },
                p: { KX: "popout", SY: "app" }, s: { iD: "native-preset", rX: "group" }, v: { intl: { string: (value: string) => value }, t: {} },
                y: { jQ: { PRESET_CUSTOM: "custom", PRESET_DOCUMENTS: "documents" }, kn: { FPS_30: 30 }, ce: [{ value: 30 }], Jk: [{ value: 720 }] },
                g: { A: () => ({ maxResolution: maximized ? 720 : 1080, maxFPS: maximized ? 30 : 60 }) },
                S: { A: () => 600 },
                m: { A: (...args: unknown[]) => { checks.push(args); return allowed; } }
            });
            assert.equal(render(null, "app"), null, "the native missing-stream guard remains in place");
            const groups = render({ guildId: "guild" }, "app").props.children;
            const fps = groups[0].props.children;
            const resolution = groups[1].props.children;
            assert.equal(fps[0].props.initialValue, 30);
            assert.equal(resolution[0].props.initialValue, 72);
            fps[0].props.onChange(45);
            resolution[0].props.onChange(90);
            resolution[1].props.action();
            assert.equal(checks.length, 3);
            for (const check of checks) {
                assert.equal(check[0], "custom");
                assert.equal(check[3], user);
                assert.equal(check[4], 2);
                assert.equal(check[5], channel);
            }
            assert.deepEqual(checks.map(args => args.slice(1, 3)), [[maximized ? 600 : 720, 45], [900, 30], [0, 30]]);
            assert.equal(calls.length, allowed ? 3 : 0);
            assert.equal(prompts, allowed ? 0 : 3);
            if (allowed) {
                assert.equal(calls[0].qualityOptions.frameRate, 45);
                assert.equal(calls[1].qualityOptions.resolution, 900);
                assert.equal(calls[2].qualityOptions.resolution, 0);
                assert.equal(calls[0].desktopSettings.sourceId, "screen:1");
                assert.equal(calls[0].desktopSettings.sound, true);
            }
            const before = calls.length + prompts;
            fps[1].props.action();
            assert.equal(calls.length + prompts, before + (maximized ? 0 : 1), "native same-quality block guard survives");
        }
    }
});

test("default Super Reactions respect picker intent, actual premium state and the native entitlement check", () => {
    const reactionSettings = { store: { superReactByDefault: true } };
    let premiumTypeActual: number | null;
    let nativeEligibility: boolean;
    const plugin = loadPlugin("src/plugins/superReactionTweaks/index.ts", {
        "@api/Settings": { definePluginSettings: () => reactionSettings },
        "@webpack/common": { OverridePremiumTypeStore: { getState: () => ({ premiumTypeActual }) } }
    });
    const source = applyPatch(discordReactionPickerSource, plugin.patches[1]);
    const render = runInNewContext(`(${source})()`, {
        plugin,
        s: { memo: (fn: unknown) => fn, useState: (value: boolean) => [value, () => {}], useRef: (value: unknown) => ({ current: value }), useEffect() {} },
        el: { default: { getCurrentUser: () => ({ premiumType: 2 }) } },
        ed: { ki: () => nativeEligibility }, eI: { EmojiIntention: { REACTION: "reaction" } }
    });
    for (const enabled of [false, true]) for (const premium of [null, 2]) for (const eligible of [false, true]) for (const intent of ["reaction", "message"]) {
        reactionSettings.store.superReactByDefault = enabled;
        premiumTypeActual = premium;
        nativeEligibility = eligible;
        const result = render({ pickerIntention: intent });
        const selected = enabled && premium !== null && intent === "reaction";
        assert.equal(result.selected, selected, "a modified UserStore premium value cannot enable the default");
        assert.equal(result.isBurstReaction, selected && eligible, "Discord's actual reaction eligibility remains authoritative");
    }
});
