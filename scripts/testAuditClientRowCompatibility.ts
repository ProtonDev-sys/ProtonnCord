import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { discordThreadRowProps, discordVoiceIcons, discordVoiceLabel } from "./fixtures/discordClientRows";
import { applyPatch, elements, loadPlugin as loadDiscordPlugin } from "./utils/discordClientFixture";

const jsx = (type: unknown, props: any, key?: string) => ({ type, props, key });
const React = { createElement: (type: unknown, props: any, ...children: unknown[]) => jsx(type, { ...props, children }) };
const settings = { store: { allCallTimers: true, showWithoutHover: false, trackSelf: false } };

function loadPlugin(path: string, imports: Record<string, unknown>) {
    return loadDiscordPlugin(path, {
        "@api/Settings": { definePluginSettings: () => settings },
        ...imports
    });
}

function timerPlugin() {
    const plugin = loadPlugin("src/plugins/callTimer/index.tsx", {
        "@components/ErrorBoundary": { __esModule: true, default: Object.assign("boundary", { wrap: (fn: unknown) => fn }) },
        "@utils/react": {}, "@utils/text": {}, "./Timer": { Timer: "timer" },
        "@webpack/common": { React, UserStore: { getCurrentUser: () => ({ id: "self" }) } }
    });
    plugin.flux.VOICE_STATE_UPDATES({ voiceStates: ["tracked", "self"].map(userId => ({ userId, channelId: "voice", oldChannelId: null })) });
    return plugin;
}

test("voice-row timers retain native indicators and keep untracked, self and disabled rows empty", () => {
    const plugin = timerPlugin();
    const renderedIds: string[] = [];
    const renderTimer = plugin.renderTimer.bind(plugin);
    plugin.renderTimer = (id: string) => { renderedIds.push(id); return renderTimer(id); };
    const nativeStream = Object.assign(() => {}, { Sizes: { SMALL: "small" } });
    const render = runInNewContext(`(${applyPatch(discordVoiceIcons, { replacement: plugin.patches[0].replacement[0] })})`, {
        plugin, i: { jsx, jsxs: jsx }, a: () => () => "icons", et: {},
        G: { useConfig: () => ({ enabled: false }) }, P: { A: () => ({ previewUrl: null }) },
        ee: { f$: { XBOX: "xbox", PLAYSTATION: "playstation" } }, Y: { J7: { XBOX: "xbox", PLAYSTATION: "playstation", QUEST: "quest" } },
        m: { m: "tooltip" }, f: { z: "microphone" }, p: { O: "muted" },
        es: { intl: { string: () => "Muted" }, t: {} }, ea: "game", v: { Ay: nativeStream }
    });
    for (const id of ["unknown", "self"]) assert.equal(render({ user: { id } }), null);
    const node = render({ user: { id: "tracked" }, mute: true, isStreaming: true, application: { isEmbedded: false } });
    const nodes = elements(node);
    assert.equal(nodes.filter(value => value.type === "timer").length, 1);
    assert.equal(nodes.filter(value => value.key === "mute").length, 1);
    assert.equal(nodes.filter(value => value.type === nativeStream).length, 1);
    assert.equal(nodes.filter(value => value.type === "game").length, 1);
    assert.ok(nodes.find(value => value.type === "timer").props.time > 0);
    for (const state of [{ collapsed: true }, { disabled: true }]) {
        const before = renderedIds.length;
        assert.equal(render({ user: { id: "tracked" }, ...state }), null);
        assert.equal(renderedIds.length, before, "the native disabled/collapsed guard runs before timer rendering");
    }
});

test("always-visible timers preserve guest names, primary-guild props and collapsed row behavior", () => {
    const plugin = timerPlugin();
    const source = applyPatch(discordVoiceLabel, { replacement: plugin.patches[0].replacement[1] });
    const user = { id: "tracked", primaryGuild: { identityGuildId: "guild" } };
    for (const guest of [false, true]) for (const collapsed of [false, true]) {
        const label = runInNewContext(`(()=>{let n,r;return ${source};})()`, {
            plugin, i: { jsx, jsxs: jsx }, a: () => () => "name", et: {}, o: "name", ei: "role",
            v: false, V: false, T: false, q: false, w: undefined, z: guest, Y: user,
            $: { Ay: { getName: () => "Voice user" } }, es: { intl: { string: () => "Guest" }, t: { "pFO/Ph": "guest" } },
            K: "guild", g: false, S: collapsed, Q: { JJy: { OVERLAY: "overlay" }, ThZ: { VOICE_PANEL: "voice" } }, en: "name-wrapper"
        });
        if (collapsed) { assert.equal(label, null); continue; }
        assert.equal(label.props.userId, "tracked");
        assert.equal(label.props.primaryGuild, user.primaryGuild);
        assert.equal(label.props.children.props.children[0], "Voice user");
        const nodes = elements(label);
        assert.equal(nodes.filter(value => value.type === "timer").length, 1);
        assert.equal(nodes.filter(value => value.type === "span").length, Number(guest));
    }
});

test("draggable thread links preserve native click, auxiliary click, focus props and the original event", () => {
    const plugin = loadPlugin("src/equicordplugins/dragify/index.tsx", {
        "@utils/discord": {}, "@utils/Logger": { Logger: class {} }, "@vencord/discord-types/enums": { ChannelType: {} },
        "@webpack/common": {}, "./dragState": {}, "./ghost": {}, "./invite": {}, "./targets": {}, "./utils": {}
    });
    const events: unknown[] = [];
    plugin.onChannelDragStart = (event: unknown) => events.push(event);
    const click = () => {}, auxiliaryClick = () => {};
    const ref = { current: "thread" };
    const originalProps = Object.freeze({ tabIndex: 0 });
    for (const fixture of discordThreadRowProps) {
        const props = runInNewContext(`(${applyPatch(fixture, plugin.patches[2])})`, {
            plugin, r: { jsx, jsxs: jsx }, I: originalProps, b: ref, C: click, x: auxiliaryClick, G: "Thread name",
            n0: {}, n2: {}, eO: () => () => "thread", eP: () => () => "thread", e0: { E: "text" }, e1: { E: "text" },
            tB: { A: "name" }, tF: { A: "name" }, g: "Thread name", m: "Thread name", nP: {}, nk: {},
            iZ: "status", iQ: "status", iw: "actions", ik: "actions", t: { id: "thread" }, _: 0, u: false, A: 0, f: false
        });
        assert.equal(props.draggable, true);
        assert.equal(props.innerRef, ref);
        assert.equal(props.onClick, click);
        assert.equal(props.onAuxClick, auxiliaryClick);
        assert.equal(props["aria-label"], "Thread name");
        assert.equal(props.focusProps.enabled, false);
        assert.equal(props.tabIndex, 0);
        const event = Object.freeze({ type: "dragstart", currentTarget: { id: "thread" } });
        props.onDragStart(event);
        assert.equal(events.at(-1), event);
    }
});
