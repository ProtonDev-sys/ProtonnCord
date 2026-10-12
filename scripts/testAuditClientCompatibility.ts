import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordConnectionStatusSource, discordDevtoolsWarningSource, discordScrollerSource } from "./fixtures/discordCoreComponents";
import { loadTestModule } from "./utils/loadTestModule";

function loadPlugin(file: string, imports: Record<string, unknown> = {}) {
    return loadTestModule(file, {
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        ...imports
    }, {}).default;
}

function applyPatch(source: string, patch: any) {
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    return replacements.reduce((current: string, replacement: any) => {
        const next = current.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, "plugin"));
        assert.ok(next !== current, `captured Discord code must match ${replacement.match}`);
        return next;
    }, source);
}

test("NoDevtoolsWarning disables the current host registration guard for web and desktop", () => {
    const plugin = loadPlugin("src/plugins/noDevtoolsWarning/index.ts");
    const patched = applyPatch(discordDevtoolsWarningSource, plugin.patches[0]);
    for (const version of [undefined, "1.2.3", "0.0.0"]) {
        function registrations(source: string) {
            let count = 0;
            runInNewContext(source, {
                eC: { A: version && { app: { getVersion: () => version }, window: { setDevtoolsCallbacks() { count++; } } } },
                e_: { Fr: false, v1: false }, eu: class { on() { count++; } },
                el: {}, window: { addEventListener() { count++; } }
            });
            return count;
        }
        assert.equal(registrations(discordDevtoolsWarningSource), version === "0.0.0" ? 0 : 2);
        assert.equal(registrations(patched), 0, "the optional plugin leaves token-hiding and banner callbacks unregistered");
    }
});

test("the concatenated scroller extractor preserves React ref props and both host layouts", () => {
    let createScroller: any;
    const plugin = loadPlugin("src/plugins/_core/concatenatedComponentExtractor.tsx", {
        "@webpack/common": { setCreateScroller: (factory: unknown) => { createScroller = factory; } }
    });
    const source = applyPatch(discordScrollerSource, plugin.patches[1]);
    const scrollerRef = { current: "scroller-node" };
    const jsx = (type: unknown, props: object) => ({ type, props });
    const modules: Record<number, any> = {
        477900: { jsx, jsxs: jsx },
        582128: { useImperativeHandle: (ref: any, create: () => unknown) => { ref.current = create(); } },
        503698: (...args: unknown[]) => args,
        536804: { A: () => ({ scrollerRef, getScrollerState: () => "state" }) },
        789279: { A() {} }, 584648: { A: () => ({ scrollTo: "scroll-helper" }) },
        518898: { A: () => "scrollbar" }, 751591: { Ay: (style: object) => style },
        331322: { B: "stack" }, 330573: { t: "focus-scope" }
    };
    const requireHost = Object.assign((id: number) => modules[id] ?? {}, { d() {}, n: (value: unknown) => () => value });
    runInNewContext(`(${source})`, { plugin })({}, {}, requireHost);
    assert.equal(typeof createScroller, "function");
    const Scroller = createScroller("thin", "fade", "theme");
    for (const experimental_useStack of [false, true]) {
        const ref = { current: null as any };
        const child = { content: "fixture" };
        const rendered = Scroller({ ref, children: child, experimental_useStack, style: { height: 120 } });
        assert.equal(rendered.type, experimental_useStack ? "stack" : "div");
        assert.equal(rendered.props.ref, scrollerRef);
        assert.equal(rendered.props.style.height, 120);
        assert.equal(rendered.props.children.props.children[0], child);
        assert.equal(ref.current.getScrollerNode(), "scroller-node");
        assert.equal(ref.current.getScrollerState(), "state");
        assert.equal(ref.current.scrollTo, "scroll-helper");
    }
});

test("connection timers remain beside the channel label when Discord displays its new status row", () => {
    const plugin = loadPlugin("src/plugins/callTimer/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/react": {}, "@utils/text": {}, "@webpack/common": {}, "./Timer": {}
    });
    const source = applyPatch(discordConnectionStatusSource, plugin.patches[1]);
    const timer = { type: "timer" };
    plugin.renderConnectionTimer = () => timer;
    const jsx = (type: unknown, props: object) => ({ type, props });
    function descendants(node: any): any[] {
        if (Array.isArray(node)) return node.flatMap(descendants);
        return node && typeof node === "object" ? [node, ...descendants(node.props?.children)] : [];
    }
    for (const showStatus of [false, true]) {
        const render = runInNewContext(`(${source})`, {
            plugin, w: { jsx, jsxs: jsx }, _n: { Ay: () => "General" },
            ef: { bG: (_stores: unknown, get: () => unknown) => get(), cf: (_stores: unknown, get: () => unknown) => get() },
            e6: { A: { getGuild: () => ({ name: "Fixture Guild" }) } }, nx: { A: { hasVideo: () => false } }, nC: { A: {} },
            K: { bFR: {}, S7L: {}, BVt: { CHANNEL: () => "/channels/fixture" } },
            DP: { KN: () => showStatus }, vS: { A: { getStatus: () => ({ connectionStatus: "connected", connectionStatusText: "Voice connected" }) } },
            D6: { A: "connection-status", e: { connected: "green" } }, ep: { vN: "tooltip" }, lf: { N_: "link" },
            rF: { E: "text" }, Dh: { A: "truncate" }, va: { Ix: "channel-label" }
        });
        const nodes = descendants(render({ channel: { id: "voice", guild_id: "guild" }, hasRemoteVoiceState: true }));
        const label = nodes.find(node => node.props?.lineClamp === 1);
        assert.deepEqual(Array.from(label.props.children), ["General / Fixture Guild", timer]);
        assert.equal(nodes.filter(node => node === timer).length, 1);
        assert.equal(nodes.filter(node => node.props?.children === "Voice connected").length, showStatus ? 1 : 0);
    }
});
